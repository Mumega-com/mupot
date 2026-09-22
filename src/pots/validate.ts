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
  | {
      ok: false
      error: 'invalid_body' | 'unexpected_fields' | 'missing_required_fields' | 'field_too_long' | 'invalid_email'
      message: string
    }

// mupot#1516 round-2 P2-5: bound caller-suppliable strings BEFORE they reach
// `provisionSovereignPot` — an unbounded `brand_name`/`admin_name` becomes
// `${brand_name} Lead Agent` (a `members.display_name`/`agents.name` value) and is also
// interpolated, inline (not bound), into the atomic seed batch (`seedPotIdentities`'s
// `lit()`); an unbounded `admin_email` is likewise inlined. `D1_MAX_STATEMENT_BYTES` in
// `tests/helpers/d1-rest-double.ts` models D1's real 100KB-per-statement cap for exactly
// this reason — these bounds keep an ordinary caller nowhere near it while still refusing a
// caller who tries. 254 for email is RFC 5321 §4.5.3.1.3's maximum total mailbox length; 200
// for the two display-name fields is generous for any real brand/person name while keeping
// the largest single seed-batch statement (`INSERT INTO members ...`, four inlined string
// literals) comfortably under a few KB.
const MAX_BRAND_NAME_LENGTH = 200
const MAX_ADMIN_NAME_LENGTH = 200
const MAX_ADMIN_EMAIL_LENGTH = 254

// mupot#1523 round-2 P1 item 6: whitespace (space, tab, newline, ...) and Unicode control
// characters (category Cc — the C0/C1 ranges, which `\s` does not fully cover: e.g. NUL
// U+0000 is Cc but not `\s`) never legitimately appear in a mailbox address; a caller-supplied
// `admin_email` containing one is refused outright rather than silently accepted and passed
// through to an inlined seed-batch SQL statement.
const EMAIL_WHITESPACE_OR_CONTROL_RE = /[\s\p{Cc}]/u

/** Basic `admin_email` SHAPE validation (mupot#1520 P1-A) — not a full RFC 5322 validator (no
 *  attempt at quoted local parts, IP-literal domains, or IDNA percent-encoding), just enough
 *  to close the round-2 gate's proof that `notanemail` sailed through unchallenged all the
 *  way to an inlined seed-batch SQL statement and a `pot_provision_receipts` row. Requires:
 *  no whitespace or control character anywhere (mupot#1523 round-2 P1 item 6); exactly one
 *  '@'; a non-empty local part before it; and a domain after it split on '.' into two or more
 *  segments, EVERY one of them non-empty (mupot#1523 round-2 P1 item 6 — the round-1 version
 *  only checked the FIRST and LAST segment via `lastIndexOf('.')`, so `a@b..c` — an empty
 *  segment in the MIDDLE — slipped through). So `notanemail`, `admin@localhost`,
 *  `admin@.com`, `admin@b.`, and `a@b..c` are all refused, while `admin@example.com` and a
 *  unicode domain like `admin@exämple.com` are both accepted. Length is bounded separately,
 *  above (`MAX_ADMIN_EMAIL_LENGTH`, RFC 5321 §4.5.3.1.3's 254). */
function isPlausibleEmailShape(email: string): boolean {
  if (EMAIL_WHITESPACE_OR_CONTROL_RE.test(email)) return false
  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@')) return false // exactly one '@', non-empty local part
  const domain = email.slice(at + 1)
  const domainSegments = domain.split('.')
  if (domainSegments.length < 2 || domainSegments.some((segment) => segment.length === 0)) return false
  return true
}

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
  const admin_name = optStr(record.admin_name)
  if (!slug || !brand_name || !admin_email) {
    return {
      ok: false,
      error: 'missing_required_fields',
      message: 'Required fields: slug, brand_name, admin_email.',
    }
  }
  if (brand_name.length > MAX_BRAND_NAME_LENGTH) {
    return { ok: false, error: 'field_too_long', message: `brand_name must be ${MAX_BRAND_NAME_LENGTH} characters or fewer.` }
  }
  if (admin_email.length > MAX_ADMIN_EMAIL_LENGTH) {
    return { ok: false, error: 'field_too_long', message: `admin_email must be ${MAX_ADMIN_EMAIL_LENGTH} characters or fewer.` }
  }
  if (!isPlausibleEmailShape(admin_email)) {
    return { ok: false, error: 'invalid_email', message: 'admin_email must look like a real email address (one "@", a non-empty local part, and a domain containing a ".").' }
  }
  if (admin_name !== undefined && admin_name.length > MAX_ADMIN_NAME_LENGTH) {
    return { ok: false, error: 'field_too_long', message: `admin_name must be ${MAX_ADMIN_NAME_LENGTH} characters or fewer.` }
  }

  return {
    ok: true,
    value: {
      slug,
      brand_name,
      admin_email,
      admin_name,
      plan_tier: optStr(record.plan_tier),
      custom_domain: optStr(record.custom_domain),
    },
  }
}
