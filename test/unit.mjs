// Unit tests for the pure parts of dsh-lan-gateway (no DSH, no network).
import assert from 'node:assert/strict'
import { __test__ } from '../index.js'

const {
  parseIPv4, parseIPv6, parseCidr, classifyAddress, isLanAddress, isLoopbackAddress, isAllowed,
  cookieFromSetCookie, forwardHeaders, targetPath, authorityOf,
  resolveConfig, editableConfig, DEFAULTS,
} = __test__

let passed = 0
const failures = []
function check(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// ── IPv4 ────────────────────────────────────────────────────────────────────
check('ipv4 basic', () => assert.equal(parseIPv4('192.168.1.5'), 0xc0a80105))
check('ipv4 zero', () => assert.equal(parseIPv4('0.0.0.0'), 0))
check('ipv4 max', () => assert.equal(parseIPv4('255.255.255.255'), 0xffffffff))
check('ipv4 out of range', () => assert.equal(parseIPv4('256.1.1.1'), undefined))
check('ipv4 short', () => assert.equal(parseIPv4('1.2.3'), undefined))
check('ipv4 spaces', () => assert.equal(parseIPv4(' 10.0.0.1 '), 0x0a000001))
check('ipv4 not a string', () => assert.equal(parseIPv4(123), undefined))

// ── IPv6 ────────────────────────────────────────────────────────────────────
const bytesOf = (text) => Array.from(parseIPv6(text) ?? [])
check('ipv6 loopback', () => assert.deepEqual(bytesOf('::1'), [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]))
check('ipv6 full', () => assert.deepEqual(bytesOf('1:2:3:4:5:6:7:8'), [0,1,0,2,0,3,0,4,0,5,0,6,0,7,0,8]))
check('ipv6 compressed head', () => assert.deepEqual(bytesOf('::2:3'), [0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,3]))
check('ipv6 compressed tail', () => assert.deepEqual(bytesOf('2:3::'), [0,2,0,3,0,0,0,0,0,0,0,0,0,0,0,0]))
check('ipv6 mapped', () => assert.deepEqual(bytesOf('::ffff:192.168.1.5'), [0,0,0,0,0,0,0,0,0,0,255,255,192,168,1,5]))
check('ipv6 zone stripped', () => assert.deepEqual(bytesOf('fe80::1%eth0'), bytesOf('fe80::1')))
check('ipv6 double :: rejected', () => assert.equal(parseIPv6('1::2::3'), undefined))
check('ipv6 too many groups', () => assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), undefined))
check('ipv6 bad group', () => assert.equal(parseIPv6('gggg::1'), undefined))
check('ipv6 empty', () => assert.equal(parseIPv6(''), undefined))

// ── CIDR ────────────────────────────────────────────────────────────────────
check('cidr v4 /8', () => assert.deepEqual(parseCidr('10.0.0.0/8'), { family: 4, base: 0x0a000000, bits: 8 }))
check('cidr v4 exact', () => assert.deepEqual(parseCidr('1.2.3.4'), { family: 4, base: 0x01020304, bits: 32 }))
check('cidr v4 /0', () => assert.deepEqual(parseCidr('0.0.0.0/0'), { family: 4, base: 0, bits: 0 }))
check('cidr v4 prefix too big', () => assert.equal(parseCidr('10.0.0.0/33'), undefined))
check('cidr v6', () => assert.equal(parseCidr('fc00::/7')?.bits, 7))
check('cidr v6 too big', () => assert.equal(parseCidr('fc00::/129'), undefined))
check('cidr garbage', () => assert.equal(parseCidr('lan'), undefined))

// ── classify / lan ──────────────────────────────────────────────────────────
check('classify v4', () => assert.deepEqual(classifyAddress('192.168.1.5'), { family: 4, value: 0xc0a80105 }))
check('classify mapped', () => assert.deepEqual(classifyAddress('::ffff:192.168.1.5'), { family: 4, value: 0xc0a80105 }))
check('classify v6', () => assert.equal(classifyAddress('::1')?.family, 6))
check('classify unknown', () => assert.equal(classifyAddress('not-an-ip'), undefined))
check('classify undefined', () => assert.equal(classifyAddress(undefined), undefined))

const lanYes = ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.254',
  '169.254.10.10', '100.64.0.1', '100.127.255.255', '127.0.0.1', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
  '::ffff:10.1.2.3']
const lanNo = ['172.15.255.255', '172.32.0.1', '192.169.0.1', '11.0.0.1', '8.8.8.8', '100.128.0.1', '2001:4860::1']
for (const address of lanYes) check(`lan yes ${address}`, () => assert.equal(isLanAddress(classifyAddress(address)), true))
for (const address of lanNo) check(`lan no ${address}`, () => assert.equal(isLanAddress(classifyAddress(address)), false))

