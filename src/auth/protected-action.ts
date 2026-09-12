// mupot — verifyProtectedAction (SENSITIVE). The exact-action approval
// contract's enforcement half: "is THIS exact knowledge write approved?"
//
// Separate file (not src/auth/elevation.ts) so tests/elevation-actions-
// enforced.test.ts's literal-call-site scanner sees `hasElevatedAction(env,
// auth, 'action:knowledge_write', ...)` as a genuine CONSUMER of the action —
// the scanner excludes elevation.ts itself (the action's declaring/enforcing
// module) as the callee, not a caller, so the real call site must live
// elsewhere. See that file's own header for the anti-vacuity reasoning.
//
// WHY A LIVE hasElevatedAction GRANT IS NOT ENOUGH HERE: hasElevatedAction
// answers "does a human currently authorize this agent session to perform
// SOME instance of action:knowledge_write, on this scope". That is the same
// coarse-grained authority every other elevated action gets — sufficient for
// "may deploy", not sufficient for "may write THIS EXACT payload to THIS
// EXACT target at THIS EXACT revision". verifyProtectedAction therefore
// layers a SECOND check on top: the elevation_action_bindings row
// (migrations/0152) a human's approval froze for this request, matched
// byte-exact by a server-recomputed SHA-256 (src/auth/exact-action.ts). A
// live grant with the wrong bound action, an expired bound action, or a
// caller's hash for a DIFFERENT payload all deny, even though the grant
// itself is live and valid for the action+scope.
import type { AuthContext, CapabilityScopeType, Env } from '../types'
import { resolveAgentSessionContext } from './agent-sessions'
import {
  type ElevatedActionDenyReason,
  elevationRemedyMessage,
  hasElevatedAction,
  loadElevationActionBinding,
  recordElevationUsage,
} from './elevation'
import { type ExactActionTarget, exactActionHash, validateExactActionInput } from './exact-action'

export interface VerifyProtectedActionInput {
  exact_action_hash: string
  target: ExactActionTarget
  expected_revision: string
  payload_hash: string
  destination: string
  operation: string
  expires_at: string
}

export interface VerifyProtectedActionOptions {
  nowMs?: number
  /** Defaults to 'org' scope, scopeId ''. hasElevatedAction's org-scope
   *  branch matches unconditionally regardless of what scope is queried, so
   *  this default is sufficient for any grant approved at org scope. A caller
   *  that knows the request was approved at squad/department scope should
   *  pass it explicitly — see hasElevatedAction's own scope-matching rules
   *  (src/auth/elevation.ts). This is a documented MVP simplification: the
   *  verify_protected_action MCP tool (src/mcp/index.ts) does not accept a
   *  scope argument from hostd today, so it always uses the default. */
  scopeType?: CapabilityScopeType
  scopeId?: string
  squadDepartmentId?: string | null
}

export interface VerifiedApproval {
  issuer_member_id: string
  issuer_web_session_live: true
  grant_id: string
  bound_action_hash: string
  /** min(grant.expires_at, binding.expires_at) — see migrations/0152's header
   *  for why the two are independent ceilings. */
  expires_at: string
  scope: { type: CapabilityScopeType; id: string }
}

export type VerifyProtectedActionDenyReason =
  | ElevatedActionDenyReason
  | 'invalid_exact_action'
  | 'action_hash_mismatch'
  | 'no_bound_action'
  | 'bound_action_mismatch'
  | 'action_expired'

export type VerifyProtectedActionResult =
  | { ok: true; approval: VerifiedApproval }
  | { ok: false; reason: VerifyProtectedActionDenyReason; detail?: unknown }

const NEW_DENY_REMEDY: Record<'invalid_exact_action' | 'action_hash_mismatch' | 'no_bound_action' | 'bound_action_mismatch' | 'action_expired', string> = {
  invalid_exact_action: 'the exact-action fields did not validate — check target/expected_revision/payload_hash/destination/operation/expires_at (ASCII-printable, payload_hash a 64-hex sha256, expires_at a parseable ISO timestamp)',
  action_hash_mismatch: 'the supplied exact_action_hash does not match a hash computed server-side from the same fields — recompute exactActionHash over the identical canonical fields',
  no_bound_action: 'no human approved this exact action — call request_elevation for action:knowledge_write with a matching exact_action and get it approved first',
  bound_action_mismatch: 'a human approved a DIFFERENT exact action under this grant — this exact payload/target/destination/operation/revision was never approved',
  action_expired: 'the approved action itself has expired (independent of the grant) — request a fresh elevation for this exact action',
}

/** protectedActionRemedyMessage — one canonical human/agent-readable string
 *  per deny reason, reusing elevation.ts's own table for the reasons this
 *  module shares with hasElevatedAction. */
export function protectedActionRemedyMessage(reason: VerifyProtectedActionDenyReason): string {
  if (reason in NEW_DENY_REMEDY) {
    return NEW_DENY_REMEDY[reason as keyof typeof NEW_DENY_REMEDY]
  }
  return elevationRemedyMessage(reason as ElevatedActionDenyReason)
}

