# D1 REST + Workers-for-Platforms runtime-provisioning limits — research brief

Research date: 2026-09-04. Read-only research for the in-Worker pot-provisioning design
(`docs/workers-for-platforms.md`, `src/pots/service.ts` `executeD1Query` /
`uploadUserWorkerToDispatch`). All claims below are cited; anything not found in
Cloudflare's docs is flagged explicitly as undocumented rather than guessed.

## 1. D1 REST `/query`, `/raw`, and the `/import` bulk path

- **Multi-statement SQL is accepted** on both `POST /accounts/{account_id}/d1/database/{database_id}/query`
  and `.../raw` — the `sql` field docs state *"Supports multiple statements, joined by
  semicolons, which will be executed as a batch."*
  https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
  (updated 2026-04-21) / `.../raw/`.
- **Max request body size for `/query`/`/raw`: undocumented.** No cap stated on either
  API reference page. The only Cloudflare body-size numbers found (100/200/500 MB by
  plan) are for edge/zone traffic through Workers, not the control-plane API host —
  don't assume it applies. https://developers.cloudflare.com/workers/platform/limits/
- **Max statements per call: undocumented.**
- **Statement length limit: 100,000 bytes (100 KB)**; **query duration: 30 s**; **max
  bound params: 100**; **max row/string/BLOB size: 2 MB**; **max columns/table: 100**.
  https://developers.cloudflare.com/d1/platform/limits/ (updated 2026-04-21)
- **Transactional behavior of a multi-statement REST `/query` call: not explicitly
  documented.** Only the Workers-binding `db.batch()` is explicitly documented as
  atomic/rolled-back-on-failure
  (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch, updated
  2026-06-22). The REST endpoint's own doc uses similar "executed as a batch" wording
  but never states atomicity for the REST path itself — treat as unconfirmed if the
  134-file chain depends on all-or-nothing REST behavior.
- **Old caveat, may be stale**: cloudflare/workers-sdk#3892 (2023) — the multi-statement
  splitter is naive text-splitting, not a real SQL parser; comment lines ending in `;`
  broke it historically. Worth stripping comments defensively before concatenating
  migration files into one REST call.
- **Cloudflare's own documented bulk-load path is the `/import` polling API** —
  `POST /accounts/{account_id}/d1/database/{database_id}/import`, four `action`s:
  `init` (returns R2 presigned `upload_url`) → plain `PUT` of the SQL file to that URL →
  `ingest` (returns `at_bookmark`) → `poll` until `status:"complete"` (returns
  `final_bookmark`, `num_queries`). **5 GiB size limit** (516 KB is trivial). **Input is
  arbitrary SQL** (DDL + DML together, not a DB-dump-only format) — a concatenated
  134-file migration chain fits this shape. **The whole database is locked for the
  import's duration.** Tutorial (do this walkthrough, it's a working standalone REST
  flow, no wrangler needed):
  https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/ (updated
  2026-04-21); reference: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/;
  https://developers.cloudflare.com/d1/how-to/importing-data/.
  **This is the recommended path for the 516 KB chain**, not 134 sequential `/query`
  POSTs — one `/import` call (concatenate all migration files, apply in order) avoids
  the undocumented per-call body/statement-count ceilings entirely and gets an
  explicit size ceiling (5 GiB) instead.
- **Cloudflare account API rate limit: 1,200 requests / 5 min per token**, global and
  cumulative across all API use on that token; 429 on excess, 5-minute lockout.
  https://developers.cloudflare.com/fundamentals/api/reference/limits/ (updated
  2026-08-25). 134 sequential `/query` calls fits easily; `/import`'s 4-call flow trivially
  does too.

## 2. Workers-for-Platforms user Worker bindings: D1/KV confirmed, DO undocumented, Workflows effectively unsupported

- Exact metadata JSON (from the canonical upload-metadata reference,
  https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/,
  updated 2026-07-03 — this is the same schema for plain and dispatch-namespace
  uploads):
  ```json
  { "type": "d1", "name": "DB", "id": "<D1_ID>" }
  { "type": "kv_namespace", "name": "SESSIONS", "namespace_id": "<KV_ID>" }
  { "type": "durable_object_namespace", "name": "<VAR>", "class_name": "<Class>" }
  ```
  (`durable_object_namespace` also supports optional `script_name` when the DO class
  lives in a *different* script than the one binding to it.)
- `migrations` (legacy tag-array format, still what the script-upload metadata API
  uses):
  ```json
  { "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyDO"] },
    { "tag": "v2", "deleted_classes": ["Old"] },
    { "tag": "v3", "renamed_classes": [{"from":"A","to":"B"}] }
  ]}
  ```
  `new_classes` (legacy KV-backed) also exists alongside `new_sqlite_classes`
  (SQLite-backed, current default); `migrations` and the newer declarative `exports`
  field are mutually exclusive.
  https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/,
  https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
  — **neither page mentions Workers for Platforms or dispatch namespaces.**
