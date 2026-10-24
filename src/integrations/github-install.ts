// mupot — per-tenant GitHub App installation store + connect flow helpers.
//
// The shared "mupot" App (platform key) is installed per-tenant; this captures each
// tenant's installation_id (set by the /connect/github callback) so token minting can
// pair the platform key with the right install. See migrations/0025.

import type { Env } from '../types'

const APP_SLUG = 'mupot' // the shared publisher App's slug (github.com/apps/<slug>)

export interface GitHubInstallation {
  tenant: string
  installation_id: string
  account_login: string | null
  installed_at: string
  updated_at: string
}

/** Store (or overwrite) this tenant's installation id. A re-install replaces the old one. */
export async function storeInstallation(
  env: Env,
  installationId: string,
  accountLogin: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO github_installations (tenant, installation_id, account_login, installed_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(tenant) DO UPDATE SET
       installation_id = excluded.installation_id,
       account_login   = excluded.account_login,
       updated_at      = excluded.updated_at`,
  )
    .bind(env.TENANT_SLUG, installationId, accountLogin, now)
    .run()
}

/** Read this tenant's stored installation id, or null. */
export async function getInstallationId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT installation_id FROM github_installations WHERE tenant = ?1 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG)
    .first<{ installation_id: string }>()
  return row?.installation_id ?? null
}

/** Remove this tenant's installation record (on uninstall / disconnect). Idempotent. */
export async function removeInstallation(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM github_installations WHERE tenant = ?1`)
    .bind(env.TENANT_SLUG)
    .run()
}

/**
 * The GitHub App install URL. `state` is an opaque CSRF token echoed back to the callback.
 * Validate the slug-free `state` only (no untrusted interpolation into the host/path).
 */
export function installUrl(state: string): string {
  const u = new URL(`https://github.com/apps/${APP_SLUG}/installations/new`)
  u.searchParams.set('state', state)
  return u.toString()
}

/**
 * Parse + validate a GitHub setup-callback query. Returns the installation_id only when the
 * setup_action is an install/update and the id is all-digits. Anything else → null (fail-closed).
 */
export function parseInstallCallback(
  url: URL,
): { installationId: string; setupAction: string } | null {
  const installationId = url.searchParams.get('installation_id') ?? ''
  const setupAction = url.searchParams.get('setup_action') ?? ''
  // All-digits and bounded — real GitHub install ids are < 19 digits.
  if (!/^\d{1,20}$/.test(installationId)) return null
  if (setupAction !== 'install' && setupAction !== 'update') return null
  return { installationId, setupAction }
}

export type InstallVerification =
  | { ok: true; accountLogin: string | null }
  | { ok: false; reason: 'not_configured' | 'missing_code' | 'exchange_failed' | 'lookup_failed' | 'not_owned' }

const GH_TIMEOUT_MS = 8000
const MAX_INSTALL_PAGES = 10

/**
 * Prove the authorizing GitHub user can access `installationId`. The setup callback carries a
 * one-time OAuth `code` (the App has "Request user authorization during installation" on); it is
 * exchanged for a user token, and the id must appear in that user's GET /user/installations.
 * The account login is taken from GitHub's answer, never from the query string.
 * Fails closed on missing config, missing code, any non-2xx, malformed JSON, or timeout.
 */
export async function verifyInstallationOwnership(
  env: Env,
  code: string | null,
  installationId: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<InstallVerification> {
  const clientId = env.GITHUB_APP_CLIENT_ID
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) return { ok: false, reason: 'not_configured' }
  if (!code) return { ok: false, reason: 'missing_code' }
  const doFetch = opts?.fetchImpl ?? fetch
  const signal = () => AbortSignal.timeout(GH_TIMEOUT_MS)

  let token: string
  try {
    const res = await doFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: signal(),
    })
    if (!res.ok) return { ok: false, reason: 'exchange_failed' }
    const data: unknown = await res.json()
    const t = (data as { access_token?: unknown } | null)?.access_token
    if (typeof t !== 'string' || !t) return { ok: false, reason: 'exchange_failed' }
    token = t
  } catch {
    return { ok: false, reason: 'exchange_failed' }
  }

  try {
    for (let page = 1; page <= MAX_INSTALL_PAGES; page++) {
      const res = await doFetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'mupot',
        },
        signal: signal(),
      })
      if (!res.ok) return { ok: false, reason: 'lookup_failed' }
      const data: unknown = await res.json()
      const list = (data as { installations?: unknown } | null)?.installations
      if (!Array.isArray(list)) return { ok: false, reason: 'lookup_failed' }
      for (const item of list) {
        const inst = item as { id?: unknown; account?: { login?: unknown } | null }
        if (String(inst.id) === installationId) {
          const login = inst.account?.login
          return { ok: true, accountLogin: typeof login === 'string' ? login : null }
        }
      }
      if (list.length < 100) break
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
  return { ok: false, reason: 'not_owned' }
}
