# mupot.seed/v1 — the seed contract

A **seed** is a short declarative document describing a project someone wants attached to a
pot. It states what the project is, where it lives, what it would like to do, and what it
would like to be allowed to do. It is a **request, never a grant**: nothing in a seed is
authority, and validating one grants nothing.

Status: contract + validator + `seed_attach` dry run + apply (`dry_run:false`). Apply creates a
minimal footprint and grants nothing; accepting the individual requests is a later, separate step.

## Document shape

YAML or JSON (JSON is valid YAML). Max 32 KiB, nesting depth at most 6, no YAML anchors or
aliases (both refused), no duplicate keys, **unknown keys are refused**.

| Key | Required | Notes |
|---|---|---|
| `schema` | yes | literal `mupot.seed/v1` |
| `slug` | yes | kebab-case, at most 63 characters |
| `name`, `goal` | yes | free text |
| `kind` | yes | one of the `kind` values in Enums and limits |
| `owner` | yes | a label only; never resolved to a member by validation |
| `repo`, `live` | no | `live` must be an https URL without embedded credentials |
| `deploy` | no | `{via, cmd?, receipt?, human_only}`; `via` per Enums and limits |
| `surfaces[]` | no | `{path` or `type, mode}`; `mode` per Enums and limits |
| `data[]` | no | `{store, tier}`; tier per Enums and limits |
| `tools[]` | no | `{mcp` or `openapi, cred_slot?}`; `cred_slot` is a slot NAME |
| `wants` | no | `{memory[], gates[{action,gate}], routines[{id,cron,approval}], seats{squad,max,capability?}}` |
| `signals` | no | `{health[], outcome[]}` |
| `risk` | no | `{class, forbidden[], human_only[], allow_direct[]}`; class per Enums and limits |

## Enums and limits

Pinned to the validator by `tests/seed-v1-doc.test.ts`: change one side and the test fails.

| Field | Allowed values / limit |
|---|---|
| `kind` | `site/astro`, `site/wordpress`, `store/shopify`, `app`, `repo` |
| `deploy.via` | `cf-pages`, `wrangler`, `wp-plugin`, `shopify-cli`, `git-push-only` |
| `surfaces[].mode` | `propose`, `direct` |
| `data[].tier` | `private`, `squad`, `project`, `role`, `entity`, `public` |
| `risk.class` | `low`, `medium`, `high` |
| `wants.seats.capability` | `observer`, `member` (default `member`; anything higher is refused) |
| `wants.routines[].approval` | `human_accept`, `per_run` (default `human_accept`) |
| `wants.seats.max` | integer 1 to 8 |
| List length | at most 50 entries per list |
| `name` | at most 120 characters |
| `goal` | at most 1000 characters |
| `owner` | at most 120 characters |
| `repo`, `live`, `deploy.cmd` | at most 300 characters each |
| `deploy.receipt` | at most 300 characters |
| `surfaces[].path` | at most 200 characters |
| `surfaces[].type` | at most 100 characters |
| `data[].store` | at most 200 characters |
| `tools[].mcp`, `tools[].openapi` | at most 300 characters each |
| `wants.gates[].action`, `wants.gates[].gate` | at most 120 characters each |
| `wants.routines[].id` | at most 120 characters |
| String list items | at most 200 characters each |
| `wants.routines[].cron` | five space-separated fields, at most 100 characters |
| `wants.seats.squad` | a kebab-case slug |
| Any text value or key | no Unicode control (Cc: C0, DEL, C1), format (Cf: zero-width, bidirectional, U+061C, U+FEFF, tag characters), default-ignorable (Hangul fillers U+3164/U+115F, U+034F, variation selectors), U+2800 or line/paragraph separator (U+2028, U+2029) characters; one trailing newline (block scalar) is stripped |

Canonical text rule: strings are NFC-normalized and trailing whitespace is trimmed before hashing
and before `allow_direct` matching; leading whitespace is NOT trimmed.

Defaults are materialized and empty optional containers are omitted before hashing, so
`capability: member` equals no capability, and `wants: {}` or `memory: []` equals no key.

## Known limits

The secret scan is an **accidental-paste guard, not an adversarial filter**. A secret deliberately
split by separators (`. / - : , ~ =`) into short runs is NOT detected. The real controls are
structural: apply stores only the canonical form (never raw source), and credentials are named
slots bound by a human, never values in a seed.

Text fields refuse default-ignorable characters, so emoji variation selectors (such as a
heart emoji with U+FE0F, or keycap sequences), ZWJ emoji families and Persian ZWNJ spellings are
rejected in `name`, `goal` and every other text field. This is deliberate strictness for
spoof-resistant request text: use plain-text names.

## Rules the validator enforces

1. **Authority is never declared.** Any key named like a grant, token, secret, password, API
   key, credential, private key, bearer or authorization is refused (`secret_in_seed`), as is
   any value shaped like a secret (vendor key prefixes, JWTs, private-key blocks, URLs with
   embedded credentials, long opaque strings). The refusal never echoes the value.
