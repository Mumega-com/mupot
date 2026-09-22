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
(optional R2 binding, `src/types.ts`), object key `${RELEASE_SHA}/worker.js`.

**Enablement (mupot#1285/#1516 follow-up — the R2-publish half of option B, now built):**
the `mupot-pot-bundles` R2 bucket exists; a colony wires it up with the same binding block
used everywhere else in this repo, in its own gitignored `wrangler.toml` (see
`wrangler.example.toml` for the exact snippet — this is a config change, no code needed on
that side):

```toml
[[r2_buckets]]
binding = "POT_WORKER_BUNDLE_BUCKET"
bucket_name = "mupot-pot-bundles"
```

With that binding present, `npm run deploy` (`scripts/deploy.mjs`) now publishes the
just-deployed bundle to it automatically as a post-deploy step, calling
`scripts/publish-pot-bundle.mjs` with the exact `RELEASE_SHA` (and `--config`, for a
multi-tenant colony) the deploy itself just stamped:

1. `scripts/build-pot-worker-bundle.mjs` builds the bundle text via `wrangler deploy
   --dry-run --outdir` (unchanged from before this follow-up — now also forwards any extra
   args like `--config` through to that dry-run build, so a non-default `wrangler.toml`
   builds its OWN bundle rather than silently publishing the default one).
2. `scripts/publish-pot-bundle.mjs` refuses to run at all from a dirty working tree, or
   when the `RELEASE_SHA` it is given is not the exact commit `git rev-parse HEAD` reports
   — the identical discipline `scripts/deploy.mjs` itself already applies before stamping a
   build (see the next section for exactly why). It then signs and PUTs the built bundle to
   `https://<account_id>.r2.cloudflarestorage.com/mupot-pot-bundles/${RELEASE_SHA}/worker.js`
   via the R2 **S3-compatible API** — deliberately NOT the plain bearer-token Cloudflare v4
   REST API's "Upload Object" endpoint, which (verified directly against the published
   `cloudflare` npm package's own `ObjectUploadParams` type) has no way to set custom
   metadata at upload time at all. Signing uses `aws4fetch`, pinned to an exact version
   (`1.0.20`, not a caret range) and used only by these two scripts — never imported from
   `src/`.
3. **Credentials — a DEDICATED, bucket-scoped R2 API token, NOT the deploy's
   `CLOUDFLARE_API_TOKEN`.** An earlier version of this PR derived S3 credentials from the
   deploy token itself (Access Key ID = the token's own `id`, Secret Access Key =
   `sha256(token value)`). Athena's round-1 ruling (2026-09-22) rejected that: it is not a
   documented Cloudflare pattern, it hands a bundle-publish script the FULL scope of
   whatever broker minted the deploy token (account-owned, not scoped to one bucket), and
   the derivation's own verification call rejects an account-owned token in practice
   anyway. The two scripts instead read `R2_POT_BUNDLES_ACCESS_KEY_ID` and
   `R2_POT_BUNDLES_SECRET_ACCESS_KEY` straight from the environment (plus
   `CLOUDFLARE_ACCOUNT_ID`, unchanged, for the endpoint hostname) and refuse — by env var
   NAME only, values never printed, before any network call — if either is absent or
   blank. See "Minting the R2 credential pair" below for how an operator produces and
   stores this pair.
4. A deploy whose bundle publish then FAILS is not reported as a successful deploy —
   `scripts/deploy.mjs` exits non-zero and prints the retry command, so a tenant
   provisioned moments later can never silently get "no bundle for this RELEASE_SHA" for a
   release that in fact went out. Skip the step entirely with `--skip-bundle-publish
   --skip-reason "<why>"` (a reason is REQUIRED — `deploy.mjs` refuses the flag without
   one) — e.g. a colony that has not wired the bucket binding at all yet. Deploying from a
   non-clean tree (`MUPOT_ALLOW_DIRTY_DEPLOY=1`) skips automatically, without needing
   `--skip-reason`, since a `-dirty`-suffixed `RELEASE_SHA` is never a valid publish target
   in the first place. Either way the skip is a **receipted** line in the deploy's own
   output — `bundle_publish: skipped by <actor> reason=<reason>` (actor = `$USER`, falling
   back to `git config user.name`) — never a silent gap.
5. `scripts/verify-pot-bundle.mjs <release-sha>` is the operator receipt: it independently
   re-fetches a previously-published object and re-verifies its digest against the same
   `x-amz-meta-sha256` metadata `loadPotWorkerBundle` itself checks, for any past release —
   not coupled to the local working tree at all. Same credential pair as publish.

### Minting the R2 credential pair

1. Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → **Create API token**.
2. Permission: **Object Read & Write**. Scope: **Apply to specific buckets only** →
   `mupot-pot-bundles`. Never account-wide, never "Admin Read & Write" — the whole point of
   this pair is that leaking it exposes exactly one bucket, nothing else the account-owned
   `CLOUDFLARE_API_TOKEN` can reach.
3. The dashboard hands back an **Access Key ID** and a **Secret Access Key** directly (this
   IS the S3-compatible credential pair — no derivation step, unlike a general Cloudflare
   API token). Copy both once; the Secret Access Key is not retrievable again after this
   screen closes (re-create the token if lost).
4. On the deploy host, store them as `~/.fleet/agents/r2-pot-bundles.env`, mode `600`,
   under the same fleet-gated-paths discipline every other host credential file on this
   estate follows (see `docs/security/secrets-inventory.md` Scope 1 — `~/.fleet/agents/`
   is already the largest such directory and already 600-by-default):
   ```
   R2_POT_BUNDLES_ACCESS_KEY_ID=<access key id>
   R2_POT_BUNDLES_SECRET_ACCESS_KEY=<secret access key>
   ```
5. A helper script **outside this repo's worktree** (this is host infrastructure, not
   tenant/repo code — the same reason `wrangler.toml` itself is gitignored and hand-managed
   per colony, not generated here) sources that file and `exec`s the real command with both
   vars exported, e.g. a one-liner such as
   `set -a; source ~/.fleet/agents/r2-pot-bundles.env; set +a; exec npm run deploy -- "$@"`
   kept alongside the operator's other fleet-gate helper scripts. This repo's scripts never
   read the file path themselves — they only ever read the two already-exported env vars,
   so the file's location is a host/ops decision, not a code dependency.
