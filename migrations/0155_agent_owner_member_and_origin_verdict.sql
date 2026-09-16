-- 0155_agent_owner_member_and_origin_verdict.sql — mupot#1424 slice: a human
-- decides over their OWN agent's harness (KayHermes/Telegram), not only over
-- a raw webhook. Two prerequisites, neither of which existed before this:
--
--   1. A real member->agent OWNERSHIP column. Prod D1 probe (2026-09-16)
--      found `agent_keys` empty for the pilot agent (KayHermes), `agents.owner`
--      a free-text label with no FK semantics (63/83 rows NULL, values like
--      'hadi'/'Hadi'/'river' — a display string, not identity), and
--      `fleet_agents.member_id` NULL for it too. `memberOwnsAssigneeAgent`
--      (src/im/index.ts, agent_keys-based) answers a DIFFERENT question — "did
--      this member mint this agent's token" — and stays exactly as it is,
--      unmodified, for its existing conflict-of-interest use. This column
--      answers "who does mupot say owns this agent's harness for the purpose
--      of carrying that person's decisions" — deliberately a separate fact,
--      not a rename or a second reader of the same table.
--   2. A durable receipt for the FIRST-BIND-BY-ORIGIN path (an owned agent's
--      harness relays a human_origin whose member has no telegram_chat_id yet
--      — bind it, no invite/button required, Hadi's direct instruction
--      2026-09-16) and a place on task_verdicts to say a verdict was decided
--      BY the member but VIA an agent's attested origin, and which agent
--      vouched for it.
--
-- No FK enforcement in D1/SQLite by default — REFERENCES is documentation;
-- validity is checked in application code (updateAgentProfile,
-- resolveHarnessAttestedOrigin), same discipline the rest of this schema uses
-- (see MEMBER_BIND_ELIGIBLE_SQL's own header in src/members/project-invites.ts).

ALTER TABLE agents ADD COLUMN owner_member_id TEXT REFERENCES members(id);

CREATE INDEX IF NOT EXISTS idx_agents_owner_member_id
  ON agents(owner_member_id)
  WHERE owner_member_id IS NOT NULL;

-- task_verdicts: which agent's harness vouched for the origin, and the fixed
-- label distinguishing this write path from an ordinary member/agent verdict.
-- Both NULL for every existing and every ordinary future row — this is
-- strictly additive, no backfill, no change to writeVerdict's existing callers.
ALTER TABLE task_verdicts ADD COLUMN decided_via TEXT
  CHECK (decided_via IS NULL OR decided_via = 'agent_attested_origin');
ALTER TABLE task_verdicts ADD COLUMN origin_agent_id TEXT REFERENCES agents(id);

-- Per-(agent, chat) rate limit (src/im/origin-verdict.ts,
-- recentAppliedOriginExists): at most one APPLIED harness-attested verdict
-- per (origin_agent_id, chat) per 30s, checked by joining to members.
-- telegram_chat_id via decided_by — reuses task_verdicts as its own receipt
-- ledger rather than a new table. Partial index: only rows this query ever
-- reads carry a non-NULL origin_agent_id.
CREATE INDEX IF NOT EXISTS idx_task_verdicts_origin_agent_decided_at
  ON task_verdicts(origin_agent_id, decided_at)
  WHERE origin_agent_id IS NOT NULL;

-- Append-only receipt for a first-bind-by-origin event: an owned agent's
-- harness relayed a human_origin for a member who had no telegram_chat_id yet,
-- and mupot bound it in the same request, before resolving the verdict.
-- Deliberately its OWN table, not a reuse of CLAIM_INVITE_SQL's invite-bind
-- path (0154) or telegram_unbind_receipts (0154): there is no invite here —
-- no pairing code, no project/squad, no minter — the binding authority is
-- entirely "this agent's owner_member_id says so", which CLAIM_INVITE_SQL's
-- statement has no field for and should not be made to grow one just to fit
-- this shape. Follows 0154's telegram_unbind_receipts append-only pattern:
-- one small table per action class, no UPDATE, no DELETE.
CREATE TABLE IF NOT EXISTS telegram_origin_bind_receipts (
  id          TEXT PRIMARY KEY,
  tenant      TEXT NOT NULL,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  chat_id     TEXT NOT NULL CHECK (length(trim(chat_id)) > 0),
  message_id  TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_origin_bind_receipts_member
  ON telegram_origin_bind_receipts(tenant, member_id, created_at DESC);

CREATE TRIGGER telegram_origin_bind_receipts_no_update
BEFORE UPDATE ON telegram_origin_bind_receipts
BEGIN
  SELECT RAISE(ABORT, 'telegram_origin_bind_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER telegram_origin_bind_receipts_no_delete
BEFORE DELETE ON telegram_origin_bind_receipts
BEGIN
  SELECT RAISE(ABORT, 'telegram_origin_bind_receipts is append-only: DELETE is forbidden');
END;

-- Replay protection for the harness-attested-origin verdict path reuses
-- `telegram_webhook_receipts` (0152) as-is via reserveTelegramUpdate /
-- completeTelegramUpdate (src/im/telegram-receipts.ts) — no new table. Its
-- `update_id` column is unconstrained TEXT (no format CHECK), so a synthetic
-- key of the shape `origin:telegram:<chat_id>:<message_id>` fits the existing
-- PRIMARY KEY (tenant, update_id) fence without a schema change. See
-- src/im/origin-verdict.ts.