2. **`cred_slot` is a slot name** matching `^[A-Z][A-Z0-9_]{2,63}$`. It is never resolved,
   looked up or checked against any vault by validation.
3. **Every ask is an explicit request.** Each `wants.gates`, `routines`, `seats`, `memory`
   entry, each `data[]` entry, each `risk.allow_direct` entry, each tool credential slot and each `direct` surface becomes a request line marked
   `needs: human_accept`. Validation grants none of them.
4. **Strict and bounded**: unknown keys, oversize or too-deep input, aliases and duplicate
   keys are refused.
5. **Deterministic canonical form.** Keys are sorted (array order is kept) and hashed with
   SHA-256 to `seed_sha256`. The digest is independent of key order, comments, whitespace and
   YAML-vs-JSON, and is the intended idempotency key for apply.
6. **Deploys are human-only.** If `deploy` is present, `deploy.human_only` must be literally
   `true`.
7. **Seats are capped.** `wants.seats.max` is an integer from 1 to 8, and a seat may not ask
   for a capability above `member`. `surfaces[].mode: direct` is refused unless that path or
   type is listed in `risk.allow_direct`. An `allow_direct` entry is compared as an exact string
   against both `path` and `type` values, so one entry opens whichever surface carries that string.

## The tool

`seed_attach { seed: string, dry_run?: boolean, accept?: string[] }` — member capability floor for
the dry run; apply needs more (below).

- `dry_run` defaults to **true**: validate and return
  `{ok, dry_run, seed_sha256, requests[], diffs[]}`. Nothing is written, including the
  generic presence bump. `diffs` compares name, goal, repo and live against the existing
  project the seed would apply to (`<slug>-prj`), only if the caller can already read it.
- `requests` is a list of `{key, kind, fields, needs, text}`: `key` is stable (`kind:` plus 12 hex of
  the digest of the request), `fields` is the structured source of truth, `needs` is always
  `human_accept`, and `text` is a rendered one-line sentence in which every author value is
  JSON-quoted (U+2028/U+2029 escaped).
- A refused seed is `400 invalid_seed` with `{code, path, message}`.

### Apply (`dry_run: false`)

Apply is a **human act**. Required, in this order:

| Check | Refusal |
|---|---|
| caller is not agent-bound (any agent token, whatever it holds) | `403 human_accept_required` |
| caller is a member with org admin standing (the `team_bootstrap` floor) | `403 forbidden` |
| seed re-validated server-side (a prior dry run is never trusted) | `400 invalid_seed` |
| `accept` present and every key known to this seed | `400 invalid_args`, `400 unknown_accept_keys` |
| EVERY request key is in `accept` (nothing is auto-accepted) | `409 requests_not_accepted` `{missing:[{key,kind}]}` |
| `slug` can derive `<slug>-prj` / `<slug>-sqd` (at most 44 chars, not ending `-prj`, `-sqd`, `-bot`) | `400 seed_slug_not_applicable` |

Then, **insert-first**: one `project_seeds` row (UNIQUE `tenant + project_slug`) is inserted before
anything is created. The INSERT itself refuses when a project of that slug exists that the caller did
not create (a project with no recorded creator counts as not theirs). On the UNIQUE key:

- same `seed_sha256`, applied: `replay: true`, nothing created (also while another apply of the same
  seed is in flight: `replay: true, status: "applying"`).
- different `seed_sha256`: `409 seed_digest_conflict`. A seed is never silently updated; update is a
  later feature.
- an existing project of that slug the caller did not create, or a seed row the caller cannot see:
  `409 seed_slug_unavailable`, **one generic body** (no id, name or creator). Use the dry run's `diffs`
  to see a project you can read.
- an apply that crashed after the claim holds a 120 second lease; only the same member may resume it
  after the lease lapses, and the resume creates nothing twice.

What apply creates is **exactly**: the project (`<slug>-prj`, `created_by_member_id` = the caller),
the squad (`<slug>-sqd`, display name from `wants.seats.squad` or `<slug>-core`) with the ADMIN
squad-project edge (both through `team_bootstrap`'s find-or-create core, which also writes its own
`team_bootstrap_receipts` row), the shared `dept-projects` department if this pot has none yet, the
seat **cap** (`wants.seats.max`, recorded only), one `project_seeds` row and one audit receipt
(`mutation_audit_entries`, handler `seed_attach`, operation `apply`, keyed `seed-apply:<row id>`,
carrying `seed_sha256`, the caller and the accepted keys).

What apply **never** creates: gate capabilities or grants, routines, connectors or credentials,
deploy rights, agents, tokens, invites. Every request stays in `requests_json` with status
`pending_human` for later explicit tools. The row stores only `canonical_json` and the digest, never
the raw source; `owner` is stored as a label (`owner_label`) and is never resolved to a member. The
project's goal, repo and live URL are recorded in `canonical_json` and are not copied onto the
project row by this slice.

Errors from creation itself (`squad_limit_reached`, archived project, ...) are `409 seed_apply_failed`
`{reason}`; the claim is released so a retry starts clean.

## Attach protocol

