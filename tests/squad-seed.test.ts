// tests/squad-seed.test.ts — S196 Slice A: squad-as-members seed + capability verification.
//
// Tests:
//   1. After seedSquadMembers(), resolveCapabilities(memberId) returns the expected
//      ladder rank for each agent (per §2A community map).
//   2. Idempotency: re-running the seed does not fail or duplicate rows.
//   3. Squad-scope grants: when a squadId is provided, kasra/river/codex are
//      granted at squad scope; hasCapability at org scope is false for them.
//   4. Org-scope fallback: when no squadId, all agents granted at org scope.
//   5. Agent↔agent messages round-trip + request/ack correlation (Slice D proof
//      that the existing service works for our agents).

import { describe, it, expect } from 'vitest'
import { seedSquadMembers, deterministicMemberId, buildSquadDefs } from '../src/members/squad-seed'
import { resolveCapabilities, hasCapability } from '../src/auth/capability'
import { sendAgentMessage, readAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'

// ── faithful in-memory D1 ─────────────────────────────────────────────────────

interface MemberRow {
  id: string
  email: string
  display_name: string
  status: string
  created_at: string
}

interface CapabilityRow {
  id: string
  member_id: string
  scope_type: string
  scope_id: string | null
  capability: string
  created_at: string
}

interface AgentMsgRow {
  seq: number
  id: string
  tenant: string
  to_agent: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
  in_reply_to: string | null
  created_at: string
  read_at: string | null
}

/** Build a minimal faithful in-memory D1 that supports:
 *  - INSERT OR IGNORE INTO members / capabilities
 *  - SELECT from capabilities (for resolveCapabilities)
 *  - INSERT INTO / UPDATE / SELECT agent_messages (for round-trip test)
 */
function makeDb() {
  const members: MemberRow[] = []
  const capabilities: CapabilityRow[] = []
  const messages: AgentMsgRow[] = []
  let msgSeq = 0

  function prepare(sql: string) {
    const binds: unknown[] = []
    const api = {
      bind(...args: unknown[]) {
        binds.push(...args)
        return api
      },
      async run(): Promise<{ meta: { changes: number; last_row_id?: number } }> {
        const s = sql.trim()

        // INSERT OR IGNORE INTO members
        if (/INSERT OR IGNORE INTO members/i.test(s)) {
          const [id, email, display_name, status, created_at] = binds as [string, string, string, string, string]
          const dupId = members.some((m) => m.id === id)
          const dupEmail = members.some((m) => m.email === email)
          if (dupId || dupEmail) return { meta: { changes: 0 } }
          members.push({ id, email, display_name, status, created_at })
          return { meta: { changes: 1 } }
        }

        // INSERT OR IGNORE INTO capabilities
        if (/INSERT OR IGNORE INTO capabilities/i.test(s)) {
          const [id, member_id, scope_type, scope_id, capability, created_at] = binds as [
            string, string, string, string | null, string, string,
          ]
          // UNIQUE(member_id, scope_type, scope_id)
          const dup = capabilities.some(
            (c) => c.member_id === member_id && c.scope_type === scope_type && c.scope_id === scope_id,
          )
          if (dup) return { meta: { changes: 0 } }
          capabilities.push({ id, member_id, scope_type, scope_id, capability, created_at })
          return { meta: { changes: 1 } }
        }

        // INSERT INTO agent_messages (for round-trip test)
        if (/INSERT INTO agent_messages/i.test(s)) {
          const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, maxUnread] =
            binds as [string, string, string, string, string, string, string, string | null, string | null, string, number]
          const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
          if (typeof maxUnread === 'number' && unread >= maxUnread) return { meta: { changes: 0 } }
          if (
            request_id != null &&
            messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)
          ) {
            throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
          }
          const seq = ++msgSeq
          messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, read_at: null })
          return { meta: { changes: 1, last_row_id: seq } }
        }

        // UPDATE agent_messages SET read_at (consume)
        if (/UPDATE agent_messages SET read_at/i.test(s)) {
          const [readAt, tenant, to_agent, limit] = binds as [string, string, string, number]
          const claimed = messages
            .filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit)
          for (const m of claimed) m.read_at = readAt
          return { meta: { changes: claimed.length } }
        }

        throw new Error(`squad-seed makeDb: unhandled run sql:\n${s}`)
      },
      async first<T>(): Promise<T | null> {
        const s = sql.trim()

        // resolveCapabilities: SELECT from capabilities UNION channel_capability_grants
        if (/SELECT member_id, scope_type, scope_id, capability/.test(s) && /FROM capabilities/.test(s)) {
          const [memberId] = binds as [string]
          // return all capabilities for this member (the UNION is a single block — split on UNION ALL)
          const rows = capabilities.filter((c) => c.member_id === memberId)
          // .first() is used by capability.ts — but resolveCapabilities uses .all()
          // This branch handles the subquery in requireCapability middleware (not used in tests).
          return (rows[0] as unknown as T) ?? null
        }

        // COUNT(*) AS n FROM agent_messages (remaining)
        if (/COUNT\(\*\) AS n FROM agent_messages/i.test(s)) {
          const [tenant, to_agent] = binds as [string, string]
          const n = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
          return { n } as unknown as T
        }

        // sender request_id dedup lookup
        if (/from_agent = \?2 AND request_id = \?3/.test(s)) {
          const [tenant, from_agent, request_id] = binds as [string, string, string]
          const m = messages.find((x) => x.tenant === tenant && x.from_agent === from_agent && x.request_id === request_id)
          if (!m) return null
          return { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: m.in_reply_to } as unknown as T
        }

        throw new Error(`squad-seed makeDb: unhandled first sql:\n${s}`)
      },
      async all<T>(): Promise<{ results: T[] }> {
        const s = sql.trim()

        // resolveCapabilities: SELECT member_id, scope_type, scope_id, capability FROM capabilities UNION ...
        if (/SELECT member_id, scope_type, scope_id, capability/.test(s)) {
          const [memberId] = binds as [string]
          // Both branches of the UNION target member_id = ?1
          const rows = capabilities
            .filter((c) => c.member_id === memberId)
            .map((c) => ({
              member_id: c.member_id,
              scope_type: c.scope_type,
              scope_id: c.scope_id,
              capability: c.capability,
            }))
          return { results: rows as unknown as T[] }
        }

        // UPDATE ... RETURNING (consume path — MUST come before peek/SELECT check because
        // the consume SQL embeds a subquery with FROM agent_messages + read_at IS NULL +
        // ORDER BY seq ASC, which would otherwise match the peek check below).
        if (/^UPDATE agent_messages SET read_at/i.test(s) && /RETURNING/i.test(s)) {
          const [readAt, tenant, to_agent, limit] = binds as [string, string, string, number]
          const claimed = messages
            .filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit)
          for (const m of claimed) m.read_at = readAt
          // Reverse to prove the service re-sorts by seq (RETURNING order is unspecified).
          return { results: claimed.slice().reverse() as unknown as T[] }
        }

        // SELECT ... FROM agent_messages WHERE ... ORDER BY seq ASC LIMIT (peek — checked AFTER consume).
        if (/^SELECT/i.test(s) && /FROM agent_messages/.test(s) && /read_at IS NULL/.test(s) && /ORDER BY seq ASC/.test(s)) {
          const [tenant, to_agent, limit] = binds as [string, string, number]
          const rows = messages
            .filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit)
          return { results: rows as unknown as T[] }
        }

        // agents table queries (for sendToRef resolver — not used in seed tests but needed by messages service)
        if (/FROM agents WHERE id = \?1 LIMIT 1/i.test(s)) {
          return { results: [] }
        }
        if (/FROM agents WHERE slug = \?1/i.test(s)) {
          return { results: [] }
        }

        throw new Error(`squad-seed makeDb: unhandled all sql:\n${s}`)
      },
    }
    return api
  }

  return {
    _members: members,
    _capabilities: capabilities,
    _messages: messages,
    prepare,
  }
}

