// Render smoke test for the panel component using a minimal fake React: it
// catches broken property access in the render path without a browser.
import assert from 'node:assert/strict'

let captured
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } }, setTimeout: () => {} }
globalThis.document = undefined

await import('../client.js')

const stateQueue = []
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const next = stateQueue.length > 0 ? stateQueue.shift() : initial
    return [next, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const exports_ = captured.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})

let Component
exports_.apply({
  slots: {
    inject: (_slot, callback) => callback(),
    register: (_options, component) => { Component = component },
  },
})

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node === 'object') {
    for (const child of node.children ?? []) texts(child, out)
  }
  return out
}

// 1) loading state
stateQueue.push(null, null, null, null, false)
const loading = Component()
assert.ok(texts(loading).includes('局域网网关'))
assert.ok(texts(loading).some((text) => text.includes('读取中')))

// 2) loaded state with a live status
const payload = {
  ok: true,
  version: '1.0.0',
  config: { enabled: true, mode: 'list', allow: ['192.168.1.0/24'], listenHost: '0.0.0.0', port: null, portOffset: 1, maxPortScan: 50, verbose: false, logRejected: true },
  upstream: { protocol: 'http:', host: '127.0.0.1', port: 3080, authority: '127.0.0.1:3080' },
  configPath: 'C:/Users/x/.dsh/lan-gateway.json',
  configFile: true,
  problems: [],
  status: { listening: true, port: 3081, mode: 'list', requests: 3, rejected: 1, upgrades: 0, activeUpgrades: 0, lastError: null },
  addresses: ['http://192.168.1.18:3081/'],
}
const draft = {
  enabled: true, mode: 'list', allow: ['192.168.1.0/24'], listenHost: '0.0.0.0', port: null,
  portOffset: 1, maxPortScan: 50, verbose: false, logRejected: true, allowText: '192.168.1.0/24',
}
stateQueue.push(payload, draft, null, null, false)
const loaded = Component()
const loadedText = texts(loaded).join('\n')
assert.ok(loadedText.includes('正在转发'))
assert.ok(loadedText.includes('127.0.0.1:3080'))
assert.ok(loadedText.includes('http://192.168.1.18:3081/'))
assert.ok(loadedText.includes('指定 IP / 网段'))
assert.ok(loadedText.includes('它做了什么'))

// 3) stop state with an error surfaces
stateQueue.push(
  { ...payload, status: { ...payload.status, listening: false, lastError: 'EADDRINUSE' }, problems: ['listener: boom'] },
  draft, null, null, false,
)
const stopped = Component()
const stoppedText = texts(stopped).join('\n')
assert.ok(stoppedText.includes('未在监听'))
assert.ok(stoppedText.includes('EADDRINUSE'))
assert.ok(stoppedText.includes('listener: boom'))

// 4) error state
stateQueue.push(null, null, '接口挂了', null, false)
const failed = Component()
assert.ok(texts(failed).join('\n').includes('接口挂了'))

console.log('ok panel render paths')
