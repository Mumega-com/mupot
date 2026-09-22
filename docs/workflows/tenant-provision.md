# Tenant provisioning (`provisionSovereignPot`) — mupot#1285

## What this closes

Before this change, `pot_provision` created a D1 database and a KV namespace, generated
admin/lead-agent credentials in memory, and returned `ok:true` — for a tenant with no
schema, no deployed worker, unwritten credentials, and an origin (`<slug>.mupot.mumega.com`)
that cannot complete a TLS handshake. It had never once produced a working pot. Live
evidence: Psychonom (2026-09-22) — `pot_provision` created D1 `mupot-pot-psychonom`
(`b0568c25-c1b6-4137-8fa0-690265d0b087`) and KV `mupot-pot-psychonom-kv`
(`061ebc1ed7c44a60b92c7e7966ed028c`), then reported `status: incomplete` honestly (the
partial-completion contract from the first phase of #1285 was already live) but the pot
still did not exist.

This PR makes `provisionSovereignPot` finish what it starts, or fail closed and say
exactly where it stopped — every time, not just on the happy path.

## The six steps

| # | Step | What it does | Idempotent how |
|---|------|--------------|-----------------|
| 1 | `create_d1` | `GET .../d1/database?name=` to find an existing database named `mupot-pot-<slug>`; adopt it if found, else `POST` to create. | Reuse-by-name — a prior partial run's orphan is adopted, never duplicated. |
| 2 | `create_kv` | Same pattern against `.../storage/kv/namespaces` (paginated list + title match, since the list endpoint has no documented title filter) for `mupot-pot-<slug>-kv`. | Reuse-by-name. |
| 3 | `apply_schema` | Runs `applySchemaChain` (`src/pots/schema-chain.ts`) — the SAME generated chain (`src/pots/schema-chain.generated.ts`, regenerated from `migrations/*.sql` via `npm run gen:schema-chain`) the main pot's schema comes from — against the new D1 via the D1 REST `/query` API, one statement per HTTP call. | `pot_schema_applied` bookkeeping (read from the pot's own D1 first) — a fresh D1 has no such table yet, read as "nothing applied." |
| 4 | `deploy_worker` | Uploads the tenant worker script into the `mupot-pots` dispatch namespace with D1/KV/`TENANT_SLUG`/`BRAND`/`PUBLIC_ORIGIN`/`RELEASE_SHA` bindings. | Not step-idempotent in the sense of avoiding a re-upload — a WFP script upload is already an overwrite-by-name PUT, so retrying is safe by construction. |
| 5 | `seed_identities` | Seeds one `core` department + squad, an org-owner admin `members` row, and the seed-seat lead agent (`<slug>-bot`) with its own home member — tokens hashed with the exact `sha256Hex` (`src/members/service.ts`) the main pot's token-verification path uses. | Checks for an existing admin member by email FIRST; a retry against an already-seeded pot mints no new rows or tokens. |
| 6 | `verify_reachable` | `GET /health` through the SAME internal path production traffic uses — `env.DISPATCHER.get(slug).fetch(request)` — never a real network `fetch()` to the public hostname. | N/A (a read). |

`ok` is `true` **only** when all six steps ran to completion, in order, and step 6 answered
`200`. Any failure returns `status: 'incomplete'` with `completed` / `not_completed` /
`orphaned_resources` naming exactly what happened, and a `pot_provision_receipts` row
(migration `0164`, on the ORCHESTRATOR's own D1 — not the tenant's) per step, grouped by
`run_id`. The in-call response's `receipts` array mirrors those rows, so a caller does not
need to query the ledger separately.

## Why `gaf.mupot.mumega.com` returns HTTP 000 (and why that's not a bug in this PR)

Cloudflare Universal SSL covers `mumega.com` and `*.mumega.com` — **not** a second-level
wildcard like `*.mupot.mumega.com`, which needs Advanced Certificate Manager. Confirmed live
2026-09-03/04 and reconfirmed 2026-09-22:

```
$ curl https://gaf.mupot.mumega.com/health
TLSv1.3 (IN), TLS alert, handshake failure (552)   # curl reports this as HTTP 000

$ curl https://mupot.mumega.com/health
HTTP 200
```

The subdomain form is dead by construction, for every slug, forever — no misconfiguration
to fix. Production already moved to path-based routing: `src/index.ts` calls
`routeApexPathTenant` (`src/dispatcher.ts`) on every request, which serves
`https://mupot.mumega.com/t/{slug}/{interface}` by rewriting the request's **internal**
hostname to `{slug}.mupot.mumega.com` and handing it to `env.DISPATCHER.get(slug).fetch()`.
That binding call never does DNS or TLS — it's a Workers-for-Platforms dispatch, not a
network request — so the subdomain string only ever exists as a `Request` property used to
extract the slug (`extractTenantSlug`), and the fact that the same string is unreachable
over the public internet is irrelevant to it working internally.

`verifyPotReachable` (`src/pots/service.ts`) uses exactly this path: it builds a synthetic
`Request` to `https://{slug}.{rootDomain}/health` and hands it to the SAME
`dispatcher.default.fetch()` production uses, dynamically imported to avoid a load-time
circular import (`src/dispatcher.ts` imports `RESERVED_TENANT_SLUGS` from
`src/pots/service.ts`). `public_origin` in every response and receipt is the path form
(`https://mupot.mumega.com/t/{slug}`) — the subdomain string never appears in output, only
internally, in the one place it is guaranteed not to touch a network.

