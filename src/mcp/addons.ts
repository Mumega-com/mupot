// mupot — MCP addon lifecycle tools (SENSITIVE: org-admin-gated installation mutations).
//
// The addon lifecycle mutation routes (POST /api/addons/:key/install|configure|activate|
// disable|archive, src/addons/routes.ts `mutate()`) were dashboard-only: gated on
// isOrgAdmin(auth) where `auth` came from the session-cookie/OAuth-resolved AuthContext.
// A member-bearer-token MCP caller reaching that Hono app WOULD work too (routes.ts already
// resolves a non-cookie request via resolveOrgAdmin), but the tool was never exposed on the
// MCP surface itself — an agent could not name and call it in-band, only click through the
// dashboard. That gap is what produced the archive+reinstall incident on 2026-07-21: a human
// had to use the UI, which took a path the lifecycle service itself does not require.
//
// These tools call the SAME service functions the dashboard route calls
// (installAddon/configureAddon/activateAddon/disableAddon/archiveAddon, src/addons/service.ts)
// — no lifecycle logic is reimplemented here, only the calling convention adapts from Hono
// Context + HTTP body to MCP AuthContext + JSON args.
//
// Auth-context translation (session-role → capability-grant), the first time this pattern
// crossed from a dashboard-only admin route to MCP:
//   - Dashboard: auth.role is a coarse session string ('owner'|'admin'|'member'); isOrgAdmin
//     checks it directly. actor = { id: auth.userId, role: auth.role }.
//   - MCP: a member-bearer-token caller's auth.role is ALWAYS the coarse literal 'member'
//     (see authenticateMember in src/mcp/index.ts — "the REAL authorization is
//     `capabilities`"). The org-admin bar is `hasWorkspaceAdmin(auth)` — the fine-grained
//     capability-grant equivalent of isOrgAdmin, checking an org-scope 'admin' (or higher)
//     capability grant OR the legacy owner/admin session-role escape.
//   - AddonActor.role participates in TWO checks inside the service layer: authorized()
//     (`role === 'owner' || role === 'admin'`, src/addons/service.ts) and, since mupot#1587
//     P1-C, archiveAddon's OWN stricter `role !== 'owner'` refusal when the manifest's
//     retention.purgeRequiresOwner is true (every manifest today) — the service re-derives
//     both as its OWN defense-in-depth gates (never trusts the route's gate alone) and
//     stamps role into receipts (actor_id) for audit. So the correct translation is NOT
//     "copy auth.role" (that would always be 'member' and every call would 403 at the
//     service layer) — it is: claim EXACTLY the rank the caller proved, no more, using the
//     SAME capability-floor mechanism at each rung. Once hasWorkspaceAdmin(auth) is true,
//     actor.role is at least 'admin'; if the caller can ALSO prove an org-scope 'owner'
//     grant (or the legacy owner session-role), actor.role is 'owner' — see
//     resolveAdminEntry's own comment for why this second rung was added and why it is a
//     no-op for install/configure/activate/disable.
//   - actor.id is ALWAYS auth.memberId — server-derived from the bearer token, never from
//     caller-supplied args. No tool below reads an identity field out of `args`.
//
// Tools (registered into the TOOLS array in src/mcp/index):
//   addon_install    — org:admin — installAddon
//   addon_configure  — org:admin — configureAddon (bindings validated by the SAME
//                       validateBindingInputs the HTTP route uses, src/addons/bindings.ts)
//   addon_activate   — org:admin — activateAddon (idempotent on an already-active
//                       installation — see addon-loop-instantiation.test.ts / PR #439)
//   addon_disable    — org:admin — disableAddon
//   addon_archive    — org:admin — archiveAddon
//   addon_setup      — org:admin — install -> configure -> activate in one call, through the
//                       SAME three service functions (mupot#1662)

import type { AuthContext } from '../types'
import { getRegisteredAddon, type AddonCatalogEntry } from '../addons/registry'
import '../addons/modules'
import {
  activateAddon,
  archiveAddon,
  configureAddon,
  disableAddon,
  installAddon,
  type AddonActor,
  type AddonMutationResult,
} from '../addons/service'
import { validateBindingInputs } from '../addons/bindings'
import { OFFICE_ADDON_KEY, probeOfficeHealth } from '../addons/office/service'
import { hasCapability } from '../auth/capability'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }

