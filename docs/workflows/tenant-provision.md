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
| 4 | `deploy_worker` | Uploads the tenant worker script into the `mupot-pots` dispatch namespace with D1/KV/`TENANT_SLUG`/`BRAND`/`PUBLIC_ORIGIN`/`RELEASE_SHA` bindings, after digest-verifying the R2-sourced bundle (round 2, see below). Receipt detail is JSON: `{source, sha256, r2_object_key?}` — every deploy is receipted with exactly which bytes it shipped. | Not step-idempotent in the sense of avoiding a re-upload — a WFP script upload is already an overwrite-by-name PUT, so retrying is safe by construction. |
| 5 | `seed_identities` | Seeds one `core` department + squad, an org-owner admin `members` row, and the seed-seat lead agent (`<slug>-bot`) with its own home member — tokens hashed with the exact `sha256Hex` (`src/members/service.ts`) the main pot's token-verification path uses. Receipt detail is JSON: `{already_seeded, admin_member_id, admin_token_fingerprint, lead_agent_id, lead_agent_member_id, lead_agent_token_fingerprint}` — identity references + one-way fingerprints, never a raw token (round 2, see "the provisioner's authority ends at the handover" below). | Checks for an existing admin member by email FIRST; a retry against an already-seeded pot mints no new rows or tokens, and its receipt still reports the EXISTING admin's id + fingerprint (read back from the stored hash, not re-derived from a raw value). |
| 6 | `verify_reachable` | `GET /health` through the SAME internal path production traffic uses — `env.DISPATCHER.get(slug).fetch(request)` — never a real network `fetch()` to the public hostname. | N/A (a read). |

`ok` is `true` **only** when all six steps ran to completion, in order, and step 6 answered
`200`. Any failure returns `status: 'incomplete'` with `completed` / `not_completed` /
`orphaned_resources` naming exactly what happened, and a `pot_provision_receipts` row
(migration `0169`, on the ORCHESTRATOR's own D1 — not the tenant's) per step, grouped by
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

**CI publish output contract (round 2 — required, not optional).** An R2 GET returning 200
only proves the bytes were *readable*, not that they are the bytes CI actually built —
silent corruption, a partial multipart write, or a stale key left over from a previous
release would all read back successfully. `loadPotWorkerBundle` therefore treats an R2
object as untrusted unless the CI publish step (once built) satisfies this exact contract:

