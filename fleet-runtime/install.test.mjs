// node --test install.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReceipt, parseArgs, summarize } from './install.mjs'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-fleet-install-'))
}

function mode(path) {
  return statSync(path).mode & 0o777
}

test('install receipt creates runtime layout, templates, and systemd units', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')

  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir })

  assert.equal(receipt.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(receipt.status, 'warn')
  assert.equal(receipt.summary.failed, 0)
  assert.ok(existsSync(join(prefix, 'runtime', 'fleet-daemon.mjs')))
  assert.ok(existsSync(join(prefix, 'runtime', 'cutover-probe.mjs')))
  assert.ok(existsSync(join(prefix, 'daemon.json')))
  assert.ok(existsSync(join(prefix, 'inbox-handler.json')))
  assert.ok(existsSync(join(prefix, 'control.json')))
  assert.ok(existsSync(join(prefix, 'flights.json')))
  assert.ok(existsSync(join(systemdDir, 'fleet-daemon.service')))
  assert.ok(existsSync(join(systemdDir, 'fleet-control-daemon.service')))
  assert.equal(mode(prefix), 0o700)
  assert.equal(mode(join(prefix, 'runtime')), 0o700)
  assert.equal(mode(join(prefix, 'agents')), 0o700)
  assert.equal(mode(join(prefix, 'daemon.json')), 0o600)
  assert.ok(receipt.checks.some((c) => c.check === 'config_needs_edit' && c.ok === null))
  assert.ok(receipt.next_steps.some((s) => s.includes('host-receipt.mjs')))
})

test('installer preserves existing configs unless forceConfig is set', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')

  await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir })
  writeFileSync(join(prefix, 'daemon.json'), '{"custom":true}\n')

  const preserved = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir })
  assert.equal(readFileSync(join(prefix, 'daemon.json'), 'utf8'), '{"custom":true}\n')
  assert.ok(preserved.checks.some((c) => c.check === 'config_preserved' && c.path.endsWith('/daemon.json')))

  const forced = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, forceConfig: true })
  assert.notEqual(readFileSync(join(prefix, 'daemon.json'), 'utf8'), '{"custom":true}\n')
  assert.ok(forced.checks.some((c) => c.check === 'config_template_copied' && c.path.endsWith('/daemon.json')))
})

test('dry run reports planned actions without writing files', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')
  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, dryRun: true })

  assert.equal(receipt.status, 'warn')
  assert.equal(existsSync(prefix), false)
  assert.ok(receipt.checks.some((c) => c.check === 'runtime_file_copied' && c.dry_run === true))
  assert.ok(receipt.checks.some((c) => c.check === 'systemd_unit_copied' && c.dry_run === true))
})

test('parseArgs and summarize cover install options', () => {
  const opts = parseArgs([
    '--source', './fleet-runtime',
    '--prefix', './tmp-fleet',
    '--systemd-dir', './tmp-systemd',
    '--skip-systemd',
    '--force-config',
    '--dry-run',
  ])

  assert.ok(opts.sourceDir.endsWith('/fleet-runtime'))
  assert.ok(opts.prefix.endsWith('/tmp-fleet'))
  assert.ok(opts.systemdDir.endsWith('/tmp-systemd'))
  assert.equal(opts.skipSystemd, true)
  assert.equal(opts.forceConfig, true)
  assert.equal(opts.dryRun, true)
  assert.deepEqual(summarize([{ ok: true }, { ok: null }]), { status: 'warn', passed: 1, failed: 0, warnings: 1 })
  assert.throws(() => parseArgs(['--prefix']), /requires a value/)
})
