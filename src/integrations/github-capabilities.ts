// mupot — GitHub feature capability gate (plan-tier + Enterprise kill switch).
//
// "Use as much of GitHub as we can, but TAG everything Enterprise so we can turn it
// off and still support tenants who don't have it." This module is that tag registry.
//
// Two orthogonal axes decide whether a GitHub feature is usable for a pot:
//   1. PLAN TIER — the tenant's GitHub plan. A feature has a MINIMUM tier (e.g. the
//      Copilot coding agent needs a paid plan; org MCP allowlists need Enterprise).
//      We default conservatively to 'free' — we NEVER assume a tenant has Enterprise.
//   2. ENTERPRISE KILL SWITCH — every Enterprise-tagged feature is ALSO gated behind an
//      explicit opt-in flag (GITHUB_ENTERPRISE_FEATURES). Off by default. So even an
//      Enterprise tenant gets Enterprise paths only when they (or we) turn them on, and
//      one flag disables them all — graceful, supported degradation.
//
// This is a CAPABILITY axis (what the plan allows), distinct from auth/capability.ts
// (member RBAC — who is allowed). A feature must pass BOTH to run.
//
// Fail-closed: unknown tier → 'free'; missing config → most restrictive.

import type { Env } from '../types'

// ── tiers ────────────────────────────────────────────────────────────────────────

/** GitHub plan tiers, ascending. 'none' = no GitHub connected at all. */
export type GitHubTier = 'none' | 'free' | 'pro' | 'team' | 'enterprise'

const TIER_RANK: Record<GitHubTier, number> = {
  none: 0,
  free: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
}

export function isGitHubTier(v: unknown): v is GitHubTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIER_RANK, v)
}

// ── features ───────────────────────────────────────────────────────────────────────

/**
 * Every GitHub capability mupot can use. Add new ones here with their tier + enterprise tag.
 * `enterprise: true` features are additionally governed by the kill switch.
 */
export type GitHubFeature =
  | 'issue_mirror' // task↔issue sync — any plan, incl free/public
  | 'app_token_mint' // GitHub App installation tokens — any plan
  | 'custom_agent_defs' // write .github/agents/*.agent.md — any plan (GA across plans)
  | 'repo_file_write' // own-fleet writes: branch + arbitrary file + open PR — any plan
  | 'coding_agent_assign' // assign an issue to the Copilot coding agent — PAID plans
  | 'org_mcp_allowlist' // org-level MCP server allowlist for agents — ENTERPRISE
  | 'audit_log_stream' // audit-log streaming — ENTERPRISE
  | 'saml_sso' // SAML SSO enforcement — ENTERPRISE

interface FeatureSpec {
  minTier: GitHubTier
  enterprise: boolean // Enterprise-tagged → also behind the kill switch
  label: string
}

/**
 * The TAG REGISTRY. Each feature → minimum plan tier + whether it is Enterprise-gated.
 * This is the single place to read "what is Enterprise and can be turned off."
 */
export const GITHUB_FEATURES: Record<GitHubFeature, FeatureSpec> = {
  issue_mirror: { minTier: 'free', enterprise: false, label: 'Task ↔ issue mirror' },
  app_token_mint: { minTier: 'free', enterprise: false, label: 'App installation tokens' },
  custom_agent_defs: { minTier: 'free', enterprise: false, label: 'Custom agent definitions' },
  repo_file_write: { minTier: 'free', enterprise: false, label: 'Own-fleet repo writes (branch/file/PR)' },
  coding_agent_assign: { minTier: 'pro', enterprise: false, label: 'Copilot coding-agent assign' },
  org_mcp_allowlist: { minTier: 'enterprise', enterprise: true, label: 'Org MCP server allowlist' },
  audit_log_stream: { minTier: 'enterprise', enterprise: true, label: 'Audit-log streaming' },
  saml_sso: { minTier: 'enterprise', enterprise: true, label: 'SAML SSO enforcement' },
}

/** The Enterprise-tagged features — the set the kill switch governs. */
export const ENTERPRISE_FEATURES: ReadonlySet<GitHubFeature> = new Set(
  (Object.keys(GITHUB_FEATURES) as GitHubFeature[]).filter((f) => GITHUB_FEATURES[f].enterprise),
)