/**
 * verifyProtectedAction — THE enforcement primitive for the exact-action
 * approval contract. Fails closed at every step; never throws (except (i)'s
 * usage-log write, which is DELIBERATELY allowed to propagate per rule
 * "if the log write fails, the action must fail" — see recordElevationUsage's
 * own doc comment).
 *
 * Steps (see migrations/0152 + src/auth/exact-action.ts for the shapes):
 *   (a) resolve the acting agent SESSION from auth — never from args.
 *   (b) validate the caller's claimed exact-action fields.
 *   (c) rebuild the ExactAction with principal/tenant from auth (never from
 *       args) and compute its hash server-side.
 *   (d) the CALLER's claimed exact_action_hash must match the computed one —
 *       catches a caller that hashed something different than what it sent.
 *   (e) hasElevatedAction must grant action:knowledge_write for this session
 *       (recordUsage:false — a real usage entry is written only after every
 *       later check also passes, at step (i)).
 *   (f) the grant's OWN elevation_request_id must have a bound action for
 *       action:knowledge_write.
 *   (g) the bound action's OWN hash (frozen at approval time, server-
 *       computed then too) must equal the computed hash — this is the
 *       actual "was THIS exact action approved" check.
 *   (h) the bound action's own expires_at must not have passed (exclusive:
 *       now === expires_at is expired, matching evaluateElevationGrant's
 *       own convention).
 *   (i) ONLY NOW record usage — if this write throws, the whole verify fails
 *       (no silent "approved but unaudited" outcome).
 */
export async function verifyProtectedAction(
  env: Env,
  auth: AuthContext,
  input: VerifyProtectedActionInput,
  opts: VerifyProtectedActionOptions = {},
): Promise<VerifyProtectedActionResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const scopeType: CapabilityScopeType = opts.scopeType ?? 'org'
  const scopeId = opts.scopeId ?? ''

  // (a)
  const sessionCtx = resolveAgentSessionContext(auth)
  if (!sessionCtx.ok) return { ok: false, reason: 'not_agent_session' }

  // (b) + (c) — principal/tenant are ALWAYS server-derived from auth, never
  // read from `input`, which carries no such fields at all (see
  // VerifyProtectedActionInput / the verify_protected_action MCP tool's
  // schema — neither accepts principal or tenant).
  const validated = validateExactActionInput({
    principal: sessionCtx.context.agentId,
    tenant: auth.tenant,
    target: input.target,
    expected_revision: input.expected_revision,
    payload_hash: input.payload_hash,
    destination: input.destination,
    operation: input.operation,
    expires_at: input.expires_at,
  })
  if (!validated.ok) return { ok: false, reason: 'invalid_exact_action', detail: validated.reason }

  const computedHash = await exactActionHash(validated.action)

  // (d)
  if (input.exact_action_hash !== computedHash) {
    return { ok: false, reason: 'action_hash_mismatch' }
  }

  // (e) — matchBindingHash: a session can hold MULTIPLE live
  // action:knowledge_write grants at once (one per concurrently-live exact
  // action, migrations/0153's header explains why that's legitimate).
  // "First live scope-matching grant" (this function's default matcher when
  // matchBindingHash is omitted) would pick whichever was approved most
  // recently, regardless of whether IT is the one bound to computedHash —
  // adversarial gate finding, P0-1 class. Passing computedHash here makes
  // hasElevatedAction iterate every live candidate and select the one whose
  // OWN binding matches, so an older still-live approval is reachable even
  // when a newer, unrelated one exists.
  const elevated = await hasElevatedAction(env, auth, 'action:knowledge_write', scopeType, scopeId, {
    nowMs,
    squadDepartmentId: opts.squadDepartmentId ?? undefined,
    recordUsage: false,
    matchBindingHash: computedHash,
  })
  if (!elevated.granted) return { ok: false, reason: elevated.reason }

  // (f) — redundant with (e)'s own binding lookup by construction (the
  // grant hasElevatedAction just returned was selected BECAUSE its binding's
  // action_hash already equals computedHash) — kept as defence in depth
  // rather than trusted-by-construction, so a future refactor of either
  // function's internals cannot silently reopen the shadowing bug without a
  // visible, testable check failing here too.
  const binding = await loadElevationActionBinding(env, auth.tenant, elevated.grant.elevation_request_id, 'action:knowledge_write')
  if (!binding) return { ok: false, reason: 'no_bound_action' }

  // (g)
  if (binding.action_hash !== computedHash) return { ok: false, reason: 'bound_action_mismatch' }

  // (h) — exclusive: now === expires_at reads as expired, matching
  // evaluateElevationGrant's own >= convention.
  if (nowMs >= Date.parse(binding.expires_at)) return { ok: false, reason: 'action_expired' }

  // (i) — must fail the verify if this throws (no catch here, deliberately).
  await recordElevationUsage(
    env,
    auth.tenant,
    elevated.grant.id,
    elevated.grant.agent_session_id,
    'action:knowledge_write',
    'verify_protected_action',
    {
      action_hash: computedHash,
      target: validated.action.target,
      expected_revision: validated.action.expected_revision,
      payload_hash: validated.action.payload_hash,
      destination: validated.action.destination,
      operation: validated.action.operation,
    },
    nowMs,
  )

  return {
    ok: true,
    approval: {
      issuer_member_id: elevated.grant.approved_by_member_id,
      issuer_web_session_live: true,
      grant_id: elevated.grant.id,
      bound_action_hash: computedHash,
      expires_at: new Date(Math.min(Date.parse(elevated.grant.expires_at), Date.parse(binding.expires_at))).toISOString(),
      scope: { type: elevated.grant.scope_type, id: elevated.grant.scope_id },
    },
  }
}
