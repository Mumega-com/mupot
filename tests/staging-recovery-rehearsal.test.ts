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
} from '../scripts/staging-recovery-rehearsal.mjs'

const START = '2026-07-09T20:00:00.000Z'
const END = '2026-07-09T20:03:00.000Z'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-staging-recovery-'))
}

function baseReceipt(step: string, evidence: Record<string, unknown> = {}) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    started_at: START,
    completed_at: END,
    target: {
      pot: 'staging',
      base_url: 'https://staging.mupot.test',
      worker: 'mupot-staging',
      db: 'mupot-staging',
      git_sha: '60cdac144a1312e1461fd386a311840ca1a1fa6a',
    },
    commands: [
      { command: `staging-${step}`, ok: true, exit_code: 0 },
    ],
    evidence,
    artifacts: [
      { label: `${step}-artifact`, path: `${step}.txt` },
    ],
  }
}

function passingEvidence(step: string): Record<string, unknown> {
  switch (step) {
    case 'upgrade':
      return { migrations_applied: true, deployed_sha: '60cdac144a1312e1461fd386a311840ca1a1fa6a' }
    case 'backup':
      return { d1_export: true, config_inventory: true, secret_names_export: true }
    case 'restore':
      return { restored_to_new_db: true, restore_validation: true }
    case 'rollback':
      return { worker_rollback: true, rollback_validation: true }
    case 'queue_dlq':
      return { queue_delivery: true, dlq_capture: true, idempotency_verified: true }
    case 'failure_reporting':
      return { ops_failure_visible: true, tail_or_log_reference: 'wrangler-tail-error-window-1' }
    case 'final_validation':
      return { health: true, mcp_health: true, owner_login: true, agent_presence: true }
    default:
      throw new Error(`unknown step ${step}`)
  }
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, step: string) => void) {
  mkdirSync(dir, { recursive: true })
  for (const step of REQUIRED_STEPS) {
    const receipt = baseReceipt(step.step, passingEvidence(step.step))
    mutate?.(receipt, step.step)
    writeFileSync(join(dir, step.file), JSON.stringify(receipt, null, 2))
  }
}

describe('staging recovery rehearsal checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--pot', 'staging']).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/stage']).check).toBe(true)
  })

  it('prints the required staging recovery evidence plan', () => {
    const plan = formatPlan({ pot: 'staging', baseUrl: 'https://staging.mupot.test', outDir: 'tmp/stage' })

    expect(plan).toContain('Mupot v0.23 staging recovery rehearsal')
    expect(plan).toContain(STEP_RECEIPT_TYPE)
    expect(plan).toContain('upgrade: write upgrade.json')
    expect(plan).toContain('queue_dlq: write queue-dlq.json')
    expect(plan).toContain('> tmp/stage/staging-recovery-check.json')
  })

  it('passes a complete redacted staging recovery bundle', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({ outDir: dir, pot: 'staging', baseUrl: 'https://staging.mupot.test' })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.target.pot).toBe('staging')
    expect(receipt.artifacts.queue_dlq.status).toBe('pass')
    expect(receipt.checks.find((check) => check.check === 'target_base_url_matches_expected')?.ok).toBe(true)
  })

  it('fails when required evidence is missing', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'restore') {
        receipt.evidence = { restored_to_new_db: true }
      }
    })

    const receipt = checkBundle({ outDir: dir, pot: 'staging', baseUrl: 'https://staging.mupot.test' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      step: 'restore',
      evidence: 'restore_validation',
    }))
  })

  it('fails inconsistent staging targets', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'rollback') {
        const target = receipt.target as Record<string, string>
        target.base_url = 'https://other-staging.mupot.test'
      }
    })

    const receipt = checkBundle({ outDir: dir, pot: 'staging', baseUrl: 'https://staging.mupot.test' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_steps',
      field: 'base_url',
    }))
  })

  it('rejects secret material in step receipts', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'failure_reporting') {
        receipt.leaked = { github_token: `ghp_${'123456789012345678901234567890123456'}` }
      }
    })

    const receipt = checkBundle({ outDir: dir, pot: 'staging', baseUrl: 'https://staging.mupot.test' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'step_receipt_no_secret_material',
      step: 'failure_reporting',
    }))
  })
})
