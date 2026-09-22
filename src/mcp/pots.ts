// src/mcp/pots.ts — Sovereign Pot Provisioning MCP Tools.

import type { ToolOutcome, ToolSpec } from './index'
import { isOrgAdmin } from '../auth/capability'
import { provisionSovereignPot, listSovereignPots, PotSlugTakenError } from '../pots/service'
import { PROVISION_ALLOWED_FIELDS, validateProvisionRequestBody } from '../pots/validate'

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

const STRING_SCHEMA = { type: 'string' }

export const toolPotProvision: ToolSpec = {
  name: 'pot_provision',
  scope: 'org:admin (1-Click provision an isolated customer sovereign pot with dedicated D1/KV)',
  min: 'admin',
  args: '{ slug: string, brand_name: string, admin_email: string, admin_name?: string, plan_tier?: string, custom_domain?: string }',
  inputSchema: {
    type: 'object',
    // Built from src/pots/validate.ts's PROVISION_ALLOWED_FIELDS — the SAME list
    // src/pots/routes.ts's HTTP body validator enforces, so the two surfaces cannot drift
    // (mupot#1507 round-2 P0-3: they already had, silently, before this fix).
    properties: Object.fromEntries(PROVISION_ALLOWED_FIELDS.map((field) => [field, STRING_SCHEMA])),
    required: ['slug', 'brand_name', 'admin_email'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!isOrgAdmin(auth)) {
      return fail(403, 'forbidden', 'Only org administrators can provision sovereign pots.')
    }
    // Same operator-principal fence as the HTTP route (src/pots/routes.ts) — a bound-agent
    // session must never trigger sovereign-pot provisioning on its own weld token.
    if (auth.boundAgentId) {
      return fail(403, 'operator_principal_required', 'Provisioning a sovereign pot requires an operator principal, not a bound-agent session.')
    }
    if (auth.tenant !== env.TENANT_SLUG) {
      return fail(403, 'tenant_mismatch', 'Caller tenant does not match this deployment.')
    }

    const validated = validateProvisionRequestBody(args)
    if (!validated.ok) {
      return fail(400, validated.error, validated.message)
    }

    if (!env.SECRET_ENV_CF_API_TOKEN) {
      return fail(503, 'unconfigured', 'Cloudflare API Token not configured for pot provisioning.')
    }

    try {
      const result = await provisionSovereignPot(env, {
        ...validated.value,
        // validateProvisionRequestBody keeps plan_tier as a plain trimmed string (it has no
        // opinion on the SovereignPotTier union); provisionSovereignPot's own
        // `input.plan_tier || 'enterprise'` fallback treats any non-recognized value the
        // same as absent, so a narrowing cast here is safe.
        plan_tier: validated.value.plan_tier as import('../pots/types').SovereignPotTier | undefined,
        minted_by_member_id: auth.memberId,
        caller_tenant: auth.tenant,
      })
      // `done()` reads as success to every caller. When provisioning did not finish, say so
      // in the payload rather than letting the envelope speak for the outcome.
      return done({
        pot: result,
        ok: result.ok,
        status: result.status,
        ...(result.ok ? {} : { warning: result.incomplete_reason }),
      })
    } catch (err) {
      if (err instanceof PotSlugTakenError) {
        return fail(409, err.code, err.message)
      }
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
