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
// "READ-ONLY" HERE MEANS: no mutation of business data (tasks, projects, messages, grants).
// The shared invokeTool()/boot_context/task_list bookkeeping still refreshes the CALLER'S OWN
// presence/last-seen rows exactly as on /mcp; the registry has no per-tool readOnly metadata
// to say otherwise.
//
// Keep this list sorted by name (a clean one-line diff per added tool).

export const NEEDS_YOU_PROFILE_PATH = '/mcp/profile/needs-you'

export interface ProfileToolAnnotations {
  title: string
  readOnlyHint: true
  destructiveHint: false
  openWorldHint: false
}

export interface ProfileToolEntry {
  name: string
  annotations: ProfileToolAnnotations
}

export const NEEDS_YOU_PROFILE: readonly ProfileToolEntry[] = [
  {
    name: 'boot_context',
    annotations: { title: 'Who am I and what can I do', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