type MutationFailure = Extract<AddonMutationResult, { ok: false }>

// mutationOutcome — mirrors mutationError() in src/addons/routes.ts exactly (same
// AddonFailureReason → status mapping) so the MCP surface and the dashboard surface report
// the same shape for the same failure. No default case: if AddonFailureReason grows a new
// member, TypeScript fails this switch at compile time instead of silently 500ing forever.
function mutationOutcome(result: MutationFailure) {
  switch (result.reason) {
    case 'addon_not_registered':
      return fail(404, result.reason)
    case 'not_authorized':
      return fail(403, 'forbidden', { need: 'org:admin' })
    case 'invalid_state':
    case 'manifest_digest_drift':
    case 'missing_required_slot':
    case 'unknown_slot':
    case 'adapter_not_allowed':
    case 'binding_kind_mismatch':
    case 'connector_not_available':
    case 'adapter_type_mismatch':
    case 'capability_mismatch':
    case 'operation_busy':
    case 'fence_lost':
    // An external_mcp manifest that fails installAddon's isolation invariants
    // (src/addons/service.ts externalIsolationViolation) — same 409 bucket as any
    // other "this manifest/installation cannot transition right now" refusal.
    case 'addon_external_invariant:rank_grants':
    case 'addon_external_invariant:multiple_departments':
    case 'addon_external_invariant:core_department_collision':
    case 'addon_external_invariant:agent_template_namespace':
    case 'addon_external_invariant:metric_namespace':
    case 'addon_external_invariant:surface_grant_namespace':
    case 'addon_external_invariant:approval_policy_namespace':
    case 'addon_external_invariant:connector_binding_kind':
    case 'addon_external_invariant:loops_not_allowed':
    case 'addon_external_invariant:event_subscription_allowlist':
      return fail(409, result.reason, { state: result.state ?? null })
    case 'write_failed':
      return fail(500, result.reason)
  }
}

function mutationSuccess(key: string, result: Extract<AddonMutationResult, { ok: true }>) {
  return done({
    key,
    state: result.state,
    ...(result.created ? { created: true } : {}),
    ...(result.idempotent ? { idempotent: true } : {}),
  })
}

// resolveAdminEntry — the shared gate + resolve step every lifecycle tool below runs first:
//   1. org:admin capability bar (the MCP-side isOrgAdmin equivalent — see file docstring).
//   2. a member identity to attribute the mutation to (always true once past the authn
//      middleware, per src/mcp/index.ts's documented invariant — checked again here in case
//      that invariant is ever violated, so this tool fails closed rather than writing an
//      undefined actor id into a receipt).
//   3. `key` present in args, and named a REGISTERED addon.
// Ordering matches routes.ts `mutate()`: the auth gate runs BEFORE resolving whether the key
// names a real addon, so an unauthorized caller cannot use this surface as an oracle for
// which addon keys exist.
async function resolveAdminEntry(
  auth: AuthContext,
  args: Record<string, unknown>,
): Promise<
  | { ok: true; key: string; entry: AddonCatalogEntry; actor: AddonActor }
  | { ok: false; outcome: ReturnType<typeof fail> }
> {
  if (!hasWorkspaceAdmin(auth)) return { ok: false, outcome: fail(403, 'forbidden', { need: 'org:admin' }) }
  if (!auth.memberId) return { ok: false, outcome: fail(403, 'forbidden', { need: 'member identity' }) }

  const key = str(args.key)
  if (!key) return { ok: false, outcome: fail(400, 'invalid_args', 'key required') }

  const entry = getRegisteredAddon(key)
  if (!entry) return { ok: false, outcome: fail(404, 'addon_not_registered') }

  // mupot#1587 P1-C: 'admin' unless the caller can ALSO prove 'owner' specifically —
  // still "claims exactly the rank the caller proved," just now able to prove one rung
  // higher via the SAME capability-floor mechanism hasWorkspaceAdmin already uses
  // ('org', null, 'owner' — an exact-or-higher floor check, not a guess). This mirrors
  // hasWorkspaceAdmin's own two-plane check (fine-grained capability grant OR the
  // legacy session-role escape) so a legacy owner session is recognized the same way.
  // Needed because archiveAddon (src/addons/service.ts) now refuses a non-owner actor
  // outright when the manifest's retention.purgeRequiresOwner is true (every manifest
  // today) — before this fix, EVERY MCP caller of addon_archive, including a genuine
  // org owner, was permanently claimed down to 'admin' and could never archive anything
  // through this tool. install/configure/activate/disable are unaffected: authorized()
  // treats owner and admin identically for those four, so this is a no-op for them.
  const isProvenOwner = auth.capabilities !== undefined
    ? hasCapability(auth.capabilities, 'org', null, 'owner')
    : auth.role === 'owner'
  return { ok: true, key, entry, actor: { id: auth.memberId, role: isProvenOwner ? 'owner' : 'admin' } }
}