- **Full documented `bindings[].type` enum (16 entries, both Script Upload and Version
  Upload APIs): `ai`, `analytics_engine`, `assets`, `browser_rendering`, `d1`,
  `durable_object_namespace`, `hyperdrive`, `kv_namespace`, `mtls_certificate`,
  `plain_text`, `queue`, `r2_bucket`, `secret_text`, `service`, `vectorize`,
  `version_metadata`. There is no `workflow` type in this schema — Workflows cannot be
  attached via the multipart PUT metadata at all**, only via a wrangler.toml
  `[[workflows]]` block + `wrangler deploy`, and that mechanism's docs never mention
  dispatch-namespace applicability either.
- **A user Worker owning its own DO class + migration in its own upload metadata is
  mechanically plausible** (the dispatch-namespace upload endpoint is the same
  script-upload API and schema) **but Cloudflare has published no WFP-specific
  documentation confirming, denying, or describing this pattern.** WFP's own
  bindings/limits/how-it-works pages (all checked, dated 2026-04-21 to 2026-07-22) only
  say generically "bindings to D1, KV, R2, and other resources," never mention DO
  ownership rules, and never restate the general "DO class must be in the same script
  as its migration" rule in a WFP context. **Treat as undocumented — verify empirically
  against the real API before relying on it.**
- **Workflows inside a user Worker: unsupported per docs.** Named once, in a marketing
  bullet, on the WFP bindings page ("Process work asynchronously with Queues and
  Workflows") with zero schema support, zero worked example, and zero cross-reference
  from the Workflows docs (developers.cloudflare.com/workflows/ never mentions Workers
  for Platforms, dispatch namespaces, or user Workers anywhere). **Do not design around
  a per-tenant `WorkflowEntrypoint` living inside the dispatched user Worker** — the
  orchestrating `TaskWorkflow` must live in the parent/dispatcher Worker, not the
  tenant's own script.
- WFP-specific confirmed facts: no limit on DO namespaces for WFP; unlimited scripts;
  `caches.default` disabled for namespaced scripts; Gradual Deployments not yet
  supported for user Workers; user Workers run "untrusted" — never share cache even on
  the same zone, no `request.cf` access.
  https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
  (updated 2026-07-03). No stated compatibility-flag restriction for user Workers
  (`nodejs_compat` neither confirmed nor denied) — undocumented.

## 3. Worker fetching its own script content to re-upload as a dispatch-namespace script

- Two distinct GET-content endpoints exist:
  - `GET /accounts/{account_id}/workers/scripts/{script_name}` ("Download Worker") —
    SDK types return as a raw `string`.
    https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/
  - `GET /accounts/{account_id}/workers/scripts/{script_name}/content/v2` ("Get Script
    Content") — SDK (TS) types return as a raw fetch `Response` object, not
    pre-parsed. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/
  Both require `Workers Scripts Read` (or Write/Tail Read).
- **Whether either endpoint returns all modules of a multi-module ES-module worker,
  and whether the response is itself `multipart/form-data` mirroring the upload shape:
  not documented anywhere found.** The `Response`-typed SDK return for `content/v2` is
  circumstantial evidence it's multipart (the upload side is unambiguously
  `multipart/form-data`,
  https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/),
  but no Cloudflare page states this outright. **Verify empirically (curl +
  inspect Content-Type) against a real multi-module deployed script before relying on
  it.**
- **The Worker Versions API does NOT return module content.**
  `GET .../scripts/{name}/versions/{version_id}` returns metadata only (`etag`,
  `handlers`, `compatibility_date`, `exports`, `cpu_ms`, `migration_tag`, etc.) — no
  content field. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
  So content/v2 (or the bare download endpoint) is the only documented content-bearing
  read path.
- A **beta** REST restructure (Worker/Version/Deployment as first-class resources,
  base64 JSON instead of multipart) was announced
  2025-09-03 (https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/)
  but no changelog entry confirms GA as of 2026-09-04 — status unresolved, check
  `/accounts/{account_id}/workers/workers/{id}` directly before depending on it.
- **No documented size/rate limit specific to the content-GET endpoints.** General
  Workers script size limits (3 MB gzip Free / 10 MB gzip Paid / 64 MB uncompressed)
  apply to storage/upload; not confirmed whether WFP namespace scripts differ.
  https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-09-03)
- **No Cloudflare doc anywhere (WFP config docs, how-it-works, dynamic-dispatch,
  Wrangler docs) describes or endorses the "Worker fetches its own bundle at runtime
  and re-uploads it as a dispatch-namespace script with different bindings" pattern.**
  It's composable from documented primitives but entirely unverified as a supported
  approach — no confirmation of multi-module completeness, no confirmation the
  re-upload would behave identically to an original wrangler-bundled deploy.

## 4. Dispatch binding fetch — reachability gate reliability

- `env.DISPATCHER.get(name).fetch(request)`: **every documented example forwards the
  original `request` unmodified** — no documented Host/URL rewrite step. But **what URL/
  Host the dispatched user Worker actually observes is never stated** on either the
  dynamic-dispatch or how-it-works page.
  https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
  (updated 2026-04-21)
