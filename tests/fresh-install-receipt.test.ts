import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_STEPS,
  STEP_RECEIPT_TYPE,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/fresh-install-receipt.mjs'

const TARGET = {
  pot: 'acme',
  base_url: 'https://acme.mupot.test',
  operator: 'owner@acme.test',
  cloudflare_account: 'cf-account-redacted',
  worker: 'mupot-acme',
  db: 'mupot-acme',
  config: 'wrangler.acme.toml',
}

const START = Date.parse('2026-07-09T20:00:00.000Z')
const STEP_WINDOW_MS = 5 * 60 * 1000
const STEP_DURATION_MS = 2 * 60 * 1000

function iso(ms: number) {
  return new Date(ms).toISOString()
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-fresh-install-'))
}

function baseReceipt(step: string, evidence: Record<string, unknown>) {
  const index = REQUIRED_STEPS.findIndex((entry) => entry.step === step)
  const startedAt = START + index * STEP_WINDOW_MS
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    started_at: iso(startedAt),
    completed_at: iso(startedAt + STEP_DURATION_MS),
    target: TARGET,
    commands: [
      { command: `run ${step}`, ok: true, exit_code: 0 },
    ],
    evidence,
    artifacts: [
      { label: `${step} artifact`, path: `${step}.txt` },
    ],
  }
}

function evidenceFor(step: string) {
  const spec = REQUIRED_STEPS.find((entry) => entry.step === step)
  if (!spec) throw new Error(`unknown step: ${step}`)
  const evidence = Object.fromEntries(spec.evidence.map((key) => [key, true]))
  evidence.no_manual_db_edits = true
  if (step === 'worker_deployed') evidence.deployed_url = TARGET.base_url
  if (step === 'owner_setup') evidence.owner_auth_method = 'bootstrap_token'
  return evidence
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, file: string) => void) {
  mkdirSync(dir, { recursive: true })

  for (const spec of REQUIRED_STEPS) {
    const receipt = baseReceipt(spec.step, evidenceFor(spec.step))
    mutate?.(receipt, spec.file)
    writeFileSync(join(dir, spec.file), JSON.stringify(receipt, null, 2))
  }
}

describe('fresh install receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--pot', TARGET.pot]).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/install']).check).toBe(true)
  })

  it('prints the fresh install evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/fresh-install/acme',
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      operator: TARGET.operator,
    })

    expect(plan).toContain('Mupot v0.23 fresh self-host install evidence plan')
    expect(plan).toContain(STEP_RECEIPT_TYPE)
    expect(plan).toContain('provision-resources.json')
    expect(plan).toContain('fresh-install-check.json')
  })

  it('passes a complete fresh install bundle', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      operator: TARGET.operator,
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.step_receipts).toBe(REQUIRED_STEPS.length)
    expect(receipt.target.pot).toBe(TARGET.pot)
    expect(receipt.timeline.map((step) => step.step)).toEqual(REQUIRED_STEPS.map((step) => step.step))
  })

  it('fails when install steps overlap or run out of order', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'secrets-configured.json') {
        receipt.started_at = iso(START + STEP_DURATION_MS - 1)
        receipt.completed_at = iso(START + STEP_WINDOW_MS)
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'install_steps_run_in_order_without_overlap',
      previous_step: 'provision_resources',
      step: 'secrets_configured',
    }))
  })

  it('fails when the deployed URL does not match the target pot URL', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'worker-deployed.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.deployed_url = 'https://other.mupot.test'
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'deployed_url_matches_target_base_url',
    }))
  })

  it('requires the no-manual-DB-edit attestation on every step', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'provision-resources.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        delete evidence.no_manual_db_edits
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'no_manual_db_edits_attested',
      step: 'provision_resources',
    }))
  })

  it('requires explicit successful command results', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'migrations-applied.json') receipt.commands = ['npm run migrate:remote']
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'receipt_commands_succeeded',
      step: 'migrations_applied',
    }))
  })

  it('fails when a required resource target is missing', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'post-setup-validation.json') {
        const target = receipt.target as Record<string, unknown>
        delete target.worker
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_present',
      step: 'post_setup_validation',
      field: 'worker',
    }))
  })

  it('fails when owner setup did not prove first owner login', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'owner-setup.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        delete evidence.first_login_became_owner
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'first_login_became_owner',
    }))
  })

  it('rejects non-boolean claims for required installation flags', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'owner-setup.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.first_login_became_owner = 'no'
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      step: 'owner_setup',
      evidence: 'first_login_became_owner',
      value: 'no',
    }))
  })

  it('requires an audited first-owner authentication method', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'owner-setup.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.owner_auth_method = 'manual_database_edit'
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      step: 'owner_setup',
      evidence: 'owner_auth_method',
      value: 'manual_database_edit',
    }))
  })

  it('fails when a manual D1 edit command appears', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'owner-setup.json') {
        receipt.commands = [
          { command: 'npx wrangler d1 execute mupot-acme --remote --command "UPDATE members SET role = owner"', ok: true, exit_code: 0 },
        ]
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'receipt_has_no_manual_db_edit_commands',
    }))
  })

  it('fails when target identity drifts between receipts', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'post-setup-validation.json') {
        receipt.target = { ...(receipt.target as Record<string, unknown>), pot: 'other' }
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_receipts',
      field: 'pot',
    }))
  })

  it('fails when a receipt contains secret material', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'secrets-configured.json') {
        receipt.evidence = {
          ...(receipt.evidence as Record<string, unknown>),
          client_secret: 'plain credential value',
        }
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'receipt_has_no_secret_material',
    }))
  })
})
