# team_bootstrap — new team in one call

mupot#1498. Replaces the six-call-by-hand path Hadi walked for Psychonom
(2026-09-22): `project_update` refused with `no_writable_squad` until a
squad edge existed → `create_squad` → `project_squad_set` → `create_agent`
→ `mint_agent_token` → `reveal_credential_claim` → write the token to a file
by hand → separately update the squad's slug via a raw D1 UPDATE (`update_squad`
had no `slug` field) → the Hermes profile written by hand, separately, by Mubot.

## Trigger → actor → tools → gate → receipt → what the person sees

| Step | Detail |
|---|---|
| **Trigger** | An org-admin (human, over MCP or `POST /actions/team_bootstrap`) wants a new project + squad + optional bot + optional human invites, in one call. |
| **Actor** | A member principal holding org-scope `admin` (or coarse role `owner`/`admin`). **Never** an agent-bound token — `team_bootstrap` is a grant tool, same rule as `mint_agent_token`/`update_squad`: `auth.boundAgentId` is refused outright with `operator_principal_required`. |
| **Tools** | One MCP tool, `team_bootstrap` (`src/mcp/team-bootstrap.ts`), backed by one core function, `teamBootstrap` (`src/org/team-bootstrap.ts`). Registering it into `TOOLS` (`src/mcp/index.ts`) is the *entire* REST surface too — `POST /actions/team_bootstrap` dispatches through the same `invokeTool` seam a minted bearer can call directly. No separate REST route exists or is needed. |
| **Gate** | AAGATE floor (`spec.min: 'admin'`, `src/mcp/index.ts`'s `invokeTool`) + the tool's own `hasWorkspaceAdmin` re-check (never trust the floor alone on a sensitive act — same pattern every `provision.ts` tool follows) + a **per-human rank ceiling** inside the core function itself (`actorRankOnScopeFor` vs. `capabilityRank(human.capability)` — defense in depth, so a future elevation path that lowers the tool's own floor cannot silently skip it). |
| **Receipt** | One append-only `team_bootstrap_receipts` row (migration `0163`, `UNIQUE(tenant, slug_base)`) — `actor_member_id` is a **frozen copy** of the caller at write time, `disposition` is `'created'`\|`'existing'`, `invited_count` is the only mutable column (a replay adds to it rather than inserting a second row). |
| **What the person sees** | `{ disposition, receipt_id, project, squad, bot, invites: [{id, url, email, capability, created}], credential_claim, hermes_scaffold }` — see the shape below. |

## Call shape

```jsonc
// team_bootstrap
{
  "slug_base": "psychonom",              // required — unsuffixed root; must NOT already end -prj/-sqd/-bot
  "name": "Psychonom",                   // required
  "department": "dept-eng",              // required — id or slug
  "humans": [                            // optional
    { "email": "lead@example.com", "capability": "member" }   // capability: "observer" | "member" only
  ],
  "bot": {                               // optional; omit === bot enabled with defaults
    "enabled": true,                     // default true; false skips bot creation entirely
    "name": "Psychonom Bot",
    "role": "builder",
    "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  },
  "seed_memory": "first project note"    // optional — see "seed_memory" below
}
```

Response (abbreviated):

```jsonc
{
  "disposition": "created",              // or "existing" on an idempotent replay with nothing new
  "receipt_id": "…",
  "project": { "id": "…", "slug": "psychonom-prj", "name": "Psychonom", … },
  "squad":   { "id": "…", "slug": "psychonom-sqd", "department_id": "dept-eng", … },
  "bot":     { "id": "…", "slug": "psychonom-bot", "name": "Psychonom Bot", "created": true },
  "invites": [
    { "id": "…", "url": "https://pot.example/invite/…", "email": "lead@example.com", "capability": "member", "created": true }
  ],
  "credential_claim": {                  // NEVER a raw token — see "credential_claim" below
    "claim_id": "…", "fingerprint": "…", "expires_at": "…", "reveal_tool": "reveal_credential_claim"
  },
  "hermes_scaffold": {
    "profile_dir_layout": ["~/hermes/profiles/psychonom-bot/", "…/.mcp.json", "…/SOUL.md", "…/systemd/psychonom-bot.service"],
    "mcp_config_template_with_claim_placeholder": "{ \"mcpServers\": { \"mupot\": { \"url\": \"…/mcp\", \"headers\": { \"Authorization\": \"Bearer <REVEAL_VIA:reveal_credential_claim:claim_id=…>\" } } } } }",
    "soul_md_template": "# Psychonom Bot\n\nrole: builder\n…",
    "systemd_unit_template_disabled": "[Unit]\n…\n[Install]\n# WantedBy intentionally omitted …"
  }
}
```

## What happens atomically, and what doesn't (and why)

**Resolved BEFORE the one D1 batch** (each is its own independently
committing, entitlement-gated create — reusing `createProject`/`createSquad`
exactly as they already exist, never forked):

1. Department resolved by id or slug (`resolveDepartmentRef`) — 404 if missing.
2. Project `<slug_base>-prj` found, or created.
3. Squad `<slug_base>-sqd` found (by department + slug), or created.

**Inside the ONE `env.DB.batch()` call — all land or none do:**

4. The ADMIN `project_squad_access` edge (upsert — a replay re-asserts admin
   even if some other tool had since changed it).
5. The bot agent row + its home-squad membership row (`prepareAgentCreate`'s
   own two statements), *only* when no agent with slug `<slug_base>-bot`
   already exists in that squad.
6. One `invites` row per human who does not already have a live (unaccepted)
   invite into this squad (0156's plain-squad shape: `squad_id` set,
   `project_id`/`pairing_hash`/`pairing_expires_at` all `NULL`).
7. The `team_bootstrap_receipts` row (insert on first call, `invited_count`
   update on a replay that adds new humans).

**Deliberately NOT in the batch** (neither is a D1 write the batch could
span):

- **Minting the bot's token** (`mintAgentBoundToken`, `src/members/service.ts`)
  — its own D1 writes, committed as its own unit, run *after* the batch
  commits, and *only* when a bot was freshly created this call. A replay
  against an already-existing bot mints no second credential.
- **`seed_memory`** (`createMemory().remember()`) — D1 *and* Vectorize, two
  systems `D1.batch()` cannot span. Runs after the batch, and *only* on a
  genuinely first bootstrap (`disposition: 'created'`) — a replay with the
  same `seed_memory` text does not accumulate a duplicate engram on every
  retry.

If the batch itself fails (e.g. the project turns out to be archived, so the
edge insert hits `validate_project_squad_access_insert`'s trigger), **nothing
from the batch lands** — no edge, no bot row, no invites, no receipt. The
project/squad that were resolved *before* the batch may still exist (they are
real, reusable rows — the same "adopt, don't fork" discipline
`createHomeForMember` applies), but nothing composite is left half-built.

## `credential_claim` — never a raw token

Same discipline as `mint_agent_token` (mupot#987): the bot's raw token is
never returned. `createCredentialClaim` stores it behind a single-use,
10-minute claim in the `SESSIONS` KV, and the tool result carries only the
claim handle. Redeem it with `reveal_credential_claim { claim_id }` —
exactly once, only as the same member who called `team_bootstrap`, within
the TTL. The Hermes `.mcp.json` template embeds the **claim id as a
placeholder** (`<REVEAL_VIA:reveal_credential_claim:claim_id=…>`), never a
value to fill in blind — an operator (or Hermes itself, on first run) must
call `reveal_credential_claim` to get the real bearer token.

## Idempotency on `slug_base`

A second call with the same `slug_base`:

- finds the existing project and squad (no duplicate rows, no `slug_taken` error surfaced to the caller);
- sends no duplicate invite for an email that already has a live invite into this squad (`invites[].created: false`, same `id` as before);
- mints no second bot, and mints no second credential claim for it;
- does not re-seed memory;
- updates the SAME `team_bootstrap_receipts` row's `invited_count` rather than inserting a second receipt (`UNIQUE(tenant, slug_base)`).

## Related, smaller fixes shipped alongside this tool

- **`update_squad` gains a `slug` field** (mupot#1495's own, separate
  migration is the broader sweep — this is the one new write path that
  needed the suffix rule *today*). A squad's slug may only be *set* to a
  value ending `-sqd`; an existing unsuffixed squad slug is left alone until
  #1495's backfill runs. A collision within the same department surfaces as
  `409 slug_taken`, not a generic 500.
- **`project_update`'s start-gate no longer refuses `no_writable_squad`
  outright** for a project that has *zero* squad edges at all (a project
  with a deliberate *read-only* edge and nothing writable still refuses —
  see `src/projects/start-gate.ts`'s doc comment for why that distinction
  matters). It auto-creates `<project.slug>-sqd` under one shared,
  find-or-create `dept-projects` department (every project with no squad
  reuses the SAME department; only the squad is per-project) and wires the
  ADMIN edge. Every caller of `startProject`
  (`src/mcp/projects.ts`'s `project_update`, `src/dashboard/index.ts`'s
  `POST /projects/:id/status`, `src/projects/index.ts`'s `PATCH /:id`)
  already gates workspace/org admin before reaching this code, so "keep the
  refusal for non-admins" holds by construction — a non-admin caller never
  reaches the auto-create path at all. The freshly-created squad starts with
  no agent in it, so the *overall* start can still block on the more
  specific, honest `no_squad_agent` — but the squad and its ADMIN edge are
  now real, reusable rows for the next attempt (an operator adds an agent to
  it, or the next `team_bootstrap` call for a related team reuses it)
  instead of a permanent dead end.

## What this does not do (scope notes)

- **No elevation path.** `team_bootstrap` is gated at standing org-admin
  only — no `action:*` elevation limb like `create_squad`/`project_create`
  have for a bounded-window squad lead. Adding one is straightforward
  (the per-human rank ceiling already defends against a lowered floor) but
  is a scope decision left to Kasra-core/Hadi, not bundled into this PR.
- **`humans[].capability` is `observer`\|`member` only** — deliberately
  narrower than the full `Capability` ladder. A team_bootstrap invite is
  meant to seat someone on a brand-new squad, not hand out `lead`/`admin`/
  `owner` in the same composite call; use `update_squad`/a direct invite for
  that.
- **The Hermes profile scaffold is a template, not a write.** `team_bootstrap`
  computes and returns the four scaffold strings; it does not write any file
  to disk, install a systemd unit, or start a process. The unit ships
  disabled by construction (`WantedBy` intentionally omitted) — an operator
  enables it deliberately after reviewing the profile and revealing the
  credential claim.
