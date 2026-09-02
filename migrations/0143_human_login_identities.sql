-- 0143_human_login_identities.sql — tenant-local binding from an external
-- verified login identity to ONE canonical human member.
--
-- Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
-- elevation-design.md, "Human login identity". Delivery Sequence step 1
-- (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
--
-- Authorization binds to (tenant, provider, provider_subject) — the OAuth
-- provider's own stable subject id — NEVER to a display email. Email is
-- verified evidence, retained for legibility, and is not itself an authority
-- join key: two different providers, or two different tenants, can report the
-- same email without that implying the same authority. UNIQUE(tenant,
-- provider, provider_subject) is the whole join key.
--
-- member_id is NOT NULL: a login identity only exists once it is bound to an
-- actual members row. This is deliberately NOT auto-populated for every login
-- — the design requires linking to be an explicit act (self-service, on first
-- login, when a members row already resolves by verified email; or a one-time
-- ceremony for a pre-existing legacy owner). See src/auth/login-identity.ts.
--
-- linked_by_member_id records who performed the link when it was NOT the
-- member's own login act (e.g. an admin completing the one-time owner
-- ceremony on someone else's behalf); NULL for an ordinary self-service link.
--
-- revoked_at makes unlinking (and denying re-link with a stale identity)
-- possible without a hard delete — same soft-revoke discipline as
-- member_tokens.revoked_at elsewhere in this schema.
CREATE TABLE IF NOT EXISTS human_login_identities (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_subject    TEXT NOT NULL,
  verified_email      TEXT,
  member_id           TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  linked_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at          TEXT,
  UNIQUE(tenant, provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_human_login_identities_member
  ON human_login_identities(member_id);

CREATE INDEX IF NOT EXISTS idx_human_login_identities_tenant
  ON human_login_identities(tenant);
