-- 0141_agent_sessions.sql — the queryable, listable, revocable runtime-session
-- registry for an AGENT's authenticated connection, mirroring migration
-- 0140_web_sessions.sql's registry for a HUMAN's.
--
-- Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
-- elevation-design.md, "Agent runtime session". Delivery Sequence step 2
-- (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
--
-- Both workspace-bearer and OAuth (directory) authentication resolve to ONE
-- server-derived runtime-session row here. Its whole purpose is Delivery
-- Sequence step 3 (elevation ledger): a human-approved grant will bind to the
-- EXACT agent_sessions.id that asked, never to the agent as a whole — so
-- elevating one session must never elevate a sibling token/session for the
-- same agent.
--
-- credential_id is NOT a secret and is deliberately NOT hashed, unlike
-- web_sessions.id_hash. web_sessions hashes a RAW, client-presented,
-- attacker-stealable cookie value that is looked up on every request — a
-- leaked D1 row would otherwise be a usable session-hijack credential.
-- credential_id here carries no such power: it is the SAME server-derived,
-- already-revalidated join key this codebase already re-checks on every
-- request — auth.tokenId, the live member_tokens.id backing the presented
-- bearer, for EITHER channel. A workspace/im/dashboard-channel agent token IS
-- a member_tokens row; a directory-channel (OAuth) agent token is ALSO a
-- member_tokens row (channel='directory') per src/mcp/oauth-authorize.ts
-- buildAuthContext, which re-reads it fresh every request rather than
-- freezing it into OAuth props (the codebase's existing "C2" live-resolution
-- rule). Knowing a row's credential_id does not let anyone authenticate as
-- that agent — the actual bearer secret stays hashed one table over
-- (member_tokens.token_hash) and is never touched or duplicated here.
--
-- auth_kind distinguishes the two doors this join key can come from, per the
-- design's CHECK. Both resolve through member_tokens today; the distinction
-- is kept (not collapsed to one enum) because the design's Failure Behavior
-- names an OAuth-refresh-continuity failure mode ("session grant is ignored,
-- never widened to the whole agent") that a future refresh-handling change
-- may need to treat differently from workspace-token rotation.
--
-- idle_expires_at / absolute_expires_at reuse web_sessions' exact independent-
-- ceiling discipline (see that migration's comment) — v1 policy here is the
-- same 24h idle / 7d absolute (src/auth/agent-sessions.ts). Unlike a human
-- login, an agent credential has no discrete "log in" event to naturally mint
-- a fresh row on expiry: resolveAgentSession's get-or-create RETIRES an
-- idle/absolute-dead row (marks it revoked_at with a reason) and mints a
-- fresh id for the SAME credential on next use. This is deliberate — it lets
-- a Delivery-Sequence-step-3 elevation grant, which will bind to one exact
-- agent_sessions.id, actually lapse on a real cadence instead of riding a
-- session-tracking row that never dies (the parent task's fact 3: "nothing
-- revokes capabilities today" — this table exists specifically so this kind
-- of state does not join that list).
--
-- Only one LIVE (revoked_at IS NULL) row may exist per (tenant, auth_kind,
-- credential_id) at a time — enforced by a PARTIAL unique index rather than a
-- table constraint, precisely so a retired dead row can coexist with its
-- successor as history (mirrors web_sessions' "history, not just current"
-- listing contract — see src/auth/web-sessions.ts listWebSessions).
--
-- seat is free text — the SAME seat label check_in already accepts (see
-- normalizeSevenAxis / SEVEN_AXIS_HARNESSES in src/mcp/index.ts), populated
-- only when a check_in call names one. It is NOT a foreign key into
-- runtime_seats (migration 0122_runtime_seats_fences.sql): that table tracks
-- fenced process generations for the separate fleet-runtime attestation
-- concern, and one session almost always outlives any single process
-- generation. Recording the human-facing seat label here (nullable — "the
-- seat/body where determinable") is enough for a future grant to show "which
-- body asked" without conflating two different identity concepts.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  member_id           TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  auth_kind           TEXT NOT NULL CHECK (auth_kind IN ('workspace_token','oauth')),
  credential_id       TEXT NOT NULL,
  seat                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT,
  revoke_reason       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_live_credential
  ON agent_sessions(tenant, auth_kind, credential_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
  ON agent_sessions(tenant, agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_member
  ON agent_sessions(tenant, member_id);
