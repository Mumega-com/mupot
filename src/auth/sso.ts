// src/auth/sso.ts — Enterprise SSO & Domain Auto-Enrollment Engine.

import type { Env } from '../types'
import { getJSON, setJSON } from '../dashboard/settings'
import { createBus } from '../bus'
import { resolveHumanMemberId } from '../members/resolve-human-member'
import { decideIdentitylessAttach } from '../members/exclusive-control'

// mupot#1454: the ONLY roles a self-service SSO auto-enrollment may hand a
// brand-new member. Deliberately excludes 'admin' (and every capability above
// it) — auto-enrollment mints a capability row for an identity nobody has
// vetted yet (the P0 header above documents these routes were unauthenticated
// from #1231 to 2026-09-02), so the safe ceiling here is "never auto-grant
// org authority", not a rank comparison against some other principal (there
// is no pre-existing target to compare against — the member doesn't exist
// yet). Single source of truth for both the config-write validator
// (sso-routes.ts) and the enroll-time re-validation below, so the two can
// never drift apart.
export const SSO_ALLOWED_DEFAULT_ROLES = ['observer', 'member'] as const
export type SsoDefaultRole = (typeof SSO_ALLOWED_DEFAULT_ROLES)[number]

export function isAllowedSsoDefaultRole(value: unknown): value is SsoDefaultRole {
  return (SSO_ALLOWED_DEFAULT_ROLES as readonly unknown[]).includes(value)
}

