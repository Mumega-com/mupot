#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HERMES_PLUGIN_SMOKE_TYPE = 'mupot.hermes-plugin-smoke/v1'
export const PLUGIN_FILES = Object.freeze([
  'README.md', '__init__.py', 'operator.py', 'plugin.yaml', 'schemas.py', 'tools.py',
])
const SMOKE_HOME = '/home/mupot'
const SMOKE_CONFIG = 'plugins:\n  enabled:\n    - mupot\n  disabled: []\n'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function pluginBundleHash(data) {
  return sha256(PLUGIN_FILES.map((name) => `${name}\0${sha256(data[name] ?? '')}\n`).join(''))
}

export function evaluatePluginSmoke({ data, stdout, exitCode }) {
  const exactFiles = Object.keys(data ?? {}).sort().join('\0') === [...PLUGIN_FILES].sort().join('\0')
  const manifest = data?.['plugin.yaml'] ?? ''
  const entrypoint = data?.['__init__.py'] ?? ''
  const operator = data?.['operator.py'] ?? ''
  const discovered = String(stdout ?? '').trim().split(/\r?\n/).some((line) =>
    /^enabled\s+user\s+0\.3\.0\s+mupot\s*$/.test(line))
  const contract = exactFiles && /name:\s*mupot\b/.test(manifest) && /version:\s*["']?0\.3\.0/.test(manifest) &&
    /MUPOT_PLUGIN_MODE/.test(entrypoint) && /["']mupot-operator["']/.test(operator)
  return {
    schema: HERMES_PLUGIN_SMOKE_TYPE,
    generated_at: new Date().toISOString(),
    status: exitCode === 0 && discovered && contract ? 'pass' : 'fail',
    plugin: { name: 'mupot', version: '0.3.0', enabled: discovered, toolset: contract ? 'mupot-operator' : null },
    plugin_bundle_sha256: exactFiles ? pluginBundleHash(data) : null,
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    failure_codes: [
      ...(exactFiles ? [] : ['plugin_files_invalid']),
      ...(contract ? [] : ['operator_contract_invalid']),
      ...(discovered ? [] : ['plugin_not_enabled']),
      ...(exitCode === 0 ? [] : ['plugin_list_failed']),
    ],
  }
}

export function prepareHermesSmokeHome(home = SMOKE_HOME, expectedHome = SMOKE_HOME) {
  if (home !== expectedHome || !lstatSync(home).isDirectory()) throw new Error('invalid smoke home')
  writeFileSync(join(home, 'config.yaml'), SMOKE_CONFIG, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

export function runPluginSmoke(options = {}) {
  const pluginDir = options.pluginDir ?? '/home/mupot/plugins/mupot'
  if (options.prepareHome !== false) prepareHermesSmokeHome(options.home ?? process.env.HOME)
  const data = {}
  for (const name of PLUGIN_FILES) {
    try {
      data[name] = readFileSync(join(pluginDir, name), 'utf8')
    } catch {
      // A missing or unreadable projected file fails the exact plugin-file check.
    }
  }
  const result = (options.spawnSyncImpl ?? spawnSync)('/usr/local/bin/hermes', [
    'plugins', 'list', '--plain', '--no-bundled',
  ], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  return evaluatePluginSmoke({ data, stdout: result.stdout, exitCode: result.status })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const receipt = runPluginSmoke()
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    if (receipt.status !== 'pass') process.exitCode = 1
  } catch {
    process.stdout.write(`${JSON.stringify({
      schema: HERMES_PLUGIN_SMOKE_TYPE, status: 'fail', failure_codes: ['smoke_runtime_failed'],
    })}\n`)
    process.exitCode = 1
  }
}
