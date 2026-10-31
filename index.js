/**
 * dsh-lan-gateway — host half.
 *
 * A *side* listener, never a patch of DSH itself:
 *   browser/remote ──HTTP──▶ this gateway (0.0.0.0:<webPort+1>) ──HTTP──▶ DSH webserver (127.0.0.1:<webPort>)
 *
 * Why it exists: DSH Web only prints/opens a URL carrying a per-process launch
 * token, and its `/api` fence accepts only loopback / the listener's bind IP /
 * `trustedHosts` authorities. Editing DSH startup or replacing BrowserAuth to
 * reach it from another machine is what other plugins do, and it breaks on
 * every DSH release. This plugin instead:
 *
 *   1. asks the in-process Connection service for the launch token
 *      (`ctx.connection.authenticatedUrl`, the same call web-app prints with),
 *   2. exchanges that token for the session cookie DSH mints itself
 *      (`GET /?token=…` → 303 + `Set-Cookie`) against the DSH listener,
 *   3. rewrites only the *proxy hop* headers (Host/Origin) so the DSH trust
 *      fence sees its own loopback authority, and
 *   4. injects that cookie on every forwarded request.
 *
 * Nothing in DSH is modified, monkey-patched or bypassed: DSH still mints and
 * verifies its own signed cookie; the gateway merely holds one and presents it
 * on behalf of the trusted network. Disable the row and DSH behaves exactly as
 * shipped.
 *
 * Access is gated in three modes: `lan` (every private/local range), `any`
 * (every address that can reach the port) and `list` (exact IPs and CIDRs).
 *
 * 2026-10-31 isolation hardening: every async entry point swallows its own
 * failure (no unhandled rejection can reach the host process), the single
 * instance hand-off lives in a `WeakMap` keyed by `ctx.root` instead of
 * `globalThis`, and `apply` as a whole is wrapped so a bad edit can only make
 * this plugin inert.
 *
 * @module dsh-lan-gateway
 */
import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync, writeFileSync, renameSync, watchFile, unwatchFile } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'

/** Cordis plugin name (the Loader row id is the same string by convention). */
export const name = 'lan-gateway'
/** Services that must exist before the gateway can learn its upstream or mint a session. */
export const inject = ['webServer', 'connection']

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Settings file that the panel writes; it overrides the row config. */
const CONFIG_FILENAME = 'lan-gateway.json'

const DEFAULTS = {
  enabled: true,
  /** `lan` | `any` | `list` */
  mode: 'lan',
  /** Exact addresses or CIDRs allowed in `list` mode. */
  allow: [],
  /** Interface the side listener binds. 0.0.0.0 serves every IPv4 interface. */
  listenHost: '0.0.0.0',
  /** Explicit base port; `null` means `webPort + portOffset`. */
  port: null,
  /** Offset added to the DSH Web port when `port` is null. */
  portOffset: 1,
  /** How many consecutive ports to try before giving up. */
  maxPortScan: 50,
  /** Log every forwarded request. */
  verbose: false,
  /** Log rejected peers (rate limited to one line per second). */
  logRejected: true,
}

/** Headers owned by one HTTP hop; never forwarded. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
])
/** Client-supplied forwarding headers are dropped: the peer address is the only identity. */
const SPOOFABLE = new Set([
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-real-ip', 'client-ip', 'x-client-ip',
])
/** Ranges `lan` mode accepts as local. */
const LAN_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8']
const LAN_V6 = ['::1/128', 'fc00::/7', 'fe80::/10']

// ─────────────────────────────────────────────────────────────────────────────
// address parsing / matching (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {number|undefined} unsigned 32-bit IPv4 value */
export function parseIPv4(text) {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text.trim())
  if (match === null) return undefined
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return undefined
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

