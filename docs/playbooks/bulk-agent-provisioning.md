# Bulk agent provisioning (roster -> mint_agent_token, once per row)

## The problem this closes

Every agent needs `mint_agent_token` to have run for it at least once. Without
a canonical `agent_member_bindings` row, the agent is not merely unauthorized
— it is **absent from the OAuth consent screen entirely**
(`src/mcp/oauth-authorize.ts`, SELECTION RULE 2: "an unminted agent has no
dedicated member row and therefore no capability set to grant; there is
nothing to consent to. Fail closed: excluded, not offered as zero."). The
operator sees nothing and cannot tell "unminted" from "does not exist".

Minting is **operator-principal-only** — every mint-capable tool
(`mint_agent_token`, `provision_agent_connection`, `list_agent_tokens`,
`revoke_agent_token`, `grant_agent_capability`) starts with:

```ts
if (auth.boundAgentId) return fail(403, 'operator_principal_required')
```

That gate never reads a capability — it refuses any agent-bound caller
outright, on purpose. It makes agent-to-agent escalation structurally
impossible, and it is **not** touched by this playbook.

So only an operator (an unbound owner/org-admin bearer token) can ever run
this, and doing it by hand once per agent does not scale to ~30 agents. This
playbook turns that into one reviewed command.

## What it is

`scripts/bulk-provision-agents.mjs` + `scripts/lib/bulk-provision-core.mjs` —
a roster-driven CLI that calls `provision_agent_connection`
(`src/mcp/provision.ts:941`, the existing composite create -> mint -> grant ->
receipt transaction) once per roster row. It does not reimplement any of that
tool's steps.

## Hard boundaries

- **You must run this yourself.** It was built and tested against a local D1
  only. It has never been run against production. No agent runs it for you —
  `--apply` performs real, credential-issuing writes.
- **The script embeds no credential.** It uses whatever operator session you
  already have, via `MUPOT_OPERATOR_TOKEN` (raw value) or
  `MUPOT_OPERATOR_TOKEN_FILE` (path to a file containing it). If that token
  turns out to be agent-bound, the script says so plainly (via `boot_context`)
  and refuses before touching the roster — it does not fail with a wall of
  opaque 403s.
- **Dry-run is the default.** Without `--apply` the script performs only
  read-only lookups (`boot_context`, `squad_member_list`, `resolve_agent`) and
  prints exactly what it would do. No agent is created, no credential is
  minted, in dry-run mode.
- **Never prints, logs, or persists a raw token.** `provision_agent_connection`
  already refuses to return one — it hands back a single-use
  `credential_claim` instead. This script only ever carries `claim_id`,
  `fingerprint`, `expires_at`, and `token_id` — all explicitly documented as
  safe to log. Revealing the raw token (`reveal_credential_claim { claim_id }`)
  is a separate, deliberate step **you** take per agent, within the claim's
  TTL — this script never calls `reveal_credential_claim`.

## The roster file

JSON, either a bare array or `{ "agents": [...] }`. See
`scripts/agent-roster.example.json`. Each row:

```json
{
  "slug": "lowercase-hyphenated",
  "name": "Human Readable Name",
  "squad": "home-squad-slug-or-id",
  "capability": "member",
  "role": "optional",
  "purpose": "optional — NOT written to the agent profile by this script (provision_agent_connection's new_agent shape only accepts slug/name/role/model); run update_agent afterward if you need this persisted",
  "model": "optional"
}
```

`capability` is the home-squad grant handed to the new credential —
`"observer"` or `"member"` only. This mirrors the ESCALATION GUARD documented
at the top of `src/mcp/provision.ts`: a minted agent token can never be graded
above `member` on its own squad, regardless of what the roster or the caller
asks for. The script refuses (before any live call) a roster row that asks
for anything else.

### Slug safety (read this before writing a roster)

`agents.slug` is `UNIQUE(squad_id, slug)` — **not** globally unique. A slug can
legitimately exist in two different squads. `deactivate_agent`'s own
credential-sweep guard exists because of exactly this
(`COUNT(*) FROM agents WHERE slug = ?`, `src/mcp/provision.ts` — an ambiguous
slug silently skips part of the sweep). This script never trusts a roster
slug as ground truth:

- **Roster-internal duplicates** (the same slug used for two different squads
  in the file itself) are refused at parse time, before any network call.
- **Live collisions**: for every row, the script does a read-only
  `resolve_agent` lookup and filters to an *exact* (case-insensitive) slug
  match. If that slug already exists **anywhere else in the tenant** (a
  different squad than the roster names), the row is refused and the script
  states exactly which agent/squad it already lives in. It never silently
  creates a second same-slug agent in a different squad, and it never
  silently "reuses" an identity from a squad the roster didn't name.
- If the exact slug already exists **in the same squad** the roster names,
  that row is treated as **resumable**: `issue_if_missing` either reports
  "already connected" (skip) or, if the agent exists but was never minted
  (a half-onboarded agent from a manual ceremony), mints it now — closing
  exactly the gap this playbook exists to close.

## Resumability

The script never keeps its own state file. Every run re-derives what to do
from **live server state** (`resolve_agent`, `squad_member_list`,
`provision_agent_connection`'s own `agent_already_connected` outcome). Running
it again after a partial failure — network blip, one bad roster row, Ctrl-C —
simply sees what already exists and skips it; nothing is duplicated. It also
sends a stable `request_id` (`<prefix>:<plan-kind>:<slug>`) to
`provision_agent_connection` itself, so an exact retry of the same in-flight
request (same slug, same plan) replays the same outcome server-side rather
than double-minting. `plan-kind` (`create` or `reuse`) is folded in
deliberately: a resumed run's plan can legitimately change shape across runs
(create the first time a slug is new; reuse once that agent exists), and
`provision_agent_connection`'s own replay check fingerprints the request
shape — reusing one id across that transition trips its `request_id_conflict`
refusal instead of the intended `agent_already_connected` skip.

## Failure policy

Default: **stop on the first failure**, print exactly what succeeded and what
remains untouched. Pass `--continue-on-error` to keep going and report a full
per-agent result list at the end instead.

## Verification (not the write's own response)

After every provision (including a skipped "already connected" row), the
script independently re-checks the agent via two read-only calls:

- `get_agent_profile` — `status === 'active'`
- `list_agent_tokens` — `live_count >= 1` (a live, non-revoked token welded to
  a member — the closest MCP-exposed proxy for "an `agent_member_bindings` row
  exists", since no MCP tool reads that table directly)

This is a **proxy** for `oauth-authorize.ts`'s exact consent-screen selection
rule (`status = 'active'` AND a canonical binding row), not a re-read of that
rule itself — stated plainly here and in the script's own comments. Anything
that doesn't verify is listed by name at the end of the run and in the
receipts file — never silently reported as done.

## Receipts

One JSON line per agent, appended as the script goes (so a crash mid-run
still leaves a readable partial record), to
`scripts/bulk-provision-receipts/<timestamp>.jsonl` by default (`--receipts
<path>` to override). Fields: `slug`, `squad`, `status`
(`provisioned`/`skipped_already_connected`/`collision`/`error`/`dry_run`),
`agent_id`, `member_id`, `token_id`, `claim_id`, `claim_fingerprint`,
`claim_expires_at`, `verified`. **Never a raw token.**

## The exact command

```bash
# 1. Dry run first — always. Confirms the roster, shows exactly what would
#    happen, touches nothing.
MUPOT_OPERATOR_TOKEN="<your existing unbound operator bearer token>" \
  node scripts/bulk-provision-agents.mjs --roster path/to/your-roster.json

# 2. Apply, stopping on the first failure (default):
MUPOT_OPERATOR_TOKEN="<...>" \
  node scripts/bulk-provision-agents.mjs --roster path/to/your-roster.json --apply

# 3. Or apply and keep going past individual failures, reporting all of them at the end:
MUPOT_OPERATOR_TOKEN="<...>" \
  node scripts/bulk-provision-agents.mjs --roster path/to/your-roster.json --apply --continue-on-error
```

`MUPOT_MCP` overrides the endpoint (default `https://mupot.mumega.com/mcp`).
`MUPOT_OPERATOR_TOKEN_FILE=<path>` works instead of `MUPOT_OPERATOR_TOKEN` if
you'd rather not put the token on the command line / in shell history.

After a successful `--apply` run, for each provisioned agent you still need
to run `reveal_credential_claim { claim_id: "<claim_id from the receipt>" }`
yourself, within the claim's TTL, to get the raw token to hand to that agent's
harness. This script deliberately never does that step for you.

## Testing

`tests/bulk-provision-agents.test.ts` drives the core module
(`scripts/lib/bulk-provision-core.mjs`) against a real, freshly migrated
SQLite D1 (`tests/helpers/sqlite-d1.ts` + the actual migration chain) through
`mcpApp.request(...)` — the same JSON-RPC seam a real MCP client uses — so the
roster logic is proven against the real tool/capability/schema behavior, not
a hand-rolled mock. Run with `npm test` (not bare `vitest run` — the
`pretest` hook generates `src/build-info.ts`, which several tests import).

## What has NOT been verified

This has never been run against production, dry-run or otherwise. It has only
been exercised against a local, freshly-migrated test D1
(`npm run migrate:local:test` + `npm run seed:local:test`) and via the vitest
suite above. The exact live roster you use, the real squad slugs in
production, and the real operator token's actual capability grants are all
things only you can confirm by running the dry-run first.
