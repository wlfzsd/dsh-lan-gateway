#!/usr/bin/env node
/**
 * Preflight check for the dsh-lan-gateway package.
 *
 * Run it after touching any file in this directory and BEFORE restarting DSH:
 *
 *   node verify.mjs
 *
 * It checks the two contracts whose violation can hurt DSH itself:
 *   1. `dsh.client` in package.json requires `client.js` to exist and parse —
 *      a declared-but-missing client bundle fails the required client-modules
 *      row and DSH does not start at all.
 *   2. the bundle patch must describe a row that names this package.
 * Everything else (module imports, exports) is checked too, so a broken edit is
 * caught here instead of at boot.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []
const notes = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${label}`)
  } else {
    failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// 1. package.json
let pkg
try {
  pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  check('package.json parses', true)
} catch (error) {
  check('package.json parses', false, String(error.message))
}
if (pkg !== undefined) {
  check('package name', pkg.name === 'dsh-lan-gateway', String(pkg.name))
  check('type is module', pkg.type === 'module', String(pkg.type))
  check('main entry exists', typeof pkg.main === 'string' && existsSync(join(here, pkg.main)), String(pkg.main))
  check('dsh.bundle.patch declared', typeof pkg.dsh?.bundle?.patch === 'string')
  if (typeof pkg.dsh?.bundle?.patch === 'string') {
    check('bundle patch file exists', existsSync(join(here, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch)
  }
  const client = pkg.dsh?.client
  if (client === undefined) {
    notes.push('no dsh.client declaration: the settings panel will not load (host-only package)')
  } else {
    check('dsh.client platform is web', client.platform === 'web', String(client.platform))
    check('client export declared', typeof pkg.exports?.['./client'] === 'string', String(pkg.exports?.['./client']))
    const clientPath = typeof pkg.exports?.['./client'] === 'string' ? join(here, pkg.exports['./client']) : join(here, 'client.js')
    // The boot-critical pair: declared client + present bundle.
    check('client bundle EXISTS (declared client without it breaks DSH startup)', existsSync(clientPath), clientPath)
    if (existsSync(clientPath)) {
      try {
        new vm.Script(readFileSync(clientPath, 'utf8'), { filename: clientPath })
        check('client bundle parses', true)
      } catch (error) {
        check('client bundle parses', false, String(error.message))
      }
      const source = readFileSync(clientPath, 'utf8')
      check('client registers with the module loader', source.includes('__ModuleLoader__.load'))
      check('client module id', source.includes("id: 'dsh-lan-gateway'"))
    }
  }
}

// 2. bundle patch
try {
  const patch = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
  check('patch inserts the row', /- insert:/.test(patch) && /name:\s*dsh-lan-gateway/.test(patch) && /id:\s*lan-gateway/.test(patch))
} catch (error) {
  check('cordis.patch.yml readable', false, String(error.message))
}

// 3. host entry
try {
  const entry = typeof pkg?.main === 'string' ? join(here, pkg.main) : join(here, 'index.js')
  const source = readFileSync(entry, 'utf8')
  check('host exports apply', /export\s+(async\s+)?function\s+apply/.test(source))
  check('host exports inject', /export\s+const\s+inject\s*=/.test(source))
  check('host plugin name', /export\s+const\s+name\s*=\s*'lan-gateway'/.test(source))
  const imports = [...source.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1])
  const nonBuiltin = imports.filter((specifier) => !specifier.startsWith('node:'))
  check('host half imports only node: builtins', nonBuiltin.length === 0, nonBuiltin.join(', '))
  check('no runtime dependency needed', Object.keys(pkg?.dependencies ?? {}).length === 0, Object.keys(pkg?.dependencies ?? {}).join(', '))

  // Isolation invariants: this plugin must stay a read-only side listener. These
  // gates exist so a later edit cannot silently reintroduce host-wide coupling.
  const forbidden = [
    [/\bglobalThis\s*\./u, 'global namespace mutation (globalThis.*)'],
    [/process\s*\.\s*on\s*\(/u, 'process-level event handler'],
    [/process\s*\.\s*env\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)/u, 'environment variable mutation'],
    [/process\s*\.\s*exit\s*\(/u, 'process exit'],
    [/\b(?:unlinkSync|rmSync|rmdirSync|unlink|rmdir)\s*\(/u, 'deletion API (this plugin never deletes anything)'],
  ]
  for (const [pattern, label] of forbidden) {
    check(`host half does not use: ${label}`, pattern.test(source) === false)
  }
  const writes = source.split('\n').filter((line) => /\bwriteFileSync\s*\(/u.test(line))
  check('only one write target (the plugin settings file)', writes.length === 1 && writes[0].includes('configPath'), writes.join(' | '))
} catch (error) {
  check('host entry readable', false, String(error.message))
}

// 4. the test suites exist
for (const file of ['test/unit.mjs', 'test/client-shape.mjs', 'test/client-render.mjs']) {
  check(`${file} present`, existsSync(join(here, file)))
}

for (const note of notes) console.log(`NOTE  ${note}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed — do NOT restart DSH until they pass.`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed — safe to restart DSH.')
}
