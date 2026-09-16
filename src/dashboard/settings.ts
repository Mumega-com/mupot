// mupot — org_settings helper (dashboard-local).
//
// The setup wizard and the dashboard read/write SUBSTRATE config here: onboarding
// progress, chosen model provider, the selected IM channel, brand overrides. This
// is the `org_settings` key/value table (migrations/0003_settings.sql) — tenant-
// LOCAL config, never business content. One DB per pot, so no tenant column; the
// caller's tenant guard lives at the route layer (env.TENANT_SLUG).
//
// Values are opaque strings. Structured values (the wizard stores small JSON blobs
// for brand + IM channel) are serialized by the caller and parsed back here via
// the typed getJSON helper. We never trust the shape blindly — getJSON returns
// null on a parse miss rather than throwing.

import type { Env, OrgSetting } from '../types'

// ── well-known keys (the only keys the wizard + dashboard read/write) ──────────
// Centralized so a typo can't silently fork a key. Add new substrate-config keys
// here, never inline string literals at call sites.
export const SETTINGS_KEYS = {
  onboardingComplete: 'onboarding_complete',
  onboardingStep: 'onboarding_step',
  orgName: 'org_name',
  brand: 'brand',
  modelProvider: 'model_provider',
  modelName: 'model_name',
  imChannel: 'im_channel',
  imProvider: 'im_provider',
  // Display-only: the @username of the DECISION-CHANNEL bot (the gateway's
  // bot a human talks to for /needs, /approve, /reject — see
  // docs/operations/telegram-project-onboarding.md). mupot never holds that
  // bot's token (it isn't mupot's bot — see src/telegram-bridge/bus_notify.ts
  // and TELEGRAM_BOT_TOKEN's own comment in src/types.ts for the notification-
  // only bot this pot DOES hold a token for), so this cannot be derived via
  // getMe the way the notification bot's username could — it must be
  // configured. Carries NO authority: nothing in the bind/redeem/authz path
  // reads it. See src/dashboard/wizard.ts (setup step 6) and
  // src/dashboard/im-settings.ts (post-setup edit) for the only writers, and
  // src/dashboard/account.ts's Connect Telegram deep link for the only reader.
  imBotUsername: 'im_bot_username',
} as const

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS]

// Telegram bot usernames are 5-32 chars of letters/digits/underscore (Telegram
// also requires they end in "bot", but that constraint buys nothing here — this
// is a shape check on an owner-supplied display string, not an authorization
// rule). ONE definition, imported by every writer of im_bot_username (the
// wizard's /setup/im step and the post-setup /admin/im-settings page) so the
// accepted shape can never drift between the two forms.
export const IM_BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/

/** True iff `v` is a syntactically valid Telegram bot @username (no leading @). */
export function isValidBotUsername(v: unknown): v is string {
  return typeof v === 'string' && IM_BOT_USERNAME_RE.test(v)
}

// ── reads ──────────────────────────────────────────────────────────────────────

/** Read one setting value. Returns null when the key is unset. */
export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM org_settings WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

/** Read every setting as a Map (one small scan; the table is tiny). */
export async function getAllSettings(env: Env): Promise<Map<string, string>> {
  const rows = await env.DB.prepare('SELECT key, value, updated_at FROM org_settings').all<OrgSetting>()
  const m = new Map<string, string>()
  for (const r of rows.results ?? []) m.set(r.key, r.value)
  return m
}

/** Read + JSON.parse a setting. Returns null on miss OR on a malformed value
 *  (fail-soft — a corrupt config value must not crash the wizard render). */
export async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  const raw = await getSetting(env, key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Upsert one setting. Bumps updated_at on every write. */
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value)
    .run()
}

/** Upsert several settings in one batch (D1 is single-writer; the batch serializes). */
export async function setSettings(env: Env, entries: Record<string, string>): Promise<void> {
  const stmts = Object.entries(entries).map(([key, value]) =>
    env.DB.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, value),
  )
  if (stmts.length === 0) return
  await env.DB.batch(stmts)
}

/** Serialize + store a structured value as JSON. */
export async function setJSON(env: Env, key: string, value: unknown): Promise<void> {
  await setSetting(env, key, JSON.stringify(value))
}

// ── onboarding-state convenience ────────────────────────────────────────────────

/** True once the owner has finished the wizard (org_settings.onboarding_complete). */
export async function isOnboardingComplete(env: Env): Promise<boolean> {
  return (await getSetting(env, SETTINGS_KEYS.onboardingComplete)) === 'true'
}

/** The furthest wizard step the owner has reached (1-based). 1 when never started. */
export async function getOnboardingStep(env: Env): Promise<number> {
  const raw = await getSetting(env, SETTINGS_KEYS.onboardingStep)
  if (raw === null) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}
