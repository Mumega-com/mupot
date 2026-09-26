// tests/data-hygiene-audit.test.ts — hermetic tests for the mupot#1496 data-hygiene
// classifier (scripts/data-hygiene-audit.mjs).
//
// Fixture is a small, hand-built snapshot shaped like the real prod snapshot taken
// 2026-09-26 15:10Z (member/agent/squad/project shapes lifted directly from it), not a
// copy of the real data. Every case below targets one documented rule so a future edit
// that breaks a rule's intent goes red here first.

import { describe, expect, it } from 'vitest'
import {
  classifyMember,
  classifyAgent,
  classifySquad,
  classifyProject,
  runAudit,
  toMarkdown,
  buildIndexes,
  computeSnapshotAsOf,
  toEpochMs,
  daysBetween,
  RECENT_DAYS,
  DORMANT_DAYS,
  PROJECT_PLANNED_STALE_DAYS,
} from '../scripts/data-hygiene-audit.mjs'

const ASOF = '2026-09-26T15:10:00.000Z'
const ASOF_MS = Date.parse(ASOF)

function baseData(overrides: Partial<Record<string, unknown[]>> = {}) {
  return {
    members: [],
    memberIdentities: [],
    memberTokens: [],
    agents: [],
    squads: [],
    projects: [],
    capabilities: [],
    presence: [],
    fleetAgents: [],
    taskCounts: [],
    ...overrides,
  }
}

function ctxFor(data: ReturnType<typeof baseData>, asOf = ASOF_MS) {
  return { asOf, idx: buildIndexes(data) }
}

describe('toEpochMs / daysBetween', () => {
  it('parses naive SQLite "YYYY-MM-DD HH:MM:SS" as UTC', () => {
    expect(toEpochMs('2026-06-03 15:39:36')).toBe(Date.parse('2026-06-03T15:39:36Z'))
  })

  it('parses ISO timestamps unchanged', () => {
    expect(toEpochMs('2026-06-28T18:20:00.000Z')).toBe(Date.parse('2026-06-28T18:20:00.000Z'))
  })

  it('returns null for unparseable/absent input rather than 1970', () => {
    expect(toEpochMs(null)).toBeNull()
    expect(toEpochMs(undefined)).toBeNull()
    expect(toEpochMs('not-a-date')).toBeNull()
  })

  it('daysBetween returns null when either side is unknown', () => {
    expect(daysBetween(null, 100)).toBeNull()
    expect(daysBetween(100, null)).toBeNull()
  })
})

describe('computeSnapshotAsOf', () => {
  it('derives asOf as the max timestamp seen across the snapshot when no override given', () => {
    const data = baseData({
      members: [{ id: 'm1', created_at: '2026-01-01T00:00:00.000Z' }],
      presence: [{ member_id: 'm1', last_seen_at: '2026-09-01T00:00:00.000Z' }],
      fleetAgents: [{ agent_id: 'a1', last_reported_at: '2026-09-15T00:00:00.000Z' }],
    })
    expect(computeSnapshotAsOf(data)).toBe(Date.parse('2026-09-15T00:00:00.000Z'))
  })

  it('an explicit override wins over the derived max', () => {
    const data = baseData({ presence: [{ member_id: 'm1', last_seen_at: '2026-09-25T00:00:00.000Z' }] })
    expect(computeSnapshotAsOf(data, '2020-01-01T00:00:00.000Z')).toBe(Date.parse('2020-01-01T00:00:00.000Z'))
  })
})

