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
} from '../scripts/work-lifecycle-receipt.mjs'

const TARGET = {
  pot: 'mumega',
  base_url: 'https://mupot.mumega.test',
  agent: 'agent-hermes',
  task_id: 'task-lifecycle-1',
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-work-lifecycle-'))
}

function evidenceFor(step: string) {
  const spec = REQUIRED_STEPS.find((entry) => entry.step === step)
  if (!spec) throw new Error(`unknown step: ${step}`)
  return Object.fromEntries(spec.evidence.map((key) => [key, key.endsWith('_id') ? TARGET.task_id : true]))
}

function baseReceipt(step: string, evidence: Record<string, unknown>) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    observed_at: '2026-07-09T20:00:00.000Z',
    target: TARGET,
    evidence,
    artifacts: [
      { label: `${step} artifact`, path: `${step}.json` },
    ],
  }
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, file: string) => void) {
  mkdirSync(dir, { recursive: true })
  for (const spec of REQUIRED_STEPS) {
    const receipt = baseReceipt(spec.step, evidenceFor(spec.step))
    mutate?.(receipt, spec.file)
    writeFileSync(join(dir, spec.file), JSON.stringify(receipt, null, 2))
  }
}

describe('work lifecycle receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--agent', TARGET.agent]).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/lifecycle']).check).toBe(true)
  })

  it('prints the real work lifecycle evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/work-lifecycle/task-lifecycle-1',
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      agent: TARGET.agent,
      taskId: TARGET.task_id,
    })

    expect(plan).toContain('Mupot v0.23 real work-lifecycle evidence plan')
    expect(plan).toContain(STEP_RECEIPT_TYPE)
    expect(plan).toContain('task-created.json')
    expect(plan).toContain('work-lifecycle-check.json')
  })

  it('passes a complete real-agent task lifecycle bundle', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      agent: TARGET.agent,
      taskId: TARGET.task_id,
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.step_receipts).toBe(REQUIRED_STEPS.length)
    expect(receipt.target.task_id).toBe(TARGET.task_id)
  })

  it('fails when human approval evidence is missing', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'approval-recorded.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        delete evidence.human_approval_recorded
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'human_approval_recorded',
    }))
  })

  it('fails when the audit receipt is for a different task', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'audit-verified.json') {
        receipt.target = { ...(receipt.target as Record<string, unknown>), task_id: 'task-other' }
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_receipts',
      field: 'task_id',
    }))
  })

  it('fails when audit evidence is missing', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'audit-verified.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        delete evidence.actor_attribution
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'actor_attribution',
    }))
  })

  it('fails when a lifecycle receipt is missing a parseable observation time', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'agent-execution.json') {
        receipt.observed_at = 'not a timestamp'
      }
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'observed_at_parseable',
      step: 'agent_execution',
    }))
  })

  it('fails when lifecycle evidence is observed out of order', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      const observedAtByFile: Record<string, string> = {
        'task-created.json': '2026-07-09T20:00:00.000Z',
        'agent-execution.json': '2026-07-09T20:05:00.000Z',
        'approval-recorded.json': '2026-07-09T20:04:00.000Z',
        'task-completed.json': '2026-07-09T20:06:00.000Z',
        'audit-verified.json': '2026-07-09T20:07:00.000Z',
      }
      receipt.observed_at = observedAtByFile[file]
    })

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'lifecycle_steps_observed_in_order',
      previous_step: 'agent_execution',
      step: 'approval_recorded',
    }))
  })

  it('fails when a receipt contains sensitive field material', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'agent-execution.json') {
        receipt.evidence = {
          ...(receipt.evidence as Record<string, unknown>),
          access_token: 'plain credential value',
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
