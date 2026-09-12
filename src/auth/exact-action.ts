// mupot — the exact-action approval contract (SENSITIVE). Companion to the
// elevation ledger (src/auth/elevation.ts, migrations/0148) and its exact-
// action binding table (migrations/0152_elevation_action_bindings.sql).
//
// THE DEFECT CLASS THIS CLOSES: an elevation grant names an ACTION KEY +
// SCOPE ("action:knowledge_write on squad X") and authorizes ANY instance of
// that action for the life of the grant — any payload, to any target, at any
// revision. A human approving that request today would authorize hostd to
// write anything, anywhere, under that grant. `ExactAction` is the shape of
// ONE concrete instance of a protected action; `exactActionHash` is a
// deterministic fingerprint of it that a human's approval (via the
// elevation_action_bindings row) freezes at approval time, and that
// verifyProtectedAction (src/auth/protected-action.ts) later demands an
// EXACT match against before treating the action as approved.
//
// CANONICAL JSON / HASH CONTRACT — read before touching canonicalExactActionJson:
//
// canonicalExactActionJson must byte-for-byte match what a Python caller
// (hostd, or any non-JS verifier) computes as:
//
//   json.dumps(obj, sort_keys=True, separators=(',', ':'))
//
// for ASCII input. The key order below (destination, expected_revision,
// expires_at, operation, payload_hash, principal, target{id,revision,system},
// tenant) is not arbitrary — it IS the alphabetical order `sort_keys=True`
// produces, so building the JS object with keys inserted in exactly this
// order and calling JSON.stringify (which preserves string-key insertion
// order and, with no `space` argument, emits no whitespace) reproduces
// Python's compact sorted-keys output exactly, for every ASCII field value.
//
// NON-ASCII CAVEAT (documented, not silently handled): Python's json.dumps
// defaults to ensure_ascii=True, which \uXXXX-escapes every non-ASCII
// character. JSON.stringify does not — it emits the raw UTF-8 characters.
// The two implementations WOULD disagree on a hash for non-ASCII input. This
// module closes that gap by construction rather than by matching escaping
// behavior: validateExactActionInput rejects any field containing a
// non-ASCII-printable character before canonicalExactActionJson/
// exactActionHash ever see it, so no value either implementation hashes can
// ever exercise the disagreement. tests/elevation-exact-action.test.ts pins
// both halves: one ASCII-only vector cross-checked against a Python-computed
// hex digest, and one assertion that non-ASCII input is refused at
// validation.
//
// Hashing uses crypto.subtle (Web Crypto) exclusively — no `node:crypto`
// import anywhere in src/, matching this codebase's Workers-only I/O rule.

export interface ExactActionTarget {
  system: string
  id: string
  revision: string
}

/**
 * ExactAction — the full, server-assembled shape of one concrete protected
 * action. `principal` and `tenant` are ALWAYS server-derived (the acting
 * agent's own id, from resolveAgentSessionContext / auth.tenant) — nothing
 * in this module or its callers ever takes either field from client-supplied
 * args. See src/auth/protected-action.ts and elevation.ts's
 * createElevationRequest for the two places this type is assembled.
 */
export interface ExactAction {
  principal: string
  tenant: string
  target: ExactActionTarget
  expected_revision: string
  payload_hash: string
  destination: string
  operation: string
  /** The action's OWN declared expiry — distinct from an elevation grant's
   *  own expires_at. Part of the hash: changing it changes what was approved. */
  expires_at: string
}

/**
 * canonicalExactActionJson — deterministic JSON with keys in a fixed sorted
 * order (see module header). Object literals below are written in that exact
 * order on purpose — JS preserves string-key insertion order, so reordering
 * these lines changes the wire format.
 */
export function canonicalExactActionJson(a: ExactAction): string {
  const canonical = {
    destination: a.destination,
    expected_revision: a.expected_revision,
    expires_at: a.expires_at,
    operation: a.operation,
    payload_hash: a.payload_hash,
    principal: a.principal,
    target: {
      id: a.target.id,
      revision: a.target.revision,
      system: a.target.system,
    },
    tenant: a.tenant,
  }
  return JSON.stringify(canonical)
}

/** exactActionHash — SHA-256 hex (lowercase) of the UTF-8 canonical JSON,
 *  via crypto.subtle (Workers-compatible). */
export async function exactActionHash(a: ExactAction): Promise<string> {
  const json = canonicalExactActionJson(a)
  const data = new TextEncoder().encode(json)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// ── validation ───────────────────────────────────────────────────────────

const MAX_FIELD_LEN = 512
// ASCII printable, excluding control characters (0x20 space .. 0x7E tilde).
// Deliberately excludes every non-ASCII codepoint — see module header.
const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/
const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/

function isAsciiPrintable(v: unknown, maxLen = MAX_FIELD_LEN): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && ASCII_PRINTABLE_RE.test(v)
}

