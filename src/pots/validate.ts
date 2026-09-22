// src/pots/validate.ts — the ONE allowed-field list for a provisioning request, shared by
// the HTTP route (src/pots/routes.ts) and the MCP tool (src/mcp/pots.ts).
//
// mupot#1507 round-2 adversarial gate, P0-3: `POST /api/pots/provision` used to spread the
// raw parsed JSON body straight into `provisionSovereignPot` — `{...body, minted_by_member_id}`
// — so a caller holding nothing more than org:admin on the PARENT tenant could supply
// `worker_js_code` (arbitrary JS deployed into the `mupot-pots` dispatch namespace using the
// SERVER's own Cloudflare token) or `cf_api_token`/`account_id` (redirect the call at a
// caller-chosen Cloudflare account entirely). The MCP tool was never vulnerable to this — its
// `inputSchema` already declares `additionalProperties: false` and `src/mcp/index.ts`'s
// `invokeTool` runs `validateArgs` against it BEFORE `spec.run()` ever sees the args — but the
// two surfaces independently hand-listed "the allowed fields," which is exactly the
// "two tools, two copies of one predicate" class: the list can drift, and here it silently did
// (routes.ts's own hand-check only asserted the three REQUIRED fields were present, never
// that nothing ELSE was).
//
// This file is the fix: one field list, one validator, both surfaces call it. Athena's
// round-2 condition (iii) additionally requires the PROVISIONER FUNCTION ITSELF to refuse
// these fields regardless of surface (defense in depth) — that check lives in
// `src/pots/service.ts` (`assertNoForbiddenProvisionInputKeys`), structurally impossible to
// skip since every call path funnels through `provisionSovereignPot`.

/** Every field a provisioning request may legitimately name. Nothing else — not
 *  `worker_js_code`, not `cf_api_token`, not `account_id` — is ever caller-suppliable
 *  through either surface. Those exist ONLY as the `provisionSovereignPot` function's own
 *  positional argument (`workerJsCode`, server/CI-only, structurally unreachable from a
 *  JSON body or MCP tool args object) or environment bindings. */
export const PROVISION_ALLOWED_FIELDS = [
  'slug',
  'brand_name',
  'admin_email',
  'admin_name',
  'plan_tier',
  'custom_domain',
] as const

export type ProvisionAllowedField = (typeof PROVISION_ALLOWED_FIELDS)[number]

export interface ValidatedProvisionRequestBody {
  slug: string
  brand_name: string
  admin_email: string
  admin_name?: string
  plan_tier?: string
  custom_domain?: string
}

export type ValidateProvisionRequestBodyResult =
  | { ok: true; value: ValidatedProvisionRequestBody }
  | { ok: false; error: 'invalid_body' | 'unexpected_fields' | 'missing_required_fields'; message: string }

/** Validates a raw HTTP JSON body against the EXACT same field set the MCP tool's
 *  `additionalProperties: false` schema already enforces. Any key outside
 *  `PROVISION_ALLOWED_FIELDS` is refused outright (400), named in the error — never
 *  silently dropped, which would look like success to a caller probing for the hole. */
export function validateProvisionRequestBody(body: unknown): ValidateProvisionRequestBodyResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body', message: 'Request body must be a JSON object.' }
  }
  const record = body as Record<string, unknown>
  const allowed = new Set<string>(PROVISION_ALLOWED_FIELDS)
  const extraKeys = Object.keys(record).filter((key) => !allowed.has(key))
  if (extraKeys.length > 0) {
    return {
      ok: false,
      error: 'unexpected_fields',
      message:
        `Unexpected field(s): ${extraKeys.join(', ')}. Only ${PROVISION_ALLOWED_FIELDS.join(', ')} ` +
        'are accepted — Cloudflare credentials and worker bundles are never caller-suppliable ' +
        '(mupot#1507 P0-3).',
    }
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const optStr = (v: unknown): string | undefined => {
    const s = str(v)
    return s.length > 0 ? s : undefined
  }

  const slug = str(record.slug)
  const brand_name = str(record.brand_name)
  const admin_email = str(record.admin_email)
  if (!slug || !brand_name || !admin_email) {
    return {
      ok: false,
      error: 'missing_required_fields',
      message: 'Required fields: slug, brand_name, admin_email.',
    }
  }

  return {
    ok: true,
    value: {
      slug,
      brand_name,
      admin_email,
      admin_name: optStr(record.admin_name),
      plan_tier: optStr(record.plan_tier),
      custom_domain: optStr(record.custom_domain),
    },
  }
}
