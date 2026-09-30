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

"Read-only" here is enforced, not just declared: a call on the profile runs in **profile mode = no session side effects** (`ToolCtx.sideEffectFree`, set only by the profile route). On `/mcp` the same tools still do their normal bookkeeping; on the profile they do not:

- `invokeTool()` does not bump the caller's presence.
- `task_list` does not refresh a poll-mode agent's `last_reported_at`.
- `boot_context` does not touch presence and never reaches `selfReportAtBoot`. It also refuses `runtime` and `model` arguments (JSON-RPC `-32602`, `profile_args_not_allowed`, HTTP 400) and omits them from the profile schema. On `/mcp` those arguments set a bound agent's fleet row to `running` (even if an operator stopped it) and overwrite its runtime/model; that defect in `selfReportAtBoot` is tracked separately (#1625) and is not changed here.
- `orient` does not create or bump the `agent_orientation` induction row (and reports `induction: false`).

`tests/mcp-profile-needs-you-no-side-effects.test.ts` snapshots every table (real migration chain) and the KV before and after each of the 8 tools with a bound-agent session, and requires no change.

## CI ratchet

`scripts/check-mcp-profile-needs-you.mjs` (CI job `mcp-profile-needs-you`) fails the build when a profile name is not a real tool, a profile tool's `min` is above `member`, a profile tool is not in the script's own explicit `REVIEWED_READ_ONLY` set, `boot_context` does not refuse `model` and `runtime`, annotations are missing or not exactly read-only, the list is unsorted or duplicated, or `handleJsonRpc` stops enforcing the allowlist refusal (`if (... !profileEntry(...))`) and the filtered listing. The gate is the reviewed set: a tool joins the profile only by being added there, with a reason, after its `run()` body was read. A secondary write-verb tripwire (names split on `.` and `_`) also runs but is not what the gate relies on.

## Loading it in ChatGPT developer mode

1. In ChatGPT, enable developer mode and add a custom MCP connector / plugin.
2. Use the profile URL above as the MCP server URL.
3. Complete OAuth. Discovery uses the standard protected-resource document at `/.well-known/oauth-protected-resource/mcp/profile/needs-you`, whose `resource` is the profile URL; an unauthenticated request receives `401` with `resource_metadata` pointing at that document.
4. Expect the 8 tools above and nothing else.

Exact ChatGPT UI labels change; these steps describe the protocol, not screenshots.

## Known limits

- A directory-connector session that is not bound to an agent has zero capabilities (the B1 ceiling). It can call `boot_context` and `orient` (authenticated tier). The observer-tier tools (`needs_you_list`, `project_get`, `project_list`, `project_wiki`) and the member-tier tools (`task_board`, `task_list`) are refused at the capability floor until it is granted access. The profile does not widen this.
- Only the exact path `/mcp/profile/needs-you` is the profile. `/mcp/profile` and every path under `/mcp/profile/` (including a trailing slash, `/x`, and `..%2F..`) answer 404; they are never routed to the full `/mcp`. Configure the connector with the exact URL, no trailing slash. Any other `/mcp...` path outside that namespace behaves exactly as before.
- OAuth audience matching in the provider is by path prefix, and it is not the control that limits what a token can do. A token issued with the profile path as its resource is rejected by the provider on `/mcp` itself (audience mismatch), while a token issued for `/mcp` is accepted on the profile path. On every path a token is subject to the same per-tool authorization, and the profile allowlist only narrows what the profile path lists and calls.
- No OpenAI submission requirements beyond the tool annotations (test cases, demo video, verification) are addressed by this change.

## What is NOT verified

- No end-to-end run against a real ChatGPT client, and no real OAuth authorization flow, was performed. Verified instead: sub-app tests against the real registry, a sqlite-backed test of the `boot_context` refusal against a stopped poll-mode row, and a workerd test (real Miniflare D1 carrying the migration chain) through the real `OAuthProvider` wrapper covering the unauthenticated `401`, the `resource_metadata` pointer, the protected-resource document, and tokens minted through the provider's own helpers (real code exchange).
- Whether OpenAI's review accepts these annotations or wants additional fields (for example `idempotentHint`) is unknown.
- Not deployed. Nothing here is live until a maintainer merges and deploys.
