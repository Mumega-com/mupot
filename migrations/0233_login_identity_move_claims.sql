-- 0233_login_identity_moved_stamp.sql — mupot#1022: per-request claim row for a confirmed sign-in move.
--
-- A confirmed "move this Google sign-in to my account" re-points the existing identity row (UNIQUE(tenant, provider,
-- provider_subject) covers revoked rows, so a second row is impossible). In ONE D1 batch the move first INSERTs a claim
-- row here, guarded by exactly the move's own predicates (INSERT ... SELECT ... FROM human_login_identities WHERE <guards>);
-- the audit INSERT and the session/passkey/phone cutoffs anchor on `stamp = <this request>` (the telegram_login_links
-- consumed_at pattern, #1579/#1979). A move whose guards fail writes no claim, so nothing downstream lands; a real move
-- always writes its audit and cutoffs, with no reliance on changes(). stamp is a per-request uuid.
CREATE TABLE IF NOT EXISTS login_identity_move_claims (
  stamp          TEXT PRIMARY KEY,
  tenant         TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  from_member_id TEXT NOT NULL,
  to_member_id   TEXT NOT NULL,
  claimed_at     TEXT NOT NULL
);
