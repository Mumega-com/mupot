# GitHub App Integration — the pot's GitHub identity

Status: keystone shipped (token minting). Provisioning surfaces (agent-def writer,
Copilot issue-assign) are follow-ups. See "Roadmap" below.

## Why

A pot needs to act ON GitHub under its **own scoped identity** — open issues from tasks,
mirror status, and (next) write `.github/agents/*.agent.md` definitions and assign issues to
GitHub's Copilot coding agent. The old path used one long-lived static PAT (`GITHUB_TOKEN`)
shared per deployment. That is the wrong trust model for a multi-tenant, sovereign substrate:
a PAT is tied to a human, never rotates, and (for org private repos) is blocked by GitHub
Enterprise policy.

The right model is a **GitHub App**: one app, each tenant installs it on their own org, the
pot mints short-lived (≤1h) installation tokens on demand.

## Architecture

```
                  one shared "mupot" GitHub App
                  (App ID + private key)
                          │
        ┌─────────────────┼──────────────────┐
   tenant A installs   tenant B installs   tenant C installs
   on their org        on their org        on their org
        │                 │                  │
   installation_id A   install_id B       install_id C
        │                 │                  │
   pot A mints         pot B mints        pot C mints
   token (1h, scoped   token (walled      ...
   to A's repos)       from A)
```

Each pot is a fork-and-deploy CF Worker with its own `TENANT_SLUG`, D1, and secrets. A pot
only ever holds **its own** installation_id, so there is no cross-tenant token surface.

## Credential storage

Two sources, vault-first (`resolveGitHubAppCreds` in `src/integrations/github-app.ts`):

