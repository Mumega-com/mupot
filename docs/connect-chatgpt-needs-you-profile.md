# ChatGPT "needs-you" profile (read-only MCP)

A second, narrow MCP door onto the same mupot server, for ChatGPT plugin / directory use.

- **URL path:** `POST /mcp/profile/needs-you` on your pot origin, for example `https://<your-pot>/mcp/profile/needs-you`.
- **Source of truth:** `src/mcp/profile-needs-you.ts`.
- **What it serves:** JSON-RPC MCP only (`initialize`, `tools/list`, `tools/call`). The legacy `{tool, args}` body is not accepted here.

## What it is, precisely

| | `/mcp` | `/mcp/profile/needs-you` |
|---|---|---|
| Authentication | OAuth (directory connector) or member API key | identical, same OAuth provider, same resource server |
| Per-tool authorization | `invokeTool()` and each tool's `min` floor | identical, the same `invokeTool()` runs for allowed tools |
| `tools/list` | full registry | only the profile allowlist, each entry with MCP `annotations`, and only for an authenticated caller |
| `tools/call` of a tool outside the allowlist | runs, subject to authorization | refused with JSON-RPC error `tool_not_in_profile` (HTTP 403) before `invokeTool` runs, even if the caller holds the capability |

The `/mcp` endpoint (`tools/list`, `tools/call`, the legacy `{tool,args}` shape) is not changed by this profile. Its `tools/list` entries carry no `annotations`.

## Tools in v1 (all read-only)

`boot_context`, `needs_you_list`, `orient`, `project_get`, `project_list`, `project_wiki`, `task_board`, `task_list`.

Each is listed with `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` and a `title`. These hints are descriptive metadata for OpenAI's review; they do not replace server-side authorization, and they are not what enforces anything.

## Why read-only in v1

Approving or rejecting a task (`task_verdict`) needs a harness-attested human origin. ChatGPT does not supply one today, so approval stays in Telegram and the dashboard. v1 therefore has no `send`, `task_create`, `task_verdict`, `task_update`, `grant_*` or any other write tool.

"Read-only" means no mutation of business data (tasks, projects, messages, grants). Two bookkeeping writes still happen, exactly as on `/mcp`: `invokeTool()` refreshes the caller's own presence after a successful call, and `boot_context` and `task_list` may refresh the caller's own presence/last-seen row and, for `boot_context` with a bound agent, the agent's self-reported runtime/model record. The registry has no per-tool read-only flag, so the hint means "does not change your work data", not "performs zero database writes".

## CI ratchet

`scripts/check-mcp-profile-needs-you.mjs` (CI job `mcp-profile-needs-you`) fails the build when a profile name is not a real tool, a profile tool's `min` is above `member`, a profile tool's name contains a write verb (`send`, `create`, `update`, `verdict`, `grant`, ...), annotations are missing or not exactly read-only, the list is unsorted or duplicated, or `handleJsonRpc` stops calling the allowlist refusal and the filtered listing. The name check is a mechanical backstop, not proof a tool is read-only: adding a tool is a reviewed change.

## Loading it in ChatGPT developer mode

1. In ChatGPT, enable developer mode and add a custom MCP connector / plugin.
2. Use the profile URL above as the MCP server URL.
3. Complete OAuth. Discovery uses the standard protected-resource document at `/.well-known/oauth-protected-resource/mcp/profile/needs-you`, whose `resource` is the profile URL; an unauthenticated request receives `401` with `resource_metadata` pointing at that document.
4. Expect the 8 tools above and nothing else.

Exact ChatGPT UI labels change; these steps describe the protocol, not screenshots.

## Known limits

- A directory-connector session that is not bound to an agent has zero capabilities (the B1 ceiling). It can call `boot_context` and `orient` (authenticated tier). The observer-tier tools (`needs_you_list`, `project_get`, `project_list`, `project_wiki`) and the member-tier tools (`task_board`, `task_list`) are refused at the capability floor until it is granted access. The profile does not widen this.
- Only the exact path `/mcp/profile/needs-you` is the profile. Any other `/mcp/...` path (including `/mcp/profile/needs-you/`) is handled exactly as before, which means it is the full `/mcp` endpoint.
- Tokens issued for the profile resource are audience-bound to the profile path, and the OAuth provider accepts them only on that path (it does not accept them on `/mcp`). A token issued for `/mcp` is accepted on the profile path, because the provider matches audiences by path prefix. It is still subject to the same tool authorization.
- No OpenAI submission requirements beyond the tool annotations (test cases, demo video, verification) are addressed by this change.

## What is NOT verified

- No end-to-end run against a real ChatGPT client, and no real OAuth authorization flow, was performed. Verified instead: sub-app tests against the real registry, and a workerd test through the real `OAuthProvider` wrapper covering the unauthenticated `401` and `resource_metadata` pointer and the protected-resource document.
- The audience-binding behavior in "Known limits" is read from the pinned `@cloudflare/workers-oauth-provider` source, not exercised with a minted token.
- Whether OpenAI's review accepts these annotations or wants additional fields (for example `idempotentHint`) is unknown.
- Not deployed. Nothing here is live until a maintainer merges and deploys.