export interface SsoConfig {
  enabled: boolean
  allowed_domains: string[]
  default_role: SsoDefaultRole
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
  // 'admin' is only ever reported for an EXISTING member (their real,
  // already-held capability — see the existing-member branch below); a NEW
  // member's role is always the (validated) SsoDefaultRole from config.
  role: 'member' | 'admin' | SsoDefaultRole
  isNew: boolean
  // 'invalid_email' | 'sso_domain_not_allowed' | 'member_suspended' — pre-existing.
  // 'member_row_competing_control' | 'member_email_ambiguous' — mupot#1551: the
  // resolver missed but decideIdentitylessAttach found the row is already
  // someone else's, or the normalized email is ambiguous. Neither ever
  // enrolls or duplicates.
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
 *
 * mupot#1454 round 2 (F3): getJSON hands back whatever JSON was stored,
 * unknown keys and all — a config written before POST /config's `.strict()`
 * schema existed (this fix) could carry a legacy/junk key. Before this fix,
 * GET /config would echo that key straight back, and an honest GET -> edit ->
 * POST round trip (the admin never touched the junk field) would then fail
 * `.strict()` on a key the admin didn't even know was there. Whitelisted to
 * exactly the known SsoConfig shape here — this does NOT validate individual
 * field VALUES (e.g. an out-of-allowlist `default_role` from before this fix
 * passes through unchanged; that is autoEnrollSsoMember's job, at enroll
 * time, so the two responsibilities stay separate), only drops keys this
 * config does not declare.
 */
export async function getSsoConfig(env: Env): Promise<SsoConfig> {
  const stored = await getJSON<Partial<SsoConfig>>(env, 'sso_config')
  const merged: SsoConfig = stored ? { ...DEFAULT_SSO_CONFIG, ...stored } : DEFAULT_SSO_CONFIG
  return {
    enabled: merged.enabled,
    allowed_domains: merged.allowed_domains,
    default_role: merged.default_role,
    enforce_sso: merged.enforce_sso,
    idp_provider: merged.idp_provider,
  }
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

  // mupot#1551 (Athena's ruling, Option B): `identityOnly` stops the resolver
  // at steps 1-2 (a live identity's own join key or verified_email) — it
  // never falls through to resolveHumanMemberRecord's members.email bootstrap
  // (step 3) or owner-alias lookup (step 4), which this function replaces
  // below with its OWN, explicit, checked fallback instead of letting the
  // resolver silently apply its lenient (no-subject) email match.
  const identityResolvedId = await resolveHumanMemberId(env, {
    tenant: env.TENANT_SLUG,
    provider: profile.provider || null,
    email,
    identityOnly: true,
  })
  let existingId = identityResolvedId
  if (!existingId) {
    // UNIQUE members.email means a resolver miss (write-once verified_email
    // drift, a genuinely suspended row, or a competing-controlled row) must
    // not INSERT a colliding row — but it also must not silently REUSE a row
    // that is already someone else's. The old raw `SELECT ... LIMIT 1`
    // fallback here had no such check at all, so a denial could never even be
    // expressed; decideIdentitylessAttach's tri-state result is authoritative
    // instead. `ignoreLiveIdentity: true` — this call never links a new
    // identity, so a row that already has ONE (just under a different
    // verified_email — the drift case) is still safe to report back; only a
    // live unbound bearer or a Telegram bind refuses enrollment outright.
    const decision = await decideIdentitylessAttach(env, {
      tenant: env.TENANT_SLUG,
      normalizedEmail: email,
      provider: profile.provider || null,
      subject: null,
      ignoreLiveIdentity: true,
    })
    if (decision.kind === 'eligible') {
      existingId = decision.memberId
    } else if (decision.kind === 'denied_competing_control') {
      return { ok: false, email, role: 'member', isNew: false, error: 'member_row_competing_control' }
    } else if (decision.kind === 'ambiguous') {
      return { ok: false, email, role: 'member', isNew: false, error: 'member_email_ambiguous' }
    }
    // 'not_found' → existingId stays null → falls through to provisioning a
    // brand-new member below, exactly as before.
  }
  if (existingId) {
    const existing = await env.DB.prepare(
      `SELECT m.id, m.status,
              EXISTS (
                SELECT 1 FROM capabilities c
                 WHERE c.member_id = m.id
                   AND c.scope_type = 'org'
                   AND c.scope_id IS NULL
                   AND c.capability IN ('owner', 'admin')
              ) AS is_admin
         FROM members m
        WHERE m.id = ?1 AND m.tenant = ?2
        LIMIT 1`,
    )
      .bind(existingId, env.TENANT_SLUG)
      .first<{ id: string; status: string; is_admin: number }>()
    if (existing) {
      const role = existing.is_admin === 1 ? 'admin' : 'member'
      if (existing.status !== 'active') {
        return { ok: false, email, role, isNew: false, error: 'member_suspended' }
      }
      return { ok: true, memberId: existing.id, email, role, isNew: false }
    }
  }

  // Provision new member
  const memberId = crypto.randomUUID()
  // mupot#1454: config.default_role is whatever JSON `getJSON` handed back from
  // org_settings — a runtime value, NOT guaranteed to satisfy the (now
  // narrowed) compile-time SsoDefaultRole type. A config written before this
  // fix (or edited directly in D1) can still carry 'admin' or anything else.
  // Never trust the stored value to already be safe — re-check it against the
  // exact same allowlist the config-write route now enforces, and clamp to
  // the non-elevating default ('member') on any miss instead of minting the
  // stored value's capability. Audited, no PII/secrets: tenant + the rejected
  // value only.
  const storedDefaultRole = config.default_role
  const roleIsAllowed = isAllowedSsoDefaultRole(storedDefaultRole)
  if (!roleIsAllowed) {
    console.error(
      `sso.autoEnrollSsoMember: stored default_role ${JSON.stringify(storedDefaultRole)} for tenant ${env.TENANT_SLUG} is not in the allowlist; clamped to 'member'`,
    )
  }
  const role: SsoDefaultRole = roleIsAllowed ? storedDefaultRole : 'member'
  const nowIso = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO members (
        id, tenant, email, display_name, telegram_chat_id, status, created_at
      ) VALUES (?1, ?2, ?3, ?4, NULL, 'active', ?5)
    `).bind(memberId, env.TENANT_SLUG, email, profile.name?.trim() || email, nowIso),
    env.DB.prepare(`
      INSERT INTO capabilities (
        id, member_id, scope_type, scope_id, capability, created_at
      ) VALUES (?1, ?2, 'org', NULL, ?3, ?4)
    `).bind(crypto.randomUUID(), memberId, role, nowIso),
  ])

  await bus.emit({
    type: 'member.auto_enrolled',
    actor: { kind: 'sso', id: profile.provider || 'oauth' },
    tenant: env.TENANT_SLUG,
    ts: new Date().toISOString(),
    payload: {
      email,
      role,
      provider: profile.provider || 'oauth',
    },
  })

  return { ok: true, memberId, email, role, isNew: true }
}
