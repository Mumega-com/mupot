// tests/loop-gate.test.ts — wireGatedAct (P3, #34): a gated loop act → gated task
// (+ pending outbound act for CRM kinds). Nothing sends here.

import { describe, expect, it, vi } from 'vitest'
import { wireGatedAct } from '../src/loops/gate'
import type { LoopManifest } from '../src/loops/manifest'
import type { ProposedAct } from '../src/loops/runtime'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

function makeLoop(over: Partial<LoopManifest> = {}): LoopManifest {
  return {
    id: 'loop-1', tenant: 't', squad_id: 'sq-1', agent_id: null, status: 'active',
    okr: 'grow', kpi: { signal: 'x', target: 5 }, sources: [], channels: [],
    gate: { require_approval: true }, budget: {}, cadence: {}, stop: {}, created_at: 'x', ...over,
  }
}

const emailAct: ProposedAct = { channel_index: 0, tool: 'send_email', args: { to: 'x@y.com' }, summary: 'first touch' }

function deps() {
  const createTask = vi.fn(async () => ({ id: 'task-9', squad_id: 'sq-1' }) as never)
  const createOutboundAct = vi.fn(async () => ({ id: 'act-9' }))
  return { createTask, createOutboundAct }
}

describe('wireGatedAct', () => {
  it('creates a REVIEW task with a gate:* capability for a squad-owned loop', async () => {
    const d = deps()
    await wireGatedAct(ENV, makeLoop(), emailAct, d)
    expect(d.createTask).toHaveBeenCalledTimes(1)
    const [, input] = d.createTask.mock.calls[0]
    expect(input.squad_id).toBe('sq-1')
    expect(input.status).toBe('review') // REQUIRED — else invisible to /approvals + un-verdictable
    expect(input.gate_owner).toBe('gate:loops') // a gate_grants capability, not a membership role
    expect(input.title).toBe('first touch')
  })

  it('queues a PENDING outbound act for a CRM kind', async () => {
    const d = deps()
    await wireGatedAct(ENV, makeLoop(), emailAct, d)
    expect(d.createOutboundAct).toHaveBeenCalledWith(ENV, 'task-9', 'send_email', { to: 'x@y.com' })
  })

  it('creates ONLY a task (no outbound act) for a non-CRM tool', async () => {
    const d = deps()
    await wireGatedAct(ENV, makeLoop(), { ...emailAct, tool: 'draft_post' }, d)
    expect(d.createTask).toHaveBeenCalledTimes(1)
    expect(d.createOutboundAct).not.toHaveBeenCalled()
  })

  it('resolves the squad via the owning agent when the loop is agent-owned', async () => {
    const d = deps()
    const resolveSquadId = vi.fn(async () => 'sq-from-agent')
    await wireGatedAct(ENV, makeLoop({ squad_id: null, agent_id: 'a-1' }), emailAct, { ...d, resolveSquadId })
    expect(resolveSquadId).toHaveBeenCalled()
    const [, input] = d.createTask.mock.calls[0]
    expect(input.squad_id).toBe('sq-from-agent')
  })

  it('BLOCK-1: passes skipMirror so a pre-verdict proposal NEVER mirrors to GitHub (Codex cross-vendor catch)', async () => {
    const d = deps()
    // A CRO proposal whose args carry first-party page-performance data + a model rec.
    const croAct: ProposedAct = {
      channel_index: -1,
      tool: 'cro_content_update',
      args: { slug: 'pricing', url: '/pricing', current_conversion_bps: 50, recommendation: 'tighten headline' },
      summary: 'CRO: improve Pricing',
    }
    await wireGatedAct(ENV, makeLoop(), croAct, d)
    const [, , options] = d.createTask.mock.calls[0]
    // createTask mirrors to a GitHub issue BEFORE the local insert unless skipMirror —
    // mirroring un-approved proposal args would be an external write before any verdict.
    expect(options?.skipMirror).toBe(true)
  })

  it('throws (no silent drop) when the squad cannot be resolved', async () => {
    const d = deps()
    await expect(
      wireGatedAct(ENV, makeLoop({ squad_id: null, agent_id: null }), emailAct, d),
    ).rejects.toThrow('loop_squad_unresolved')
    expect(d.createTask).not.toHaveBeenCalled()
  })
})