export type ValidateExactActionResult =
  | { ok: true; action: ExactAction }
  | { ok: false; reason: string }

/**
 * validateExactActionInput — every field must be a non-empty, ASCII-printable
 * string within a bounded length (payload_hash additionally must be a
 * lowercase 64-hex SHA-256; expires_at additionally must parse as an ISO
 * timestamp). Returns a typed result, NEVER throws — callers (elevation.ts,
 * protected-action.ts) are on a request-validation path, not a "this cannot
 * happen" path.
 */
export function validateExactActionInput(raw: unknown): ValidateExactActionResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'exact_action must be an object' }
  }
  const r = raw as Record<string, unknown>

  const target = r.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, reason: 'exact_action.target must be an object' }
  }
  const t = target as Record<string, unknown>

  if (!isAsciiPrintable(r.principal)) return { ok: false, reason: 'invalid principal' }
  if (!isAsciiPrintable(r.tenant)) return { ok: false, reason: 'invalid tenant' }
  if (!isAsciiPrintable(t.system)) return { ok: false, reason: 'invalid target.system' }
  if (!isAsciiPrintable(t.id)) return { ok: false, reason: 'invalid target.id' }
  if (!isAsciiPrintable(t.revision)) return { ok: false, reason: 'invalid target.revision' }
  if (!isAsciiPrintable(r.expected_revision)) return { ok: false, reason: 'invalid expected_revision' }
  if (typeof r.payload_hash !== 'string' || !PAYLOAD_HASH_RE.test(r.payload_hash)) {
    return { ok: false, reason: 'payload_hash must be a lowercase 64-character hex sha256' }
  }
  if (!isAsciiPrintable(r.destination)) return { ok: false, reason: 'invalid destination' }
  if (!isAsciiPrintable(r.operation)) return { ok: false, reason: 'invalid operation' }
  if (typeof r.expires_at !== 'string' || r.expires_at.length === 0 || Number.isNaN(Date.parse(r.expires_at))) {
    return { ok: false, reason: 'expires_at must be a parseable ISO timestamp' }
  }

  return {
    ok: true,
    action: {
      principal: r.principal as string,
      tenant: r.tenant as string,
      target: {
        system: t.system as string,
        id: t.id as string,
        revision: t.revision as string,
      },
      expected_revision: r.expected_revision as string,
      payload_hash: r.payload_hash as string,
      destination: r.destination as string,
      operation: r.operation as string,
      expires_at: r.expires_at as string,
    },
  }
}

// ── arg-shape guards (schema-level, used by the MCP tool layer) ─────────────
//
// src/mcp/index.ts's validateArgs enforces `additionalProperties:false` only
// at the TOP level of a tool's own inputSchema — it does not recurse into a
// nested `{type:'object'}` property. request_elevation's `exact_action` arg
// and verify_protected_action's `target` arg are both such nested objects,
// so their own allowed-key sets are enforced here instead, by the tool
// handlers that call these two functions before touching the value.

const EXACT_ACTION_TARGET_KEYS = ['system', 'id', 'revision'] as const
const EXACT_ACTION_REQUEST_KEYS = ['target', 'expected_revision', 'payload_hash', 'destination', 'operation', 'expires_at'] as const

/** Validates the shape (allowed keys + string-typed fields) of a `target`
 *  argument. Does NOT validate content (ASCII/length/etc) — that is
 *  validateExactActionInput's job, once the fields are known well-shaped. */
export function validateExactActionTargetShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'target must be an object'
  const t = raw as Record<string, unknown>
  for (const k of Object.keys(t)) {
    if (!(EXACT_ACTION_TARGET_KEYS as readonly string[]).includes(k)) return `unknown field in target: ${k}`
  }
  for (const k of EXACT_ACTION_TARGET_KEYS) {
    if (typeof t[k] !== 'string') return `target.${k} must be a string`
  }
  return null
}

/** Validates the shape of a full `exact_action` argument (request_elevation) —
 *  its own allowed keys, plus its nested `target`'s. additionalProperties:false
 *  equivalent for both levels, so a caller cannot smuggle `principal`/`tenant`
 *  (or any other field) into a client-supplied exact_action — both are always
 *  server-derived (see ExactAction's own doc comment). */
export function validateExactActionRequestShape(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'exact_action must be an object'
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) {
    if (!(EXACT_ACTION_REQUEST_KEYS as readonly string[]).includes(k)) return `unknown field in exact_action: ${k}`
  }
  const targetError = validateExactActionTargetShape(r.target)
  if (targetError) return `exact_action.${targetError}`
  for (const k of ['expected_revision', 'payload_hash', 'destination', 'operation', 'expires_at'] as const) {
    if (typeof r[k] !== 'string') return `exact_action.${k} must be a string`
  }
  return null
}
