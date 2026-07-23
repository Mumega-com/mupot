# Editable RBAC content + agent-accessible docs — comparables research (2026-07-23)

**Question:** given Inkwell's tiered-MDX (`tier`: public/squad/project/role/entity/private, `src/content.config.ts:4-14`) + our MCP + Cloudflare D1, is there OSS worth adopting for (a) web-editable content with RBAC, (b) field/block-level RBAC, (c) agent-scoped programmatic access — or do we extend what we have?

All findings below verified 2026-07-23 via GitHub push-activity + official docs (not memory/pretrained knowledge).

## 1. Editable-website / headless CMS with RBAC

| Tool | RBAC model | Deploy fit | Verdict |
|---|---|---|---|
| **Keystatic** | None beyond GitHub repo write access | Needs Node for API routes (GitHub-mode auth proxy) | Weaker than Inkwell's `tier` field |
| **TinaCMS** (self-hosted) | You implement it yourself in a custom auth provider; not shipped granular | Needs a running Node backend function | Weaker than Inkwell |
| **Outstatic** | None — GitHub OAuth write access only | No DB, commits MDX via GitHub API | Weaker than Inkwell |
| **Decap CMS** | None — delegates to git host permissions | Static-friendly | Weaker; also flagged poorly-maintained under new ownership |
| **Sveltia CMS** | None (same git-permission model) | Static-friendly, actively developed successor to Decap, still beta (GA late 2026) | Weaker than Inkwell on RBAC, but worth watching as Decap replacement |
| **Payload CMS 3.x** | Real, granular — collection + **field-level** access functions, boolean allow/deny, evaluated per request | "Optimized for a persistent Node process"; a `with-cloudflare-d1` template exists but needs workarounds + Workers Paid plan | Best RBAC model of all 6, worst fit for our no-Node-server constraint |
| **Directus** | Real, deep — role → policy → collection/row/field permissions, field CSV allow-list | Docker image, needs persistent server + Postgres/MySQL | Best granularity, confirmed does NOT fit Cloudflare-native |

**Bottom line:** none of the git/MDX tools beat what Inkwell already has (all reduce to "git write = edit everything"). The two tools with real granular RBAC (Payload, Directus) both force a persistent Node server + real DB — a poor fit. **Nothing here is a drop-in adoption; their access-control *patterns* are worth borrowing, not the tools themselves.**

## 2. Field/block-level content RBAC

| System | Granularity | Mechanism |
|---|---|---|
| **Payload** | Genuinely field-granular | `access.read` function per field; failing field is omitted server-side from the response |
| **Directus** | Genuinely field-granular | Policy `fields` CSV allow-list + `read_field_blacklist`; server-side response filtering |
| **Sanity** | Document/dataset-level only | No block-level primitive; custom roles are Enterprise-only; block-level would require hand-rolled tagging + app-side filtering |
| **Postgres RLS** | Row-level, not attribute-level (column masking is a separate `GRANT`/view mechanism) | Useful as the *conceptual* analog: a block = a row, `tier` = the row predicate |
| **OSS remark/rehype MDX block-RBAC plugin** | **Does not exist** — searched specifically, no packaged library found | Confirmed gap |

**Cleanest buildable model for Inkwell:** extend the single document-level `tier` field down to block granularity via a remark-directive (`:::tier{squad}` ... `:::`) or an MDX component (`<Tier require="squad">`), stripped server-side (Astro build step or edge Worker) before the tree reaches the client/agent — the direct MDX analog of Postgres RLS's per-row predicate, applied per-block. This is genuinely novel work (no OSS to lean on) but small in scope: one remark plugin.

## 3. Agent/programmatic RBAC (ReBAC/ABAC engines)