1. **Connector vault** (`type: 'github_app'`) — the encrypted secret is the App **private
   key** (PKCS#8 PEM); the `meta` JSON carries `{ app_id, installation_id }`. Key and meta
   are read from the **same row** (a partial unique index, migration `0024`, enforces at most
   one active `github_app` connector per tenant, so "the row" is unambiguous).
2. **Worker secrets** (fallback, for platform/dogfood) —
   `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID`.

The private key is decrypted only at mint-time, signs one JWT, and is never returned, logged,
or persisted in plaintext. Same discipline as `resolveConnector`.

## Token minting

`getInstallationToken(env)`:

1. Resolve creds (vault → Worker-secret fallback). Missing any piece → `null` (fail-closed).
2. Check the in-memory cache (module-scope Map, keyed by installation_id, evicted 60s before
   expiry). Hit → return cached token, no GitHub call.
3. Sign an RS256 App JWT (`createAppJwt`): `iss` = App ID, `iat` backdated 60s for skew,
   span 540s (60s headroom under GitHub's 600s cap). Signing key imported non-extractable.
4. `POST /app/installations/{id}/access_tokens` with `Bearer <jwt>`.
5. Cache + return the installation token. Any GitHub error / network throw → `null`.

`resolveOutboundGitHubToken(env)` wraps it App-first: installation token if available, else
the static `GITHUB_TOKEN` PAT (legacy pots), else `null`. The task↔issue mirror
(`mirrorTaskCreate` / `mirrorTaskUpdate`) now uses this — App tokens with PAT fallback, zero
behavior change for pots not yet on the App.

## Security properties (adversarial-reviewed)

- **Fail-closed everywhere** — every failure path returns `null`; no path yields access on a
  missing/invalid credential.
- **No secret egress** — private key never returned, thrown in a message, or logged (no
  logger calls in the module).
- **JWT not forgeable by callers** — all claims server-set from the clock; key non-extractable.
- **No SSRF** — host is a hardcoded constant; installation_id is `encodeURIComponent`-wrapped
  and admin-supplied per tenant, not request-derived.
- **One-row key+meta** — key and install id come from the same connector row; the unique index
  prevents an ambiguous second active row.
- **Latent constraint** — the token cache assumes one tenant per isolate (true under
  fork-and-deploy). If mupot ever moves to a single multi-tenant Worker with request-derived
  tenant, the cache key MUST become `${TENANT_SLUG}:${installation_id}`. Documented in-code.

## Setup (dogfood: Mumega as tenant #0)

1. Create the GitHub App at `github.com/settings/apps/new`:
   - Repository permissions: Contents R/W, Issues R/W, Pull requests R/W,
     Metadata R, Workflows **No access**.
   - Organization permissions: Projects R.
   - Everything else: **No access**. In particular, do not grant members,
     organization secrets, organization personal access tokens,
     organization self-hosted runners, organization custom roles, actions, hooks,
     or organization plan permissions.
   - Generate a private key → convert to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in key.pem`.
2. Install it on the `Mumega-com` org; note the `installation_id` (from the install URL).
3. Store creds — either:
   - Vault: add a `github_app` connector (secret = PKCS#8 PEM, meta = `{app_id, installation_id}`).
   - Or Worker secrets: `wrangler secret put GITHUB_APP_ID` (etc.).
4. Set `GITHUB_REPO` (`owner/repo`) for the mirror target.

## Repo-write actions (the pot's GitHub hands)

`src/integrations/github-repo-write.ts` — built on the keystone + capability gate:

- **`writeAgentDef(env, { repo, agentName, content })`** — write/update
  `.github/agents/<name>.agent.md` in a repo (create-or-update via blob SHA). Gated on
  `custom_agent_defs` (free tier). Makes the pot the AUTHOR of the tenant's GitHub coding
  agents. `agentName` is `[a-z0-9-]`-only (no path traversal); `repo` rejects dot-segments.
- **`assignIssueToCopilot(env, { repo, issueNumber })`** — hand an issue to the Copilot
  coding agent via GraphQL `replaceActorsForAssignable` (actorIds = the `copilot-swe-agent`
  bot resolved from `suggestedActors`, with the `issues_copilot_assignment_api_support`
  feature header). Gated on `coding_agent_assign` (paid tier). Returns `copilot_unavailable`
  if the bot isn't assignable for the repo/plan.

Both gate on `githubCan()` BEFORE any network call, resolve the App token (App-first), and
fail closed (typed `{ok:false}`; no token/detail leaks). Adversarial-reviewed: no P0/P1.

## Live status (Mumega tenant #0)

The `mupot` worker (TENANT_SLUG=`mumega`) has the App wired: `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_REPO` set as Worker secrets;
keystone deployed. Before `v0.23.0`, #151 must prove the live App definition and
re-accepted installation use the least-privilege set above. The release-readiness bundle
must include a redacted `GET /app` export whose `permissions` object has only:
`metadata:"read"`, `contents:"write"`, `issues:"write"`, `pull_requests:"write"`,
and `organization_projects:"read"`.

## Roadmap (remaining)

- [x] Agent-def writer — `writeAgentDef`
- [x] Copilot assign — `assignIssueToCopilot`
- [ ] **Route/UI wiring** — expose the two actions behind admin-gated routes (or a task-flow
      hook) so an operator triggers them from the dashboard. (Service layer is ready.)
- [ ] **Install callback** — a `/connect/github` flow that captures `installation_id` from
      the GitHub App install redirect and writes the connector automatically.
- [ ] **Per-agent MCP wiring** — point each `.agent.md`'s `mcp-servers` at the tenant's pot
      MCP endpoint so the GitHub cloud agent reads that pot's bus/memory/tasks.

## Files

- `src/integrations/github-app.ts` — minting keystone (JWT, cache, resolve).
- `src/connectors/crypto.ts` — `github_app` connector type.
- `src/tasks/service.ts` — mirror uses `resolveOutboundGitHubToken`.
- `migrations/0024_github_app_single_active.sql` — one active install per tenant.
- `tests/github-app.test.ts` — 16 tests (JWT, PEM, mint, cache, vault path, fallback).
