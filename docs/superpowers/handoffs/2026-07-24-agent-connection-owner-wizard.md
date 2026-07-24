# Codex handoff — Agent Connection Owner Wizard (#528)

- **Date:** 2026-07-24
- **Implementation owner:** Codex
- **Independent gate owner:** user/Cursor
- **Tracking:** https://github.com/Mumega-com/mupot/issues/528
- **Draft PR:** https://github.com/Mumega-com/mupot/pull/539
- **Stack base:** PR #538, `feat/agent-connection-guided-flow` at `9ede067`
- **Branch:** `feat/agent-connection-owner-wizard`

## Outcome

The owner/admin browser flow now provides one path to:

1. search and reuse an existing agent or resolve-before-create a new one;
2. preserve the immutable home squad and choose optional synchronized
   cross-squad access;
3. explicitly issue, add, or replace an agent-bound MCP credential;
4. copy generated Claude Code, Codex, and Cursor configuration;
5. call `verify_agent_connection` with the issued key; and
6. revisit a non-secret receipt that separates issuance facts from current
   agent/token/access state.

The promoted `/agents` action is now **Create or connect agent**. The old
`POST /agents` remains a deprecated create-only compatibility primitive; it
does not mint or bypass the shared provisioning service.

## Security and recovery boundaries

- Dashboard mutations adapt to `provisionAgentConnection()` and
  `cancelAgentConnectionRequest()`; the wizard contains no direct protected
  table writes.
- Owner/admin identity is server-derived. Bound-agent sessions are refused.
  Fine-grained org-admin members are re-resolved from current grants.
- New-agent requests repeat an exact normalized name/slug check on the server.
- Existing actor-scoped request IDs bypass duplicate preflight and reach the
  canonical fingerprint replay/conflict path. This preserves retry safety after
  the new identity has already committed.
- Migration `0073_agent_connection_pending_quota.sql` enforces at most three
  pending requests per `(tenant, actor_kind, actor_id)` under concurrency.
- The wizard lists only the current operator's pending reservations. Its cancel
  action conditionally changes only that actor's exact still-pending request;
  committed issuance and credentials cannot be cancelled or revoked there.
- Every wizard JSON mutation requires a present `Origin` exactly matching the
  request origin. This supplements the parent dashboard form-CSRF middleware.
- Raw credential and plaintext verification challenge appear only in the
  successful no-store response/current DOM. They are never placed in a URL,
  cookie, browser storage API, report, screenshot, config snippet, receipt, or
  log.
- Configurations and receipt links use only pinned `PUBLIC_ORIGIN`.
- Human/workspace `send`, `broadcast`, and `inbox` still return
  `not_agent_bound`, now with `/agents/connect` and
  `provision_agent_connection` as the actionable next step.

## Current-head evidence

Evidence was run on implementation head `f009e2b` before this documentation-only
handoff commit.

Browser completion evidence was strengthened on follow-up head `171ed25`. That
follow-up adds a second local squad plus an unminted existing-agent fixture and
drives both identity dispositions through the rendered owner wizard.

Connected-agent replacement evidence was added on follow-up head `3134a8d`.
That run reconnects the same existing identity, explicitly replaces its live
credential, verifies the replacement, and confirms the prior receipt reports
only the old credential revoked.

### Static and repository tests

```text
pnpm typecheck
PASS

node scripts/no-secrets.mjs
PASS — no secrets found

pnpm vitest run --maxWorkers=4 --reporter=dot
PASS — 267 files, 4296 tests, 0 failures
Duration — 173.56s
```

The focused wizard/recovery matrix is included in the full result and separately
passed:

```text
tests/agent-connection-pending-quota.test.ts
tests/agent-connection-service.test.ts
tests/agent-connection-wizard.test.ts
tests/agent-connection-wizard-render.test.ts
tests/agent-connection-status.test.ts
tests/agent-connection-issued-key.test.ts
tests/mcp-agent-connection-verification.test.ts
tests/agent-messages.test.ts
tests/mcp-broadcast.test.ts
tests/dashboard-auth-shell.test.ts
tests/dashboard-unit-panels.test.ts
```