const KEY_SCHEMA = {
  type: 'object' as const,
  properties: { key: STRING_SCHEMA },
  required: ['key'],
  additionalProperties: false,
}

const toolAddonInstall: ToolSpec = {
  name: 'addon_install',
  scope: 'org (org-admin installs a registered addon)',
  min: 'admin',
  args: '{ key: string }',
  inputSchema: KEY_SCHEMA,
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome
    const result = await installAddon(env, resolved.actor, resolved.key)
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

const toolAddonConfigure: ToolSpec = {
  name: 'addon_configure',
  scope: 'org (org-admin sets connector bindings for an addon installation)',
  min: 'admin',
  args: '{ key: string, bindings?: Array<{ slot: string, adapter: string, bindingKind: "internal_adapter"|"vault_connector", connectorId?: string }> }',
  inputSchema: {
    type: 'object',
    properties: {
      key: STRING_SCHEMA,
      bindings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slot: STRING_SCHEMA,
            adapter: STRING_SCHEMA,
            bindingKind: { type: 'string', enum: ['internal_adapter', 'vault_connector'] },
            connectorId: STRING_SCHEMA,
          },
          required: ['slot', 'adapter', 'bindingKind'],
          additionalProperties: false,
        },
      },
    },
    required: ['key'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome

    const rawBindings = args.bindings === undefined ? [] : args.bindings
    if (!Array.isArray(rawBindings)) return fail(400, 'invalid_args', 'bindings must be an array')

    // Same validator the HTTP route uses (src/addons/bindings.ts#validateBindingInputs) —
    // see that function's docstring for why there is exactly one implementation.
    const validated = validateBindingInputs(rawBindings, resolved.entry.manifest.connectorRequirements.length)
    if (!validated.ok) return fail(400, 'invalid_args', 'invalid bindings')

    const result = await configureAddon(env, resolved.actor, resolved.key, { bindings: validated.bindings })
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

const toolAddonActivate: ToolSpec = {
  name: 'addon_activate',
  scope: 'org (org-admin activates a configured addon installation)',
  min: 'admin',
  args: '{ key: string }',
  inputSchema: KEY_SCHEMA,
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome
    // activateAddon is idempotent on an already-'active' installation (materializes any
    // addon-declared loop claim via ensureLoopClaim if one is missing, but never archives
    // or reinstalls — PR #439 / tests/addon-loop-instantiation.test.ts). Re-running this
    // tool on a live installation reconciles it; it does not recreate it.
    const result = await activateAddon(env, resolved.actor, resolved.key)
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

const toolAddonDisable: ToolSpec = {
  name: 'addon_disable',
  scope: 'org (org-admin disables an active addon installation)',
  min: 'admin',
  args: '{ key: string }',
  inputSchema: KEY_SCHEMA,
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome
    const result = await disableAddon(env, resolved.actor, resolved.key)
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

const toolAddonArchive: ToolSpec = {
  name: 'addon_archive',
  scope: 'org (org-admin archives an addon installation)',
  min: 'admin',
  args: '{ key: string }',
  inputSchema: KEY_SCHEMA,
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome
    // P1-3 (kasra-review adversarial round 1, PR #1588): resolveAdminEntry's
    // isProvenOwner check reads auth.capabilities, and an agent-bound bearer
    // carries its OWNER MEMBER's capabilities (resolveCapabilities(c.env,
    // row.member_id), src/mcp/index.ts) — so an agent whose token was minted under
    // an owner member satisfies the org:owner capability check above even though
    // the actual PRINCIPAL making this call is an agent, not an operator. That
    // defeats retention.purgeRequiresOwner's entire point (every registered
    // manifest sets it true): a human decision to permanently retire an addon
    // installation. Mirrors src/mcp/archive.ts:31's operator-principal bar for the
    // identical reason — a capability borrowed through an agent seat is not proof
    // an operator made this call.
    if (resolved.entry.manifest.retention.purgeRequiresOwner && auth.boundAgentId) {
      return fail(403, 'operator_principal_required')
    }
    const result = await archiveAddon(env, resolved.actor, resolved.key)
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

type SetupStepName = 'install' | 'configure' | 'activate'
type SetupStepOutcome = 'created' | 'applied' | 'idempotent' | 'skipped'

const toolAddonSetup: ToolSpec = {
  name: 'addon_setup',
  scope: 'org (org-admin installs, configures and activates an addon in one call)',
  min: 'admin',
  args: '{ key: string, bindings?: Array<{ slot: string, adapter: string, bindingKind: "internal_adapter"|"vault_connector", connectorId?: string }> }',
  inputSchema: toolAddonConfigure.inputSchema,
  async run(auth, env, args) {
    const resolved = await resolveAdminEntry(auth, args)
    if (!resolved.ok) return resolved.outcome

    const rawBindings = args.bindings === undefined ? [] : args.bindings
    if (!Array.isArray(rawBindings)) return fail(400, 'invalid_args', 'bindings must be an array')
    const validated = validateBindingInputs(rawBindings, resolved.entry.manifest.connectorRequirements.length)
    if (!validated.ok) return fail(400, 'invalid_args', 'invalid bindings')

    const { key, actor } = resolved
    const steps: Array<{ step: SetupStepName, outcome: SetupStepOutcome }> = []
    // Stops at the first refusal. Each step is the SAME service function the individual
    // addon_* tool calls, so receipts/audit rows are identical to the three-call path and
    // no authority is added here; a refusal reports which step failed and what already ran.
    const stop = (step: SetupStepName, result: MutationFailure) => {
      const outcome = mutationOutcome(result)
      const detail = !outcome.ok && typeof outcome.detail === 'object' && outcome.detail !== null ? outcome.detail : {}
      return fail(outcome.ok ? 409 : outcome.status, outcome.ok ? result.reason : outcome.error, {
        ...detail,
        failed_step: step,
        completed_steps: steps,
      })
    }

    const installed = await installAddon(env, actor, key)
    if (!installed.ok) return stop('install', installed)
    steps.push({ step: 'install', outcome: installed.created ? 'created' : 'idempotent' })

    // configureAddon refuses an already-active installation, and re-running it with no
    // bindings on an already-configured one would only restamp it; both are skipped so a
    // repeat call converges. Bindings supplied against an ACTIVE installation are not
    // applied (disable -> addon_setup is the reconfigure path) and the output says so.
    const state = installed.state
    const skipConfigure = state === 'active' || (state === 'configured' && validated.bindings.length === 0)
    if (skipConfigure) {
      steps.push({ step: 'configure', outcome: 'skipped' })
    } else {
      const configured = await configureAddon(env, actor, key, { bindings: validated.bindings })
      if (!configured.ok) return stop('configure', configured)
      steps.push({ step: 'configure', outcome: 'applied' })
    }

    const activated = await activateAddon(env, actor, key)
    if (!activated.ok) return stop('activate', activated)
    steps.push({ step: 'activate', outcome: activated.idempotent ? 'idempotent' : 'applied' })

    const bindingsIgnored = state === 'active' && validated.bindings.length > 0
    const base = {
      key,
      state: activated.state,
      steps,
      ...(bindingsIgnored ? { bindings_applied: false } : {}),
    }
    if (key !== OFFICE_ADDON_KEY) return done(base)

    // Activation never depends on health; the probe only reports (mupot#1662).
    const probe = await probeOfficeHealth(env)
    const health = probe.ok
      ? probe.value
      : { status: 'unavailable' as const, reason: probe.reason }
    return done({ ...base, health })
  },
}

export const ADDON_TOOLS: ToolSpec[] = [
  toolAddonInstall,
  toolAddonConfigure,
  toolAddonActivate,
  toolAddonDisable,
  toolAddonArchive,
  toolAddonSetup,
]