describe('classifyMember', () => {
  it('R-M1: a member with a login identity is real', () => {
    const data = baseData({
      members: [{ id: 'mem-hadi', display_name: 'Hadi', email: 'hadi@mumega.com', status: 'active', created_at: '2026-06-03 15:39:36', has_tg: 0 }],
      memberIdentities: [{ member_id: 'mem-hadi', provider: 'google', created_at: '2026-09-05T01:25:27.359Z' }],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(r.class).toBe('real')
    expect(r.evidence.has_login_identity).toBe(true)
  })

  it('R-M2: canonical @agents.mumega.com seat with capabilities is real', () => {
    const data = baseData({
      members: [{ id: 'kasra-mem', display_name: 'Kasra', email: 'kasra@agents.mumega.com', status: 'active', created_at: '2026-06-28T18:20:00.000Z', has_tg: 0 }],
      capabilities: [{ member_id: 'kasra-mem', scope_type: 'squad', scope_id: 'squad-core', capability: 'admin' }],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(r.class).toBe('real')
  })

  it('R-M3: a distinct external human email is real even with no login yet (Gavin/Bardiya shape)', () => {
    const data = baseData({
      members: [{ id: 'gavin', display_name: 'Gavin Kelpin', email: 'gkelpin63@gmail.com', status: 'active', created_at: '2026-07-22T16:01:33Z', has_tg: 0 }],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(r.class).toBe('real')
  })

  it('R-M4: a DNU-marked member is test, even with some capabilities (name overrides)', () => {
    const data = baseData({
      members: [{ id: 'dnu1', display_name: 'Hadi ChatGPT DNU', email: '', status: 'active', created_at: '2026-09-16T20:42:04.859Z', has_tg: 0 }],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(r.class).toBe('test')
  })

  it('R-M5: a duplicate display_name with zero live binding is duplicate, not debris', () => {
    const data = baseData({
      members: [
        { id: 'kasra-real', display_name: 'Kasra', email: 'kasra@agents.mumega.com', status: 'active', created_at: '2026-06-28T18:20:00.000Z', has_tg: 0 },
        { id: 'kasra-dup', display_name: 'Kasra', email: '', status: 'suspended', created_at: '2026-07-19T19:55:21.000Z', has_tg: 0 },
      ],
      capabilities: [{ member_id: 'kasra-real', scope_type: 'squad', scope_id: 'squad-core', capability: 'admin' }],
    })
    const dup = data.members[1]
    const r = classifyMember(dup, ctxFor(data))
    expect(r.class).toBe('duplicate')
    expect(r.evidence.duplicate_name_siblings).toContain('kasra-real')
  })

  it('a duplicate-named member that IS live-bound (a real running fleet body) is routed to review, never auto-archived', () => {
    const data = baseData({
      members: [
        { id: 'kasra-real', display_name: 'Kasra', email: 'kasra@agents.mumega.com', status: 'active', created_at: '2026-06-28T18:20:00.000Z', has_tg: 0 },
        { id: 'kasra-live-dup', display_name: 'Kasra', email: '', status: 'active', created_at: '2026-07-21T02:15:48.470Z', has_tg: 0 },
      ],
      presence: [{ member_id: 'kasra-live-dup', agent_id: 'ag1', last_seen_at: '2026-09-26 15:10:24' }],
      fleetAgents: [{ agent_id: 'ag1', member_id: 'kasra-live-dup', status: 'running', last_reported_at: '2026-09-26 15:10:24' }],
    })
    const r = classifyMember(data.members[1], ctxFor(data))
    expect(r.class).not.toBe('duplicate')
    expect(r.class).not.toBe('connector-debris')
    expect(r.class).toBe('review')
  })

  it('R-M6: no identity/email/capability/token/activity beyond creation is connector-debris', () => {
    const data = baseData({
      members: [{ id: 'ghost1', display_name: 'Fleet Consumer', email: '', status: 'suspended', created_at: '2026-07-12T04:12:09.324Z', has_tg: 0 }],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(r.class).toBe('connector-debris')
  })

  it('MUST NOT classify an ambiguous row (some tokens, no other signal) as connector-debris or test — falls to review', () => {
    const data = baseData({
      members: [{ id: 'ambig1', display_name: 'Rava', email: '', status: 'active', created_at: '2026-09-13T01:38:37.630Z', has_tg: 0 }],
      memberTokens: [
        { member_id: 'ambig1', label: '', channel: 'workspace', created_at: '2026-09-13T01:40:00.000Z', revoked_at: null, expires_at: null },
        { member_id: 'ambig1', label: '', channel: 'workspace', created_at: '2026-09-14T01:40:00.000Z', revoked_at: null, expires_at: null },
      ],
    })
    const r = classifyMember(data.members[0], ctxFor(data))
    expect(['test', 'connector-debris', 'duplicate']).not.toContain(r.class)
    expect(r.class).toBe('review')
  })

  it('R-M7: dormant when old, no capability, and no activity beyond a stale creation date', () => {
    const oldAsOf = Date.parse('2026-09-26T15:10:00.000Z')
    const data = baseData({
      members: [{ id: 'old1', display_name: 'Old Thing', email: '', status: 'suspended', created_at: '2026-06-01T00:00:00.000Z', has_tg: 0 }],
      memberTokens: [{ member_id: 'old1', label: '', channel: 'workspace', created_at: '2026-06-01T00:05:00.000Z', revoked_at: null, expires_at: null }, { member_id: 'old1', label: '', channel: 'workspace', created_at: '2026-06-02T00:05:00.000Z', revoked_at: null, expires_at: null }],
    })
    const r = classifyMember(data.members[0], ctxFor(data, oldAsOf))
    expect(r.class).toBe('dormant')
  })
})

describe('classifyAgent', () => {
  it('R-A1: DNU-slugged agent is test', () => {
    const data = baseData({ agents: [{ id: 'a1', slug: 'dnu-cursor', name: 'DNU Cursor', status: 'active', squad_id: 'dnu-sq', created_at: '2026-09-16T20:50:26.010Z' }] })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('test')
  })

  it('R-A2: walker-named agent is test', () => {
    const data = baseData({ agents: [{ id: 'a1', slug: 'uc1-walker', name: 'UC-1 Walker', status: 'active', squad_id: 'sq1', created_at: '2026-09-21T17:52:25.989Z' }] })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('test')
  })

  it('R-A3: explicit (retired) marker is dormant', () => {
    const data = baseData({ agents: [{ id: 'a1', slug: 'kayhermes-retired-921befae', name: 'kayhermes (retired)', status: 'inactive', squad_id: 'sq1', created_at: '2026-09-10T00:15:25.090Z' }] })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('dormant')
  })

  it('R-A4: inactive agent superseded by an active same-slug sibling elsewhere is dormant, not review', () => {
    const data = baseData({
      agents: [
        { id: 'old-hermes', slug: 'hadi-hermes', name: 'hadi-hermes', status: 'inactive', squad_id: 'sq-old', created_at: '2026-08-15T17:43:39.234Z' },
        { id: 'new-hermes', slug: 'hadi-hermes', name: 'hadi-hermes', status: 'active', squad_id: 'sq-new', created_at: '2026-08-15T18:17:22.608Z' },
      ],
    })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('dormant')
    expect(r.evidence.duplicate_slug_siblings).toContain('new-hermes')
  })

  it('R-A7: active agent with recent activity is real', () => {
    const data = baseData({
      agents: [{ id: 'kasra-ag', slug: 'kasra', name: 'Kasra', status: 'active', squad_id: 'squad-core', created_at: '2026-07-21T02:15:37.470Z' }],
      fleetAgents: [{ agent_id: 'kasra-ag', status: 'running', last_reported_at: '2026-09-26 15:10:24' }],
    })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('real')
  })

  it('R-A8: active agent, never seen in presence/fleet, zero squad receipts, old — dormant', () => {
    const data = baseData({
      agents: [{ id: 'seat1', slug: 'hadi-portfolio', name: 'Hadi Portfolio', status: 'active', squad_id: 'sq-hadi-cc', created_at: '2026-06-01T00:00:00.000Z' }],
    })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('dormant')
  })

  it('active agent with no activity but WITHIN the dormancy window falls to review, not dormant', () => {
    const data = baseData({
      agents: [{ id: 'seat1', slug: 'freshseat', name: 'Fresh Seat', status: 'active', squad_id: 'sq1', created_at: '2026-09-20T00:00:00.000Z' }],
    })
    const r = classifyAgent(data.agents[0], ctxFor(data))
    expect(r.class).toBe('review')
  })
})

describe('classifySquad', () => {
  it('R-S1: dnu-named squad is test', () => {
    const data = baseData({ squads: [{ id: 'sq-dnu', slug: 'dnu', name: 'DNU', kind: 'work', created_at: '2026-09-16T20:33:44.891Z' }] })
    const r = classifySquad(data.squads[0], ctxFor(data))
    expect(r.class).toBe('test')
  })

  it('R-S3: an empty squad with zero agents, caps, receipts is connector-debris', () => {
    const data = baseData({ squads: [{ id: 'sq-empty', slug: 'gavin', name: 'Gavin', kind: 'work', created_at: '2026-07-22T13:05:22.179Z' }] })
    const r = classifySquad(data.squads[0], ctxFor(data))
    expect(r.class).toBe('connector-debris')
  })

  it('R-S5: a squad with an active agent is real', () => {
    const data = baseData({
      squads: [{ id: 'squad-core', slug: 'core', name: 'Core Platform', kind: 'work', created_at: '2026-06-03 15:39:36' }],
      agents: [{ id: 'a1', slug: 'kasra', name: 'Kasra', status: 'active', squad_id: 'squad-core', created_at: '2026-07-21T02:15:37.470Z' }],
    })
    const r = classifySquad(data.squads[0], ctxFor(data))
    expect(r.class).toBe('real')
  })
})

describe('classifyProject', () => {
  it('R-P1: a verify-scratch project name is test', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'kasra-verify-1788472119-proj', name: 'Kasra Verify Proj', status: 'archived', created_at: '2026-09-03T21:48:49.062Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('test')
  })

  it('R-P2: stalled=1 is dormant regardless of status', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'dme-integration', name: 'DME Integration', status: 'archived', stalled: 1, created_at: '2026-07-18T19:11:13.739Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('dormant')
  })

  it('R-P3: already-archived non-stalled project is dormant', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'mcpwp-growth', name: 'MCPWP Growth', status: 'archived', stalled: 0, created_at: '2026-08-25T22:36:29.917Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('dormant')
  })

  it('R-P4: planned and untouched past the dormancy window is dormant (pfc-neuraya shape)', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'pfc-neuraya', name: 'Neuraya', status: 'planned', stalled: 0, created_at: '2026-09-04T18:35:09.072Z', updated_at: '2026-09-04T18:35:09.072Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('dormant')
  })

  it('R-P5: active project is real', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'mumega-com', name: 'mumega.com', status: 'active', stalled: 0, created_at: '2026-07-21T22:23:50.908Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('real')
  })

  it('planned but still within the dormancy window falls to review', () => {
    const data = baseData({ projects: [{ id: 'p1', slug: 'fresh-plan', name: 'Fresh Plan', status: 'planned', stalled: 0, created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' }] })
    const r = classifyProject(data.projects[0], ctxFor(data))
    expect(r.class).toBe('review')
  })
})

describe('runAudit + toMarkdown', () => {
  it('produces per-entity totals and a sorted-worst-first markdown table', () => {
    const data = baseData({
      members: [
        { id: 'mem-hadi', display_name: 'Hadi', email: 'hadi@mumega.com', status: 'active', created_at: '2026-06-03 15:39:36', has_tg: 0 },
        { id: 'dnu1', display_name: 'Hadi ChatGPT DNU', email: '', status: 'active', created_at: '2026-09-16T20:42:04.859Z', has_tg: 0 },
      ],
      memberIdentities: [{ member_id: 'mem-hadi', provider: 'google', created_at: '2026-09-05T01:25:27.359Z' }],
      agents: [{ id: 'a1', slug: 'dnu-cursor', name: 'DNU Cursor', status: 'active', squad_id: 'sq1', created_at: '2026-09-16T20:50:26.010Z' }],
      squads: [{ id: 'sq-dnu', slug: 'dnu', name: 'DNU', kind: 'work', created_at: '2026-09-16T20:33:44.891Z' }],
      projects: [{ id: 'p1', slug: 'mumega-com', name: 'mumega.com', status: 'active', stalled: 0, created_at: '2026-07-21T22:23:50.908Z' }],
    })
    const result = runAudit(data, { asOf: ASOF })
    expect(result.totals.members.real).toBe(1)
    expect(result.totals.members.test).toBe(1)
    expect(result.totals.agents.test).toBe(1)
    expect(result.totals.squads.test).toBe(1)
    expect(result.totals.projects.real).toBe(1)

    const md = toMarkdown(result, data)
    expect(md).toContain('## members (2)')
    // worst-first: the `test` row must appear before the `real` row in the members table.
    const memberSection = md.split('## agents')[0]
    expect(memberSection.indexOf('DNU Cursor')).toBe(-1) // sanity: agent name not leaked into member table
    expect(memberSection.indexOf('Hadi ChatGPT DNU')).toBeLessThan(memberSection.indexOf('| mem-hadi |'))
  })

  it('never emits a class outside the documented set', () => {
    const data = baseData({
      members: [{ id: 'm1', display_name: 'Whatever', email: '', status: 'active', created_at: '2026-09-01T00:00:00.000Z', has_tg: 0 }],
      agents: [{ id: 'a1', slug: 'whatever', name: 'Whatever', status: 'active', squad_id: 'sq1', created_at: '2026-09-01T00:00:00.000Z' }],
      squads: [{ id: 'sq1', slug: 'whatever', name: 'Whatever', kind: 'work', created_at: '2026-09-01T00:00:00.000Z' }],
      projects: [{ id: 'p1', slug: 'whatever', name: 'Whatever', status: 'planned', stalled: 0, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' }],
    })
    const result = runAudit(data, { asOf: ASOF })
    const allowed = new Set(['real', 'test', 'connector-debris', 'duplicate', 'dormant', 'review'])
    for (const kind of ['members', 'agents', 'squads', 'projects'] as const) {
      for (const r of result[kind]) expect(allowed.has(r.class)).toBe(true)
    }
  })
})

// Threshold constants are asserted directly so a silent edit to them is a visible diff
// in this test, not just in the script.
describe('documented thresholds', () => {
  it('RECENT_DAYS, DORMANT_DAYS, PROJECT_PLANNED_STALE_DAYS match the header comment', () => {
    expect(RECENT_DAYS).toBe(7)
    expect(DORMANT_DAYS).toBe(30)
    expect(PROJECT_PLANNED_STALE_DAYS).toBe(14)
  })
})
