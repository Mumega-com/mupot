// src/auth/sso.ts — Enterprise SSO & Domain Auto-Enrollment Engine.

import type { Env } from '../types'
import { getJSON, setJSON } from '../dashboard/settings'
import { createBus } from '../bus'

export interface SsoConfig {
  enabled: boolean
  allowed_domains: string[]
  default_role: 'member' | 'admin'
  enforce_sso: boolean
  idp_provider: 'google' | 'saml' | 'generic'
}

export const DEFAULT_SSO_CONFIG: SsoConfig = {
  enabled: false,
  allowed_domains: [],
  default_role: 'member',
  enforce_sso: false,
  idp_provider: 'google',
}

export interface SsoProfile {
  email: string
  name?: string
  hd?: string // Hosted domain from Google OAuth
  provider?: string
}

export interface AutoEnrollResult {
  ok: boolean
  memberId?: string
  email: string
  role: 'member' | 'admin'
  isNew: boolean
  error?: string
}

/**
 * Extracts email domain and checks if it matches allowed SSO domains.
 */
export function isDomainAllowed(email: string, config: SsoConfig): boolean {
  if (!config.enabled) return true
  if (config.allowed_domains.length === 0 || config.allowed_domains.includes('*')) return true

  const parts = email.toLowerCase().trim().split('@')
  if (parts.length !== 2) return false
  const domain = parts[1]

  return config.allowed_domains.some((d) => d.toLowerCase().trim() === domain)
}

/**
 * Retrieves the current SSO configuration from org_settings.
 */
export async function getSsoConfig(env: Env): Promise<SsoConfig> {
  const config = await getJSON<SsoConfig>(env, 'sso_config')
  return config ? { ...DEFAULT_SSO_CONFIG, ...config } : DEFAULT_SSO_CONFIG
}

/**
 * Saves updated SSO configuration to org_settings.
 */
export async function setSsoConfig(env: Env, config: Partial<SsoConfig>): Promise<SsoConfig> {
  const current = await getSsoConfig(env)
  const updated: SsoConfig = {
    ...current,
    ...config,
    allowed_domains: Array.isArray(config.allowed_domains)
      ? config.allowed_domains.map((d) => d.toLowerCase().trim()).filter(Boolean)
      : current.allowed_domains,
  }
  await setJSON(env, 'sso_config', updated)
  return updated
}

/**
 * Validates domain and auto-provisions member if not already registered in D1.
 */
export async function autoEnrollSsoMember(
  env: Env,
  profile: SsoProfile,
): Promise<AutoEnrollResult> {
  const config = await getSsoConfig(env)
  const email = profile.email.toLowerCase().trim()

  if (!email || !email.includes('@')) {
    return { ok: false, email, role: 'member', isNew: false, error: 'invalid_email' }
  }

  if (config.enabled && !isDomainAllowed(email, config)) {
    return {
      ok: false,
      email,
      role: 'member',
      isNew: false,
      error: 'sso_domain_not_allowed',
    }
  }

  const bus = createBus(env)

  // Check if member already exists
  const existing = await env.DB.prepare(`
    SELECT id, role, status FROM members
     WHERE tenant = ?1 AND lower(email) = ?2
     LIMIT 1
  `)
    .bind(env.TENANT_SLUG, email)
    .first<{ id: string; role: 'member' | 'admin'; status: string }>()

  if (existing) {
    if (existing.status !== 'active') {
      return { ok: false, email, role: existing.role, isNew: false, error: 'member_suspended' }
    }
    return { ok: true, memberId: existing.id, email, role: existing.role, isNew: false }
  }

  // Provision new member
  const memberId = crypto.randomUUID()
  const role = config.default_role || 'member'
  const nowIso = new Date().toISOString()

  await env.DB.prepare(`
    INSERT INTO members (
      id, tenant, email, role, status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
  `)
    .bind(memberId, env.TENANT_SLUG, email, role, nowIso)
    .run()

  await bus.emit({
    type: 'member.auto_enrolled',
    actor: { kind: 'sso', id: profile.provider || 'oauth' },
    target: { kind: 'member', id: memberId },
    payload: {
      email,
      role,
      provider: profile.provider || 'oauth',
    },
  })

  return { ok: true, memberId, email, role, isNew: true }
}