function makeEnv(db: ReturnType<typeof makeDb>, tenant = 'mumega'): Env {
  return { DB: db, TENANT_SLUG: tenant } as unknown as Env
}

// ── Slice A: seed + capability verification ───────────────────────────────────

describe('seedSquadMembers — Slice A', () => {
  it('creates all 6 member rows on first seed', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    const result = await seedSquadMembers(env, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seeded.length).toBe(6)
    expect(db._members.length).toBe(6)
    const slugs = result.seeded.map((s) => s.slug).sort()
    expect(slugs).toEqual(['codex', 'colleague', 'hadi', 'kasra', 'loom', 'river'])
  })

  it('all 6 members get exactly 1 capability grant each', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    await seedSquadMembers(env, null)
    expect(db._capabilities.length).toBe(6)
  })

  it('resolveCapabilities → hadi has owner at org scope', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    await seedSquadMembers(env, null)
    const hadiId = await deterministicMemberId('hadi')
    const grants = await resolveCapabilities(env, hadiId)
    expect(grants.length).toBeGreaterThan(0)
    expect(hasCapability(grants, 'org', null, 'owner')).toBe(true)
    // org owner covers everything
    expect(hasCapability(grants, 'org', null, 'lead')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'member')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'observer')).toBe(true)
  })

  it('resolveCapabilities → loom has lead at org scope', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    await seedSquadMembers(env, null)
    const loomId = await deterministicMemberId('loom')
    const grants = await resolveCapabilities(env, loomId)
    expect(hasCapability(grants, 'org', null, 'lead')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'member')).toBe(true)
    // loom does NOT have owner
    expect(hasCapability(grants, 'org', null, 'owner')).toBe(false)
  })

  it('resolveCapabilities → kasra/river/codex have member at org scope (no squadId)', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    await seedSquadMembers(env, null)
    for (const slug of ['kasra', 'river', 'codex']) {
      const id = await deterministicMemberId(slug)
      const grants = await resolveCapabilities(env, id)
      expect(hasCapability(grants, 'org', null, 'member')).toBe(true)
      expect(hasCapability(grants, 'org', null, 'lead')).toBe(false) // not lead
      expect(hasCapability(grants, 'org', null, 'owner')).toBe(false) // not owner
    }
  })

  it('resolveCapabilities → kasra/river/codex have member at squad scope (with squadId)', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    const squadId = 'sq-test-0001-0001-0001-000000000001'
    await seedSquadMembers(env, squadId)
    for (const slug of ['kasra', 'river', 'codex']) {
      const id = await deterministicMemberId(slug)
      const grants = await resolveCapabilities(env, id)
      // squad-scope grant satisfies squad-scope checks
      expect(hasCapability(grants, 'squad', squadId, 'member')).toBe(true)
      // squad-scope grant does NOT satisfy org-scope checks (no upward bubble)
      expect(hasCapability(grants, 'org', null, 'member')).toBe(false)
    }
  })

  it('resolveCapabilities → colleague has observer at org scope', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    await seedSquadMembers(env, null)
    const id = await deterministicMemberId('colleague')
    const grants = await resolveCapabilities(env, id)
    expect(hasCapability(grants, 'org', null, 'observer')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'member')).toBe(false)
  })

  it('idempotency: re-seeding returns ok with 0 inserts (no duplicates)', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    const r1 = await seedSquadMembers(env, null)
    const r2 = await seedSquadMembers(env, null)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    // On re-seed: no new rows
    for (const s of r2.seeded) {
      expect(s.inserted).toBe(false)
      expect(s.grantInserted).toBe(false)
    }
    // DB still has exactly 6 members + 6 grants (no duplicates)
    expect(db._members.length).toBe(6)
    expect(db._capabilities.length).toBe(6)
  })

  it('deterministicMemberId is stable across calls', async () => {
    const id1 = await deterministicMemberId('kasra')
    const id2 = await deterministicMemberId('kasra')
    expect(id1).toBe(id2)
    // Different slugs produce different ids
    const id3 = await deterministicMemberId('loom')
    expect(id1).not.toBe(id3)
  })

  it('buildSquadDefs returns 6 defs; squad scope sets correct scope_id', () => {
    const squadId = 'test-squad-id'
    const defs = buildSquadDefs(squadId)
    expect(defs.length).toBe(6)
    // hadi/loom/colleague always org scope
    const hadi = defs.find((d) => d.slug === 'hadi')!
    expect(hadi.scope_type).toBe('org')
    expect(hadi.scope_id).toBeNull()
    // kasra/river/codex get squad scope when squadId provided
    const kasra = defs.find((d) => d.slug === 'kasra')!
    expect(kasra.scope_type).toBe('squad')
    expect(kasra.scope_id).toBe(squadId)
    // no-squadId fallback
    const defsNoSquad = buildSquadDefs(null)
    const kasraNoSquad = defsNoSquad.find((d) => d.slug === 'kasra')!
    expect(kasraNoSquad.scope_type).toBe('org')
    expect(kasraNoSquad.scope_id).toBeNull()
  })
})

