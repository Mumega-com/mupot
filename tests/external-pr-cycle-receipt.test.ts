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
} from '../scripts/external-pr-cycle-receipt.mjs'

const TARGET = {
  pot: 'mumega',
  base_url: 'https://mupot.mumega.test',
  repo: 'Mumega-com/mupot',
  agent: 'kasra-code',
  task_id: 'task-pr-cycle-1',
  issue_url: 'https://github.com/Mumega-com/mupot/issues/150',
  pr_url: 'https://github.com/Mumega-com/mupot/pull/278',
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-external-pr-cycle-'))
}

function evidenceFor(step: string): Record<string, unknown> {
  switch (step) {
    case 'board_item':
      return { project_item_id: 'PVTI_lADO', issue_url: TARGET.issue_url, agent_field: TARGET.agent }
    case 'task_import':
      return { task_id: TARGET.task_id, assigned_agent_id: TARGET.agent, board_item_linked: true }
    case 'agent_execution':
      return { runtime_identity: TARGET.agent, inbox_work_received: true, execution_started: true }
    case 'pull_request':
      return { pr_url: TARGET.pr_url, pr_number: 278, author: TARGET.agent, task_linked: true }
    case 'task_linkback':
      return { task_result_links_pr: true, audit_record: 'task_verdicts:verdict-pr-cycle-1' }
    case 'ci_feedback':
      return { checks_observed: true, status_synced_to_task_or_board: true }
    case 'final_verification':
      return { issue_to_pr_trace: true, task_to_pr_trace: true, agent_author_trace: true }
    default:
      throw new Error(`unknown step ${step}`)
  }
}

function baseReceipt(step: string, evidence: Record<string, unknown> = evidenceFor(step)) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    observed_at: '2026-07-09T21:00:00.000Z',
    target: TARGET,
    evidence,
    links: {
      issue_url: TARGET.issue_url,
      task_url: `${TARGET.base_url}/tasks/${TARGET.task_id}`,
      pr_url: TARGET.pr_url,
    },
    artifacts: [
      { label: `${step}-artifact`, path: `${step}.json` },
    ],
  }
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, step: string) => void) {
  mkdirSync(dir, { recursive: true })
  for (const step of REQUIRED_STEPS) {
    const receipt = baseReceipt(step.step)
    mutate?.(receipt, step.step)
    writeFileSync(join(dir, step.file), JSON.stringify(receipt, null, 2))
  }
}

describe('external PR-cycle receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--repo', TARGET.repo]).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/external']).check).toBe(true)
  })

  it('prints the #150 evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/external-pr-cycle/task-pr-cycle-1',
      pot: TARGET.pot,
      repo: TARGET.repo,
      agent: TARGET.agent,
      taskId: TARGET.task_id,
      issueUrl: TARGET.issue_url,
      prUrl: TARGET.pr_url,
      baseUrl: TARGET.base_url,
    })

    expect(plan).toContain('Mupot #150 external PR-cycle evidence plan')
    expect(plan).toContain(STEP_RECEIPT_TYPE)
    expect(plan).toContain('board_item: write board-item.json')
    expect(plan).toContain('pull_request: write pull-request.json')
    expect(plan).toContain('> tmp/external-pr-cycle/task-pr-cycle-1/external-pr-cycle-check.json')
  })

  it('passes a complete board to task to agent to PR evidence bundle', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      pot: TARGET.pot,
      repo: TARGET.repo,
      agent: TARGET.agent,
      taskId: TARGET.task_id,
      issueUrl: TARGET.issue_url,
      prUrl: TARGET.pr_url,
      baseUrl: TARGET.base_url,
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.target.repo).toBe(TARGET.repo)
    expect(receipt.artifacts.pull_request.status).toBe('pass')
    expect(receipt.checks.find((check) => check.check === 'issue_and_pr_same_repo')?.ok).toBe(true)
  })

  it('fails when the task linkback does not prove the PR link', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'task_linkback') {
        receipt.evidence = { audit_record: 'task_verdicts:verdict-pr-cycle-1' }
      }
    })

    const receipt = checkBundle({ outDir: dir, repo: TARGET.repo })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      step: 'task_linkback',
      evidence: 'task_result_links_pr',
    }))
  })

  it('fails when issue and PR are from different repositories', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'pull_request') {
        const target = receipt.target as Record<string, string>
        target.pr_url = 'https://github.com/Mumega-com/other/pull/1'
        const links = receipt.links as Record<string, string>
        links.pr_url = target.pr_url
      }
    })

    const receipt = checkBundle({ outDir: dir, repo: TARGET.repo })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_steps',
      field: 'pr_url',
    }))
  })

  it('rejects secret material in evidence receipts', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, step) => {
      if (step === 'ci_feedback') {
        receipt.leaked = { authorization: `Bearer ${'abcdefghijklmnopqrstuvwxyz123456'}` }
      }
    })

    const receipt = checkBundle({ outDir: dir, repo: TARGET.repo })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'step_receipt_no_secret_material',
      step: 'ci_feedback',
    }))
  })
})