6. **Live-verify-before-merge receipt** (Kasra-core, required before merging this PR):
   capture, as a PR comment, (a) UTC timestamp and operator name, (b) the git HEAD sha used
   for the live run, (c) `npm run deploy -- --config <toml>` exit code, (d) the
   `scripts/publish-pot-bundle.mjs` stdout JSON receipt
   (`{ok,bucket,key,sha256,size,already_published}`),
   (e) the `scripts/verify-pot-bundle.mjs <sha>` stdout JSON receipt confirming `ok:true`
   (also run automatically by `scripts/deploy.mjs` itself before it prints success),
   and (f) a `grep`-for-the-secret-value confirmation that neither
   `R2_POT_BUNDLES_ACCESS_KEY_ID` nor `R2_POT_BUNDLES_SECRET_ACCESS_KEY`'s VALUE appears
   anywhere in the captured terminal output being pasted. Merge only after that receipt is
   posted.

### Round 2 (Kasra-core adversarial pass, 2026-09-22): immutability, signed payloads, config parsing

- **A published RELEASE_SHA bundle is now immutable.** `putPotWorkerBundleObject` PUTs with
  `If-None-Match: '*'` (R2's S3-compatible conditional-write extension). A `412` means the
  key already exists: an internal re-GET compares digests — identical bytes is a successful,
  idempotent re-publish (`already_published: true` in the JSON receipt); DIFFERENT bytes is
  refused outright (`bundle_sha_conflict`, exit 1), never silently overwritten. Before this,
  a stale local tree, a non-reproducible build, or two colonies racing the same commit could
  silently replace what a prior `loadPotWorkerBundle` call had already trusted.
- **The PUT's body is now genuinely signature-covered.** `aws4fetch` defaults an s3-service
  request to `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` unless that header is set before
  signing — under that default the SigV4 signature does not cover the body at all.
  `putPotWorkerBundleObject` sets it explicitly to the same digest it records as
  `x-amz-meta-sha256`, so the signature genuinely covers the exact bytes sent.
- **`--config`/`-c`/`--config=<path>` are all recognized, by ONE shared matcher**
  (`scripts/lib/wrangler-config-arg.mjs`), used by both `scripts/deploy.mjs` (peek-only —
  it must forward argv to `wrangler deploy` unchanged) and
  `scripts/build-pot-worker-bundle.mjs` (which allowlists its own argv against this shape).
  Before this, `scripts/deploy.mjs` matched only the long `--config <path>` form: a real
  `-c wrangler.acme.toml` or `--config=wrangler.acme.toml` deploy would silently
  build-and-publish the DEFAULT config's bundle under the RELEASE_SHA the RIGHT config's
  deploy actually stamped — a self-consistent digest over the WRONG bytes, with nothing to
  flag it.
- **`scripts/build-pot-worker-bundle.mjs` now ALLOWLISTS its own argv** (`--outdir` and one
  of the three `--config` spellings — nothing else) instead of forwarding everything to
  `wrangler deploy --dry-run`. A caller-supplied `--dry-run=false` (or any other
  wrangler flag this script doesn't know about) could otherwise have turned a documented
  no-network dry-run build into a REAL deploy.
- **`scripts/deploy.mjs` re-verifies what it just published** — after a successful
  `scripts/publish-pot-bundle.mjs` run, it also runs `scripts/verify-pot-bundle.mjs
  <release-sha>` (an independent re-GET + digest check) BEFORE printing its own
  `bundle_publish: published by ...` receipt line. A publish step exiting 0 was not, on its
  own, proof the object was live and byte-correct.
- **The explicit `--skip-bundle-publish` receipt now states its consequence up front**: a
  `⚠ ... pot_provision will refuse this RELEASE_SHA with 'no_bundle_source' ...` line prints
  before the `bundle_publish: skipped by <actor> reason=<reason>` receipt line, so the skip
  is never mistaken for a no-op.
- **S3 error bodies are scrubbed of `<AWSAccessKeyId>` before being thrown, returned, or
  printed** — an S3-shaped XML error can echo the access key id used in the failed request;
  the VALUE is redacted, the rest of the diagnostic body is left intact.
- **One bucket-name constant, pinned against `wrangler.example.toml`** —
  `POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT` and the example config's `bucket_name` are asserted
  equal by a dedicated test, so the two can never silently drift apart.

UNVERIFIED LIVE, same discipline as the rest of this module: this session cannot confirm R2's
S3-compatible PutObject actually honors `If-None-Match: '*'` with a `412` on conflict —
folded into the live-verify-before-merge receipt above (item (d)'s JSON receipt should show
`already_published:false` on a genuinely fresh key, and a deliberate second run for the SAME
sha should show `already_published:true`).

**Still not done, and explicitly out of scope for this follow-up too:** this session never
calls the live Cloudflare API (no bucket write, no deploy) — the S3 endpoint shapes above
are sourced from developers.cloudflare.com and the published `cloudflare` npm package's own
type definitions, not exercised against a real account. See the live-verify-before-merge
receipt above for exactly what Kasra-core captures once a scoped R2 credential pair exists.

**CI publish output contract (round 2 — required, not optional; this is the exact contract
`scripts/publish-pot-bundle.mjs` now satisfies).** An R2 GET returning 200 only proves the
bytes were *readable*, not that they are the bytes CI actually built — silent corruption, a
partial multipart write, or a stale key left over from a previous release would all read
back successfully. `loadPotWorkerBundle` therefore treats an R2 object as untrusted unless
the publish step satisfies this exact contract:

- **Object key:** `${RELEASE_SHA}/worker.js` (unchanged from the design above; `RELEASE_SHA`
  is the same value `scripts/deploy.mjs` already stamps for the colony worker, mupot#443).
- **Custom metadata:** an R2 `sha256` key (`POT_WORKER_BUNDLE_SHA256_METADATA_KEY` in
  `src/pots/service.ts`) whose value is the lowercase hex sha256 digest of the EXACT bytes
  in the object body — i.e. `sha256 === sha256Hex(await fs.readFile(bundlePath, 'utf8'))`
  for whatever bundle text `scripts/build-pot-worker-bundle.mjs` produced, computed and set
  in the SAME publish step that does the R2 write (an `x-amz-meta-sha256` header on the
  S3-compatible PUT — R2 maps that 1:1 onto `customMetadata.sha256` for a Workers-binding
  reader, stripping the `x-amz-meta-` prefix), not read back and hoped to match.

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

## Round 3 (mupot#1516): the release path's own edges, and the tools that model D1

Adversarial round 1 on the round-2-v2 fix (head `215c45e4`) came back AMBER — 0 P0, every
round-2-v2 P0 confirmed closed by execution — with four P1s and five P2s on code round-2-v2
itself introduced. Round 2 is the last round for this PR.

**P1-1/P1-2 (`releaseStalePot` fail-open on its own write).** Two bugs in the function meant
to be the SAFE, receipted alternative to blindly reassigning a slug: (1) its receipt write's
returned boolean was discarded — a receipt-write failure left `ok: true`, the `pots` row
durably `'released'`, and ZERO rows on the append-only ledger explaining who released it or
why; (2) the status-flip `UPDATE ... WHERE status = ?2` never checked `meta.changes` — a row
reclaimed (by its own provisioner completing a retry) between this function's own SELECT and
its UPDATE could report `ok: true` for a write that changed 0 rows, receipting a `'release'`
event against a slug that was, by the time the receipt landed, active again. **Fixed:**
`meta.changes === 0` is now a named `release_lost_race` refusal with no receipt; a
receipt-write failure now reverts the status flip via a compensating UPDATE (same
fail-closed discipline `provisionSovereignPot`'s own `recordStep` already established) and
reports `receipt_write_failed`.

**P1-3/P1-4 (`pot_release` fences).** The MCP tool had `operator_principal_required` but no
`tenant_mismatch` check at all — a foreign-tenant org:admin could release a slug and have it
receipted under `actor_tenant: 'someone-else'` on THIS deployment's own ledger. Added the
identical fence `pot_provision` already uses. The existing bound-agent refusal was real but
had no test at all (a silent "M7" survivor) — both fences are now pinned through `invokeTool`.

**P3 (final registry activation).** `UPDATE pots SET status = 'active' WHERE slug = ?1` — no
ownership check, no `meta.changes` read. The six steps before it can take real wall-clock
time (up to ~970 sequential D1 REST calls for a fresh schema chain) — long enough for the
slug to be released and reclaimed by a DIFFERENT provisioner before this run's own activation
write lands. The unconditional UPDATE would mark that other provisioner's row `'active'` on
this run's say-so — a false success for a pot this run no longer owns. Now guarded by this
run's own ownership claim (checkout-session match, or member+tenant match) AND `status IN
('provisioning', 'active')` — the latter so an idempotent retry of an already-active run
(e.g. a replayed Stripe webhook) still succeeds — with a `meta.changes` check.

**ENABLEMENT GATE (new step, not a fix to an existing one).** A deployment with neither
`POT_WORKER_BUNDLE_BUCKET` configured nor a `workerJsCode` argument used to burn a real,
billable D1 (step 1) and KV namespace (step 2), and apply the ENTIRE schema chain (step 3),
before discovering at step 4 that there was never anything to deploy — the exact `#1285`
orphan class this whole file exists to close, for a failure mode that is knowable BEFORE the
first Cloudflare call (whether a bundle source exists depends on neither the slug, the D1,
nor the schema). The bundle source is now resolved ONCE, as a preflight, immediately after
the registry gate and before `create_d1` — a missing source refuses `no_bundle_source` with
**zero** Cloudflare calls, receipted under the `deploy_worker` step. The resolved bundle is
reused (never re-resolved) at the real `deploy_worker` step later in the run.

**P2-1 (the D1 REST double is now a closer cousin of the real thing —
`tests/helpers/d1-rest-double.ts`).** The transaction-control check only tested
`^\s*(BEGIN|COMMIT|ROLLBACK)` against the WHOLE multi-statement string with no `m` flag —
`^` without `m` matches only the very start of the string, so a transaction-control
statement anywhere but the FIRST line of a batch slipped through undetected. Making that
check correct is NOT as simple as adding the `m` flag to a whole-batch regex, though: a
`CREATE TRIGGER ... BEGIN ... END` body legitimately contains a bare `BEGIN` on its own
line, and a per-line regex cannot tell that apart from real transaction control without
understanding block nesting — getting this wrong would refuse every trigger-bearing
migration in the real schema chain (45+ files). The double now SPLITS the batch into real
top-level statements via this repo's own battle-tested `splitSqlStatements`
(`scripts/gen-schema-chain.mjs` — already used by `tests/schema-chain.test.ts`, and already
correctly tracks BEGIN/CASE/END nesting and throws on transaction-control BEGIN) and checks
each resulting statement's own leading keyword. Also added: D1's documented 100
bound-parameter cap and ~100KB per-statement cap; `ATTACH` refusal (per Cloudflare's D1
documentation — not independently re-verified live this session) and `CREATE TEMP TABLE`
refusal (EMPIRICALLY VERIFIED already, per `migrations/0049_agent_status_inactive.sql`'s own
header); and one result element per statement in the response (previously always one,
regardless of how many statements were in the call — nothing in this codebase currently
reads past `result[0]`, but a double that lies about a real API's response SHAPE will
mislead the next caller who does need element N). Each refusal is documented with its source
in the double's own file header; each has its own test.

**P2-2.** `executeD1Query`'s doc comment claimed "this module always sends exactly one
statement per call" — stale since `seedPotIdentities`' own atomic batch. Corrected.

**P2-3 (redaction coverage).** `receiptOk`'s `fields` and `receiptError`'s `extraFields`
were spread into the JSON verbatim — completely unredacted and unbounded; only the
top-level `message` argument to `receiptError` ever went through `redactAndBound`. Every
field on today's actual call sites happens to be a safe id/count/enum, but the function
SIGNATURES placed no limit on what a future call site passes there. New `redactFields`/
`redactDeep` apply the same redaction and length bound recursively to every string value
reachable from either parameter.

**P2-4 (the email-redaction regex itself was too wide).** `/[^\s@]+@[^\s@]+\.[^\s@]+/g`
matched ANY run of non-space-non-`@` characters before an `@` — wide enough to swallow
`binding=@cf/meta/llama-3.3` whole (`binding=` as a fake local part, `cf/meta/llama-3` as a
fake domain, `.3` as a fake TLD), redacting a Workers AI binding name that contains no email
at all — the exact false positive this rule exists to avoid. Replaced with an RFC-ish
`[\w.+-]+@[\w-]+\.[\w.-]+`, which requires a word-character local part immediately before
the `@` (never `=`, `:`, or `/`) — verified against both the false-positive example and a
real email in the same string.

**P2-5 (caller-suppliable string bounds, `src/pots/validate.ts`).** `brand_name`/
`admin_name` are now capped at 200 characters, `admin_email` at 254 (RFC 5321 §4.5.3.1.3) —
shared by both the HTTP route and the MCP tool (one validator, same as the field allow-list
itself). A new `field_too_long` error surfaces as 400. A maximal-length seed (all three
fields at their cap) was verified to still land comfortably under the D1 double's own 100KB
per-statement cap — the two bounds do not fight each other for an ordinary caller.

**Known, documented, NOT fixed this round:**
- **`user@localhost`-shaped and punycode (`xn--...`) inputs.** `admin_email`'s only
  validation is presence + the 254-char bound above — no format check exists at all (a
  malformed but short address like `user@localhost`, with no dot in the domain part, passes
  cleanly through `validateProvisionRequestBody` and only fails later, if at all, when
  Stripe/the credential-claim flow tries to use it as a real mailbox). Slugs accept only
  `[a-z0-9-]` (`validateSlug`) — a punycode-encoded internationalized domain label like
  `xn--wgv71a` would pass THAT format check today, but nothing in this file has been tested
  against one, and the reserved-word list and the `pots`/`projects` collision checks have
  never been exercised with punycode input either. Neither is exploitable (both paths stay
  fail-closed on anything that doesn't parse), but neither is validated for CORRECTNESS —
  flagged here rather than asserted true by omission.
- **`handlePotCreationCompleted` has no production caller.** `src/billing/stripe.ts`'s
  `handleStripeWebhookEvent`'s own `checkout.session.completed` branch never inspects
  `session.metadata.action` or routes to `handlePotCreationCompleted` at all — it only
  handles THIS deployment's own plan-tier upgrade (`applyPlanEvent`). Every test in
  `tests/pot-checkout-provisioning.test.ts` and this PR's own P0-C tests calls
  `handlePotCreationCompleted` DIRECTLY; nothing in the real webhook-receiving path ever
  reaches it. This is a real, standing gap — self-serve checkout completion currently does
  not provision anything in production — tracked as a separate issue (Kasra-core), not wired
  up as part of this PR.

## What Kasra-core still needs to do (this session cannot)

- Confirm the D1 list-by-name (`GET .../d1/database?name=`) and KV-list pagination against
  the REAL Cloudflare API — both are implemented defensively (client-side exact-match
  filtering regardless of whether the server already narrowed the result) but unverified
  live, since this session never calls the live CF API.
- Run `scripts/build-pot-worker-bundle.mjs` for real (needs a real `wrangler.toml`) and wire
  its output into a live `pot_provision` call end-to-end — with a real CF token, on a
  disposable test slug, watching the receipts land.
- Smoke-test `scripts/publish-pot-bundle.mjs` / `scripts/verify-pot-bundle.mjs` for real
  (mupot#1285/#1516 enablement, now built — see "Bundle source trade-off" and "Minting the
  R2 credential pair" above): a minted, scoped `R2_POT_BUNDLES_ACCESS_KEY_ID` /
  `R2_POT_BUNDLES_SECRET_ACCESS_KEY` pair plus `CLOUDFLARE_ACCOUNT_ID`, the
  `POT_WORKER_BUNDLE_BUCKET` binding added to the real `wrangler.toml`, one real
  `npm run deploy`, and confirmation that `loadPotWorkerBundle` picks the published object
  up on the next `pot_provision` call — captured as the live-verify-before-merge receipt
  named above. This session never called the real R2 S3-compatible endpoint at all — it is
  implemented against documentation and the published `cloudflare` npm package's own types,
  not exercised live.
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