### Real browser and local runtime

The default local port `8787` was already owned by a long-running Wrangler
process from another Kasra scratchpad. It was not terminated. Evidence ran with
an isolated temporary D1 state on port `8799`:

```text
MUPOT_LOCAL_PORT=8799 bash scripts/ci-local-evidence.sh
PASS
```

That run:

- applied all 75 local migrations through `0073`;
- seeded the local fixture;
- loaded `/agents/connect` at HTTP 200 with no browser console errors or
  redirect;
- drove real owner new-agent and existing-agent journeys through the rendered
  UI;
- selected optional additional access in both directions across two squads;
- proved the new journey created one canonical identity and the existing
  journey reused the exact seeded identity with its home unchanged;
- captured the show-once values in process memory, then removed them from the
  DOM before any screenshot/failure artifact;
- proved Claude Code, Codex, and Cursor configs did not contain the raw key;
- called `verify_agent_connection` over `/mcp` using each newly issued key;
- observed `messaging_verified` plus passing `orient`, `send`, and
  `inbox_peek` receipt checks for both journeys;
- proved both home and additional squad rows were synchronized exactly once;
- revisited the now-connected existing agent, selected the explicit replacement
  action, and proved the replacement retained the same identity, home, and
  synchronized access;
- proved the prior credential became revoked while the replacement stayed live;
- loaded the durable receipt and proved it contained neither key nor challenge;
- completed all pre-existing dashboard workflows; and
- passed every `runtime-adapter/v1` conformance step.

The non-secret browser report records both paths:

```json
[
  {
    "name": "owner create-connect-verify agent journey",
    "status": "passed",
    "existingIdentityReused": false,
    "canonicalIdentityCount": 1,
    "additionalAccessSynchronized": true,
    "messagingVerified": true,
    "durableReceiptSecretFree": true
  },
  {
    "name": "owner connect existing agent journey",
    "status": "passed",
    "existingIdentityReused": true,
    "canonicalIdentityCount": 1,
    "additionalAccessSynchronized": true,
    "messagingVerified": true,
    "durableReceiptSecretFree": true
  },
  {
    "name": "owner replace existing agent credential journey",
    "status": "passed",
    "existingIdentityReused": true,
    "existingCredentialReplaced": true,
    "priorCredentialRevoked": true,
    "canonicalIdentityCount": 1,
    "additionalAccessSynchronized": true,
    "messagingVerified": true,
    "durableReceiptSecretFree": true
  }
]
```

## Coverage distinction

**PASS**

- Browser: complete new-agent create and existing-agent reuse journeys through
  identity selection, immutable home, optional additional access, credential,
  configuration, live MCP verification, synchronized access, and receipt;
  plus connected-agent credential replacement with prior-token revocation.
- Route/real-SQLite: existing-agent add flow, no duplicate canonical identity,
  cross-squad access, stable retry without second key, owner/admin/fine-grained
  admin gates, bound-agent refusal, cross-origin refusal, abandoned-request
  listing/cancellation, pinned-origin output, and secret-free refresh.
- Service/real-SQLite: add/replace behavior, quota/tenant/actor scoping,
  concurrent target/request rules, synchronized access, issued-key
  boot/orient/send/inbox behavior, verification replay/error matrix.

**NOT YET TESTED**

- Production migration, deploy, live credential issuance, or live token
  revocation.

## Review boundary

This is a stacked implementation candidate only. Codex does not self-gate.
Cursor/the user should review the complete diff from
`feat/agent-connection-guided-flow...feat/agent-connection-owner-wizard`,
including adversarial checks for:

1. actor/request replay ordering;
2. JSON Origin enforcement;
3. pending quota/cancellation scoping;
4. no direct wizard writes;
5. raw credential/challenge lifetime;
6. pinned-origin configuration and receipt URLs; and
7. existing-agent identity reuse under add/replace.

No production deploy, migration, merge, live credential mutation, or
self-approval was performed.