- **Object key:** `${RELEASE_SHA}/worker.js` (unchanged from the design above; `RELEASE_SHA`
  is the same value `scripts/deploy.mjs` already stamps for the colony worker, mupot#443).
- **Custom metadata:** an R2 `sha256` key (`POT_WORKER_BUNDLE_SHA256_METADATA_KEY` in
  `src/pots/service.ts`) whose value is the lowercase hex sha256 digest of the EXACT bytes
  in the object body — i.e. `sha256 === sha256Hex(await fs.readFile(bundlePath, 'utf8'))`
  for whatever bundle text `scripts/build-pot-worker-bundle.mjs` produced, computed and set
  in the SAME publish step that does the R2 `put()` (`{ customMetadata: { sha256 } }`), not
  read back and hoped to match.

`loadPotWorkerBundle` recomputes the digest of what it reads and compares it to this custom
metadata field. Missing metadata or a mismatch is a hard `deploy_worker` failure — never a
silent fallback to `worker_js_code`, since falling back would mask the exact
tampering/corruption this check exists to catch. The `worker_js_code` fallback path has
nothing to verify against (nothing publishes it anywhere), so it is not gated the same way —
but its own digest is still computed and written into the `deploy_worker` receipt
unconditionally, so exactly which bytes were deployed is always auditable after the fact
regardless of which source won ("an unpinned fallback is an unsigned binary on the control
plane" — every deploy is receipted, even the ones nothing can independently verify).

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

### The provisioner's authority ends at the handover

This is the property the whole credential-claim design (above) and the receipt-fingerprint
design (below) both exist to hold, stated once, plainly, so it can be checked against
directly rather than re-derived from the mechanism each time:

**Post-bootstrap, the child pot's own RBAC governs its own credentials. The parent
(orchestrator) admin cannot reach into the child's credential plane.**

What the parent legitimately keeps, forever, in its OWN `pot_provision_receipts` ledger:
- The seeded admin's `member_id` and lead agent's `agent_id`/`member_id` — identity
  references, not credentials. Knowing an id lets you ask the CHILD "who is this," it does
  not let you authenticate as them.
- A **fingerprint** of each minted token (`sha256(raw).slice(0, 16)`, `src/pots/service.ts`
  `SeedIdentitiesResult`) — the SAME one-way, non-reversible value
  `CredentialClaimHandle.fingerprint` already uses (`src/auth/credential-claim.ts`).
  Fingerprints are safe to log, persist, and compare; they are cryptographically useless for
  reconstructing or replaying the credential they were derived from.

What the parent does NOT keep, anywhere durable:
- The raw token itself. `admin_token`/`lead_agent_token` in `SovereignPotProvisionResult`
  are typed `null`, always. The only place a raw value ever exists in the RESPONSE path is
  the SESSIONS-KV-backed, single-redemption, 10-minute `CredentialClaimHandle` — and that
  mechanism is scoped to the ONE interactive caller who supplied `minted_by_member_id`, not
  to "the parent" as a standing capability. Once redeemed (or expired), it is gone; nothing
  about the parent's own database, code path, or RBAC lets it be reconstructed.
- Any standing read/write access to the child pot's own D1. Provisioning talks to the
  child's D1 purely over the Cloudflare D1 REST API using the SAME account-level
  `cf_api_token` used to create it in the first place — this is Cloudflare-account-owner
  authority (already held before provisioning ever ran), not a credential the child's own
  RBAC granted the parent. The child's `member_tokens`/`capabilities` tables — the actual
  authorization surface a human or agent authenticates against inside that pot — are never
  read by anything in `src/pots/service.ts` after seeding, and nothing here mints a
  standing session, API key, or capability grant that would let the parent's own operators
  act AS a principal inside the child once the six steps finish.

In short: the receipt is an audit trail of what was minted, not a spare key to what was
minted. A parent operator who wants to act inside a provisioned pot goes through that pot's
OWN login/token surface, exactly like any other member of it — the same door the seeded
admin uses.

## Round 2: adversarial gate findings and fixes (mupot#1507)

Athena's round-1 adversarial pass on the first version of this feature found 4 P0s, 3 P1s,
and 4 P2s — all real, all fixed on the same branch (round 2 is the last round for this PR).
Four load-bearing semantics changed as a result:

- **`ok` semantics.** `ok: true` now requires all six steps AND the `pots` registry row
  being marked `status: 'active'` — a run that finished all six steps but failed the
  registry write is still `ok: false` (see the code comment on that specific edge case;
  it is the one place `not_completed` can read `[]` under `status: 'incomplete'`).
- **Adoption rule.** A slug is claimed in the `pots` registry (`provisioner_member_id` +
  `provisioner_tenant`, migration 0170) BEFORE any Cloudflare call. Reuse-by-name is
  allowed ONLY when the caller matches that claim; anyone else gets `pot_slug_taken`
  (409) with zero CF calls made, even if the D1/KV/worker CF resources for that slug
  already exist under a different provisioner.
- **R2 trust boundary.** Once `POT_WORKER_BUNDLE_BUCKET` is configured on a deployment at
  all, it is the ONLY trusted bundle source — a transport failure reading it is a hard
  `deploy_worker` failure, never a silent fallback to `worker_js_code`. Only "no object
  published yet for this RELEASE_SHA" (a clean 404-shaped absence, not an error) still
  falls through to the explicit path.
- **HTTP field set.** `POST /api/pots/provision` now validates the body against the exact
  same allow-list (`src/pots/validate.ts`) the MCP tool's `additionalProperties: false`
  schema already enforced — `slug`, `brand_name`, `admin_email`, `admin_name`, `plan_tier`,
  `custom_domain`, nothing else. `worker_js_code`/`cf_api_token`/`account_id` are refused
  with a named 400, and `provisionSovereignPot` itself refuses them again at runtime
  regardless of caller (defense in depth against a bypass of either surface).

Full findings, by severity:

**P0 (all fixed):**
1. The seed's `member_tokens` insert for the lead agent's seed-seat token was aborted by
   migration 0071's real `member_tokens_agent_binding_insert` trigger — no
   `agent_member_bindings` row existed yet. Fixed by inserting the binding first and
   sending the whole seed as one atomic `BEGIN`/`COMMIT` batch.
2. "Already seeded" was checked by member-email existence alone, certifying a
   half-seeded pot (admin exists, no capability/token/agent/binding) as fully ready.
   Fixed with `readFullSeedIdentityState` — every piece must exist or it is a named,
   hard failure.
3. `POST /api/pots/provision` spread the raw JSON body into the provisioner, letting a
   caller supply `worker_js_code`/`cf_api_token`/`account_id`. Fixed at the type, the
   shared validator, and the function itself (three layers).
4. A slug could be adopted by any caller with no ownership check. Fixed with the `pots`
   registry claim described above.

**P1 (all fixed):** `verifyPotReachable` now asserts `/health`'s `tenant` and `commit`
match what was actually deployed (P1-1); an R2 read failure is a hard failure, never a
fallback (P1-2); the reserved-slug refusal and the no-claim-without-a-minter rule are both
pinned by dedicated tests at the `provisionSovereignPot` entry (P1-3, "M5"/"M8").

**P2 (all addressed):** receipts carry `actor_member_id`/`actor_tenant` (migration 0169);
a database `CHECK` constraint refuses any receipt `detail` containing `@` and requires
valid JSON for the three structured steps — enforced by SQLite itself, not just
application code (verified empirically against a real engine); `verify_reachable`'s
receipt stores a sha256 of the `/health` body, never the body; the HTTP route and MCP tool
both refuse a bound-agent session (`operator_principal_required`) and a caller whose
tenant doesn't match the deployment's own `TENANT_SLUG`.

**Test harness fix (prerequisite to trusting any of the above):** the original test
suite's fake Cloudflare backend answered `success: true` to every D1 `/query` call,
so the seed step's real triggers (migration 0071's whole identity-weld invariant set)
never actually ran against it — which is exactly how the P0-1 defect shipped in the
first place. The suite now routes `/query` calls to a REAL SQLite database
(`tests/helpers/sqlite-d1.ts`) with the full committed migration chain applied, so every
insert in this document runs against the real constraint set.

## Round 2-v2 (mupot#1507-v2): a real engine is not a raw SQLite connection

A second adversarial pass on round 2's OWN fix found 3 new P0s — all in code round 2 itself
introduced. This is a successor PR (superseding the frozen #1507 branch, same base commit),
not a third round on that branch: Kasra-core froze #1507 at its own head, so these fixes
land on a new branch built FROM that exact head.

**P0-A — D1 REST is not a raw SQLite connection this Worker can `BEGIN`/`COMMIT` over the
wire.** Round 2's `seedPotIdentities` wrapped its whole atomic seed batch in an app-level
`BEGIN;` / `COMMIT;` script, reasoning "D1 is built on SQLite, so real transaction
semantics apply." Cloudflare's D1 REST `/query` endpoint REJECTS transaction-control
statements outright — `"cannot start a transaction within a transaction"` — because the
semicolon-joined statements in ONE `/query` call are ALREADY executed as a single atomic
batch by Cloudflare itself (developers.cloudflare.com/d1/best-practices/import-export-data/,
developers.cloudflare.com/d1/worker-api/d1-database/, cloudflare/workers-sdk#2733). This
codebase's own `scripts/gen-schema-chain.mjs` already refuses to GENERATE a migration file
containing transaction-control BEGIN for the identical reason — round 2 violated, at
runtime, exactly the rule this repo already enforces at generation time for migrations. The
round-2 test suite could not see this: its fake Cloudflare backend answered `success: true`
to raw SQL text, the same class of gap that let round-1's own defect ship. **Fix:** the
`BEGIN;`/`COMMIT;` wrapper is gone — atomicity comes entirely from D1 REST's own documented
one-call-one-batch semantics. **Test harness fix (again):** `tests/helpers/d1-rest-double.ts`
is a new, reusable D1-REST double every fake-CF backend in this repo should route `/query`
through — it refuses transaction control with D1's real error text, runs each `/query` body
inside its OWN implicit transaction (mirroring D1's real behavior, so a mid-batch failure
still leaves nothing committed without any app-level wrapper), and refuses combining bound
params with a multi-statement body (D1's per-statement binding semantics for that
combination are undocumented, so this codebase never relies on them either).

**P0-B — the receipt ledger's own CHECK constraint was rejecting the receipts it was
supposed to record.** Migration 0169's round-2 CHECK required `json_valid(detail)` for only
three of the six steps and separately refused ANY `'@'` character in `detail` regardless of
context. Every FAILURE path across all six steps wrote plain prose — which the three-step
JSON rule then rejected outright for the steps it covered, and the blanket `'@'` rule
rejected for EVERY step whenever a failure message happened to quote something with an `'@'`
in it that was not an email (`@cf/meta/llama-3.3`, a Workers AI binding name, for instance).
Either violation made the `INSERT` throw, and `writeProvisionReceipt`'s swallowed catch
turned that into a step that ran, failed, and left NO receipt at all — the exact "orphan
discovered with no explanation" failure mode this ledger exists to prevent. **Fix:** the
CHECK now requires `json_valid(detail)` uniformly for every step (structure is a database
concern SQLite can verify exactly); PII redaction moved to application code
(`redactAndBound` in `src/pots/service.ts`, which matches EMAIL SHAPES, not every `'@'`);
`receiptOk`/`receiptError` are the only two functions anywhere in that file that build a
`detail` value, so every row this schema will ever see is JSON by construction, not
convention. `writeProvisionReceipt` no longer swallows a write failure — it returns whether
the write landed, and `recordStep` treats a failed write as a FAILED STEP even when the
underlying provisioning operation itself succeeded (fail-closed, logged via `console.error`
since there is no better channel this deep in an already-fail-closed path).

**P0-C — a self-serve claim with no interactive member degraded to "everyone with the same
tenant."** `checkout.ts`'s Stripe webhook path never set `minted_by_member_id` (there is no
interactive member at checkout time), so ownership of a self-serve `pots` row matched on
`actorTenant` alone — the SAME value for every self-serve buyer on this deployment (and
`null` on both sides when `TENANT_SLUG` was unset). A second self-serve call for the same
slug — a retry, a different customer, an attacker — could silently adopt whatever the first
call claimed, redeploying over a live customer's pot and handing the caller back the
victim's own admin identity references. **Fix:** migration 0170 (still branch-only, rewritten
in place) adds `pots.checkout_session_id`. `checkout.ts` passes the completed Stripe
Checkout Session's own `id` through to `provisionSovereignPot` as `checkout_session_id`;
the registry gate now requires an EXACT session-id match to adopt a row that carries one —
a webhook retry of the SAME session is idempotent (same id ⇒ same claim ⇒ adopt), a
genuinely different session on the same slug is refused outright, before any Cloudflare
call. A row with NEITHER a checkout-session claim NOR a member claim is never adoptable by
anyone — including another caller who also carries no identity: two `null === null` callers
matching each other was the exact mechanism of the original defect.

**Release path for a burned slug (P1-A, new this round).** A `pots` row can get stuck at
`status: 'provisioning'` forever — an abandoned Stripe checkout, a crashed run nobody
retried. `checkSlugAvailability` now treats a `'provisioning'` row past
`STALE_PROVISIONING_MS` (30 minutes) as available again for a NEW checkout attempt's
pre-flight check — a UX signal only, never itself authorization. The SAME provisioner can
always retry their own claimed row regardless of age (already true via the ownership check
above). A DIFFERENT provisioner needs an explicit, receipted org:admin action —
`releaseStalePot` / the `pot_release` MCP tool — which refuses outright to release anything
that is `'active'` (regardless of age) or `'provisioning'` but not yet stale, and writes a
`pot_provision_receipts` row under a new `step: 'release'` value on the SAME ledger. A
released row is then adoptable by any new caller via an `UPDATE ... WHERE status =
'released'`, guarded against a second concurrent claim the same way the original INSERT-race
guard works.

**The 'lead' seed-seat floor, spelled out (Athena's binding addition).** The seed-seat lead
agent's own home member is seeded with `capability = 'lead'` (squad-scoped), matching the
agent's own `role` column — this is the pot's first OPERATOR, not a bystander, so its
capability sits on the SAME plane its role already claims. `'lead'` (rank 3) does **not**
reach `mint_agent_token`, `grant_agent_capability`, or `routine_create` — all three require
`min: 'admin'` (rank 4) in `src/auth/capability.ts`'s `RANK` ladder. The seed seat can act as
a lead inside its own pot; it cannot mint tokens, grant capabilities, or create routines
without a separate, later elevation to admin — the same ladder every other member in this
schema climbs.

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
- Confirm LIVE that D1 REST's `/query` actually answers `"cannot start a transaction within
  a transaction"` (or an equivalent refusal) for a `BEGIN`/`COMMIT`-bearing body, matching
  the public docs this PR cites and `tests/helpers/d1-rest-double.ts`'s modeling of it — this
  session never calls the live CF API, so the refusal text and the one-call-one-batch
  atomicity claim are verified against documentation and a faithful test double, not a real
  D1 database.
- Nothing further to renumber for THIS PR: `0169`/`0170` were assigned after rebasing onto
  `origin/main` (`585f26cf`, head migration `0165`), with `0166`/`0168` deliberately skipped
  as reserved by sibling in-flight PRs (a bootstrap successor and a runners successor,
  neither merged yet). `scripts/check-migration-numbering.mjs` passes clean at this head. If
  either sibling merges first and claims a number this branch also touches before THIS
  branch merges, the collision-and-renumber dance happens again — same as the two prior
  renumbers in this branch's own history (`0163`→`0164`, `0165`→`0167`, and now this PR's
  own `0164`→`0169`/`0167`→`0170`) — a migration number is provisional until merge, not
  claimed at branch time.
- Wire `pot_release`'s org:admin-only MCP tool into whatever admin dashboard surface lists
  provisioning attempts, so a human doesn't need raw MCP/SQL access to use it.
