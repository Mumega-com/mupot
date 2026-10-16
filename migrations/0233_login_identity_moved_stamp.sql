-- 0233_login_identity_moved_stamp.sql — mupot#1022: per-move claim stamp on human_login_identities.
--
-- A confirmed "move this Google sign-in to my account" re-points the existing identity row (UNIQUE(tenant, provider,
-- provider_subject) covers revoked rows, so a second row is impossible). The move UPDATE writes a per-request unique
-- stamp here, and the audit INSERT in the same D1 batch anchors on `moved_stamp = <this request's stamp>`, so a move that
-- changed zero rows writes no audit and no session cutoff, and a real move always does. Same pattern as
-- telegram_login_links.consumed_at (#1579). NULL for every identity that was never moved.
ALTER TABLE human_login_identities ADD COLUMN moved_stamp TEXT;