| Engine | Deploy model | Verdict |
|---|---|---|
| **OpenFGA** (CNCF) | Standalone Go server; Postgres/MySQL/SQLite; JS SDK confirmed non-edge (depends on Node `http`, open issue openfga/js-sdk#72) | Requires persistent server + DB — doesn't fit without extra infra |
| **Ory Keto** | Go server; production docs require Postgres/MySQL/CockroachDB (SQLite explicitly non-prod) | Requires persistent server + DB — doesn't fit |
| **SpiceDB** | Recommends CockroachDB/Postgres 15+, K8s Operator deploy | Requires persistent server + DB — doesn't fit |
| **Cerbos** | Base OSS PDP is stateless/DB-less (YAML policy files); **Cerbos Hub ships a WASM embedded PDP explicitly built to run inside edge/serverless runtimes, in-process, no round trip** | **Fits Cloudflare-native edge/Workers** — the one outlier built for exactly this topology (WASM embed is a Hub/commercial feature; plain OSS server is DB-less but still a separate process to host) |
| **D1 row-level isolation** | No native RLS; no mature OSS library for it. Realistic pattern = Worker-middleware enforced `tenant_id`/`tier` predicate on every query ("a discipline problem disguised as a technical solution" — *Architecting on Cloudflare* ch.23). DB-per-tenant is the alternative for higher-sensitivity isolation. | Hand-roll it |
| **MCP authorization spec (2026 revision)** | Servers are OAuth 2.1 resource servers; spec ships only coarse scopes (`mcp:tools`/`mcp:prompts`/`mcp:resources`) — granularity gap is called out by multiple 2026 vendor writeups (WorkOS, getmaxim.ai) | Fine-grained "tier≤squad, write-only-Y" enforcement must be built on top — per-tool-call scope check in the Worker/gateway in front of the MCP server |

## Composite answer — no single project does all three

There is **no OSS project that already does "editable RBAC content + agent-accessible."** The realistic path is composition, and even the composition pieces are mostly things we build, not adopt:

- **(a) Extend Inkwell, don't replace it.** The git/MDX CMS field is strictly worse than what we have on RBAC; none justify a swap.
- **(b) Add a policy-decision layer, not a Zanzibar server.** Of OpenFGA/Keto/Cerbos/SpiceDB, only **Cerbos** (via its WASM embedded PDP) avoids a persistent server + Postgres — the other three would force exactly the infra dependency we're avoiding. Cerbos's free OSS DB-less server is a fallback if the WASM/Hub path doesn't pencil out, but it's still a process to host.
- **(c) Field/block RBAC is greenfield.** No OSS exists for MDX block-level access control; write a small remark plugin extending the existing `tier` frontmatter pattern to per-block directives, enforced server-side (never client-side, per the existing `feedback_authz_portable_authn_delegated` decision — AuthZ stays app-layer/portable).
- **(d) Agent access rides the same enforcement, not a parallel one.** MCP's own auth scopes are too coarse (confirmed spec gap); gate MCP tool calls through the same policy check (Cerbos or hand-rolled) that gates human web reads — one decision point, two callers (human session, agent token), not two RBAC systems.

**What doesn't fit and should be flagged/avoided:** Payload and Directus (force Node server + Postgres/Mongo), OpenFGA/Keto/SpiceDB (force a persistent server + Postgres-class DB), Sanity Enterprise custom roles (paid tier, still document-level only). All four violate the Cloudflare-native / no-forced-Postgres constraint.

**Lightest path to "human-editable, RBAC-scoped, agent-accessible project docs":** (1) keep Inkwell's git+MDX+Zod `tier` field as the document-level gate — already portable, already works; (2) add one remark-directive plugin for block-level tiers inside a document, enforced at Astro build/edge-render time; (3) put a single policy-decision point in front of both the web reader path and the MCP tool-call path — start with hand-rolled Worker middleware (cheapest, zero new infra) and evaluate Cerbos's WASM embedded PDP only if policy complexity grows past what a middleware function can hold; (4) agent tokens carry the same `tier`/role claims as human sessions so one enforcement function serves both — no parallel "agent RBAC" system needed.

## Sources
- Keystatic: keystatic.com/docs/github-mode, github.com/Thinkmill/keystatic
- TinaCMS: tina.io/docs/self-hosted/overview, tina.io/docs/reference/self-hosted/auth-provider/tinacloud
- Payload: payloadcms.com/access-control, payloadcms.com/docs/access-control/fields, github.com/payloadcms/payload/tree/main/templates/with-cloudflare-d1
- Directus: directus.com/docs/guides/auth/access-control, directus.com/docs/api/permissions
- Outstatic: outstatic.com, github.com/avitorio/outstatic
- Decap/Sveltia: decapcms.org/docs/backends-overview, sveltiacms.app/en/docs/successor-to-netlify-cms, github.com/sveltia/sveltia-cms
- Sanity: sanity.io/docs/content-lake/roles-concepts, sanity.io/docs/developer-guides/restrict-access-to-specific-documents
- Postgres RLS: satoricyber.com/row-level-security/row-level-security-101
- OpenFGA: github.com/openfga/js-sdk/issues/72, openfga.dev/docs/getting-started/setup-openfga/configure-openfga
- Ory Keto: ory.sh/docs/keto/guides/production
- Cerbos: cerbos.dev/features-benefits-and-use-cases/wasm-embedded-pdp, cerbos.dev/news/announcing-cerbos-hub-public-beta
- SpiceDB: authzed.com/docs/spicedb/concepts/datastores
- D1/RLS pattern: architectingoncloudflare.com/chapter-23, github.com/nileshtrivedi/turso-row-level-security-demo
- MCP auth: modelcontextprotocol.io/specification/draft/basic/authorization, workos.com/blog/mcp-authorization-patterns-per-tool-scopes, getmaxim.ai/articles/mcp-rbac-tool-level-permissions-for-production-ai-agents

## Prior internal decisions this builds on
- `feedback_authz_portable_authn_delegated` — AuthZ stays app-layer/portable, never outsourced; only coarse perimeter auth is delegatable. Confirms Cerbos-as-policy-layer (not Cerbos-as-identity-provider) is the only shape that fits.
- `feedback_cms_as_addon_uniform_port` — CMS backends are pluggable addons behind one uniform port; each CMS owns its own RBAC, mupot owns the gate/approval/receipt layer above. Consistent with "one policy decision point serves both web and MCP paths."
