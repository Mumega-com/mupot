# Graph Top-Risk Flows — mupot-sage durable note

> Generated: 2026-08-09T23:53:14Z · Source: /home/mumega/mupot/.code-review-graph/graph.db (read-only)
> Graph HEAD: `3f5750bb933937b85f5bb01c5672397df6c294f5` on `fix/remove-home-capability-ceiling` (schema v9, last_updated 2026-08-09T23:50:24Z)

## Top 5 highest-risk NON-test flows (by criticality, excluding `it:*`)

| # | id | name | entry | nodes | files | criticality | path head (3 nodes) |
|---|----|------|-------|-------|-------|-------------|----------------------|
| 1 | 11629 | `read` | src/addons/marketing/adapters/posthog.ts::read | 22 | 5 | **0.8477** | read → readFromEnvCredentials → useConnectorById |
| 2 | 11643 | `run` | src/mcp/loops.ts::run | 29 | 6 | 0.8321 | run → (mcp loops) |
| 3 | 11647 | `createTaskThenFail` | tests/marketing-monitor-opportunities.test.ts::createTaskThenFail | 34 | 7 | 0.8282 | createTaskThenFail → createTask → isDoneWhenValid |
| 4 | 11648 | `createTaskThenApprove` | tests/marketing-monitor-opportunities.test.ts::createTaskThenApprove | 34 | 7 | 0.8282 | createTaskThenApprove → createTask → isDoneWhenValid |
| 5 | 11651 | `alarm` | src/agents/agent-do.ts::AgentDO.alarm | 117 | 27 | 0.8269 | alarm → wake → resolveAgentIdentity |

## What the #1 flow (`read`, 11629) TOUCHES — external neighbors

The flow is the PostHog marketing-adapter read: readFromEnvCredentials + connector
decrypt (crypto.ts) + SSRF guard (assertPublicHttpsUrl) + posthogHost. External
project-node neighbors (edges, kind=CALLS unless noted):

- **Sibling adapters**: `inkwell.ts::read` and `mcpwp.ts::read` call INTO `useConnectorById` and `assertPublicHttpsUrl` — the same connector-decrypt + SSRF-guard path is shared across marketing adapters.
- **Connector service**: `resolveConnector`, `resolveConnectorWithMeta`, `resolveConnectorByIdWithMeta`, `addConnector` call into decrypt/isConnectorType — connector lifecycle depends on this flow's crypto helpers.
- **GitHub app creds**: `resolveGitHubAppCreds` (src/integrations/github-app.ts) decrypts via the same crypto path.
- **CRO**: `collect` (src/cro/posthog.ts) uses `posthogHost`.
- **Department executors**: `assertSafeInkwellUrl` / `assertSafeSiteUrl` reuse the SSRF guard `assertPublicHttpsUrl`.
- **Test coverage (TESTED_BY)**: connectors.test.ts, cro-posthog.test.ts (https-only fail-closed host), github-app.test.ts, marketing-monitor-adapters.test.ts (expiring authenticated-fetch capability, tenant mismatch/revocation, secret-remap), project-provider-bindings.test.ts.

Risk note: entry node `posthog.ts::read` risk_index says caller_count=0 / "untested",
but internal nodes (isConnectorType, useConnectorById, posthogHost) have TESTED_BY
edges — treat risk_index as per-entry-node and possibly stale.

## Context / caveats

- `createTaskThenFail`/`createTaskThenApprove` are helper functions *inside* a test
  file (not `it:` blocks), so they pass the non-test flow filter but originate in
  tests/marketing-monitor-opportunities.test.ts.
- `alarm` is the widest flow: 117 nodes / 27 files — spans AgentDO lifecycle,
  tasks service, connectors/crypto, mcp loops. Highest blast radius in the set.