- **Script-not-found is a *thrown JS exception* on `.get()`/`.fetch()`, not an HTTP
  response** — Cloudflare's own documented pattern is `try { ... } catch (e) { if
  (e.message.startsWith('Worker not found')) return 404 }`. An uncaught version becomes
  a Cloudflare-level 500, not a clean signal from the tenant Worker.
- **No documented statement that "fetch + 200" is a valid liveness/health gate.**
  Cold-start behavior for dispatched Workers is undocumented. A 200 only proves routing
  succeeded and the tenant Worker's handler returned 200 — it says nothing documented
  about binding/DB health inside that Worker unless its own `/health` handler checks
  that itself (which the current design already plans to do — good, since the gate's
  reliability rests entirely on that handler, not on the dispatch mechanism).

## 5. Cloudflare Workflows limits (for a `TaskWorkflow` orchestrating ~10–150 steps)

| Limit | Free | Paid |
|---|---|---|
| Max steps/instance | 1,024 | 10,000 default, up to 25,000 configurable |
| CPU time/step | 10 ms | 30 s default, up to 5 min configurable |
| Wall-clock/step | unlimited | unlimited |
| Total instance duration | unlimited | unlimited |
| Max step result size | 1 MiB | 1 MiB |
| Concurrent running instances | 100 | 50,000 |
| Instance creation rate | 100/s | 300/s account-wide, 100/s per workflow |
| Queued instances | 100,000 | 2,000,000 |

https://developers.cloudflare.com/workflows/reference/limits/ (updated 2026-06-15);
step-cap raise: https://developers.cloudflare.com/changelog/post/2026-03-03-step-limits-to-25k/
(2026-03-03); concurrency raise: https://developers.cloudflare.com/changelog/post/2026-04-15-workflows-limits-raised/
(2026-04-15).

- **~140 steps fits comfortably within both Free (1,024) and Paid (10,000) step caps.**
  On Free, the binding constraint is **10 ms CPU per step**, not step count — a single
  step doing a REST fetch + JSON parse can plausibly exceed that, so Free-plan use is
  the real risk, not Paid.
- Default retry config per step: `{ retries: { limit: 5, delay: 10000ms, backoff:
  "exponential" }, timeout: "10 minutes" }`, overridable per `step.do()`.
  https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ (updated
  2026-07-09)
- Cloudflare's own guidance: **"Do not do too much CPU-intensive work inside a single
  step — the engine may restart, and it starts over from the beginning of that step."**
  Recommends step timeouts ≤30 min. Supports the design choice of one `step.do()` per
  migration-file/REST-call rather than batching many calls into one step.
  https://developers.cloudflare.com/workflows/build/rules-of-workflows/ (updated
  2026-04-29)
- **Subrequests**: the flat 1,000-subrequest cap was removed 2026-02-11
  (https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).
  Current: Free 50 external + 1,000 internal per invocation; Paid 10,000 default, up to
  10M configurable. Workflows limits page tracks the same numbers. **Whether the
  subrequest counter is scoped per-step or per whole instance is not documented** —
  flag as unverified; the more defensible (but unconfirmed) reading is per-step, since
  each step runs as its own durable-execution invocation.
- Only "running" instances count against the concurrency ceiling; instances that would
  exceed it go "queued" rather than being rejected, up to the queued cap. Exact
  behavior/error at the queued-cap overflow itself is not documented.

## Feasibility flag for "Worker uploads a copy of its own bundle"

**Two separate undocumented gaps compound here, not one:**
1. Whether `GET .../content/v2` (or the download endpoint) returns *all* modules of a
   multi-module worker in a re-uploadable shape is unconfirmed — no doc states the
   response format or multi-module completeness.
2. Whether a user Worker in a dispatch namespace can own its own Durable Object
   class/migration, and whether Workflows can attach to a user Worker at all
   (**effectively no — no `workflow` binding type exists in the upload schema**), are
   both either undocumented (DO) or unsupported per docs (Workflows).

**Recommendation:** don't build the provisioner around runtime self-fetch-and-republish
of the dispatcher's own bundle. **Fallback: CI publishes the per-tenant user-Worker
bundle (a fixed, small, DO-free, Workflow-free script — D1/KV/plain-text bindings only,
which ARE fully documented and already working per `uploadUserWorkerToDispatch`) to R2
per release SHA**, and the provisioning Workflow (which itself lives in the *parent*
dispatcher Worker, not in any tenant script) fetches that known-good bundle from R2 and
PUTs it to the dispatch namespace. This sidesteps both undocumented gaps entirely: no
self-referential content-read is needed, and the tenant script never needs its own DO
class or Workflow — any stateful/orchestration need for a tenant is served by the
*parent* Worker's own DOs/Workflow instead, addressed with `TENANT_SLUG`.

For the D1 migration chain specifically: use the documented `/import` polling API
(§1) on a single concatenated SQL file, not per-file `/query` POSTs — it has an
explicit 5 GiB ceiling (516 KB is nothing) and is Cloudflare's own documented bulk-load
path, versus the multiple genuinely-undocumented limits (body size, statement count,
REST-path atomicity) on repeated `/query` calls.
