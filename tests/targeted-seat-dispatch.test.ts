// tests/targeted-seat-dispatch.test.ts — Migration 0120: targeted seat mailboxes and partition leasing.
//
// Proves:
//   (a) send() with target_seat persists target_seat in agent_messages.
//   (b) inbox()/inbox_lease() with a seat-bound token fetch only that seat's messages
//       + broadcast (target_seat IS NULL) messages.
//   (c) A seat-bound token's inbox()/inbox_lease() do NOT consume or drain another seat's
//       mail, even when the caller explicitly asks for it via args.seat.
//   (d) A caller with NO seat bound to its token (a legacy/generic family token, or an
//       unbound token) still only sees broadcast mail on an unscoped read — it can never
//       reach into a seat-labelled partition it does not hold the matching token for.
//   (e) Schema ratchets and migration numbering remain 100% GREEN.
//
// mupot#1254 C1 (kasra-code, flight-20260902-seat-bind): this file used to drive both seats
// off ONE shared, seat-less auth object and let `args.seat` alone pick the partition — which
// is exactly the caller-controlled-partition hole #1254 named and deferred here. Fixed by
// binding the seat to the LIVE `member_tokens.label` for `auth.tokenId` (see
// resolveBoundSeat in src/mcp/index.ts): each physical seat now needs its OWN seat-labelled
// token (mintAgentBoundToken, same path /enroll and mint_agent_token use), and args.seat is
// only ever a same-value compat echo of that token's own bound seat.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { mintAgentBoundToken } from '../src/members/service'
import type { AuthContext, Env } from '../src/types'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('targeted seat dispatch & isolated mailboxes (Migration 0120 + mupot#1254 seat-bind)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const senderAgentId = 'a-sender'
  const senderMemberId = 'm-sender'
  const familyAgentId = 'a-grok-family'
  const familyMemberId = 'm-grok-family'
  const SEAT_ALPHA = 'cursor-mupot-setup'
  const SEAT_BETA = 'Mumega Ceo'

  const senderAuth: AuthContext = {
    memberId: senderMemberId,
    boundAgentId: senderAgentId,
    tenant,
    role: 'member',
    channel: 'workspace',
    capabilities: [{ member_id: senderMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
  }

  // The pre-fix "legacy" family auth: bound to the agent, but its token (tok-f, label
  // 'family') carries no SEAT label at all — resolveBoundSeat returns null for it. This is
  // the honest shape of "a caller who holds *an* agent-bound token but not a seat-scoped
  // one" — it must behave exactly like an unbound-seat caller: unscoped reads only, and any
  // explicit args.seat is refused (seat_not_bound), never silently honoured.
  const familyAuthNoSeat: AuthContext = {
    memberId: familyMemberId,
    boundAgentId: familyAgentId,
    tenant,
    role: 'member',
    channel: 'workspace',
    capabilities: [{ member_id: familyMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    tokenId: 'tok-f',
  }

  // Populated in beforeAll once the seat-labelled tokens are minted.
  let familyAuthAlpha: AuthContext
  let familyAuthBeta: AuthContext

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHashSender = await sha256('tok-sender')
    const tokHashFamily = await sha256('tok-family')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));

      -- Sender Agent
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${senderMemberId}', '${tenant}', 'Sender Agent', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${senderAgentId}', '${squadId}', 'sender-agent', 'Sender Agent', 'agent', 'grok-beta', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${senderAgentId}', '${senderMemberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-s', '${senderMemberId}', '${tenant}', '${tokHashSender}', '${senderAgentId}', 'sender', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-s', '${senderMemberId}', 'squad', '${squadId}', 'member');

      -- Recipient Family Agent (e.g. hadi-grok-desktop) — one identity, multiple physical
      -- seats. The legacy 'family' token (label='family', no seat) models a caller that
      -- holds AN agent-bound token but not a seat-scoped one.
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${familyMemberId}', '${tenant}', 'hadi-grok-desktop', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${familyAgentId}', '${squadId}', 'hadi-grok-desktop', 'hadi-grok-desktop', 'agent', 'grok-beta', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${familyAgentId}', '${familyMemberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-f', '${familyMemberId}', '${tenant}', '${tokHashFamily}', '${familyAgentId}', 'family', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-f', '${familyMemberId}', 'squad', '${squadId}', 'member');
    `)

    const sessionsStore = new Map<string, string>()
    const mockSessions = {
      get: async (k: string) => sessionsStore.get(k) ?? null,
      put: async (k: string, v: string) => { sessionsStore.set(k, v) },
      delete: async (k: string) => { sessionsStore.delete(k) },
    }

    env = {
      TENANT_SLUG: tenant,
      DB: harness.db,
      SESSIONS: mockSessions,
    } as unknown as Env

    // Mint the two REAL seat-labelled tokens — the same path /enroll and mint_agent_token
    // use (mintAgentBoundToken's "LATER MINTS: token only" branch: familyAgentId is already
    // bound to familyMemberId above, so this just adds a new member_tokens row).
    const agentForMint = { id: familyAgentId, slug: 'hadi-grok-desktop', name: 'hadi-grok-desktop', squad_id: squadId }
    const alpha = await mintAgentBoundToken(env, agentForMint as never, SEAT_ALPHA)
    const beta = await mintAgentBoundToken(env, agentForMint as never, SEAT_BETA)

    familyAuthAlpha = { ...familyAuthNoSeat, tokenId: alpha.tokenId }
    familyAuthBeta = { ...familyAuthNoSeat, tokenId: beta.tokenId }
  })

  afterAll(() => {
    harness.close()
  })

  it('send with seat persists target_seat in D1', async () => {
    // Send targeted message to Seat Alpha
    const resA = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello Seat Alpha only',
      seat: SEAT_ALPHA,
      request_id: 'req-alpha-1',
    })
    expect(resA.ok).toBe(true)
    if (resA.ok) {
      expect((resA.result as any).target_seat).toBe(SEAT_ALPHA)
    }

    // Send targeted message to Seat Beta
    const resB = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello Mumega Ceo desktop only',
      seat: SEAT_BETA,
      request_id: 'req-beta-1',
    })
    expect(resB.ok).toBe(true)

    // Send broadcast family message (no seat specified)
    const resC = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello all family seats',
      request_id: 'req-family-1',
    })
    expect(resC.ok).toBe(true)

    // Verify D1 rows
    const rows = harness.sqlite.prepare(
      `SELECT body, target_seat FROM agent_messages WHERE to_agent = ? ORDER BY seq ASC`,
    ).all(familyAgentId) as Array<{ body: string; target_seat: string | null }>

    expect(rows).toHaveLength(3)
    expect(rows[0].target_seat).toBe(SEAT_ALPHA)
    expect(rows[1].target_seat).toBe(SEAT_BETA)
    expect(rows[2].target_seat).toBeNull()
  })

  it('seat-bound inbox() consumes only its OWN seat + broadcast, leaving the other seat untouched', async () => {
    // Seat Alpha's OWN token reads its inbox with consume. Its bound seat is applied even
    // though args.seat is also passed here as a same-value compat echo (see next test for
    // the omitted-args.seat case).
    const readAlpha = await invokeTool(familyAuthAlpha, env, 'inbox', {
      seat: SEAT_ALPHA,
      peek: false,
    })

    expect(readAlpha.ok).toBe(true)
    if (readAlpha.ok) {
      const msgs = (readAlpha.result as any).messages as any[]
      // Should receive: "Hello Seat Alpha only" and "Hello all family seats" (broadcast)
      // Should NOT receive: "Hello Mumega Ceo desktop only"
      expect(msgs).toHaveLength(2)
      expect(msgs.some((m) => m.body === 'Hello Seat Alpha only')).toBe(true)
      expect(msgs.some((m) => m.body === 'Hello all family seats')).toBe(true)
      expect(msgs.some((m) => m.body === 'Hello Mumega Ceo desktop only')).toBe(false)
    }

    // Now Seat Beta's OWN token reads its inbox — omitting args.seat entirely. The bound
    // seat is applied automatically; this is the fix ALSO closing the "seat mail never
    // delivered because nothing derived the seat from the token" delivery gap.
    const readBeta = await invokeTool(familyAuthBeta, env, 'inbox', {
      peek: false,
    })

    expect(readBeta.ok).toBe(true)
    if (readBeta.ok) {
      const msgs = (readBeta.result as any).messages as any[]
      // Its targeted message must still be unread and delivered here!
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Hello Mumega Ceo desktop only')
      expect(msgs[0].target_seat).toBe(SEAT_BETA)
    }
  })

  it('KILL-WITNESS: Seat Alpha cannot read, lease, or drain Seat Beta by passing args.seat — refused, not silently rescoped', async () => {
    // Fresh messages for this test.
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Protected Beta Message',
      seat: SEAT_BETA,
      request_id: 'req-beta-kill-witness',
    })

    // Seat Alpha's token tries to read Seat Beta's mail by naming it explicitly.
    const stolenRead = await invokeTool(familyAuthAlpha, env, 'inbox', {
      seat: SEAT_BETA,
      peek: false,
    })
    expect(stolenRead.ok).toBe(false)
    if (!stolenRead.ok) {
      expect(stolenRead.status).toBe(403)
      expect(stolenRead.error).toBe('seat_mismatch')
    }

    // Same attempt via inbox_lease.
    const stolenLease = await invokeTool(familyAuthAlpha, env, 'inbox_lease', {
      seat: SEAT_BETA,
    })
    expect(stolenLease.ok).toBe(false)
    if (!stolenLease.ok) {
      expect(stolenLease.status).toBe(403)
      expect(stolenLease.error).toBe('seat_mismatch')
    }

    // Verify in D1: Protected Beta Message MUST STILL HAVE read_at IS NULL and no lease.
    const betaRow = harness.sqlite.prepare(
      `SELECT body, target_seat, read_at, lease_expires_at FROM agent_messages WHERE request_id = 'req-beta-kill-witness'`,
    ).get() as { body: string; target_seat: string; read_at: string | null; lease_expires_at: string | null }
    expect(betaRow.body).toBe('Protected Beta Message')
    expect(betaRow.target_seat).toBe(SEAT_BETA)
    expect(betaRow.read_at).toBeNull()
    expect(betaRow.lease_expires_at).toBeNull()

    // Positive control: Seat Beta's OWN token reads it fine.
    const legitRead = await invokeTool(familyAuthBeta, env, 'inbox', { peek: false })
    expect(legitRead.ok).toBe(true)
    if (legitRead.ok) {
      const msgs = (legitRead.result as any).messages as any[]
      expect(msgs.some((m) => m.body === 'Protected Beta Message')).toBe(true)
    }
  })

  it('inbox_lease partitions visibility by seat correctly', async () => {
    // Send two new messages
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Lease target Alpha',
      seat: SEAT_ALPHA,
      request_id: 'req-alpha-lease',
    })

    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Lease target Beta',
      seat: SEAT_BETA,
      request_id: 'req-beta-lease',
    })

    // Lease for Alpha — its own token, no args.seat needed.
    const leaseAlpha = await invokeTool(familyAuthAlpha, env, 'inbox_lease', {})
    expect(leaseAlpha.ok).toBe(true)
    if (leaseAlpha.ok) {
      const msgs = (leaseAlpha.result as any).messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Lease target Alpha')
      expect(msgs[0].target_seat).toBe(SEAT_ALPHA)
    }

    // Lease for Beta — its own token, args.seat passed as a matching compat echo.
    const leaseBeta = await invokeTool(familyAuthBeta, env, 'inbox_lease', {
      seat: SEAT_BETA,
    })
    expect(leaseBeta.ok).toBe(true)
    if (leaseBeta.ok) {
      const msgs = (leaseBeta.result as any).messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Lease target Beta')
      expect(msgs[0].target_seat).toBe(SEAT_BETA)
    }
  })

  it('a token bound to a DIFFERENT seat ("family") is refused seat_mismatch, not silently rescoped, and its unscoped read stays broadcast-only', async () => {
    // Send a fresh seat-targeted message and a fresh broadcast message.
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Seat-targeted, unreachable by the family token',
      seat: SEAT_ALPHA,
      request_id: 'req-alpha-noseat',
    })
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Broadcast Family Message',
      request_id: 'req-broadcast-noseat',
    })

    // tok-f's own bound seat is 'family' (its member_tokens.label) — naming a DIFFERENT
    // seat is refused as a mismatch, exactly like Alpha naming Beta above.
    const namedSeatDenied = await invokeTool(familyAuthNoSeat, env, 'inbox', {
      seat: SEAT_ALPHA,
      peek: true,
    })
    expect(namedSeatDenied.ok).toBe(false)
    if (!namedSeatDenied.ok) {
      expect(namedSeatDenied.status).toBe(403)
      expect(namedSeatDenied.error).toBe('seat_mismatch')
    }

    // Its unscoped (no args.seat) read now auto-applies ITS OWN bound seat ('family') —
    // still broadcast-only here because nothing was ever sent with seat: 'family'.
    const unScopedRead = await invokeTool(familyAuthNoSeat, env, 'inbox', {
      peek: false,
    })
    expect(unScopedRead.ok).toBe(true)
    if (unScopedRead.ok) {
      const msgs = (unScopedRead.result as any).messages as any[]
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Broadcast Family Message')
      expect(msgs[0].target_seat).toBeNull()
    }

    // Verify in D1: the seat-targeted row MUST STILL HAVE read_at IS NULL — never drained
    // by the 'family' token, scoped or not.
    const alphaRow = harness.sqlite.prepare(
      `SELECT body, target_seat, read_at FROM agent_messages WHERE request_id = 'req-alpha-noseat'`,
    ).get() as { body: string; target_seat: string; read_at: string | null }
    expect(alphaRow.body).toBe('Seat-targeted, unreachable by the family token')
    expect(alphaRow.target_seat).toBe(SEAT_ALPHA)
    expect(alphaRow.read_at).toBeNull()
  })

  it('a token with NO label at all (empty string, the column default) cannot name any seat — seat_not_bound', async () => {
    // A raw token row with label = '' (member_tokens.label's NOT NULL DEFAULT '') — the
    // shape of a token minted before seats existed, or with no label ever supplied.
    const tokHashBare = await sha256('tok-bare-no-label')
    harness.sqlite.exec(`
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-bare', '${familyMemberId}', '${tenant}', '${tokHashBare}', '${familyAgentId}', '', 'workspace', datetime('now'));
    `)
    const bareAuth: AuthContext = { ...familyAuthNoSeat, tokenId: 'tok-bare' }

    const namedSeatDenied = await invokeTool(bareAuth, env, 'inbox', { seat: SEAT_ALPHA, peek: true })
    expect(namedSeatDenied.ok).toBe(false)
    if (!namedSeatDenied.ok) {
      expect(namedSeatDenied.status).toBe(403)
      expect(namedSeatDenied.error).toBe('seat_not_bound')
    }

    const leaseDenied = await invokeTool(bareAuth, env, 'inbox_lease', { seat: SEAT_BETA })
    expect(leaseDenied.ok).toBe(false)
    if (!leaseDenied.ok) {
      expect(leaseDenied.status).toBe(403)
      expect(leaseDenied.error).toBe('seat_not_bound')
    }

    // Unscoped (no args.seat) still works exactly as before this fix.
    const unScoped = await invokeTool(bareAuth, env, 'inbox', { peek: true })
    expect(unScoped.ok).toBe(true)
  })

  it('unbound token (no auth.tokenId at all) — args.seat refused, unscoped inbox() unchanged', async () => {
    const unboundAuth: AuthContext = { ...familyAuthNoSeat, tokenId: null }

    const denied = await invokeTool(unboundAuth, env, 'inbox', { seat: SEAT_ALPHA })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.status).toBe(403)
      expect(denied.error).toBe('seat_not_bound')
    }

    const unScoped = await invokeTool(unboundAuth, env, 'inbox', { peek: true })
    expect(unScoped.ok).toBe(true)
  })

  it('inbox_ack is unaffected by seat binding — scoped by to_agent only, by design (no seat argument exists on it)', async () => {
    // Send a seat-targeted message and lease it with Beta's own (correctly bound) token.
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Ack scoping check',
      seat: SEAT_BETA,
      request_id: 'req-beta-ack-check',
    })
    const leased = await invokeTool(familyAuthBeta, env, 'inbox_lease', {})
    expect(leased.ok).toBe(true)
    const leasedMsgs = leased.ok ? ((leased.result as any).messages as any[]) : []
    const target = leasedMsgs.find((m) => m.body === 'Ack scoping check')
    expect(target).toBeDefined()

    // inbox_ack takes no `seat` arg — Alpha's token CAN ack it purely because it knows the
    // id and both tokens are welded to the same to_agent. This is documented, pre-existing,
    // unchanged-by-this-PR behavior (see the comment above toolInboxAck in src/mcp/index.ts).
    // NOTE (corrected on kasra-review's round-2 gate): this test only proves ackAgentMessages
    // never checks target_seat — it does NOT prove Alpha has no way to learn a seat-B id. Two
    // separate, pre-existing, out-of-scope channels still leak ids/bodies across seats
    // (inbox_dead_letters, project_context message projections) — see toolInboxAck's own
    // comment and mumega-com#1176. Not fixed here.
    const ackByAlpha = await invokeTool(familyAuthAlpha, env, 'inbox_ack', { ids: [target.id] })
    expect(ackByAlpha.ok).toBe(true)
    if (ackByAlpha.ok) {
      expect((ackByAlpha.result as any).acked).toContain(target.id)
    }
  })

  // mupot#1272 adversarial-gate P1 (kasra-review round 2, proved A/B against base): the
  // read side above is now strictly seat-bound, but `send` only checked isRef(target_seat) —
  // any syntactically valid string, typo included. A target_seat matching no LIVE token
  // label for the recipient created an ORPHAN row no MCP surface could ever read back
  // (inbox/inbox_lease are label-bound; inbox_ack needs an id nobody can obtain;
  // inbox_dead_letters needs delivery_attempts/dead_lettered_at, which only the lease path
  // sets, and lease can't see the row either) — and MAX_UNREAD_PER_RECIPIENT (per to_agent,
  // seat-blind) meant enough orphans permanently DoS'd the whole agent's inbox. Closed by
  // validating target_seat against a live member_tokens.label for the recipient inside
  // sendAgentMessage itself (src/agents/messages.ts), so both the MCP `send` tool and the
  // REST `POST /api/inbox/send` route get it from one place.
  //
  // ROUND 3 (kasra-review): the first version of this test asserted a distinct
  // `seat_unknown` reason + a confirming detail string — that shape IS an enumeration
  // oracle (a sender can distinguish "seat exists, not live/yours" from "no such seat/
  // target" for free). Refusal is now collapsed onto `send_target_not_visible` — the SAME
  // string this codebase already uses for "no such recipient" / "recipient not visible to
  // you" — with no detail at all.
  it('send to a seat matching no LIVE token label is refused with the SAME non-disclosing shape as an invisible target, and creates NO orphan row', async () => {
    const before = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
    ).get(familyAgentId) as { n: number }

    // Case-mismatch of the real SEAT_BETA label ('Mumega Ceo') — exactly the human-typo shape
    // the reviewer's PoC used.
    const res = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Orphan attempt — typo seat',
      seat: 'mumega ceo',
      request_id: 'req-orphan-attempt',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // 404 + 'send_target_not_visible' is the EXACT status/reason a nonexistent or
      // not-yours recipient gets (see the ternary in toolSend, src/mcp/index.ts) — a bad
      // seat must be indistinguishable from a bad recipient.
      expect(res.status).toBe(404)
      expect(res.error).toBe('send_target_not_visible')
      // No confirming detail string — nothing in the response should name the seat, the
      // recipient's real seats, or otherwise distinguish this refusal from any other
      // send_target_not_visible.
      expect((res as { detail?: unknown }).detail).toBeUndefined()
    }

    // Recovery assertion: the row this would have orphaned was never written.
    const after = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
    ).get(familyAgentId) as { n: number }
    expect(after.n).toBe(before.n)
    expect(
      harness.sqlite.prepare(`SELECT id FROM agent_messages WHERE request_id = 'req-orphan-attempt'`).get(),
    ).toBeUndefined()
  })

  it('send to a real bound seat still succeeds — positive control for the new write-side guard', async () => {
    const res = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Positive control send',
      seat: SEAT_ALPHA,
      request_id: 'req-positive-control-send',
    })
    expect(res.ok).toBe(true)

    const read = await invokeTool(familyAuthAlpha, env, 'inbox', { peek: true })
    expect(read.ok).toBe(true)
    if (read.ok) {
      const msgs = (read.result as any).messages as any[]
      expect(msgs.some((m) => m.body === 'Positive control send')).toBe(true)
    }
  })

  it('args.seat = "" (empty string) normalizes to "no seat requested" — the token\'s own bound seat applies, not a spurious mismatch', async () => {
    // ROUND 3 comment fix (kasra-review nit): this does NOT reproduce "pre-fix behavior" —
    // pre-fix, seat:'' gave broadcast-ONLY (the read-side normalization lived in
    // readAgentInboxForReader/leaseAgentInbox and target_seat was never auto-applied from the
    // token at all). Post-fix, '' is treated as "args.seat was not really supplied," which
    // means the bound token's OWN seat (SEAT_ALPHA here) is what actually gets used — the same
    // always-apply-your-own-seat semantic every other omitted-args.seat call gets. What this
    // test actually pins: '' must NOT be compared against boundSeat as if it were a real,
    // different value (which would spuriously 403 seat_mismatch, since '' !== SEAT_ALPHA).
    const res = await invokeTool(familyAuthAlpha, env, 'inbox', { seat: '', peek: true })
    expect(res.ok).toBe(true)

    const whitespaceRes = await invokeTool(familyAuthAlpha, env, 'inbox_lease', { seat: '   ' })
    expect(whitespaceRes.ok).toBe(true)
  })

  // mupot#1272 adversarial-gate round 3 (kasra-review, Pattern 6): "delete the whole guard"
  // going red proves the guard RUNS, not that any one of its WHERE conjuncts matters. Mutating
  // src/agents/messages.ts's new send-side check (`t.tenant = ?1 AND t.agent_id = ?2 AND
  // t.label = ?3 AND TOKEN_LIVE_PREDICATE(?4)`) one conjunct at a time found THREE that
  // survived deletion with zero test coverage — one test per conjunct below closes that.
  describe('send-side seat guard — each WHERE conjunct proven individually', () => {
    it('a REVOKED token\'s label is not live — send refused (closes the TOKEN_LIVE_PREDICATE conjunct)', async () => {
      const agentForMint = { id: familyAgentId, slug: 'hadi-grok-desktop', name: 'hadi-grok-desktop', squad_id: squadId }
      const revoked = await mintAgentBoundToken(env, agentForMint as never, 'revoked-seat')
      harness.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '${revoked.tokenId}'`)

      const before = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
      ).get(familyAgentId) as { n: number }

      const res = await invokeTool(senderAuth, env, 'send', {
        to: familyAgentId,
        body: 'Revoked-seat attempt',
        seat: 'revoked-seat',
        request_id: 'req-revoked-seat-attempt',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(404)
        expect(res.error).toBe('send_target_not_visible')
      }

      const after = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
      ).get(familyAgentId) as { n: number }
      expect(after.n).toBe(before.n)
    })

    it('a live label bound to a DIFFERENT agent is not accepted — send refused (closes the t.agent_id conjunct, the deliberate-orphan-manufacture case)', async () => {
      // A REAL, LIVE token — just welded to senderAgentId, not familyAgentId. Without the
      // t.agent_id conjunct, this would let anyone who knows ANY live seat label anywhere in
      // the tenant manufacture an orphan on an unrelated recipient.
      const senderForMint = { id: senderAgentId, slug: 'sender-agent', name: 'Sender Agent', squad_id: squadId }
      await mintAgentBoundToken(env, senderForMint as never, 'cross-agent-seat')

      const before = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
      ).get(familyAgentId) as { n: number }

      const res = await invokeTool(senderAuth, env, 'send', {
        to: familyAgentId,
        body: 'Cross-agent-seat attempt',
        seat: 'cross-agent-seat',
        request_id: 'req-cross-agent-seat-attempt',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(404)
        expect(res.error).toBe('send_target_not_visible')
      }

      const after = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`,
      ).get(familyAgentId) as { n: number }
      expect(after.n).toBe(before.n)

      // Positive control: the SAME label, on the RIGHT agent, works (proves the refusal above
      // was about agent scoping, not the label itself).
      await mintAgentBoundToken(env, { id: familyAgentId, slug: 'hadi-grok-desktop', name: 'hadi-grok-desktop', squad_id: squadId } as never, 'cross-agent-seat')
      const positiveControl = await invokeTool(senderAuth, env, 'send', {
        to: familyAgentId,
        body: 'Same label, right agent',
        seat: 'cross-agent-seat',
        request_id: 'req-cross-agent-seat-positive',
      })
      expect(positiveControl.ok).toBe(true)
    })

    it('CANNOT build a cross-tenant token for an existing agent in this harness — and the reason is itself a real, enforced schema invariant', () => {
      // ROUND 3 answer to "if the harness can build a cross-tenant token do it, otherwise
      // say explicitly it cannot and why rather than faking it": it cannot, for an EXISTING
      // agent, and this is not a gap in the harness — it is `member_tokens_agent_binding_insert`
      // (migrations/0071_agent_connections.sql), a trigger that ALREADY refuses to insert any
      // member_tokens row whose (tenant, agent_id, member_id) does not match a live
      // agent_member_bindings row. familyAgentId's only real binding is
      // (tenant='mumega', agent_id=familyAgentId, member_id=familyMemberId) — attempting a
      // member_tokens row for the SAME agent under a different tenant string aborts BEFORE it
      // ever reaches my new guard's `t.tenant = ?1` conjunct. Proving that with a real failing
      // INSERT (not asserting it in prose) is the honest version of "cannot":
      expect(() => {
        harness.sqlite.exec(`
          INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at)
          VALUES ('tok-cross-tenant', '${familyMemberId}', 'a-different-tenant', 'cross-tenant-token-hash-stub', '${familyAgentId}', 'cross-tenant-seat', 'workspace', datetime('now'));
        `)
      }).toThrow(/agent_identity_conflict/)

      // Manufacturing the matching agent_member_bindings row under the fictitious tenant
      // first (to get PAST that trigger) is possible in raw SQL — agent_member_bindings'
      // primary key is the COMPOSITE (tenant, agent_id), not agent_id alone, so nothing at
      // the schema level stops a second binding row for the same agent under a different
      // tenant string. I deliberately did NOT do that here: it would prove something about
      // this SQLite harness's constraint enforcement, not about mupot as deployed. A real
      // mupot pot is ONE D1 database per tenant — env.TENANT_SLUG is a fixed Worker-level
      // config value, never attacker-influenced, never read from a request — so a token
      // "existing under a different tenant" is not a reachable state to defend against in the
      // first place; fabricating one here would be testing a state that cannot occur, dressed
      // up as coverage. The `t.tenant = ?1` conjunct in the new guard's SQL therefore stays
      // UNPROVEN BY MUTATION in this suite, honestly — recorded as a gap, not silently closed.
    })
  })
})
