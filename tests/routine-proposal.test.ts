import { describe, expect, it } from 'vitest'
import { parseRoutineProposal } from '../src/routines/proposal'

const base = {
  version: 'routine.proposal/v1',
  run_id: 'run-1',
  project_id: 'project-1',
  situation_digest: 'a'.repeat(64),
  summary: 'The highest-leverage next action is explicit and bounded.',
}

const proposals = {
  create_task: {
    ...base,
    action: {
      key: 'task-1', kind: 'create_task',
      input: { title: 'Verify the conversion event', description: 'Check the exact event and attach evidence.', assignee_agent_id: 'agent-1' },
    },
  },
  dispatch_flight: {
    ...base,
    action: {
      key: 'flight-1', kind: 'dispatch_flight',
      input: { goal: 'Measure the conversion path', task_ids: ['task-1'], artifact_refs: ['https://example.test/evidence'], budget_micro_usd: 5000 },
    },
  },
  request_review: {
    ...base,
    action: {
      key: 'review-1', kind: 'request_review',
      input: { source_type: 'task', source_id: 'task-1', summary: 'Confirm the evidence meets the success predicate.' },
    },
  },
  ask_human: {
    ...base,
    action: {
      key: 'question-1', kind: 'ask_human',
      input: { question: 'Which conversion event is authoritative?', choices: ['Booked call', 'Paid order'], references: [{ type: 'task', id: 'task-1' }] },
    },
  },
  no_action: {
    ...base,
    action: {
      key: 'none-1', kind: 'no_action',
      input: { reason: 'The Project is already waiting on verified evidence.', next_check_at: '2026-07-20T12:00:00.000Z' },
    },
  },
} as const

describe('parseRoutineProposal', () => {
  it.each(Object.entries(proposals))('accepts a bounded %s action', (_kind, proposal) => {
    expect(parseRoutineProposal(proposal)).toEqual({ ok: true, value: proposal })
  })

  it('rejects unknown envelope, action, and input keys', () => {
    expect(parseRoutineProposal({ ...proposals.no_action, extra: true })).toEqual({ ok: false, error: 'unknown_key' })
    expect(parseRoutineProposal({
      ...proposals.no_action,
      action: { ...proposals.no_action.action, extra: true },
    })).toEqual({ ok: false, error: 'unknown_key' })
    expect(parseRoutineProposal({
      ...proposals.no_action,
      action: { ...proposals.no_action.action, input: { ...proposals.no_action.action.input, secret: 'x' } },
    })).toEqual({ ok: false, error: 'unknown_key' })
  })

  it('rejects unsupported kinds and malformed correlation fields', () => {
    expect(parseRoutineProposal({ ...proposals.no_action, version: 'routine.proposal/v2' })).toEqual({ ok: false, error: 'invalid_envelope' })
    expect(parseRoutineProposal({ ...proposals.no_action, situation_digest: 'abc' })).toEqual({ ok: false, error: 'invalid_envelope' })
    expect(parseRoutineProposal({
      ...proposals.no_action,
      action: { key: 'x', kind: 'shell', input: {} },
    })).toEqual({ ok: false, error: 'unsupported_action' })
  })

  it('rejects oversized text, invalid keys, duplicate references, and unsafe budgets', () => {
    expect(parseRoutineProposal({ ...proposals.no_action, summary: 'x'.repeat(4001) })).toEqual({ ok: false, error: 'invalid_envelope' })
    expect(parseRoutineProposal({
      ...proposals.no_action,
      action: { ...proposals.no_action.action, key: 'contains space' },
    })).toEqual({ ok: false, error: 'invalid_action' })
    expect(parseRoutineProposal({
      ...proposals.dispatch_flight,
      action: { ...proposals.dispatch_flight.action, input: { ...proposals.dispatch_flight.action.input, task_ids: ['task-1', 'task-1'] } },
    })).toEqual({ ok: false, error: 'invalid_action_input' })
    expect(parseRoutineProposal({
      ...proposals.dispatch_flight,
      action: { ...proposals.dispatch_flight.action, input: { ...proposals.dispatch_flight.action.input, budget_micro_usd: Number.MAX_SAFE_INTEGER + 1 } },
    })).toEqual({ ok: false, error: 'invalid_action_input' })
  })

  it('rejects malformed human choices and references', () => {
    expect(parseRoutineProposal({
      ...proposals.ask_human,
      action: { ...proposals.ask_human.action, input: { ...proposals.ask_human.action.input, choices: ['only one'] } },
    })).toEqual({ ok: false, error: 'invalid_action_input' })
    expect(parseRoutineProposal({
      ...proposals.ask_human,
      action: { ...proposals.ask_human.action, input: { ...proposals.ask_human.action.input, references: [{ type: 'unknown', id: 'x' }] } },
    })).toEqual({ ok: false, error: 'invalid_action_input' })
  })
})
