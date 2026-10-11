# mupot.seed/v1 — the seed contract

A **seed** is a short declarative document describing a project someone wants attached to a
pot. It states what the project is, where it lives, what it would like to do, and what it
would like to be allowed to do. It is a **request, never a grant**: nothing in a seed is
authority, and validating one grants nothing.

Status: contract + validator + `seed_attach` dry run. Applying a seed is a later change.

## Document shape

YAML or JSON (JSON is valid YAML). Max 32 KiB, nesting depth at most 6, no YAML anchors or
aliases, no duplicate keys, **unknown keys are refused**.

| Key | Required | Notes |
|---|---|---|
| `schema` | yes | literal `mupot.seed/v1` |
| `slug` | yes | kebab-case, at most 63 characters |
| `name`, `goal` | yes | free text |
| `kind` | yes | `site/astro`, `site/wordpress`, `store/shopify`, `app`, `repo` |
| `owner` | yes | a label only; never resolved to a member by validation |
| `repo`, `live` | no | `live` must be an https URL without embedded credentials |
| `deploy` | no | `{via, cmd?, receipt?, human_only}`; `via` is `cf-pages`, `wrangler`, `wp-plugin`, `shopify-cli` or `git-push-only` |
| `surfaces[]` | no | `{path` or `type, mode}`; `mode` is `propose` or `direct` |
| `data[]` | no | `{store, tier}`; tier is `private`, `squad`, `project`, `role`, `entity` or `public` |
| `tools[]` | no | `{mcp` or `openapi, cred_slot?}`; `cred_slot` is a slot NAME |
| `wants` | no | `{memory[], gates[{action,gate}], routines[{id,cron,approval}], seats{squad,max}}` |
| `signals` | no | `{health[], outcome[]}` |
| `risk` | no | `{class, forbidden[], human_only[], allow_direct[]}`; class is `low`, `medium` or `high` |

## Rules the validator enforces

1. **Authority is never declared.** Any key named like a grant, token, secret, password, API
   key, credential, private key, bearer or authorization is refused (`secret_in_seed`), as is
   any value shaped like a secret (vendor key prefixes, JWTs, private-key blocks, URLs with
   embedded credentials, long opaque strings). The refusal never echoes the value.
2. **`cred_slot` is a slot name** matching `^[A-Z][A-Z0-9_]{2,63}$`. It is never resolved,
   looked up or checked against any vault by validation.
3. **Every ask is an explicit request.** Each `wants.gates`, `routines`, `seats`, `memory`
   entry, each tool credential slot and each `direct` surface becomes a request line marked
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
   type is listed in `risk.allow_direct`.

## The tool

`seed_attach { seed: string, dry_run?: boolean }` — member capability floor.

- `dry_run` defaults to **true**: validate and return
  `{ok, dry_run, seed_sha256, requests[], diffs[]}`. Nothing is written, including the
  generic presence bump. `diffs` compares name, goal, repo and live against an existing
  project with the same slug, only if the caller can already read that project.
- `dry_run: false` is not implemented yet and answers `501 seed_apply_not_built`.
- A refused seed is `400 invalid_seed` with `{code, path, message}`.

## Attach protocol

| # | Step | Who |
|---|---|---|
| 1 | Author the seed (a person, or an agent drafting for one) | anyone |
| 2 | `seed_attach` dry run: validate, read requests and diffs | member |
| 3 | Review the requests and diffs | human |
| 4 | Accept requests, one by one (gates, routines, seats, memory, direct surfaces) | **human only** |
| 5 | Bind each credential slot to a real credential in the vault | **human only** |
| 6 | Apply: find-or-create project, squad and seats keyed by `seed_sha256` (not built yet) | member, after step 4 |
| 7 | Deploy, DNS and production changes | **human only**, always |

Steps 4, 5 and 7 can never be performed by validation or by an agent acting alone.

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
list), `src/seeds/canonical.ts` (canonical JSON and digest), `src/mcp/seed.ts` (tool).
