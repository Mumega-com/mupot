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