/** @returns {Uint8Array|undefined} 16 IPv6 bytes, zone id stripped */
export function parseIPv6(text) {
  if (typeof text !== 'string') return undefined
  let value = text.trim()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === '' || !value.includes(':')) return undefined
  // An embedded IPv4 tail becomes the last two hextets.
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':')
    if (colon < 0) return undefined
    const v4 = parseIPv4(value.slice(colon + 1))
    if (v4 === undefined) return undefined
    value = `${value.slice(0, colon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0].split(':')
  const right = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  if ([...left, ...right].some((group) => !/^[0-9a-fA-F]{1,4}$/u.test(group))) return undefined
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 0 : missing !== 0) return undefined
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right]
  const bytes = new Uint8Array(16)
  for (const [index, group] of groups.entries()) {
    const hextet = parseInt(group, 16)
    bytes[index * 2] = hextet >> 8
    bytes[index * 2 + 1] = hextet & 0xff
  }
  return bytes
}

/** @returns {{family: 4|6, base: number|Uint8Array, bits: number}|undefined} */
export function parseCidr(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const raw = text.trim()
  const slash = raw.lastIndexOf('/')
  if (slash < 0) {
    const v4 = parseIPv4(raw)
    if (v4 !== undefined) return { family: 4, base: v4, bits: 32 }
    const v6 = parseIPv6(raw)
    return v6 === undefined ? undefined : { family: 6, base: v6, bits: 128 }
  }
  const address = raw.slice(0, slash)
  const prefixText = raw.slice(slash + 1)
  if (!/^\d{1,3}$/u.test(prefixText)) return undefined
  const bits = Number(prefixText)
  const v4 = parseIPv4(address)
  if (v4 !== undefined) return bits <= 32 ? { family: 4, base: v4, bits } : undefined
  const v6 = parseIPv6(address)
  if (v6 !== undefined) return bits <= 128 ? { family: 6, base: v6, bits } : undefined
  return undefined
}

function ipv4InRange(value, cidr) {
  if (cidr.bits === 0) return true
  const mask = cidr.bits === 32 ? 0xffffffff : ((0xffffffff << (32 - cidr.bits)) >>> 0)
  return (value & mask) === (cidr.base & mask)
}

function ipv6InRange(bytes, cidr) {
  const full = cidr.bits >> 3
  const rest = cidr.bits & 7
  for (let index = 0; index < full; index += 1) {
    if (bytes[index] !== cidr.base[index]) return false
  }
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (bytes[full] & mask) === (cidr.base[full] & mask)
}

function isV4Mapped(bytes) {
  for (let index = 0; index < 10; index += 1) if (bytes[index] !== 0) return false
  return bytes[10] === 0xff && bytes[11] === 0xff
}

/**
 * Classify a socket peer address. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) reads as
 * IPv4, which is what a dual-stack listener reports for an IPv4 client.
 * @param {string|undefined} address
 * @returns {{family: 4, value: number}|{family: 6, value: Uint8Array}|undefined}
 */
export function classifyAddress(address) {
  if (typeof address !== 'string' || address === '') return undefined
  const v4 = parseIPv4(address)
  if (v4 !== undefined) return { family: 4, value: v4 }
  const v6 = parseIPv6(address)
  if (v6 === undefined) return undefined
  if (isV4Mapped(v6)) return { family: 4, value: ((v6[12] << 24) + (v6[13] << 16) + (v6[14] << 8) + v6[15]) >>> 0 }
  return { family: 6, value: v6 }
}

/** Whether one classification is a private/local address (the `lan` mode set). */
export function isLanAddress(peer) {
  if (peer === undefined) return false
  if (peer.family === 4) return LAN_V4.some((entry) => ipv4InRange(peer.value, parseCidr(entry)))
  return LAN_V6.some((entry) => ipv6InRange(peer.value, parseCidr(entry)))
}

/** Whether one classification is the local machine's loopback. */
export function isLoopbackAddress(peer) {
  if (peer === undefined) return false
  if (peer.family === 4) return ipv4InRange(peer.value, parseCidr('127.0.0.0/8'))
  return ipv6InRange(peer.value, parseCidr('::1/128'))
}

/**
 * Decide one peer against the configured mode.
 *
 * Loopback is always admitted: a process on this machine can already reach the
 * DSH listener itself, so refusing it buys nothing and would let a `list` rule
 * lock the operator out of the very panel used to fix that rule.
 *
 * @param {string|undefined} address - `socket.remoteAddress`
 * @param {string} mode - `lan` | `any` | `list`
 * @param {Array<{family: 4|6, base: number|Uint8Array, bits: number}>} allow - parsed `list` entries
 */
export function isAllowed(address, mode, allow) {
  if (mode === 'any') return true
  const peer = classifyAddress(address)
  if (peer === undefined) return false
  if (isLoopbackAddress(peer)) return true
  if (mode === 'lan') return isLanAddress(peer)
  return allow.some((cidr) => {
    if (cidr.family !== peer.family) return false
    return cidr.family === 4 ? ipv4InRange(peer.value, cidr) : ipv6InRange(peer.value, cidr)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// config
// ─────────────────────────────────────────────────────────────────────────────

function dshHome() {
  const fromEnvironment = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnvironment === '' ? join(homedir(), '.dsh') : fromEnvironment
}

function integerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

/**
 * Merge the row config and the settings file over {@link DEFAULTS}.
 * @returns {{config: object, problems: string[]}}
 */
export function resolveConfig(rowConfig, fileConfig) {
  const config = { ...DEFAULTS, allow: [] }
  const problems = []
  for (const source of [rowConfig, fileConfig]) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
    if (typeof source.enabled === 'boolean') config.enabled = source.enabled
    if (typeof source.mode === 'string') {
      if (source.mode === 'lan' || source.mode === 'any' || source.mode === 'list') config.mode = source.mode
      else problems.push(`unknown mode ${JSON.stringify(source.mode)}; keeping ${config.mode}`)
    }
    if (Array.isArray(source.allow)) {
      config.allow = source.allow.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry !== '')
    }
    if (typeof source.listenHost === 'string' && source.listenHost.trim() !== '') config.listenHost = source.listenHost.trim()
    if (source.port === null) config.port = null
    else {
      const port = integerIn(source.port, 1, 65535)
      if (port !== undefined) config.port = port
      else if (source.port !== undefined) problems.push(`port ${JSON.stringify(source.port)} is not 1..65535; ignored`)
    }
    const offset = integerIn(source.portOffset, 0, 1000)
    if (offset !== undefined) config.portOffset = offset
    const scan = integerIn(source.maxPortScan, 1, 1000)
    if (scan !== undefined) config.maxPortScan = scan
    if (typeof source.verbose === 'boolean') config.verbose = source.verbose
    if (typeof source.logRejected === 'boolean') config.logRejected = source.logRejected
  }
  const parsedAllow = []
  for (const entry of config.allow) {
    const cidr = parseCidr(entry)
    if (cidr === undefined) problems.push(`allow entry ${JSON.stringify(entry)} is not an IP or CIDR; ignored`)
    else parsedAllow.push(cidr)
  }
  config.parsedAllow = parsedAllow
  if (config.mode === 'list' && config.allow.length > 0 && parsedAllow.length === 0) {
    problems.push('every allow entry was invalid; list mode now admits loopback only')
  }
  return { config, problems }
}

/** The user-editable subset, for persistence and the panel payload. */
export function editableConfig(config) {
  return {
    enabled: config.enabled,
    mode: config.mode,
    allow: config.allow,
    listenHost: config.listenHost,
    port: config.port,
    portOffset: config.portOffset,
    maxPortScan: config.maxPortScan,
    verbose: config.verbose,
    logRejected: config.logRejected,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// browser-session replay
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the DSH session cookie out of an exchange response's Set-Cookie list. */
export function cookieFromSetCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (typeof setCookie === 'string' ? [setCookie] : [])
  for (const raw of list) {
    const pair = raw.split(';', 1)[0] ?? ''
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    const cookieName = pair.slice(0, equals).trim()
    if (!cookieName.startsWith('dsh-auth-')) continue
    const maxAge = /;\s*max-age=(\d+)/iu.exec(raw)
    const expires = /;\s*expires=([^;]+)/iu.exec(raw)
    let expiresAt = Number.POSITIVE_INFINITY
    if (maxAge !== null) expiresAt = Date.now() + Number(maxAge[1]) * 1000
    else if (expires !== null) {
      const at = Date.parse(expires[1])
      if (Number.isFinite(at)) expiresAt = at
    }
    return { name: cookieName, value: pair.slice(equals + 1).trim(), expiresAt }
  }
  return undefined
}

/**
 * Holds the launch-token → session-cookie exchange for this process.
 *
 * The cookie is signed by DSH's own persistent browser-session secret, so it
 * survives a DSH restart; the launch token does not. A rejected cookie (401)
 * triggers one re-exchange, so a rotated secret heals without a user action.
 */
class Sessions {
  constructor({ getToken, request, log }) {
    this.getToken = getToken
    this.request = request
    this.log = log
    this.current = undefined
    this.pending = undefined
    this.exchanges = 0
    this.lastError = undefined
  }

  invalidate() {
    this.current = undefined
  }

  async ensure() {
    if (this.current !== undefined && this.current.expiresAt - Date.now() > 60_000) return this.current
    if (this.pending === undefined) {
      this.pending = this.exchange().finally(() => { this.pending = undefined })
    }
    return this.pending
  }

  exchange() {
    return new Promise((resolve, reject) => {
      let token
      try {
        token = this.getToken()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (typeof token !== 'string' || token === '') {
        reject(new Error('the launch token is unavailable; is the DSH Connection service active?'))
        return
      }
      const path = `/?token=${encodeURIComponent(token)}`
      const request = this.request({
        method: 'GET',
        path,
        headers: { accept: 'text/html' },
        agent: false,
      }, (response) => {
        const cookie = cookieFromSetCookie(response.headers['set-cookie'])
        response.resume()
        response.on('end', () => {
          if (cookie === undefined) {
            reject(new Error(`launch-token exchange returned ${String(response.statusCode)} without a session cookie`))
            return
          }
          this.exchanges += 1
          this.current = cookie
          this.lastError = undefined
          resolve(cookie)
        })
        response.on('error', reject)
      })
      request.setTimeout(15_000, () => request.destroy(new Error('launch-token exchange timed out')))
      request.on('error', (error) => {
        this.lastError = error.message
        reject(error)
      })
      request.end()
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gateway
// ─────────────────────────────────────────────────────────────────────────────

function authorityOf(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

function targetPath(url) {
  if (typeof url !== 'string' || url === '') return '/'
  if (url === '*') return '/'
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url)
      return `${parsed.pathname}${parsed.search}`
    } catch {
      return '/'
    }
  }
  return url
}

/** Build the upstream request headers for one client request. */
export function forwardHeaders(incoming, { authority, origin, cookie }) {
  const headers = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key) || SPOOFABLE.has(key) || key === 'host') continue
    headers[key] = value
  }
  headers.host = authority
  if (typeof headers.origin === 'string' && headers.origin !== '') headers.origin = origin
  const kept = (typeof incoming.cookie === 'string' ? incoming.cookie : '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (part === '') return false
      const equals = part.indexOf('=')
      return equals <= 0 || part.slice(0, equals) !== cookie.name
    })
  headers.cookie = [...kept, `${cookie.name}=${cookie.value}`].join('; ')
  return headers
}

function filterResponseHeaders(headers, request, upstream) {
  const filtered = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key)) continue
    filtered[key] = value
  }
  // An absolute redirect pointing at the loopback upstream is mapped back to
  // the authority this client actually used.
  const clientHost = typeof request.headers.host === 'string' ? request.headers.host : undefined
  if (clientHost !== undefined && typeof filtered.location === 'string') {
    const prefix = `${upstream.protocol}//${upstream.authority}`
    if (filtered.location.startsWith(prefix)) filtered.location = `${upstream.protocol}//${clientHost}${filtered.location.slice(prefix.length)}`
  }
  return filtered
}

