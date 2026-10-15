-- 0229_telegram_login_links.sql — mupot#1579: a Telegram-first member gets a web login by PROOF OF CONTROL.
--
-- WHY. A member born through the Telegram door (redeemTelegramProjectInvite) holds a bound chat, an email and no
-- human_login_identities row. Under the exclusive-control rule (#1551/#1963) a bound chat is a competing controller, so
-- no web login can attach to that row by email match, and the only exit (self-unbind) needs a web session they cannot
-- get. The one honest proof is the chat itself: the member asks the bot (`/login`), the worker mints ONE short-lived
-- link INSIDE that authenticated private chat, the member opens it in a browser, signs in with a provider, and
-- confirms. The confirm consumes the link and links that login identity to the member in one D1 batch.
--
-- token_hash is sha256 of the secret in the URL (the secret itself is never stored here). telegram_chat_id snapshots the
-- chat the link was minted for: a later unbind or rebind of the member's chat makes the link unusable. consumed_at is
-- the claim stamp (unique per claim) the identity INSERT anchors on. revoked_at: superseded by a newer link.
CREATE TABLE IF NOT EXISTS telegram_login_links (
  id               TEXT PRIMARY KEY,
  tenant           TEXT NOT NULL,
  member_id        TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  token_hash       TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT,
  consumed_provider TEXT,
  consumed_subject  TEXT,
  revoked_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_login_links_member
  ON telegram_login_links(tenant, member_id);