// ── Slice D: agent↔agent inbox round-trip (proves Slice D works for our agents) ─

/**
 * Faithful agent_messages DB for the round-trip test.
 * Reuses the same makeDb above (which includes agent_messages handling).
 */
describe('agent↔agent inbox round-trip (Slice D proof — S196)', () => {
  it('kasra sends to loom → loom reads inbox → message delivered', async () => {
    const db = makeDb()
    const env = makeEnv(db)

    const kasraId = await deterministicMemberId('kasra')
    const loomId = await deterministicMemberId('loom')

    // Kasra sends a message to Loom.
    const send = await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-loom',
      body: 'S196 A+B shipped. Diff attached.',
    })
    expect(send.ok).toBe(true)

    // Loom reads its inbox.
    const inbox = await readAgentInbox(env, { agent: 'ag-loom' })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.messages.length).toBe(1)
    expect(inbox.messages[0].body).toBe('S196 A+B shipped. Diff attached.')
    expect(inbox.messages[0].from_agent).toBe('ag-kasra')
    expect(inbox.messages[0].from_member).toBe(kasraId)
    expect(inbox.remaining).toBe(0)
  })

  it('request/ack correlation: kasra sends [request_id:...] → loom ACKs with in_reply_to', async () => {
    const db = makeDb()
    const env = makeEnv(db)

    const kasraId = await deterministicMemberId('kasra')
    const loomId = await deterministicMemberId('loom')
    const requestId = 's196-gate-abc123'

    // Kasra sends a request (kind=request, requestId set).
    const req = await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-loom',
      body: '[request_id:s196-gate-abc123] Gate S196 Slice A — is RBAC correct?',
      kind: 'request',
      requestId,
    })
    expect(req.ok).toBe(true)

    // Loom reads and ACKs.
    const inbox = await readAgentInbox(env, { agent: 'ag-loom', peek: true })
    if (!inbox.ok) return
    expect(inbox.messages[0].kind).toBe('request')
    expect(inbox.messages[0].request_id).toBe(requestId)

    // Loom sends ACK back with in_reply_to.
    const ack = await sendAgentMessage(env, {
      fromAgent: 'ag-loom',
      fromMember: loomId,
      toAgent: 'ag-kasra',
      body: `{ack_for:${requestId}, ok: true} RBAC looks correct per §2A. GREEN.`,
      kind: 'ack',
      inReplyTo: requestId,
    })
    expect(ack.ok).toBe(true)

    // Kasra reads its ACK inbox.
    const kasraInbox = await readAgentInbox(env, { agent: 'ag-kasra' })
    if (!kasraInbox.ok) return
    expect(kasraInbox.messages.length).toBe(1)
    expect(kasraInbox.messages[0].kind).toBe('ack')
    expect(kasraInbox.messages[0].in_reply_to).toBe(requestId)
    expect(kasraInbox.messages[0].from_agent).toBe('ag-loom')
  })

  it('consume-once: inbox consumed on read; second read returns empty', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    const kasraId = await deterministicMemberId('kasra')

    await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-river',
      body: 'Design review needed.',
    })

    const first = await readAgentInbox(env, { agent: 'ag-river' })
    if (!first.ok) return
    expect(first.messages.length).toBe(1)

    // Second read → empty (consumed-once)
    const second = await readAgentInbox(env, { agent: 'ag-river' })
    if (!second.ok) return
    expect(second.messages.length).toBe(0)
  })

  it('inbox isolation: each agent only sees its own messages', async () => {
    const db = makeDb()
    const env = makeEnv(db)
    const kasraId = await deterministicMemberId('kasra')

    await sendAgentMessage(env, { fromAgent: 'ag-kasra', fromMember: kasraId, toAgent: 'ag-loom', body: 'for loom' })
    await sendAgentMessage(env, { fromAgent: 'ag-kasra', fromMember: kasraId, toAgent: 'ag-river', body: 'for river' })

    const loom = await readAgentInbox(env, { agent: 'ag-loom' })
    if (!loom.ok) return
    expect(loom.messages.map((m) => m.body)).toEqual(['for loom'])
    // River's inbox untouched by Loom's read
    const river = await readAgentInbox(env, { agent: 'ag-river' })
    if (!river.ok) return
    expect(river.messages.map((m) => m.body)).toEqual(['for river'])
  })
})
