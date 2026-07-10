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

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-fresh-install-'))
}

function baseReceipt(step: string, evidence: Record<string, unknown>) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    started_at: '2026-07-09T20:00:00.000Z',
    completed_at: '2026-07-09T20:01:00.000Z',
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
  return Object.fromEntries(spec.evidence.map((key) => [key, true]))
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
