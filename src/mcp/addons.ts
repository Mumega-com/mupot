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
//   - AddonActor.role only participates in ONE check inside the service layer — authorized()
//     at src/addons/service.ts:315 (`role === 'owner' || role === 'admin'`) — which the
//     service re-derives as its OWN defense-in-depth gate (never trusts the route's gate
//     alone) and stamps into receipts (actor_id) for audit. So the correct translation is NOT
//     "copy auth.role" (that would always be 'member' and every call would 403 at the service
//     layer) — it is: once hasWorkspaceAdmin(auth) is true, the MCP caller has proven the SAME
//     semantic bar isOrgAdmin gates on, so actor.role is the literal 'admin' (never 'owner' —
//     we do not claim a rank the caller didn't prove; 'admin' is what authorized() needs and
//     is what the ladder's admin/owner equivalence already treats the same way).
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

  // 'admin' — never 'owner' — see the file docstring: this claims exactly the rank the
  // caller proved via hasWorkspaceAdmin, no more.
  return { ok: true, key, entry, actor: { id: auth.memberId, role: 'admin' } }
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
    const result = await archiveAddon(env, resolved.actor, resolved.key)
    if (!result.ok) return mutationOutcome(result)
    return mutationSuccess(resolved.key, result)
  },
}

export const ADDON_TOOLS: ToolSpec[] = [
  toolAddonInstall,
  toolAddonConfigure,
  toolAddonActivate,
  toolAddonDisable,
  toolAddonArchive,
]
