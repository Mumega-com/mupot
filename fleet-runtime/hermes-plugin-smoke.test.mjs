import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PLUGIN_FILES, evaluatePluginSmoke, prepareHermesSmokeHome } from './hermes-plugin-smoke.mjs'

function pluginData() {
  const data = Object.fromEntries(PLUGIN_FILES.map((name) => [name, `content for ${name}`]))
  data['plugin.yaml'] = 'name: mupot\nversion: "0.3.0"\n'
  data['__init__.py'] = 'mode = os.environ.get("MUPOT_PLUGIN_MODE")\n'
  data['operator.py'] = 'TOOLSET = "mupot-operator"\n'
  return data
}

test('accepts exact enabled Mupot 0.3 plugin discovery and operator contract', () => {
  const receipt = evaluatePluginSmoke({
    data: pluginData(), stdout: 'enabled      user     0.3.0    mupot\n', exitCode: 0,
  })
  assert.equal(receipt.status, 'pass')
  assert.match(receipt.plugin_bundle_sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(receipt.plugin, { name: 'mupot', version: '0.3.0', enabled: true, toolset: 'mupot-operator' })
  assert.deepEqual(receipt.failure_codes, [])
})

test('fails closed on disabled discovery, extra files, or missing toolset contract', () => {
  const disabled = evaluatePluginSmoke({ data: pluginData(), stdout: 'not enabled user 0.3.0 mupot', exitCode: 0 })
  assert.equal(disabled.status, 'fail')
  assert.ok(disabled.failure_codes.includes('plugin_not_enabled'))
  const extra = pluginData()
  extra['unexpected.py'] = 'x'
  assert.equal(evaluatePluginSmoke({ data: extra, stdout: 'enabled user 0.3.0 mupot', exitCode: 0 }).status, 'fail')
  const missing = pluginData()
  missing['operator.py'] = ''
  assert.equal(evaluatePluginSmoke({ data: missing, stdout: 'enabled user 0.3.0 mupot', exitCode: 0 }).status, 'fail')
})

test('prepares only a fresh fixed-path smoke config with Mupot explicitly enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'mupot-smoke-home-'))
  const home = join(root, 'home', 'mupot')
  mkdirSync(home, { recursive: true })
  assert.throws(() => prepareHermesSmokeHome(home), /invalid smoke home/)
  prepareHermesSmokeHome(home, home)
  const configPath = join(home, 'config.yaml')
  assert.equal(readFileSync(configPath, 'utf8'), 'plugins:\n  enabled:\n    - mupot\n  disabled: []\n')
  assert.equal(statSync(configPath).mode & 0o777, 0o600)
  assert.throws(() => prepareHermesSmokeHome(home, home), /EEXIST/)
})
