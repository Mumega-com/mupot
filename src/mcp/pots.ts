// src/mcp/pots.ts — Sovereign Pot Provisioning MCP Tools.

import type { ToolOutcome, ToolSpec } from './index'
import { isOrgAdmin } from '../auth/capability'
import { provisionSovereignPot, listSovereignPots } from '../pots/service'
import type { SovereignPotProvisionInput } from '../pots/types'

function done(result: unknown): ToolOutcome {
  return { ok: true, result }
}

function fail(
  status: Extract<ToolOutcome, { ok: false }>['status'],
  error: string,
  detail?: unknown,
): ToolOutcome {
  return { ok: false, status, error, detail }
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
    if (!isOrgAdmin(auth)) {
      return fail(403, 'forbidden', 'Only org administrators can provision sovereign pots.')
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
      }
      const result = await provisionSovereignPot(env, input)
      // `done()` reads as success to every caller. When provisioning did not finish, say so
      // in the payload rather than letting the envelope speak for the outcome.
      return done({
        pot: result,
        ok: result.ok,
        status: result.status,
        ...(result.ok ? {} : { warning: result.incomplete_reason }),
      })
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
    if (!isOrgAdmin(auth)) {
      return fail(403, 'forbidden', 'Only org administrators can list sovereign pots.')
    }

    const accountId = env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
    const apiToken = env.SECRET_ENV_CF_API_TOKEN
    if (!apiToken) {
      return fail(503, 'unconfigured', 'Cloudflare API Token not configured for pot listing.')
    }

    try {
      const pots = await listSovereignPots({ accountId, apiToken })
      return done({ count: pots.length, pots })
    } catch (err) {
      return fail(500, 'list_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

export const POT_TOOLS: ToolSpec[] = [toolPotProvision, toolPotList]