| # | Step | Who |
|---|---|---|
| 1 | Author the seed (a person, or an agent drafting for one) | anyone |
| 2 | `seed_attach` dry run: validate, read requests and diffs | member |
| 3 | Review the requests and diffs | human |
| 4 | Accept requests, one by one (gates, routines, seats, memory, data, tool credentials, direct surfaces, allow_direct) | **human only** |
| 5 | Bind each credential slot to a real credential in the vault | **human only** |
| 6 | Apply: find-or-create project and squad keyed by `seed_sha256`; records the seat cap (built; accepts every request key, grants none) | human org admin |
| 7 | Deploy, DNS and production changes | **human only**, always |

### Apply preconditions (normative)

Apply MUST (and is tested to):

1. Store only the **canonical form** (`canonical`), never the raw source. Comments and
   whitespace can carry secrets and still pass validation.
2. Find-or-create by `seed_sha256` and slug, and MUST NOT take over an existing project with
   that slug unless the caller can already read or own it.
3. Treat `owner` as a label. It is never resolved to a member.
4. Show requests from their structured `fields`; author text is never rendered unescaped
   (`src/seeds/render.ts` JSON-quotes every field).

Step 6's `accept` is the human listing every request key it saw in the dry run; it records the
requests and grants none of them. Steps 4, 5 and 7 can never be performed by validation or by an
agent acting alone.

## Example 1 — Astro site

See `docs/examples/seeds/mumega-com.seed.yaml`: an Astro content site deployed to
Cloudflare Pages. Content edits are proposals; it requests a publish gate, a weekly audit
routine needing a human accept, two seats, and one tool credential slot.

## Example 2 — WordPress site

See `docs/examples/seeds/digid-ca.seed.yaml`: a WordPress site operated through a plugin.
Page and post edits are proposals; media uploads are `direct`, allowed only because
`wp.media` is listed in `risk.allow_direct`. Deploy is `wp-plugin`, human-only.

Both examples are test fixtures: CI validates them (`tests/seed-v1-validate.test.ts`).

## Code

`src/seeds/contract.ts` (types, enums, caps), `src/seeds/validate.ts` (validator and request
list), `src/seeds/canonical.ts` (canonical JSON, digest, request keys), `src/seeds/apply.ts` (apply),
`src/mcp/seed.ts` (tool), `migrations/0209_project_seeds.sql`.

## Mutation checks

Each test below was written to fail when the named mutation is applied to the code:

- Drop the secret-key scan or the value patterns: the `secret_in_seed` tests fail.
- Echo the offending value in a refusal: the no-echo test fails.
- Allow YAML aliases or anchors (raise `maxAliasCount`, drop the anchor visit): the alias and anchor tests fail.
- Let `deploy.human_only` be anything but literal `true`: the deploy tests fail.
- Skip the `risk.allow_direct` check on a `direct` surface: the direct tests fail.
- Raise the seat cap or accept a capability above `member`: the seat tests fail.
- Stop omitting empty containers or stop materializing defaults: the digest-equivalence tests fail.
- Make the digest ignore a semantic change: the digest-difference tests fail.
- Count `/` as opaque-string material again: the ordinary-path test fails.
- Drop a secret-shaped value check for opaque tokens: the 40-character token test fails.
- Narrow the secret scan back (drop `-`/`_` from the run class, the Google/Stripe/GitLab/query patterns, the list-join scan, the key scan): the per-shape secret tests fail.
- Drop a `data` or `allow_direct` request: the policy-request test fails.
- Allow zero-width or bidi characters, or paste author text into a sentence: the spoofing tests fail.
- Skip NFC or trailing-whitespace normalization, or reject a block scalar's final newline: the normalization tests fail.
- Change a documented enum or cap in only one place (either direction, exact set): `tests/seed-v1-doc.test.ts` fails.
- Add a secret pattern to only one of `validate.ts` / `scripts/no-secrets.mjs`: `tests/seed-v1-patterns.test.ts` fails.
- Match `allow_direct` on raw instead of canonical text: the normalization test fails.
- Let a line separator or C1 control through, or leave U+2028 raw in rendered text: the spoofing tests fail.
- Let `seed_attach` write on a dry run, or apply on `dry_run: false`: the whole-database snapshot tests fail.
- Lower the tool floor below `member`: the observer test (403 forbidden) fails.
- Change how `allow_direct` matches `path` and `type`: the allow_direct matching test fails.
- Drop the agent-bound or org-admin refusal on apply, or the all-requests-accepted check: the apply authority tests fail.
- Skip the insert-first claim, or let a repeat or racing apply past the UNIQUE key: the replay and concurrent-apply tests fail.
- Remove the no-takeover guard from the claim INSERT, or treat a project with no recorded creator as the caller's: the takeover tests fail.
- Compare digests loosely (or not at all) on a repeat: the digest-conflict test fails.
- Store the raw source anywhere: the canary-comment test fails.
- Let apply create a bot, agent, capability or gate: the whole-database footprint test fails.
- Drop the receipt or its UNIQUE key: the footprint and concurrent-apply tests fail.
