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

const RELEASE_SHA = '8a2bd44c5f0efcc23791e3b08d9f5472d1a6c4be'
const OTHER_RELEASE_SHA = '7b2bd44c5f0efcc23791e3b08d9f5472d1a6c4be'
const MISSING = Symbol('missing')

function sourceHealth(commit = RELEASE_SHA) {
  return { ok: true, service: 'mupot', commit, clean: true }
}

function bindReleaseReceipt(receipt: Record<string, unknown>, file: string, releaseSha = RELEASE_SHA) {
  receipt.target = { ...(receipt.target as Record<string, unknown>), release_sha: releaseSha }
  if (file === 'agent-execution.json') {
    receipt.evidence = {
      ...(receipt.evidence as Record<string, unknown>),
      source_health: sourceHealth(releaseSha),
    }
  }
}

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
    target: { ...TARGET },
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

    expect(plan).toContain('Mupot real work-lifecycle evidence plan')
    expect(plan).not.toContain('v0.23')
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
    expect(receipt.next_steps.join(' ')).not.toContain('v0.23 release issue')
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

  it('binds every work-lifecycle receipt to the requested release SHA', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      bindReleaseReceipt(receipt, file)
    })

    const parsed = parseArgs(['--check', '--out-dir', dir, '--release-sha', RELEASE_SHA])
    const plan = formatPlan({ outDir: dir, releaseSha: RELEASE_SHA })
    const receipt = checkBundle(parsed)

    expect(parsed.releaseSha).toBe(RELEASE_SHA)
    expect(plan).toContain('"release_sha": "8a2bd44c5f0efcc23791e3b08d9f5472d1a6c4be"')
    expect(plan).toContain('"source_health": {')
    expect(plan).toContain('"service": "mupot"')
    expect(plan).toContain('"commit": "8a2bd44c5f0efcc23791e3b08d9f5472d1a6c4be"')
    expect(plan).toContain('"clean": true')
    expect(plan).toContain('--release-sha 8a2bd44c5f0efcc23791e3b08d9f5472d1a6c4be')
    expect(receipt.status).toBe('pass')
    expect(receipt.target.release_sha).toBe(RELEASE_SHA)
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: true,
      check: 'source_health_matches_expected_release_sha',
      step: 'agent_execution',
    }))
  })

  it.each([
    ['missing', MISSING],
    ['null', null],
    ['array', [sourceHealth()]],
    ['unknown field', { ...sourceHealth(), note: 'unexpected' }],
    ['secret-bearing field', { ...sourceHealth(), api_key: 'plain credential value' }],
    ['malformed commit', { ...sourceHealth(), commit: 'not-a-sha' }],
    ['uppercase commit', { ...sourceHealth(), commit: RELEASE_SHA.toUpperCase() }],
    ['non-clean source', { ...sourceHealth(), clean: false }],
    ['wrong service', { ...sourceHealth(), service: 'other' }],
    ['non-ok source', { ...sourceHealth(), ok: false }],
  ])('rejects %s designated work-lifecycle source health', (_label, value) => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      bindReleaseReceipt(receipt, file)
      if (file !== 'agent-execution.json') return
      const evidence = receipt.evidence as Record<string, unknown>
      if (value === MISSING) delete evidence.source_health
      else evidence.source_health = value
    })

    const result = checkBundle({ outDir: dir, releaseSha: RELEASE_SHA })
    expect(result.status).toBe('fail')
    expect(result.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'source_health_matches_expected_release_sha',
      step: 'agent_execution',
    }))
  })

  it('rejects relabeling every work-lifecycle target from source SHA B to requested SHA A', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      bindReleaseReceipt(receipt, file)
      if (file === 'agent-execution.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.source_health = sourceHealth(OTHER_RELEASE_SHA)
      }
    })

    const result = checkBundle({ outDir: dir, releaseSha: RELEASE_SHA })
    expect(result.status).toBe('fail')
    expect(result.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'source_health_matches_expected_release_sha',
      step: 'agent_execution',
    }))
  })

  it('rejects a work-lifecycle bundle when a bound step omits the release SHA', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      receipt.target = { ...(receipt.target as Record<string, unknown>), release_sha: RELEASE_SHA }
      if (file === 'agent-execution.json') delete (receipt.target as Record<string, unknown>).release_sha
    })

    expect(checkBundle({ outDir: dir, releaseSha: RELEASE_SHA }).status).toBe('fail')
  })

  it('rejects a work-lifecycle bundle with different valid release SHAs', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      receipt.target = {
        ...(receipt.target as Record<string, unknown>),
        release_sha: file === 'task-completed.json' ? '7b2bd44c5f0efcc23791e3b08d9f5472d1a6c4be' : RELEASE_SHA,
      }
    })

    expect(checkBundle({ outDir: dir }).status).toBe('fail')
  })

  it.each([
    ['malformed', 'not-a-sha'],
    ['uppercase', RELEASE_SHA.toUpperCase()],
    ['array', [RELEASE_SHA]],
    ['object', { sha: RELEASE_SHA }],
  ])('rejects %s work-lifecycle release SHA values without coercion', (_kind, releaseSha) => {
    const dir = tempDir()
    writeBundle(dir, (receipt) => {
      receipt.target = { ...(receipt.target as Record<string, unknown>), release_sha: releaseSha }
    })

    expect(checkBundle({ outDir: dir }).status).toBe('fail')
  })

  it('rejects malformed or uppercase work-lifecycle CLI release SHAs', () => {
    expect(() => parseArgs(['--check', '--release-sha', 'not-a-sha'])).toThrow('invalid release SHA')
    expect(() => parseArgs(['--check', '--release-sha', RELEASE_SHA.toUpperCase()])).toThrow('invalid release SHA')
  })

  it('rejects a work-lifecycle bundle whose SHA differs from the requested release', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt) => {
      receipt.target = { ...(receipt.target as Record<string, unknown>), release_sha: RELEASE_SHA }
    })

    expect(checkBundle({ outDir: dir, releaseSha: '7b2bd44c5f0efcc23791e3b08d9f5472d1a6c4be' }).status).toBe('fail')
  })

  it('keeps a historical work-lifecycle bundle without release SHAs valid', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({ outDir: dir })

    expect(receipt.status).toBe('pass')
    expect(receipt.target.release_sha).toBeNull()
  })
})
