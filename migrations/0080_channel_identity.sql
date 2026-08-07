-- Channel identity: (platform, platform_user_id) -> member.
--
-- Spec: docs/architecture/channel-identity-and-caller-authority.md (#775)
--
-- A message from an IM channel acts with the CALLER's authority, not the bot's.
-- This table is the missing step: platform user -> member. Authority itself is
-- unchanged (resolveCapabilities on the member).
--
-- SECURITY PRINCIPLE THIS ENCODES:
--   "My Telegram is as secure as my Gmail — because if I have you on it, you have
--    access to my Gmail."  (Hadi, 2026-08-07)
-- A binding inherits the blast radius of everything the bound member can reach.
-- Therefore binding is DELIBERATE (never inferred), REVOCABLE, and AUDITED.
--
-- ⚠ platform_user_id is the platform's IMMUTABLE id — Telegram numeric from.id,
-- Discord snowflake, Slack U-id. NEVER a username or display name: those are
-- user-mutable and can be released and re-registered by someone else, which makes
-- a handle-keyed binding a spoofable credential. Same defect class as the actor id
-- corrected in #769.

CREATE TABLE IF NOT EXISTS channel_identity (
  tenant            TEXT NOT NULL,
  platform          TEXT NOT NULL CHECK (platform IN ('telegram','discord','slack','google_chat','whatsapp')),
  platform_user_id  TEXT NOT NULL,
  member_id         TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,

  -- Audit: a binding is an authentication factor, so who created it and how must
  -- survive. bound_method records the ceremony strength — an admin bind and a
  -- verified-login bind are not equally strong evidence of identity.
  bound_at          TEXT NOT NULL,
  bound_by          TEXT NOT NULL,
  bound_method      TEXT NOT NULL CHECK (bound_method IN ('admin','verified_login')),

  -- Soft revoke. History must survive revocation: "which channel could act as this
  -- member, and when did that stop" is an audit question, not a cleanup detail.
  revoked_at        TEXT,
  revoked_by        TEXT,

  PRIMARY KEY (tenant, platform, platform_user_id)
);

-- Enumerability: "which channel identities can act as me?" must be one indexed
-- lookup, because a member cannot revoke what they cannot list.
CREATE INDEX IF NOT EXISTS idx_channel_identity_member
  ON channel_identity(tenant, member_id);

-- NOTE ON WHAT IS DELIBERATELY ABSENT:
-- No UNIQUE on (tenant, member_id). One member may legitimately bind several
-- channels — Telegram and Slack, or a second device. The constraint that matters
-- is the reverse: one platform identity resolves to at most ONE member, which the
-- primary key already enforces. A platform id resolving to two members would be an
-- ambiguous caller, and ambiguity on an authorisation path must be impossible by
-- schema rather than by convention.
--
-- No backfill. There is no existing data that proves any Telegram account belongs
-- to any member — inferring one would be exactly the auto-bind that
-- channels/index.ts:102 removed for forging identity. Bindings start empty and are
-- created deliberately.
