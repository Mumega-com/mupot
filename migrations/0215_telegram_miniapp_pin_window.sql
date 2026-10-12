-- 0215_telegram_miniapp_pin_window.sql — secure moments, wave W4.2: PIN fallback + a user-chosen trusted-device window
-- for the Telegram Mini App (docs/architecture/secure-moments.md, "W4.2"). Additive only: every column is NULL or has a
-- constant default, and nothing reads them unless TELEGRAM_MINIAPP_PIN_WINDOW is on.
--
-- Neither the PIN nor the window grants authority. They are two more ways a device proves "it is the same human again";
-- sensitive elevations and home_access stay passkey-only, decided before any of this is consulted.

-- unlock_mode: where the device secret lives on the phone. 'biometric' = inside Telegram's BiometricManager (the W4 path);
-- 'pin' = in the Mini App's device storage, with the 6-digit PIN as the second factor the SERVER verifies.
ALTER TABLE tg_miniapp_devices ADD COLUMN unlock_mode TEXT NOT NULL DEFAULT 'biometric'
  CHECK (unlock_mode IN ('biometric', 'pin'));

-- The PIN is never stored: only PBKDF2-HMAC-SHA256(pin, per-device random salt + device/member/telegram-user binding).
-- pin_iterations is kept per row so the cost can be raised later without invalidating existing PINs.
ALTER TABLE tg_miniapp_devices ADD COLUMN pin_salt TEXT
  CHECK (pin_salt IS NULL OR (length(pin_salt) = 32 AND pin_salt = lower(pin_salt) AND pin_salt NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tg_miniapp_devices ADD COLUMN pin_hash TEXT
  CHECK (pin_hash IS NULL OR (length(pin_hash) = 64 AND pin_hash = lower(pin_hash) AND pin_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tg_miniapp_devices ADD COLUMN pin_iterations INTEGER
  CHECK (pin_iterations IS NULL OR (pin_iterations >= 1 AND pin_iterations <= 100000));

-- Wrong-PIN counter. An attempt RESERVES a slot with a guarded UPDATE (... WHERE pin_failed_attempts < 5) BEFORE the hash
-- is computed, so concurrent guesses cannot exceed the cap; the CHECK makes the cap a database fact, not just code.
ALTER TABLE tg_miniapp_devices ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (pin_failed_attempts >= 0 AND pin_failed_attempts <= 5);

-- The trusted-device window, chosen per device by its owner. 0 = prompt every time, and 0 is the column default on purpose:
-- a device enrolled before this wave never chose a window, so it never silently gets one (new setups write their choice explicitly). 604800 (7 days) is the hard cap,
-- enforced here as well as in code.
ALTER TABLE tg_miniapp_devices ADD COLUMN trust_window_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (trust_window_seconds >= 0 AND trust_window_seconds <= 604800);

-- While now < trusted_until a routine decision needs initData plus the CURRENT trust secret (a second, rotating secret the
-- phone caches outside BiometricManager for the window only; stored as sha256). It is void the moment trusted_until passes,
-- so "an expired window prompts again" is enforced here, not by the client.
ALTER TABLE tg_miniapp_devices ADD COLUMN trust_secret_sha256 TEXT
  CHECK (trust_secret_sha256 IS NULL OR (length(trust_secret_sha256) = 64 AND trust_secret_sha256 = lower(trust_secret_sha256) AND trust_secret_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tg_miniapp_devices ADD COLUMN trusted_until TEXT;

-- Whatever revokes a device (owner removal, sign-out-everywhere, identity revoke, stale-secret replay, PIN lockout) ends its
-- window in the same statement. Revoked devices are already refused everywhere; this keeps the row honest.
CREATE TRIGGER IF NOT EXISTS tg_miniapp_devices_revoke_ends_window
  AFTER UPDATE OF revoked_at ON tg_miniapp_devices
  WHEN NEW.revoked_at IS NOT NULL AND (NEW.trusted_until IS NOT NULL OR NEW.trust_secret_sha256 IS NOT NULL)
BEGIN
  UPDATE tg_miniapp_devices SET trusted_until = NULL, trust_secret_sha256 = NULL WHERE id = NEW.id;
END;
