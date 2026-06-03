-- org settings — onboarding state + chosen model/IM config. Key/value, tenant-local.
-- The setup wizard writes here; nothing business-specific, just substrate config.
CREATE TABLE IF NOT EXISTS org_settings (
  key        TEXT PRIMARY KEY,           -- e.g. 'onboarding_complete', 'model_provider'
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
