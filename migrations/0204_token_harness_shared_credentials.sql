-- 0202_token_harness_shared_credentials.sql — mupot#1794 W4: harness recognition for TOKEN
-- credentials + shared-credential detection.
--
-- WHY: W1-W3 let an OAuth grant be a HARNESS (harnesses keyed on (tenant, member, oauth_client_id)).
-- Many real clients share ONE credential across many actors (a Codex cloud env secret, CI, a shared
-- .env, one MCP config inside Cursor / Grok bots). The identity was derived from the credential, but
-- the credential is shared, so every thread collapsed into one identity. A member-scoped TOKEN can
-- now be a harness too; each thread behind it calls seat_select and gets its own seat agent.
--
-- Behind SEAT_AUTO_ENROLL (unset in prod): with the flag off no code writes a token harness and a
-- token linked to one is inert (src/mcp/oauth-authorize.ts, src/mcp/index.ts). Additive migration.
--
-- 1. harnesses grows a credential kind. A harness is EITHER an OAuth client install OR a token.
--      credential_kind  'oauth' (every existing row, the DEFAULT) | 'token'
--      token_id         the member_tokens row that IS the harness credential (token kind only)
--    DESIGN NOTE (why oauth_client_id is not made nullable): harnesses is the PARENT of agent_seats
--    and seat_handles, both ON DELETE RESTRICT. Rebuilding a parent table to drop NOT NULL means
--    DROP TABLE harnesses, and RESTRICT is checked immediately (defer_foreign_keys does not defer
--    it), so the rebuild would fail on any pot that already holds a seat; backing the children up is
--    not possible either (agent_seats / seat_handles are no-delete by trigger). So credential_kind is
--    the discriminator and the legacy NOT NULL column carries a RESERVED 'token:<token_id>' pointer
--    for token rows, enforced by the triggers below. Nothing reads oauth_client_id for a token row.
ALTER TABLE harnesses ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'oauth' CHECK (credential_kind IN ('oauth', 'token'));
ALTER TABLE harnesses ADD COLUMN token_id TEXT;

-- One harness per token; the existing UNIQUE (tenant, member_id, oauth_client_id) already makes the
-- reserved pointer unique too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_harnesses_token ON harnesses (tenant, token_id) WHERE token_id IS NOT NULL;

-- Shape guard, inside the inserting statement/batch. A token harness must point at a live-shaped
-- UNBOUND directory token of the SAME member + tenant (the token insert precedes it in the batch)
-- and carry one of the allowed kinds; an OAuth harness may not squat the reserved namespace (so the
-- OAuth upsert's ON CONFLICT can never touch a token row).
CREATE TRIGGER IF NOT EXISTS harnesses_credential_shape_insert
BEFORE INSERT ON harnesses
FOR EACH ROW
WHEN (NEW.credential_kind = 'oauth'
      AND (NEW.token_id IS NOT NULL OR NEW.oauth_client_id LIKE 'token:%'))
  OR (NEW.credential_kind = 'token'
      AND (NEW.token_id IS NULL
           OR NEW.oauth_client_id IS NOT ('token:' || NEW.token_id)
           OR NEW.kind NOT IN ('claude-code', 'cursor', 'codex', 'grok', 'ci', 'other')
           OR NOT EXISTS (SELECT 1 FROM member_tokens t
                           WHERE t.id = NEW.token_id AND t.member_id = NEW.member_id
                             AND t.tenant = NEW.tenant AND t.channel = 'directory' AND t.agent_id IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'harness_credential_shape');
END;

-- Who/what a harness is never changes (only the display labels client_name / kind may).
CREATE TRIGGER IF NOT EXISTS harnesses_credential_immutable
BEFORE UPDATE ON harnesses
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant IS NOT OLD.tenant
  OR NEW.member_id IS NOT OLD.member_id
  OR NEW.oauth_client_id IS NOT OLD.oauth_client_id
  OR NEW.credential_kind IS NOT OLD.credential_kind
  OR NEW.token_id IS NOT OLD.token_id
BEGIN
  SELECT RAISE(ABORT, 'harness_immutable');
END;

-- 2. Revoking (or deleting) the harness token retires every seat on its harness, mirroring the
-- 0199 revoke triggers; the existing seat_handles_revoke_on_seat_retire trigger then revokes the
-- seats' handles in the same statement. A retired seat's key is never resurrected, and it frees its
-- live-cap slot (it still counts toward the lifetime max_total bound).
CREATE TRIGGER IF NOT EXISTS harness_token_revoke_retires_seats
AFTER UPDATE OF revoked_at ON member_tokens
FOR EACH ROW
WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
BEGIN
  UPDATE agent_seats SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE retired_at IS NULL
     AND harness_id IN (SELECT hh.id FROM harnesses hh WHERE hh.credential_kind = 'token' AND hh.token_id = NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS harness_token_delete_retires_seats
AFTER DELETE ON member_tokens
FOR EACH ROW
BEGIN
  UPDATE agent_seats SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE retired_at IS NULL
     AND harness_id IN (SELECT hh.id FROM harnesses hh WHERE hh.credential_kind = 'token' AND hh.token_id = OLD.id);
END;

-- 3. Shared-credential detection (read-only observability; never consulted by auth). One row per
-- (credential, session fingerprint): fp is a 32-hex hash of the counter inputs (Mcp-Session-Id,
-- client thread hints, user-agent family) — it is a COUNTER KEY, never an identity, and no raw
-- session id / IP / user-agent is stored. The labels (client_name / client_version / ua_family) are
-- sanitised display text. The writer is ONE atomic upsert (hits = hits + 1, no read-compare-put) and
-- keeps at most 64 rows per credential; rows older than an hour are pruned in the same batch.
-- Written only when SHARED_CREDENTIAL_DETECT === '1' (default off).
CREATE TABLE IF NOT EXISTS credential_session_fingerprints (
  tenant         TEXT NOT NULL,
  token_id       TEXT NOT NULL CHECK (length(token_id) BETWEEN 1 AND 128),
  fp             TEXT NOT NULL CHECK (length(fp) = 32),
  client_name    TEXT NOT NULL DEFAULT '' CHECK (length(client_name) <= 40),
  client_version TEXT NOT NULL DEFAULT '' CHECK (length(client_version) <= 24),
  ua_family      TEXT NOT NULL DEFAULT 'other' CHECK (length(ua_family) <= 24),
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant, token_id, fp)
);

CREATE INDEX IF NOT EXISTS idx_credential_session_fp_seen ON credential_session_fingerprints (tenant, token_id, last_seen);
