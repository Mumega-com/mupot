-- 0091_oauth_consent_receipts.sql — audit trail for mupot#903b agent-bound OAuth
-- consent (P1-3, adversarial review 2026-08-10).
--
-- WHY: a consent-bound directory token's member_tokens.member_id is the AGENT's
-- own dedicated member (required by 0071's member_tokens_agent_binding_insert
-- trigger — see src/mcp/oauth-authorize.ts's mintDirectoryToken comment), never
-- the connecting human. Nothing in the schema recorded "human X consented to bind
-- their session to agent A at time T" — the review's exact words: "grep for
-- emitAudit|emitProvisioned|appendAudit in oauth-authorize.ts hits comments only
-- ... the KV pending record is deleted on use." Two humans both eligible for the
-- same agent were indistinguishable in any trail; there was no trail at all.
--
-- Append-only, immutable, mirroring 0086's agent_audit precedent (same no-update/
-- no-delete shape, no controlled-exception clause needed here — this table has no
-- corrective-write path the way agent_audit's backfill did).
--
-- Migration numbering: origin/main head is 0089. The open PR #903
-- (feat/inbox-lease-ack-dlq) claims 0090. Verified via `git ls-tree -r --name-only
-- <ref> -- migrations/` across every `refs/remotes/origin/*` (not just main) —
-- 0090 is the highest anywhere, so 0091 does not collide with any open PR.

CREATE TABLE IF NOT EXISTS oauth_consent_receipts (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  token_id              TEXT NOT NULL,   -- the member_tokens row this consent minted
  consenting_member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,  -- the HUMAN
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,   -- the chosen agent
  agent_member_id       TEXT NOT NULL,   -- the agent's own dedicated member at consent time
                                          -- (= member_tokens.member_id for this token)
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_consent_receipts_agent
  ON oauth_consent_receipts(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_receipts_human
  ON oauth_consent_receipts(consenting_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_receipts_token
  ON oauth_consent_receipts(token_id);

-- Append-only: a receipt is written once, at consent time, and never corrected —
-- unlike agent_audit (0086) there is no legitimate two-phase write for this table,
-- so no controlled exception is carved out.
CREATE TRIGGER oauth_consent_receipts_no_update
BEFORE UPDATE ON oauth_consent_receipts
BEGIN
  SELECT RAISE(ABORT, 'oauth_consent_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER oauth_consent_receipts_no_delete
BEFORE DELETE ON oauth_consent_receipts
BEGIN
  SELECT RAISE(ABORT, 'oauth_consent_receipts is append-only: DELETE is forbidden');
END;
