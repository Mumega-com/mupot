// src/mcp/profile-needs-you.ts — the committed source of truth for the curated,
// READ-ONLY "needs-you" MCP profile served at POST /mcp/profile/needs-you.
//
// WHY THIS EXISTS
//
// OpenAI's ChatGPT plugin/directory review wants every MCP tool to carry readOnlyHint /
// destructiveHint / openWorldHint annotations. Those hints are DESCRIPTIVE — they do not
// replace server-side authorization — and mupot's full registry (~130+ tools) is far too
// large to annotate and review. Separately, mupot#1609 notes that tools/list on /mcp
// discloses the whole registry. This profile is a second, narrow door onto the SAME server:
//
//   - same OAuth resource server (the OAuthProvider apiRoute '/mcp' is a PREFIX match, so
//     /mcp/profile/needs-you is authenticated by the same provider, same member API key
//     door, same AuthContext construction);
//   - same per-tool authorization (tools/call goes through the ordinary invokeTool(),
//     including its spec.min floor — this file grants nothing);
//   - a DIFFERENT tools/list: only the names below, each with MCP `annotations`;
//   - tools/call for any name not below is REFUSED before invokeTool runs, even if the
//     caller holds the capability. Hiding a tool from the list is never the control; the
//     allowlist check on tools/call is.
//
// /mcp itself (tools/list, tools/call, legacy {tool,args}) is not changed by this file.
//
// WHY READ-ONLY IN v1
//
// Approvals (task_verdict) need a harness-attested human origin that ChatGPT does not
// provide today; approval stays in Telegram / the dashboard. So no send, task_create,
// task_verdict, task_update, grant_* etc. here. scripts/check-mcp-profile-needs-you.mjs
// fails CI if a tool above member capability, or one whose name reads as a write, is added.
//
// "READ-ONLY" HERE IS ENFORCED: the profile route sets ToolCtx.sideEffectFree, under which
// invokeTool does not bump presence, task_list does not refresh a poll agent's last-seen,
// boot_context does not touch presence or self-report (and refuses runtime/model, rejectArgs
// below), and orient does not record an induction row. tests/mcp-profile-needs-you-no-side-
// effects.test.ts snapshots every table and the KV around each tool. If a tool cannot be made
// side-effect-free, it does not belong in this list.
//
// PATH NAMESPACE: /mcp/profile and /mcp/profile/* are reserved. Only the exact
// NEEDS_YOU_PROFILE_PATH is served; every other path in that namespace is a 404 (see
// mcpInternalRequest), never the full /mcp.
//
// Keep this list sorted by name (a clean one-line diff per added tool).

export const NEEDS_YOU_PROFILE_PATH = '/mcp/profile/needs-you'

/** True for `/mcp/profile` and every `/mcp/profile/...` path (the reserved namespace). */
export function inProfileNamespace(pathname: string): boolean {
  return pathname === '/mcp/profile' || pathname.startsWith('/mcp/profile/')
}

export interface ProfileToolAnnotations {
  title: string
  readOnlyHint: true
  destructiveHint: false
  openWorldHint: false
}

export interface ProfileToolEntry {
  name: string
  annotations: ProfileToolAnnotations
  /** Argument names the profile REFUSES (JSON-RPC -32602, HTTP 400) before invokeTool runs,
   *  and omits from the profile's tools/list schema. */
  rejectArgs?: readonly string[]
  /** Replaces the tool's documented `Args:` text in the profile's tools/list description. */
  args?: string
}

export const NEEDS_YOU_PROFILE: readonly ProfileToolEntry[] = [
  {
    name: 'boot_context',
    annotations: { title: 'Who am I and what can I do', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    // runtime/model make boot_context call selfReportAtBoot, which WRITES the caller's
    // fleet_agents row (status -> 'running' even for an operator-stopped agent, runtime,
    // model). That is a state change under a readOnlyHint, and ChatGPT calls read-only-hinted
    // tools without confirmation — so the profile never forwards them (#1625 tracks the
    // stopped-row defect in selfReportAtBoot itself).
    rejectArgs: ['model', 'runtime'],
    args: '{ source?: string, seat?: string, label?: string }',
  },
  {
    name: 'needs_you_list',
    annotations: { title: 'List items that need my attention', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'orient',
    annotations: { title: 'Orientation packet', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'project_get',
    annotations: { title: 'Get a project', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'project_list',
    annotations: { title: 'List projects', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'project_wiki',
    annotations: { title: 'Read a project wiki', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'task_board',
    annotations: { title: 'Task board', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'task_list',
    annotations: { title: 'List tasks', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
]

const PROFILE_BY_NAME: ReadonlyMap<string, ProfileToolEntry> = new Map(
  NEEDS_YOU_PROFILE.map((e) => [e.name, e]),
)

/** The profile entry for a tool name, or undefined when the tool is NOT in the profile.
 *  A Map (not an object) so `constructor` / `__proto__` can never resolve to a hit. */
export function profileEntry(name: unknown): ProfileToolEntry | undefined {
  return typeof name === 'string' ? PROFILE_BY_NAME.get(name) : undefined
}
