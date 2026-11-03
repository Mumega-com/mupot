-- 0271_doorbell_profile.sql — per-doorbell delivery profile.
--
-- APPLY THIS BEFORE the Worker that reads `profile` (get / send paths SELECT it).
--
-- profile
--   'generic'            existing rows (the DEFAULT) and every registration that names no profile.
--                        Inline Authorization: Bearer POST of the wake JSON, unchanged.
--   'anthropic_routine'  the Claude Code routine fire endpoint
--                        (https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire).
--                        Fixed anthropic-* headers and a short {"text": ...} body, id and type only.
--                        The profile IS the allowlist for that one URL shape; no host is added to
--                        EVENTS_CALLBACK_HOSTS.
--
-- ADD COLUMN ... NOT NULL DEFAULT: every existing row becomes 'generic' with no table rebuild.
-- Metadata only; the bearer stays AES-GCM ciphertext in auth_ciphertext.
ALTER TABLE agent_webhook_doorbells ADD COLUMN profile TEXT NOT NULL DEFAULT 'generic'
  CHECK (profile IN ('generic', 'anthropic_routine'));
