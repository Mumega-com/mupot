import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  CYCLE_RECEIPT_TYPE,
  DAY_RECEIPT_TYPE,
  END_RECEIPT_TYPE,
  START_RECEIPT_TYPE,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/production-soak-receipt.mjs'

const TARGET = {
  pot: 'mumega',
  base_url: 'https://mupot.mumega.test',
  rc_version: 'v0.23.0-rc.1',
  agent: 'agent-hermes',
}

const START = Date.parse('2026-07-09T00:00:00.000Z')
const END = Date.parse('2026-07-16T00:10:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function iso(ms: number) {
  return new Date(ms).toISOString()
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-production-soak-'))
}

function baseReceipt(receiptType: string, status = 'pass') {
  return {
    receipt_type: receiptType,
    status,
    observed_at: iso(START),
    target: TARGET,
    evidence: {},
  }
}

function dayReceipt(day: number) {
  return {
    ...baseReceipt(DAY_RECEIPT_TYPE),
    day_index: day,
    observed_at: iso(START + (day - 0.5) * DAY_MS),
    evidence: {
      health: true,
      mcp_health: true,
      agent_presence: true,
      runtime_control_ok: true,
      no_lost_work: true,
      no_duplicate_effects: true,
      no_unauthorized_actions: true,
      no_critical_failures: true,
    },
  }
}

function cycleReceipt(index: number) {
  return {
    ...baseReceipt(CYCLE_RECEIPT_TYPE),
    observed_at: iso(START + index * 36 * 60 * 60 * 1000),
    target: {
      ...TARGET,
      task_id: `task-soak-${index}`,
    },
    evidence: {
      task_created: true,
      agent_received_work: true,
      agent_executed_work: true,
      approval_or_gate_recorded: true,
      task_completed: true,
      audit_record: `task_verdicts:soak-${index}`,
    },
  }
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, name: string) => void) {
  mkdirSync(dir, { recursive: true })

  const start = {
    ...baseReceipt(START_RECEIPT_TYPE),
    started_at: iso(START),
  }
  mutate?.(start, 'soak-start.json')
  writeFileSync(join(dir, 'soak-start.json'), JSON.stringify(start, null, 2))

  for (let day = 1; day <= 7; day += 1) {
    const receipt = dayReceipt(day)
    mutate?.(receipt, `day-${day}.json`)
    writeFileSync(join(dir, `day-${day}.json`), JSON.stringify(receipt, null, 2))
  }

  for (let index = 1; index <= 3; index += 1) {
    const receipt = cycleReceipt(index)
    mutate?.(receipt, `cycle-${index}.json`)
    writeFileSync(join(dir, `cycle-${index}.json`), JSON.stringify(receipt, null, 2))
  }

  const end = {
    ...baseReceipt(END_RECEIPT_TYPE),
    observed_at: iso(END),
    completed_at: iso(END),
    evidence: {
      no_lost_work: true,
      no_duplicate_effects: true,
      no_unauthorized_actions: true,
      no_critical_failures: true,
    },
  }
  mutate?.(end, 'soak-end.json')
  writeFileSync(join(dir, 'soak-end.json'), JSON.stringify(end, null, 2))
}

describe('production soak receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--agent', TARGET.agent]).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/soak']).check).toBe(true)
  })

  it('prints the v0.23 RC soak evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/production-soak/v0.23.0-rc.1',
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      rcVersion: TARGET.rc_version,
      agent: TARGET.agent,
    })

    expect(plan).toContain('Mupot v0.23 production soak evidence plan')
    expect(plan).toContain(START_RECEIPT_TYPE)
    expect(plan).toContain(DAY_RECEIPT_TYPE)
    expect(plan).toContain(CYCLE_RECEIPT_TYPE)
    expect(plan).toContain('> tmp/production-soak/v0.23.0-rc.1/production-soak-check.json')
  })

  it('passes a complete seven-day soak with three task cycles', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      rcVersion: TARGET.rc_version,
      agent: TARGET.agent,
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.day_receipts).toBe(7)
    expect(receipt.summary.task_cycles).toBe(3)
    expect(receipt.target.agent).toBe(TARGET.agent)
    expect(receipt.timeline.days.map((day) => day.day_index)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(receipt.timeline.cycles).toHaveLength(3)
  })

  it('fails when daily observations are not captured in their 24-hour windows', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name.startsWith('day-')) receipt.observed_at = iso(START)
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'day_observed_in_expected_window',
      day_index: 2,
    }))
  })

  it('fails when a day receipt index does not match its filename', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'day-4.json') receipt.day_index = 5
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'day_index_matches_filename',
      filename_day_index: 4,
      receipt_day_index: 5,
    }))
  })

  it('fails when a task cycle falls outside the soak window', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'cycle-2.json') receipt.observed_at = iso(START - 1)
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'cycle_observed_within_soak_window',
    }))
  })

  it('accepts the aggregate output file created by shell redirection', () => {
    const dir = tempDir()
    writeBundle(dir)
    writeFileSync(join(dir, 'production-soak-check.json'), '')

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('pass')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: true,
      check: 'bundle_only_expected_json_files',
    }))
  })

  it('fails when soak duration is shorter than seven days', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'soak-end.json') {
        receipt.observed_at = iso(START + 6 * 24 * 60 * 60 * 1000)
        receipt.completed_at = receipt.observed_at
      }
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'soak_duration_at_least_seven_days',
    }))
  })

  it('fails when fewer than three distinct task cycles are present', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'cycle-3.json') {
        const target = receipt.target as Record<string, string>
        target.task_id = 'task-soak-2'
      }
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'minimum_distinct_task_cycles_present',
    }))
  })

  it('fails when target identity drifts across receipts', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'day-4.json') {
        const target = receipt.target as Record<string, string>
        target.agent = 'agent-other'
      }
    })

    const receipt = checkBundle({ outDir: dir, agent: TARGET.agent, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_receipts',
      field: 'agent',
    }))
  })

  it('rejects secret material in soak receipts', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, name) => {
      if (name === 'day-2.json') {
        receipt.leaked = { authorization: `Bearer ${'abcdefghijklmnopqrstuvwxyz123456'}` }
      }
    })

    const receipt = checkBundle({ outDir: dir, rcVersion: TARGET.rc_version })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'day_no_secret_material',
    }))
  })
})
