-- Who coined this agent-bound key?
--
-- `member_tokens` records that a key EXISTS (id, agent_id, label, channel,
-- created_at) but never recorded the human who issued it. Until now every mint
-- door was org-admin-gated, so "some org admin did it" was a small enough set to
-- live without the record. /enroll widens issuance to squad-admin on the target
-- agent's squad — deliberately, to match the bar mint_agent_token already
-- enforces — which makes the issuing principal a fact worth keeping rather than
-- one worth inferring.
--
-- Rotation is deliberately NOT covered here: agent_token_rotation_handoffs
-- (0134) already carries minted_by_member_id, so the replacement ceremony has
-- had an actor record since it shipped. This table closes the gap on PLAIN
-- issuance, which had none.
--
-- No foreign keys, and that is on purpose — the same reasoning as agent_audit
-- (#857). `token_id REFERENCES member_tokens(id) ON DELETE CASCADE` would erase
-- the issuance record at exactly the moment someone asks "who handed this seat a
-- credential, and are they still supposed to have that power" — i.e. during
-- revocation or an incident. Dropping only the CASCADE would be worse: the
-- default NO ACTION would make token deletion fail once any key had history.
-- Orphan rows are the acceptable price of the record outliving its subject.
--
-- seq is the ordering key; created_at keeps millisecond precision for humans.
-- token_hash and the raw token are NEVER written here. This table is safe to
-- read in full by anyone who may read the audit trail.

CREATE TABLE IF NOT EXISTS agent_token_issuance_audit (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  tenant            TEXT NOT NULL,
  token_id          TEXT NOT NULL,   -- member_tokens.id of the key that was coined
  agent_id          TEXT NOT NULL,   -- the agent it was welded to
  member_id         TEXT NOT NULL,   -- the agent's canonical member envelope
  actor_member_id   TEXT NOT NULL,   -- WHO coined it: the operator principal
  actor_principal   TEXT NOT NULL,   -- their email/handle AS OF issuance time
  -- Which door. Recorded because the doors do not share an authorization bar:
  -- 'enroll' and 'mcp_mint_agent_token' gate on squad admin, 'admin_agent_token'
  -- on org admin. Reading the trail without knowing the door would flatten that
  -- difference and make a squad-scoped issuance look like an org-scoped one.
  surface           TEXT NOT NULL CHECK (surface IN (
                      'enroll',
                      'admin_agent_token',
                      'mcp_mint_agent_token',
                      'provision',
                      'bootstrap_self'
                    )),
  seat_label        TEXT NOT NULL,   -- member_tokens.label, i.e. the seat name
  grant_capability  TEXT NOT NULL,   -- the clamped squad grant the token records
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_token_issuance_agent
  ON agent_token_issuance_audit(tenant, agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_token_issuance_actor
  ON agent_token_issuance_audit(tenant, actor_member_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_token_issuance_token
  ON agent_token_issuance_audit(token_id);