## Bundle source trade-off (requirement 3)

The tenant script body must be THIS worker's own built bundle. Three options:

**A — the worker fetches its own script content back from the CF API and re-uploads it.**
REJECTED. Prior research
(`docs/d1-rest-and-wfp-provisioning-limits-2026-09-04.md`, point 4) found the
`.../scripts/{name}/content/v2` endpoint's multi-module completeness and exact format
entirely undocumented. Two independent, unverified gaps compounding is not a foundation for
a path whose entire point is to be more honest than what it replaces.

**B — CI publishes the built bundle to R2 at deploy time, keyed by `RELEASE_SHA`; this is
the production target.** This was the design decision recorded on the issue 2026-09-04 (S2).
`provisionSovereignPot` checks this FIRST via `loadPotWorkerBundle` — `env.POT_WORKER_BUNDLE_BUCKET`
(new optional R2 binding, `src/types.ts`), object key `${RELEASE_SHA}/worker.js`. **Not
implemented in this PR**: `scripts/deploy.mjs` does not yet write to this bucket, and no
`wrangler.toml` R2 binding for it exists — this session cannot create Cloudflare resources
(a bucket) or verify the write path live. `scripts/build-pot-worker-bundle.mjs` (new, this
PR) produces the bundle text via `wrangler deploy --dry-run --outdir` — the actual "PUT it
to R2 after a successful deploy" step in `scripts/deploy.mjs` is the follow-up.

**C — the caller passes the bundle text directly (`worker_js_code` on
`SovereignPotProvisionInput`, or the legacy positional `workerJsCode` argument).** Works
TODAY with zero new Cloudflare resources. `loadPotWorkerBundle` falls back to this when R2
has no object for the current build. This is the path exercised end-to-end by this PR's
tests, and the only one Kasra-core can smoke-test live without first standing up option B's
infrastructure.

Neither source configured is a **named, hard failure** on `deploy_worker` — never a silent
skip like the pre-#1285 `if (workerJsCode)` branch, which is exactly how the original defect
shipped (nobody passed it, so nothing was ever deployed, and nothing said so).

## D1 REST apply strategy trade-off (requirement 2)

`applySchemaChain`'s `exec` is one D1 REST `/query` call per statement (≈970 sequential HTTP
round trips for a fresh pot on today's chain, `src/pots/schema-chain.ts`'s own header already
flagged this as "not a viable production shape" when S1 landed). The alternative — the
documented D1 `/import` bulk API — was the S1-era recommendation
(`docs/d1-rest-and-wfp-provisioning-limits-2026-09-04.md`), and is **deliberately not** what
this PR uses: `/import` is one atomic whole-file operation with no per-statement
granularity, which would silently give up the exact "which statement failed" receipt
requirement 2 asks for. This PR chose precision over throughput. Follow-up worth doing:
batch the happy-path statements (`batchStatements`, already exported and tested in
`schema-chain.ts`, unused until now) and fall back to one-at-a-time only after a batch
fails, to get most of the speed back without losing exact-statement diagnosis on failure.

## Credential claims, not raw tokens (requirement 4)

Freshly-minted admin/lead-agent tokens are hashed with `sha256Hex` and written to the
tenant's own `member_tokens` before this call ever touches the response. The response
itself carries **no raw token** — `admin_token` / `lead_agent_token` are always `null`.
Instead, when the caller supplied `minted_by_member_id` (an interactive org-admin caller —
the dashboard route or the MCP tool, both updated to pass `auth.memberId`), the raw value is
staged behind the existing one-time `CredentialClaimHandle` mechanism
(`src/auth/credential-claim.ts`, mupot#987) and only `claim_id` / `fingerprint` /
`expires_at` come back. The caller redeems it once, within 10 minutes, via the existing
`reveal_credential_claim` tool.

**Known gap, explicitly out of scope for #1285**: `checkout.ts`'s self-serve Stripe
webhook path has no interactive member session to hand a claim to (the buyer isn't a mupot
member yet). It still gets `admin_credential_claim: null` and `admin_token: null` — i.e.
today, self-serve checkout provisions a pot with a real seeded admin but delivers no
credential to the buyer at all. Fixing that is a credential-DELIVERY problem (magic-link
email, or a first-login flow keyed by `admin_email`), not a provisioning-completeness
problem — tracked separately, not bundled into this already-large change.

## What Kasra-core still needs to do (this session cannot)

- Confirm the D1 list-by-name (`GET .../d1/database?name=`) and KV-list pagination against
  the REAL Cloudflare API — both are implemented defensively (client-side exact-match
  filtering regardless of whether the server already narrowed the result) but unverified
  live, since this session never calls the live CF API.
- Run `scripts/build-pot-worker-bundle.mjs` for real (needs a real `wrangler.toml`) and wire
  its output into a live `pot_provision` call end-to-end — with a real CF token, on a
  disposable test slug, watching the receipts land.
- Design and land the R2-publish half of bundle option B (`scripts/deploy.mjs` writing to
  `POT_WORKER_BUNDLE_BUCKET` after a successful deploy), and the actual bucket/binding.
- Migrate Psychonom's `psychonom-prj` / `psychonom-sqd` / `psychonom-mubot` rows (currently
  living inside the mumega tenant) into its own pot once one is actually stood up for it —
  named in the issue as part of this work's acceptance criteria, not attempted here (it is a
  live-data migration on production identities, squarely inside "never touch live CF
  resources / tenant-specific hand-edits" for this build session).
