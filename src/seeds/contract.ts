// mupot.seed/v1 — the declarative description of a project a person wants attached
// to a pot. A seed REQUESTS; it never GRANTS. Nothing in a seed is authority: no
// credential value, no capability, no approval. Every request the seed implies is
// surfaced as an explicit line that a human must accept in a later, separate step.
// Contract doc: docs/architecture/seed-v1.md. Modelled on src/addons/contract.ts.

export const SEED_SCHEMA = 'mupot.seed/v1' as const

export const SEED_MAX_BYTES = 32 * 1024
export const SEED_MAX_DEPTH = 6
export const SEED_MAX_SEATS = 8
export const SEED_MAX_LIST = 50

export const SEED_KINDS = ['site/astro', 'site/wordpress', 'store/shopify', 'app', 'repo'] as const
export const SEED_DEPLOY_VIA = ['cf-pages', 'wrangler', 'wp-plugin', 'shopify-cli', 'git-push-only'] as const
export const SEED_SURFACE_MODES = ['propose', 'direct'] as const
// Same memory tiers as the content collections (private = brain … public = blog).
export const SEED_DATA_TIERS = ['private', 'squad', 'project', 'role', 'entity', 'public'] as const
export const SEED_RISK_CLASSES = ['low', 'medium', 'high'] as const
export const SEED_ROUTINE_APPROVALS = ['human_accept', 'per_run'] as const
// A seat may never ask for more than member.
export const SEED_SEAT_CAPABILITIES = ['observer', 'member'] as const

export const CRED_SLOT_RE = /^[A-Z][A-Z0-9_]{2,63}$/
export const SEED_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SeedKind = (typeof SEED_KINDS)[number]
export type SeedDeployVia = (typeof SEED_DEPLOY_VIA)[number]
export type SeedSurfaceMode = (typeof SEED_SURFACE_MODES)[number]
export type SeedDataTier = (typeof SEED_DATA_TIERS)[number]
export type SeedRiskClass = (typeof SEED_RISK_CLASSES)[number]
export type SeedRoutineApproval = (typeof SEED_ROUTINE_APPROVALS)[number]

export interface SeedSurface { path?: string; type?: string; mode: SeedSurfaceMode }
export interface SeedData { store: string; tier: SeedDataTier }
export interface SeedTool { mcp?: string; openapi?: string; cred_slot?: string }
export interface SeedGateWant { action: string; gate: string }
export interface SeedRoutineWant { id: string; cron: string; approval: SeedRoutineApproval }
export interface SeedSeatsWant { squad: string; max: number; capability?: 'observer' | 'member' }

export interface SeedV1 {
  schema: typeof SEED_SCHEMA
  slug: string
  name: string
  kind: SeedKind
  goal: string
  owner: string
  repo?: string
  live?: string
  deploy?: { via: SeedDeployVia; cmd?: string; receipt?: string; human_only: true }
  surfaces?: SeedSurface[]
  data?: SeedData[]
  tools?: SeedTool[]
  wants?: {
    memory?: string[]
    gates?: SeedGateWant[]
    routines?: SeedRoutineWant[]
    seats?: SeedSeatsWant
  }
  signals?: { health?: string[]; outcome?: string[] }
  risk?: { class: SeedRiskClass; forbidden?: string[]; human_only?: string[]; allow_direct?: string[] }
}

export type SeedErrorCode =
  | 'seed_too_large' | 'seed_unparseable' | 'seed_not_object' | 'seed_too_deep'
  | 'secret_in_seed' | 'unknown_key' | 'missing_field' | 'invalid_field'
  | 'invalid_schema' | 'invalid_cred_slot' | 'deploy_not_human_only'
  | 'direct_not_allowed' | 'seat_cap_exceeded' | 'seat_capability_too_high'

export interface SeedError { code: SeedErrorCode; path: string; message: string }

/** Something the seed ASKS for. Validation grants none of it. */
export interface SeedRequest {
  kind: 'gate' | 'routine' | 'seat' | 'memory' | 'tool_credential' | 'direct_surface'
  detail: string
  needs: 'human_accept'
}

export type SeedValidation =
  | { ok: true; seed: SeedV1; canonical: string; seedSha256: string; requests: SeedRequest[] }
  | { ok: false; error: SeedError }
