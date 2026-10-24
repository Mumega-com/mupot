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
  | {
      ok: false
      reason:
        | 'not_configured'
        | 'missing_code'
        | 'exchange_failed'
        | 'bad_verification_code'
        | 'lookup_failed'
        | 'not_owned'
        | 'org_admin_unverifiable'
        | 'not_org_admin'
        | 'not_account_owner'
    }

const GH_TIMEOUT_MS = 8000
const MAX_INSTALL_PAGES = 10

interface GhAccount {
  id?: unknown
  login?: unknown
  type?: unknown
}

/**
 * Prove the authorizing GitHub user OWNS (not merely can read) `installationId`. The setup
 * callback carries a one-time OAuth `code`; it is exchanged for a user token, then:
 *   1. the id must appear in GET /user/installations;
 *   2. a User-account install must belong to the same user (GET /user id == account.id);
 *   3. an Organization install requires GET /user/memberships/orgs/{login} role=admin, state=active
 *      (needs the App permission "Members: read"; if GitHub refuses it we fail closed with
 *      `org_admin_unverifiable` rather than accepting).
 * The account login comes from GitHub's answer, never the query string. Every failure refuses.
 * The user token is revoked afterwards (best effort, never blocks).
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
    const d = data as { access_token?: unknown; error?: unknown } | null
    // GitHub answers 200 with { error: 'bad_verification_code' } for a spent/forged code.
    if (d && typeof d.error === 'string') return { ok: false, reason: 'bad_verification_code' }
    if (typeof d?.access_token !== 'string' || !d.access_token) return { ok: false, reason: 'exchange_failed' }
    token = d.access_token
  } catch {
    return { ok: false, reason: 'exchange_failed' }
  }

  const api = (path: string) =>
    doFetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mupot' },
      signal: signal(),
    })

  try {
    return await decide(api, installationId)
  } finally {
    // Best-effort revoke of the user-to-server token; failure must not block or leak.
    try {
      await doFetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'mupot',
        },
        body: JSON.stringify({ access_token: token }),
        signal: signal(),
      })
    } catch {
      // ignored on purpose
    }
  }
}

async function decide(
  api: (path: string) => Promise<Response>,
  installationId: string,
): Promise<InstallVerification> {
  let account: GhAccount | null = null
  let found = false
  try {
    for (let page = 1; page <= MAX_INSTALL_PAGES && !found; page++) {
      const res = await api(`/user/installations?per_page=100&page=${page}`)
      if (!res.ok) return { ok: false, reason: 'lookup_failed' }
      const data: unknown = await res.json()
      const list = (data as { installations?: unknown } | null)?.installations
      if (!Array.isArray(list)) return { ok: false, reason: 'lookup_failed' }
      for (const item of list) {
        const inst = item as { id?: unknown; account?: GhAccount | null }
        if (String(inst.id) === installationId) {
          found = true
          account = inst.account ?? null
          break
        }
      }
      if (list.length < 100) break
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
  if (!found) return { ok: false, reason: 'not_owned' }
  const login = account?.login
  if (typeof login !== 'string' || !login) return { ok: false, reason: 'lookup_failed' }

  try {
    if (account?.type === 'User') {
      const res = await api('/user')
      if (!res.ok) return { ok: false, reason: 'lookup_failed' }
      const me = (await res.json()) as { id?: unknown } | null
      if (me?.id === undefined || account.id === undefined || String(me.id) !== String(account.id)) {
        return { ok: false, reason: 'not_account_owner' }
      }
      return { ok: true, accountLogin: login }
    }
    if (account?.type === 'Organization') {
      const res = await api(`/user/memberships/orgs/${encodeURIComponent(login)}`)
      if (res.status === 403 || res.status === 404) return { ok: false, reason: 'org_admin_unverifiable' }
      if (!res.ok) return { ok: false, reason: 'lookup_failed' }
      const m = (await res.json()) as { role?: unknown; state?: unknown } | null
      if (m?.role !== 'admin' || m?.state !== 'active') return { ok: false, reason: 'not_org_admin' }
      return { ok: true, accountLogin: login }
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
  return { ok: false, reason: 'lookup_failed' } // unknown account type: fail closed
}
