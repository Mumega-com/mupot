-- mupot — per-tenant GitHub App installation record.
--
-- The "mupot" GitHub App is ONE shared publisher app (App ID + private key live as
-- platform Worker secrets). Each tenant installs it on their own org and gets a distinct
-- installation_id. This table captures that id per tenant, set by the /connect/github
-- callback. Token minting pairs the platform key with THIS tenant's installation_id.
--
-- One active install per tenant (a re-install overwrites). tenant is the PK.
CREATE TABLE IF NOT EXISTS github_installations (
  tenant          TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  account_login   TEXT,            -- the org/user the app was installed on (display only)
  installed_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