// ── isAllowed ───────────────────────────────────────────────────────────────
const allowList = ['192.168.1.0/24', '10.9.9.9', 'fd00::/8'].map(parseCidr)
check('mode any allows public', () => assert.equal(isAllowed('8.8.8.8', 'any', []), true))
check('mode any allows garbage', () => assert.equal(isAllowed('garbage', 'any', []), true))
check('mode lan allows private', () => assert.equal(isAllowed('192.168.1.9', 'lan', []), true))
check('mode lan denies public', () => assert.equal(isAllowed('8.8.8.8', 'lan', []), false))
check('mode lan denies unknown', () => assert.equal(isAllowed(undefined, 'lan', []), false))
check('mode list allows cidr', () => assert.equal(isAllowed('192.168.1.77', 'list', allowList), true))
check('mode list allows exact', () => assert.equal(isAllowed('10.9.9.9', 'list', allowList), true))
check('mode list allows v6', () => assert.equal(isAllowed('fd00::5', 'list', allowList), true))
check('mode list denies outside', () => assert.equal(isAllowed('192.168.2.77', 'list', allowList), false))
check('mode list denies public', () => assert.equal(isAllowed('8.8.8.8', 'list', allowList), false))
check('mode list empty denies', () => assert.equal(isAllowed('192.168.1.1', 'list', []), false))
check('loopback classified', () => {
  assert.equal(isLoopbackAddress(classifyAddress('127.0.0.1')), true)
  assert.equal(isLoopbackAddress(classifyAddress('::1')), true)
  assert.equal(isLoopbackAddress(classifyAddress('::ffff:127.0.0.1')), true)
  assert.equal(isLoopbackAddress(classifyAddress('192.168.1.1')), false)
})
check('loopback always admitted', () => {
  assert.equal(isAllowed('127.0.0.1', 'list', []), true)
  assert.equal(isAllowed('::1', 'list', []), true)
})
check('mode list mapped ipv4', () => assert.equal(isAllowed('::ffff:192.168.1.20', 'list', allowList), true))

// ── cookie parsing ──────────────────────────────────────────────────────────
const setCookie = 'dsh-auth-abc123=v1.eyJ4Ijox.zzz; Max-Age=2592000; Path=/; Expires=Wed, 30 Nov 2026 00:00:00 GMT; HttpOnly; SameSite=Strict'
check('cookie name/value', () => {
  const parsed = cookieFromSetCookie([setCookie])
  assert.equal(parsed?.name, 'dsh-auth-abc123')
  assert.equal(parsed?.value, 'v1.eyJ4Ijox.zzz')
  assert.ok(parsed.expiresAt > Date.now())
})
check('cookie ignores other cookies', () => assert.equal(cookieFromSetCookie(['a=b; Path=/']), undefined))
check('cookie undefined input', () => assert.equal(cookieFromSetCookie(undefined), undefined))

// ── header rewriting ────────────────────────────────────────────────────────
const cookie = { name: 'dsh-auth-x', value: 'SIGNED' }
const incoming = {
  host: '192.168.1.9:3081',
  origin: 'http://192.168.1.9:3081',
  cookie: 'other=1; dsh-auth-x=stale',
  connection: 'keep-alive',
  'x-forwarded-for': '1.2.3.4',
  'accept-encoding': 'gzip',
  'content-length': '3',
  'transfer-encoding': 'chunked',
  'sec-fetch-site': 'same-origin',
}
const headers = forwardHeaders(incoming, { authority: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', cookie })
check('host rewritten', () => assert.equal(headers.host, '127.0.0.1:3080'))
check('origin rewritten', () => assert.equal(headers.origin, 'http://127.0.0.1:3080'))
check('cookie merged once', () => {
  assert.equal(headers.cookie, 'other=1; dsh-auth-x=SIGNED')
})
check('hop by hop dropped', () => {
  assert.equal(headers.connection, undefined)
  assert.equal(headers['transfer-encoding'], undefined)
})
check('spoof dropped', () => assert.equal(headers['x-forwarded-for'], undefined))
check('content length kept', () => assert.equal(headers['content-length'], '3'))
check('sec-fetch-site kept', () => assert.equal(headers['sec-fetch-site'], 'same-origin'))
check('no origin stays absent', () => {
  const plain = forwardHeaders({ host: 'x' }, { authority: '127.0.0.1:1', origin: 'http://127.0.0.1:1', cookie })
  assert.equal(plain.origin, undefined)
})

check('targetPath keep path+query', () => assert.equal(targetPath('/a/b?c=1'), '/a/b?c=1'))
check('targetPath absolute form', () => assert.equal(targetPath('http://x/y?z=2'), '/y?z=2'))
check('targetPath star', () => assert.equal(targetPath('*'), '/'))
check('targetPath empty', () => assert.equal(targetPath(undefined), '/'))

check('authority v4', () => assert.equal(authorityOf('127.0.0.1', 3080), '127.0.0.1:3080'))
check('authority v6', () => assert.equal(authorityOf('::1', 3080), '[::1]:3080'))

// ── config ──────────────────────────────────────────────────────────────────
check('defaults', () => {
  const { config } = resolveConfig(undefined, undefined)
  assert.deepEqual(editableConfig(config), editableConfig(DEFAULTS))
  assert.equal(config.mode, 'lan')
  assert.equal(config.portOffset, 1)
})
check('file overrides row', () => {
  const { config } = resolveConfig({ mode: 'lan' }, { mode: 'any', verbose: true })
  assert.equal(config.mode, 'any')
  assert.equal(config.verbose, true)
})
check('bad mode ignored', () => {
  const { config, problems } = resolveConfig({ mode: 'public' }, undefined)
  assert.equal(config.mode, 'lan')
  assert.equal(problems.length, 1)
})
check('bad port ignored', () => {
  const { config, problems } = resolveConfig({ port: 70000 }, undefined)
  assert.equal(config.port, null)
  assert.equal(problems.length, 1)
})
check('list mode parses allow', () => {
  const { config } = resolveConfig({ mode: 'list', allow: ['192.168.0.0/16', 'bogus', ' 10.0.0.1 '] }, undefined)
  assert.deepEqual(config.allow, ['192.168.0.0/16', 'bogus', '10.0.0.1'])
  assert.equal(config.parsedAllow.length, 2)
})
check('list mode all invalid warns', () => {
  const { problems } = resolveConfig({ mode: 'list', allow: ['bogus'] }, undefined)
  assert.ok(problems.some((problem) => problem.includes('loopback only')))
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${failures.length + passed}`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`ok ${passed} checks`)
}
