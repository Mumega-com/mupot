// src/mcp/pots.ts — Sovereign Pot Provisioning MCP Tools.

import type { AuthContext, Env } from '../types'
import { isOrgAdmin, callerHoldsActionCapability } from '../auth/capability'
import { provisionSovereignPot, listSovereignPots } from '../pots/service'
import type { SovereignPotProvisionInput } from '../pots/types'

export interface ToolOutcome {
  ok: boolean
  status: number
  body: unknown
  tool?: string
}

export interface ToolSpec {
  name: string
  scope: string
  min: 'authenticated' | 'member' | 'lead' | 'admin' | 'owner'
  args: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  run: (auth: AuthContext, env: Env, args: Record<string, unknown>, ctx?: unknown) => Promise<ToolOutcome>
}

function done(result: unknown): ToolOutcome {
  return { ok: true, status: 200, body: result }
}

function fail(status: number, error: string, detail?: unknown): ToolOutcome {
  return { ok: false, status, body: { ok: false, error, detail } }
}

function str(val: unknown): string | null {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : null
}

const STRING_SCHEMA = { type: 'string' }

export const toolPotProvision: ToolSpec = {
  name: 'pot_provision',
  scope: 'org:admin (1-Click provision an isolated customer sovereign pot with dedicated D1/KV)',
  min: 'admin',
  args: '{ slug: string, brand_name: string, admin_email: string, admin_name?: string, plan_tier?: string, custom_domain?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      slug: STRING_SCHEMA,
      brand_name: STRING_SCHEMA,
      admin_email: STRING_SCHEMA,
      admin_name: STRING_SCHEMA,
      plan_tier: STRING_SCHEMA,
      custom_domain: STRING_SCHEMA,
    },
    required: ['slug', 'brand_name', 'admin_email'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const canProvision = isOrgAdmin(auth) || (await callerHoldsActionCapability(env, auth, 'action:manage_access'))
    if (!canProvision) {
      return fail(403, 'forbidden', 'Only org administrators or callers with action:manage_access can provision sovereign pots.')
    }

    const slug = str(args.slug)
    const brand_name = str(args.brand_name)
    const admin_email = str(args.admin_email)

    if (!slug || !brand_name || !admin_email) {
      return fail(400, 'invalid_args', 'Missing required fields: slug, brand_name, admin_email.')
    }

    try {
      const input: SovereignPotProvisionInput = {
        slug,
        brand_name,
        admin_email,
        admin_name: str(args.admin_name) || undefined,
        plan_tier: (str(args.plan_tier) as any) || 'enterprise',
        custom_domain: str(args.custom_domain) || undefined,
        migrations: Array.isArray(args.migrations) ? (args.migrations as string[]) : undefined,
      }
      const result = await provisionSovereignPot(env, input)
      return done({ ok: true, pot: result })
    } catch (err) {
      return fail(500, 'provisioning_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

export const toolPotList: ToolSpec = {
  name: 'pot_list',
  scope: 'org:admin (List all provisioned sovereign customer pots in WFP dispatch namespace)',
  min: 'admin',
  args: '{}',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run(auth, env) {
    const canList = isOrgAdmin(auth) || (await callerHoldsActionCapability(env, auth, 'action:manage_access'))
    if (!canList) {
      return fail(403, 'forbidden', 'Only org administrators or callers with action:manage_access can list sovereign pots.')
    }

    const accountId = env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
    const apiToken = env.SECRET_ENV_CF_API_TOKEN
    if (!apiToken) {
      return fail(503, 'unconfigured', 'Cloudflare API Token not configured for pot listing.')
    }

    try {
      const pots = await listSovereignPots({ accountId, apiToken })
      return done({ ok: true, count: pots.length, pots })
    } catch (err) {
      return fail(500, 'list_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

export const POT_TOOLS: ToolSpec[] = [toolPotProvision, toolPotList]
