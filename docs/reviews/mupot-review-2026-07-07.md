# Mupot Review Follow-up - 2026-07-07

Review target: `Mumega-com/mupot` `main` at `ba43289`.

This note captures the highest-signal issues found during a local review pass. It is meant to be copied into GitHub issues or used as the working checklist for a fix branch.

## Findings to File

### 1. P1 - Preserve workspace and agent member-token auth through production `/mcp`

Labels: `bug`, `auth`, `mcp`, `security`

Production `POST /mcp` is wrapped by `OAuthProvider`. Non-OAuth bearer keys are routed through `resolveExternalToken()` and then through `McpOAuthApiHandler`, which calls `buildAuthContextFromProps()`.

`buildAuthContextFromProps()` currently applies the directory/OAuth zero-capability ceiling unconditionally:

- `channel: 'directory'`
- `capabilities: []`
- `boundAgentId: null`

That is correct for public directory OAuth seats, but not for normal `mupot_...` workspace keys. Impact: production member API keys likely lose grants, and agent-bound keys lose their weld, so tools like `task_create`, `wake_agent`, `send`, `inbox`, and no-arg `orient` can fail even when the same key works in tests that call `mcpApp` directly.

Suggested fix:

- Extend `OAuthMemberProps` with the token row channel and `agent_id`.
- In `resolveExternalToken()`, select `t.channel` and `t.agent_id`.
- In `buildAuthContextFromProps()`, apply the zero-capability ceiling only when the token channel is `directory`.
- For workspace/member API keys, resolve live capabilities and preserve `boundAgentId`.
- Add a regression test that exercises the production convergence path instead of only direct `mcpApp` calls.

Acceptance checks:

- A workspace member key with org/squad grants can call capability-gated tools through the production `/mcp` path.
- An agent-bound workspace key can call `inbox`, `send`, and no-arg `orient`.
- A directory OAuth seat still receives `capabilities: []` and no agent weld.

### 2. P1/P2 - Resolve dependency audit advisories

Labels: `dependencies`, `security`

`npm audit --json` reported 6 advisories: 5 high and 1 low.

Direct runtime concern:

- `hono@4.12.23` is below the fixed `4.12.25+` range for current Hono advisories.

Tooling concern:

- `wrangler@4.97.0` pulls vulnerable `miniflare`, `undici`, `ws`, and `esbuild` versions.
- `npm audit fix --dry-run` currently hits a peer dependency conflict because newer Wrangler wants newer `@cloudflare/workers-types`, while `agents`/`partyserver` still peer the v4 workers-types line.

Suggested fix:

- Update Hono within the current major first and rerun tests.
- Plan a coordinated Cloudflare stack bump for Wrangler, Workers types, and `agents`.
- Add `npm audit --audit-level=high` to CI once dependency ranges are updated enough to pass.

Acceptance checks:

- `npm audit --audit-level=high` passes or has documented accepted tooling-only exceptions.
- `npm run typecheck`, `npm test`, fleet runtime tests, and Wrangler dry-run all pass after dependency updates.

### 3. P2 - Expand CI to cover all shipped test suites

Labels: `ci`, `testing`

Current CI runs only:

- `npm install`
- `npm run typecheck`
- `npm test --if-present`

Manual validation found additional green checks that CI should own:

- `node --test fleet-runtime/*.test.mjs`
- `python -m pytest plugin/tests`
- `npx wrangler deploy --dry-run --config wrangler.example.toml`
- D1 migration-chain application to a scratch SQLite database

Suggested fix:

- Switch CI install to `npm ci`.
- Add fleet runtime Node tests.
- Add Python setup and plugin tests.
- Add Wrangler dry-run bundle check.
- Add a migration syntax/order check.

Acceptance checks:

- CI fails if fleet runtime tests fail.
- CI fails if plugin tests fail.
- CI fails if the Worker no longer bundles from `wrangler.example.toml`.
- CI fails on migration syntax or ordering drift.

### 4. P2 - Add pre-auth body size caps to HMAC webhook ingress routes

Labels: `hardening`, `webhooks`, `security`

Some unauthenticated webhook routes buffer the full request body before a hard local size check:

- `src/events/ingest.ts` reads `c.req.text()` before signature verification.
- `src/integrations/ghl-routes.ts` reads `c.req.text()` before signature verification.

GitHub has a 256 KiB post-read cap; event ingest and GHL should have comparable caps. Cloudflare request limits reduce blast radius, but these are still unauthenticated, controllable hashing/parsing costs.

Suggested fix:

- Reject large declared `Content-Length` before reading the body.
- Enforce actual UTF-8 byte length immediately after reading and before HMAC/JSON parsing.
- Keep the cap route-specific, for example 64 KiB or 256 KiB depending on expected payloads.

Acceptance checks:

- Oversized declared bodies return `413` without HMAC work.
- Oversized actual bodies return `413`.
- Valid signed payloads under the cap still pass.

## Validation Already Run

- `npm ci` passed, with audit advisories.
- `npm run typecheck` passed.
- `npm test` passed: 121 test files, 2278 tests.
- `node --test fleet-runtime/*.test.mjs` passed: 18 tests.
- `npx wrangler deploy --dry-run --config wrangler.example.toml` passed.
- D1 migrations `0001` through `0041` applied cleanly to scratch SQLite.
- Python plugin tests passed in a temporary venv: 102 tests.
- `python -m compileall -q plugin` passed.

## Work I Can Do Next

- File the four GitHub issues with titles, labels, and acceptance criteria.
- Implement the `/mcp` production auth regression fix and add tests.
- Update Hono and validate the dependency/security impact.
- Plan or perform the coordinated Cloudflare dependency bump.
- Expand GitHub Actions CI to include fleet runtime, plugin, dry-run bundle, and migration checks.
- Add webhook body caps and route-level tests.
- Open a draft pull request from this `codex/` branch.
