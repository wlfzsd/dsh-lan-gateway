// Shape test: load the browser bundle the way the shell does and check that it
// registers exactly one Plugins-settings tab. No DOM, no React renderer.
import assert from 'node:assert/strict'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec },
  },
}
globalThis.document = undefined

await import('../client.js')

assert.ok(captured, 'the bundle registers itself with the module loader')
assert.equal(captured.id, 'dsh-lan-gateway')
assert.equal(typeof captured.factory, 'function')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const exports_ = captured.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require(${JSON.stringify(specifier)}) — the platform seed table only publishes react`)
})

assert.equal(typeof exports_.apply, 'function')
assert.deepEqual(exports_.inject, ['slots'])

const registrations = []
const ctx = {
  slots: {
    inject: (slot, callback) => { assert.equal(slot, 'settings.plugins.tab'); callback() },
    register: (options, component) => { registrations.push({ options, component }) },
  },
}
exports_.apply(ctx)

assert.equal(registrations.length, 1)
const [registration] = registrations
assert.equal(registration.options.name, 'settings.plugins.tab')
assert.equal(registration.options.id, 'lan-gateway')
assert.equal(registration.options.order, 30)
assert.equal(registration.options.label(), '局域网网关')
assert.equal(typeof registration.component, 'function')
assert.equal(typeof registration.options.inject, 'function')

console.log('ok client bundle shape')