class Gateway {
  constructor(options) {
    this.upstream = options.upstream
    this.request = options.request
    this.agent = options.agent
    this.sessions = options.sessions
    this.config = options.config
    this.log = options.log
    this.displayHost = options.displayHost
    this.stats = { requests: 0, rejected: 0, upgrades: 0, activeUpgrades: 0, errors: 0 }
    this.lastError = undefined
    this.bound = undefined
    this.listening = false
    this.startedAt = Date.now()
    this.rejectLogAt = 0
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server.requestTimeout = 0
    this.server.headersTimeout = 60_000
    this.server.keepAliveTimeout = 60_000
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    this.server.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
    })
    this.server.on('clientError', (_error, socket) => {
      try { socket.destroy() } catch { /* already gone */ }
    })
  }

  /** The port actually bound, or `undefined` when the listener is down. */
  get port() {
    return this.bound?.port
  }

  /** One reachable URL, for logs and the panel. */
  get url() {
    if (this.bound === undefined) return undefined
    const host = this.bound.address === '0.0.0.0' || this.bound.address === '::'
      ? (this.displayHost ?? '127.0.0.1')
      : this.bound.address
    return `http://${authorityOf(host, this.bound.port)}/`
  }

  allowed(request) {
    return isAllowed(request.socket?.remoteAddress, this.config.mode, this.config.parsedAllow ?? [])
  }

  deny(response, address) {
    this.stats.rejected += 1
    if (this.config.logRejected === true && Date.now() - this.rejectLogAt > 1000) {
      this.rejectLogAt = Date.now()
      this.log(`rejected ${String(address)} (mode=${this.config.mode})`)
    }
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('forbidden: this address is not allowed to use the DSH LAN gateway\n')
  }

  async handle(request, response) {
    try {
      this.stats.requests += 1
      if (!this.allowed(request)) {
        this.deny(response, request.socket?.remoteAddress)
        return
      }
      await this.forward(request, response)
    } catch (error) {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(`forwarding failed: ${this.lastError}`)
      try {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          response.end(`DSH LAN gateway could not reach the DSH webserver: ${this.lastError}\n`)
        } else {
          response.destroy()
        }
      } catch { /* the client is already gone */ }
    }
  }

  async forward(request, response) {
    let cookie = await this.sessions.ensure()
    const retryable = request.method === 'GET' || request.method === 'HEAD'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.pipeUpstream(request, response, cookie, attempt === 0 && retryable)
      if (outcome !== 'retry') return
      cookie = await this.sessions.ensure()
    }
  }

  /** One upstream round trip. Resolves `'retry'` when DSH rejected the cookie. */
  pipeUpstream(request, response, cookie, allowRetry) {
    return new Promise((resolve, reject) => {
      const headers = forwardHeaders(request.headers, {
        authority: this.upstream.authority,
        origin: `${this.upstream.protocol}//${this.upstream.authority}`,
        cookie,
      })
      const upstream = this.request({
        method: request.method,
        path: targetPath(request.url),
        headers,
        agent: this.agent,
      }, (reply) => {
        if (allowRetry && reply.statusCode === 401) {
          reply.resume()
          this.sessions.invalidate()
          reply.on('end', () => resolve('retry'))
          reply.on('error', reject)
          return
        }
        const status = reply.statusCode ?? 502
        response.writeHead(status, filterResponseHeaders(reply.headers, request, this.upstream))
        reply.pipe(response)
        response.on('close', () => {
          if (!response.writableFinished) reply.destroy()
        })
        reply.on('end', () => {
          if (this.config.verbose === true) this.log(`${String(status)} ${request.method ?? 'GET'} ${targetPath(request.url)}`)
          resolve('done')
        })
        reply.on('error', reject)
      })
      upstream.setTimeout(0)
      upstream.on('error', reject)
      request.on('aborted', () => { upstream.destroy() })
      request.pipe(upstream)
    })
  }

  /** Never rejects: a failed upgrade handler must not become an unhandled rejection. */
  async handleUpgrade(request, socket, head) {
    try {
      await this.upgrade(request, socket, head)
    } catch (error) {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      try { socket.destroy() } catch { /* peer already gone */ }
    }
  }

  async upgrade(request, socket, head) {
    socket.on('error', () => {})
    if (!this.allowed(request)) {
      this.stats.rejected += 1
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      } catch { /* peer already gone */ }
      socket.destroy()
      return
    }
    let cookie
    try {
      cookie = await this.sessions.ensure()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      socket.destroy()
      return
    }
    const headers = forwardHeaders(request.headers, {
      authority: this.upstream.authority,
      origin: `${this.upstream.protocol}//${this.upstream.authority}`,
      cookie,
    })
    headers.connection = 'Upgrade'
    headers.upgrade = typeof request.headers.upgrade === 'string' ? request.headers.upgrade : 'websocket'
    const upstream = this.request({
      method: request.method,
      path: targetPath(request.url),
      headers,
      agent: false,
    })
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      try { upstream.destroy() } catch { /* already gone */ }
      try { socket.destroy() } catch { /* already gone */ }
    }
    socket.on('close', abort)
    upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
      settled = true
      this.stats.upgrades += 1
      this.stats.activeUpgrades += 1
      let raw = `HTTP/1.1 ${String(reply.statusCode)} ${reply.statusMessage ?? 'Switching Protocols'}\r\n`
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        raw += `${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}\r\n`
      }
      raw += '\r\n'
      socket.write(raw)
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
      if (head !== undefined && head.length > 0) socket.unshift(head)
      upstreamSocket.on('error', () => socket.destroy())
      upstreamSocket.on('close', () => {
        this.stats.activeUpgrades = Math.max(0, this.stats.activeUpgrades - 1)
        socket.destroy()
      })
      socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on('response', (reply) => {
      if (settled) return
      settled = true
      this.stats.errors += 1
      try {
        socket.write(`HTTP/1.1 ${String(reply.statusCode)} ${reply.statusMessage ?? 'Error'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
      } catch { /* peer already gone */ }
      reply.resume()
      socket.destroy()
    })
    upstream.on('error', abort)
    upstream.end()
  }

  /** Bind `host:port`, scanning upward while the port is busy. */
  async listen(host, basePort, maxScan) {
    if (basePort === this.upstream.port && host === this.upstream.host) {
      throw new Error('the gateway port would equal the DSH webserver port')
    }
    let lastError
    for (let attempt = 0; attempt < maxScan; attempt += 1) {
      const port = basePort + attempt
      if (port > 65535) break
      try {
        const address = await new Promise((resolve, reject) => {
          const onError = (error) => { this.server.off('listening', onListening); reject(error) }
          const onListening = () => { this.server.off('error', onError); resolve(this.server.address()) }
          this.server.once('error', onError)
          this.server.once('listening', onListening)
          this.server.listen(port, host)
        })
        this.bound = { address: address.address, port: address.port }
        this.listening = true
        this.lastError = undefined
        return this.bound
      } catch (error) {
        lastError = error
        if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') continue
        throw error
      }
    }
    throw new Error(`no free port in ${String(basePort)}..${String(basePort + maxScan - 1)}${lastError === undefined ? '' : ` (last: ${String(lastError.code ?? lastError.message)})`}`)
  }

  async close() {
    this.listening = false
    if (!this.server.listening) {
      this.bound = undefined
      return
    }
    await new Promise((resolve) => {
      this.server.close(() => resolve())
      // Remote pages reconnect on their own (Connection retries), so a rebind
      // may cut live sockets instead of waiting for them.
      try { this.server.closeAllConnections() } catch { /* older runtime */ }
    })
    this.bound = undefined
  }

  status() {
    return {
      listening: this.listening,
      listenHost: this.config.listenHost,
      port: this.port,
      url: this.url,
      mode: this.config.mode,
      allow: this.config.allow,
      requests: this.stats.requests,
      rejected: this.stats.rejected,
      upgrades: this.stats.upgrades,
      activeUpgrades: this.stats.activeUpgrades,
      errors: this.stats.errors,
      lastError: this.lastError ?? this.sessions.lastError,
      exchanges: this.sessions.exchanges,
      startedAt: this.startedAt,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// plugin
// ─────────────────────────────────────────────────────────────────────────────

function localAddresses() {
  const found = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${String(entry.family)}`
      if (family === 'IPv4' && entry.internal !== true) found.push(entry.address)
    }
  }
  return found
}

/**
 * Mount the gateway. **Never throws and never rejects**: every failure is
 * logged and surfaced in the panel, because a side listener must not be able to
 * take the host profile down. The whole body runs inside one try/catch.
 */
export async function apply(ctx, rowConfig) {
  try {
    await mount(ctx, rowConfig)
  } catch (error) {
    console.log(`[lan-gateway] mount failed, staying inert: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

/**
 * Per-root instance table: the same DSH process keeps one gateway even when a
 * live reload mounts the new row before the old fiber is gone. Keyed by
 * `ctx.root`, so nothing is added to the global namespace; a plain object is
 * the fallback key if a host ever exposes no root context.
 */
const OWNERS = new WeakMap()
const FALLBACK_OWNER = {}

async function mount(ctx, rowConfig) {
  const ownerKey = typeof ctx?.root === 'object' && ctx.root !== null ? ctx.root : FALLBACK_OWNER
  const previous = OWNERS.get(ownerKey)
  if (previous !== undefined) {
    try {
      await previous()
    } catch { /* the previous instance is already gone */ }
  }
  const log = (message) => console.log(`[lan-gateway] ${message}`)
  const configPath = join(dshHome(), CONFIG_FILENAME)
  const upstreamHost = ctx.webServer.host
  const upstreamPort = ctx.webServer.port
  const upstreamProtocol = ctx.webServer.protocol ?? 'http:'
  if (typeof upstreamPort !== 'number' || upstreamPort <= 0) {
    log('the DSH webserver has no port yet; gateway not started')
    return
  }
  const upstream = {
    protocol: upstreamProtocol,
    host: upstreamHost,
    port: upstreamPort,
    authority: authorityOf(upstreamHost, upstreamPort),
  }
  const transport = upstreamProtocol === 'https:' ? https : http
  const tlsOptions = upstreamProtocol === 'https:'
    ? { rejectUnauthorized: false, servername: isIP(upstreamHost) === 0 ? upstreamHost : undefined }
    : {}
  const request = (options, callback) => transport.request({
    ...tlsOptions,
    host: upstream.host,
    port: upstream.port,
    ...options,
  }, callback)
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 128 })

  const readFileConfig = () => {
    if (!existsSync(configPath)) return { value: undefined, problems: [] }
    try {
      return { value: JSON.parse(readFileSync(configPath, 'utf8')), problems: [] }
    } catch (error) {
      return { value: undefined, problems: [`${configPath}: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }

  const initialFile = readFileConfig()
  const initial = resolveConfig(rowConfig, initialFile.value)
  initial.problems = [...initial.problems, ...initialFile.problems]
  const state = {
    config: initial.config,
    problems: initial.problems,
    gateway: undefined,
    fileSignature: JSON.stringify(initialFile.value ?? null),
  }
  for (const problem of initial.problems) log(problem)

  const displayHost = localAddresses()[0] ?? '127.0.0.1'
  const sessions = new Sessions({
    getToken: () => {
      const url = new URL(ctx.connection.authenticatedUrl(`${upstreamProtocol}//${upstream.authority}/`))
      return url.searchParams.get('token') ?? undefined
    },
    request,
    log,
  })

  const view = () => {
    const port = state.gateway?.port ?? state.config.port ?? (upstreamPort + state.config.portOffset)
    return {
      ok: true,
      version: VERSION,
      config: editableConfig(state.config),
      upstream: { protocol: upstreamProtocol, host: upstreamHost, port: upstreamPort, authority: upstream.authority },
      configPath,
      configFile: existsSync(configPath),
      problems: state.problems,
      status: state.gateway?.status() ?? { listening: false },
      addresses: localAddresses().map((address) => `http://${authorityOf(address, port)}/`),
    }
  }

  const stopGateway = async () => {
    const gateway = state.gateway
    state.gateway = undefined
    if (gateway !== undefined) await gateway.close()
  }

  const startGateway = async () => {
    try {
      const config = state.config
      if (config.enabled !== true) return
      const basePort = config.port ?? upstreamPort + config.portOffset
      const gateway = new Gateway({
        upstream,
        request,
        agent,
        sessions,
        config,
        log,
        displayHost,
      })
      try {
        const bound = await gateway.listen(config.listenHost, basePort, config.maxPortScan)
        state.gateway = gateway
        const shown = bound.address === '0.0.0.0' || bound.address === '::'
          ? (localAddresses()[0] ?? '127.0.0.1')
          : bound.address
        log(`listening on http://${authorityOf(shown, bound.port)}/ -> ${upstreamProtocol}//${upstream.authority} (mode=${config.mode}${config.mode === 'list' ? `, allow=${config.allow.join(',') || '(empty: loopback only)'}` : ''})`)
        if (config.mode === 'any') log('mode=any exposes this DSH to every address that can reach the port, with full owner access')
        state.problems = state.problems.filter((problem) => !problem.startsWith('listener:'))
      } catch (error) {
        state.problems = [...state.problems.filter((problem) => !problem.startsWith('listener:')), `listener: ${error instanceof Error ? error.message : String(error)}`]
        log(`could not start: ${error instanceof Error ? error.message : String(error)}`)
        await gateway.close().catch(() => {})
      }
    } catch (error) {
      log(`start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const applyConfig = async (next, problems) => {
    try {
      const previous = state.config
      state.config = next
      state.problems = problems
      const rebind = previous.enabled !== next.enabled
        || previous.listenHost !== next.listenHost
        || previous.port !== next.port
        || previous.portOffset !== next.portOffset
        || previous.maxPortScan !== next.maxPortScan
        || state.gateway === undefined
      if (rebind) {
        await stopGateway()
        await startGateway()
        return
      }
      state.gateway.config = next
    } catch (error) {
      log(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── panel API, inside Connection's authenticated /api fence ────────────────
  try {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/lan-gateway',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const json = (status, body) => new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
        try {
          return await handlePanelCall(request, json)
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'lan-gateway: panel route')
  } catch (error) {
    log(`could not register the panel route: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** The panel's read/write body, kept separate so one failure answers 500. */
  async function handlePanelCall(request, json) {
    if (request.method === 'GET') return json(200, view())
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { ok: false, error: 'body is not JSON' })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'body must be an object' })
    const candidate = { ...editableConfig(state.config), ...body }
    if (candidate.mode !== 'lan' && candidate.mode !== 'any' && candidate.mode !== 'list') {
      return json(400, { ok: false, error: 'mode must be lan, any or list' })
    }
    if (!Array.isArray(candidate.allow)) return json(400, { ok: false, error: 'allow must be an array of IPs or CIDRs' })
    for (const entry of candidate.allow) {
      if (typeof entry !== 'string' || parseCidr(entry) === undefined) {
        return json(400, { ok: false, error: `not an IP or CIDR: ${JSON.stringify(entry)}` })
      }
    }
    if (typeof candidate.listenHost !== 'string' || isIP(candidate.listenHost) === 0) {
      return json(400, { ok: false, error: `listenHost must be an IP literal, got ${JSON.stringify(candidate.listenHost)}` })
    }
    if (candidate.port !== null && integerIn(candidate.port, 1, 65535) === undefined) {
      return json(400, { ok: false, error: 'port must be null or 1..65535' })
    }
    const resolved = resolveConfig(candidate, undefined)
    const persisted = editableConfig(resolved.config)
    // Record the signature before writing, so the watcher never mistakes
    // this panel write for an external edit and rebinds mid-response.
    state.fileSignature = JSON.stringify(persisted)
    try {
      writeFileSync(`${configPath}.tmp`, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
      renameSync(`${configPath}.tmp`, configPath)
    } catch (error) {
      return json(500, { ok: false, error: `could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}` })
    }
    // A rebind closes every socket this listener owns — including the one
    // carrying this very response. Answer first, rebind a beat later, and
    // tell the caller which URL to reload.
    const previous = state.config
    const rebind = previous.enabled !== resolved.config.enabled
      || previous.listenHost !== resolved.config.listenHost
      || previous.port !== resolved.config.port
      || previous.portOffset !== resolved.config.portOffset
      || previous.maxPortScan !== resolved.config.maxPortScan
      || state.gateway === undefined
    if (!rebind) {
      await applyConfig(resolved.config, resolved.problems)
      return json(200, view())
    }
    const expectedPort = resolved.config.port ?? (upstreamPort + resolved.config.portOffset)
    setTimeout(() => { void applyConfig(resolved.config, resolved.problems) }, 350)
    return json(200, {
      ...view(),
      config: editableConfig(resolved.config),
      pending: true,
      expected: localAddresses().map((address) => `http://${authorityOf(address, expectedPort)}/`),
    })
  }

  // ── start + watch the settings file ────────────────────────────────────────
  startGateway().catch((error) => log(`start failed: ${error instanceof Error ? error.message : String(error)}`))
  try {
    watchFile(configPath, { interval: 1000 }, (current) => {
      try {
        if (!current.isFile()) return
        const fromFile = readFileConfig()
        const signature = JSON.stringify(fromFile.value ?? null)
        if (signature === state.fileSignature) return
        state.fileSignature = signature
        const resolved = resolveConfig(rowConfig, fromFile.value)
        resolved.problems = [...resolved.problems, ...fromFile.problems]
        applyConfig(resolved.config, resolved.problems).catch(() => {})
      } catch (error) {
        log(`settings watcher failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    log(`could not watch ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const dispose = async () => {
    unwatchFile(configPath)
    try { agent.destroy() } catch { /* already destroyed */ }
    await stopGateway()
  }
  OWNERS.set(ownerKey, dispose)
  ctx.effect(() => () => {
    if (OWNERS.get(ownerKey) === dispose) OWNERS.delete(ownerKey)
    return dispose()
  }, 'lan-gateway: listener')
}

/** Pure helpers for the unit tests; the plugin itself never reads this. */
export const __test__ = {
  DEFAULTS,
  resolveConfig,
  editableConfig,
  parseIPv4,
  parseIPv6,
  parseCidr,
  classifyAddress,
  isLanAddress,
  isLoopbackAddress,
  isAllowed,
  cookieFromSetCookie,
  forwardHeaders,
  targetPath,
  authorityOf,
}
