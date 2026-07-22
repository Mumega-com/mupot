import { describe, expect, it, vi } from 'vitest'
import {
  classifyHermesTurn,
  handleHermesTurn,
  parseSolAction,
  stripSolActionTrailer,
  HERMES_TIER_MODELS,
} from '../src/hermes'
import type { Env, Task } from '../src/types'

function makeEnv(): Env {
  return {
    TENANT_SLUG: 'test',
    DB: {} as Env['DB'],
    AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
    },
  } as unknown as Env
}

describe('classifyHermesTurn (Luna triage)', () => {
  it('routes greetings and status to luna without opus wake', () => {
    expect(classifyHermesTurn('hi')).toEqual({
      tier: 'luna',
      reason: 'heartbeat_or_greeting',
      wakeOpus: false,
    })
    expect(classifyHermesTurn('status').tier).toBe('luna')
    expect(classifyHermesTurn('help').wakeOpus).toBe(false)
  })

  it('routes hard-call language to opus wake', () => {
    const d = classifyHermesTurn('Please escalate to kasra for a production incident')
    expect(d.tier).toBe('opus')
    expect(d.wakeOpus).toBe(true)
  })

  it('routes ordinary reasoning to sol', () => {
    const d = classifyHermesTurn('Break down the next three tasks for the marketing project')
    expect(d).toEqual({ tier: 'sol', reason: 'needs_reasoning', wakeOpus: false })
  })
})

describe('parseSolAction / stripSolActionTrailer', () => {
  it('parses TASK and WAKE_OPUS trailers fail-closed on empty/oversized', () => {
    expect(parseSolAction('Sure.\nTASK: Ship landing page')).toEqual({
      kind: 'task',
      title: 'Ship landing page',
    })
    expect(parseSolAction('Hard.\nWAKE_OPUS: need architecture call')).toEqual({
      kind: 'wake_opus',
      reason: 'need architecture call',
    })
    expect(parseSolAction('Just a reply.')).toEqual({ kind: 'none' })
    expect(parseSolAction(`x\nTASK: ${'a'.repeat(201)}`)).toEqual({ kind: 'none' })
  })

  it('strips the trailer from the visible reply', () => {
    expect(stripSolActionTrailer('Done.\n\nTASK: Do the thing')).toBe('Done.')
  })
})

describe('handleHermesTurn', () => {
  it('luna path replies without calling the model', async () => {
    const chat = vi.fn()
    const result = await handleHermesTurn(
      makeEnv(),
      { message: 'hello', memberId: 'm-1', projectId: null, squadId: null },
      { chat },
    )
    expect(chat).not.toHaveBeenCalled()
    expect(result.route.tier).toBe('luna')
    expect(result.reply.toLowerCase()).toContain('luna')
    expect(result.taskId).toBeNull()
    expect(result.wokeOpusAgentId).toBeNull()
  })

  it('opus path wakes Kasra and does not call Sol', async () => {
    const chat = vi.fn()
    const wakeAgent = vi.fn(async () => undefined)
    const result = await handleHermesTurn(
      makeEnv(),
      {
        message: 'Wake kasra — production incident on the pot',
        memberId: 'm-1',
        projectId: null,
        squadId: null,
      },
      {
        chat,
        resolveOpusAgentId: async () => 'agent-kasra',
        wakeAgent,
      },
    )
    expect(chat).not.toHaveBeenCalled()
    expect(wakeAgent).toHaveBeenCalledOnce()
    expect(wakeAgent.mock.calls[0][1]).toBe('agent-kasra')
    expect(result.wokeOpusAgentId).toBe('agent-kasra')
    expect(result.route.wakeOpus).toBe(true)
  })

  it('sol path dispatches a task when Sol emits TASK trailer', async () => {
    const created: Task = {
      id: 'task-hermes-1',
      squad_id: 'squad-core',
      project_id: null,
      title: 'Write release notes',
      body: 'x',
      done_when: 'y',
      status: 'open',
      assignee_agent_id: null,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: 'gate:kasra-core',
      source_pot: null,
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    }
    const create = vi.fn(async () => created)
    const chat = vi.fn(async () => 'I will queue that.\nTASK: Write release notes')
    const result = await handleHermesTurn(
      makeEnv(),
      {
        message: 'Please create a task to write release notes',
        memberId: 'm-1',
        projectId: null,
        squadId: 'squad-core',
      },
      { chat, createTask: create },
    )
    expect(chat).toHaveBeenCalledOnce()
    expect(chat.mock.calls[0][1]).toEqual({ model: HERMES_TIER_MODELS.sol, maxTokens: 1024 })
    expect(create).toHaveBeenCalledOnce()
    expect(result.taskId).toBe('task-hermes-1')
    expect(result.reply).toContain('Dispatched task')
    expect(result.reply).not.toContain('TASK:')
  })

  it('sol path wakes Opus when Sol emits WAKE_OPUS trailer', async () => {
    const wakeAgent = vi.fn(async () => undefined)
    const chat = vi.fn(async () => 'This needs Kasra.\nWAKE_OPUS: architecture decision')
    const result = await handleHermesTurn(
      makeEnv(),
      {
        message: 'How should we redesign the gate lane?',
        memberId: 'm-1',
        projectId: null,
        squadId: null,
      },
      {
        chat,
        resolveOpusAgentId: async () => 'agent-kasra',
        wakeAgent,
      },
    )
    expect(wakeAgent).toHaveBeenCalledOnce()
    expect(result.wokeOpusAgentId).toBe('agent-kasra')
    expect(result.route.wakeOpus).toBe(true)
    expect(result.reply).toBe('This needs Kasra.')
  })
})