// ── pure gate ────────────────────────────────────────────────────────────────────

/**
 * Pure capability check. A feature is enabled iff:
 *   - the tenant's tier meets the feature's minimum tier, AND
 *   - if the feature is Enterprise-tagged, the Enterprise kill switch is ON.
 *
 * No I/O — fully testable. The async wrappers below resolve tier + flag from env.
 */
export function featureEnabled(
  tier: GitHubTier,
  feature: GitHubFeature,
  opts: { enterpriseEnabled: boolean },
): boolean {
  const spec = GITHUB_FEATURES[feature]
  if (!spec) return false
  if (spec.enterprise && !opts.enterpriseEnabled) return false
  return TIER_RANK[tier] >= TIER_RANK[spec.minTier]
}

// ── env resolution ─────────────────────────────────────────────────────────────────

interface GitHubCapEnv {
  GITHUB_PLAN_TIER?: string
  GITHUB_ENTERPRISE_FEATURES?: string
}

function capEnv(env: Env): GitHubCapEnv {
  return env as unknown as GitHubCapEnv
}

/**
 * Is the Enterprise kill switch ON? Default OFF (fail-closed). Truthy values:
 * 'on' | 'true' | '1' | 'yes' (case-insensitive).
 */
export function enterpriseFeaturesEnabled(env: Env): boolean {
  const raw = capEnv(env).GITHUB_ENTERPRISE_FEATURES
  if (typeof raw !== 'string') return false
  return ['on', 'true', '1', 'yes'].includes(raw.trim().toLowerCase())
}

/**
 * Resolve the tenant's GitHub plan tier. Sources, in order:
 *   1. github_app connector meta `{ plan_tier }` (per-tenant, the right home)
 *   2. GITHUB_PLAN_TIER Worker var (platform/dogfood fallback)
 *   3. default 'free' (conservative — never assume Enterprise)
 */
export async function resolveGitHubTier(env: Env): Promise<GitHubTier> {
  // Connector meta path.
  try {
    const row = await env.DB.prepare(
      `SELECT meta FROM connectors
        WHERE tenant = ?1 AND type = 'github_app' AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(env.TENANT_SLUG)
      .first<{ meta: string | null }>()
    if (row?.meta) {
      const parsed = JSON.parse(row.meta) as { plan_tier?: unknown }
      if (isGitHubTier(parsed.plan_tier)) return parsed.plan_tier
    }
  } catch {
    // DB/parse failure → fall through to env/default (fail-closed to conservative tier)
  }

  const envTier = capEnv(env).GITHUB_PLAN_TIER
  if (isGitHubTier(envTier)) return envTier
  return 'free'
}

/**
 * Async convenience: can this pot use `feature` right now? Resolves tier + kill switch.
 * This is the call sites use before taking an Enterprise-tagged path.
 */
export async function githubCan(env: Env, feature: GitHubFeature): Promise<boolean> {
  const tier = await resolveGitHubTier(env)
  return featureEnabled(tier, feature, { enterpriseEnabled: enterpriseFeaturesEnabled(env) })
}

/**
 * Snapshot of every feature's enabled/disabled state — for the connectors dashboard,
 * so an operator sees exactly what is on, what their tier unlocks, and what the kill
 * switch is gating. Pure presentation; no secrets.
 */
export async function githubCapabilitySnapshot(
  env: Env,
): Promise<{ tier: GitHubTier; enterpriseEnabled: boolean; features: Array<{ feature: GitHubFeature; label: string; enterprise: boolean; minTier: GitHubTier; enabled: boolean }> }> {
  const tier = await resolveGitHubTier(env)
  const enterpriseEnabled = enterpriseFeaturesEnabled(env)
  const features = (Object.keys(GITHUB_FEATURES) as GitHubFeature[]).map((feature) => {
    const spec = GITHUB_FEATURES[feature]
    return {
      feature,
      label: spec.label,
      enterprise: spec.enterprise,
      minTier: spec.minTier,
      enabled: featureEnabled(tier, feature, { enterpriseEnabled }),
    }
  })
  return { tier, enterpriseEnabled, features }
}
