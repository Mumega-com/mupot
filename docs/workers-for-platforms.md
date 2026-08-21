# Workers for Platforms — one pot per org

The plan for hosted mupot: a **dispatch namespace** holding one **user Worker per pot**,
each with its own D1 and KV, fronted by a single **dispatch Worker** that routes
`<org>.mupot.mumega.com` to the right one.

This page records what is **verified**, what is **quoted from Cloudflare's docs**, and what
is **unknown** — kept separate on purpose. Two of tonight's worst errors came from an
inference reported as a fact.

Design case: `mumega.com/agents/river/governance/case-2026-08-11-mupot-onboarding-workers-platforms.md`.

## Why per-org, not one shared pot

`TENANT_SLUG` is **one value per Worker**. A shared pot has no second tenant to put anyone
in — every customer would land in the same org tree as the colony's own agents.

That is not a policy gap to patch later. Every defect found in the `bootstrap_self` review
is *contained* in a per-org pot and *colony-wide* in a shared one:

| Defect | Per-org pot | One shared pot |
|---|---|---|
| Caller-chosen agent slug | squats their own pot | **any customer squats `kasra`** → `resolve()` ambiguous, `getFleetAgentRuntime` → `''`, and `deactivate_agent` skips the slug-keyed key delete (revocation bypass) |
| Plan-counter bypass | inflates their own counts | unlimited free everything, on our bill |
| Plan ceilings | metered per customer | one ceiling for the whole world |

**`mupot.mumega.com` is the colony's own pot, not the product.** The product is
`<org>.mupot.mumega.com`.

## Verified hands-on

Run against wrangler 4.102–4.119 on this host, 2026-08-12. Not quoted from docs.

```
wrangler dispatch-namespace list | get <name> | create <name> | delete <name> | rename <old> <new>
wrangler deploy --dispatch-namespace <name>      # exists
wrangler versions upload                          # does NOT accept it — no staged rollout
```

Dispatch Worker binding, validated by `wrangler deploy --dry-run`
(→ `env.DISPATCHER (mupot-pots)  Dispatch Namespace`):

```toml
[[dispatch_namespaces]]
binding = "DISPATCHER"
namespace = "mupot-pots"
```

Runtime: `env.DISPATCHER.get(name, {}, { limits: { cpuMs, subRequests } }).fetch(request)`.

**Account state:** WFP is entitled and **zero dispatch namespaces exist**. Verified two
ways — `GET /accounts/{acct}/workers/dispatch/namespaces` returns `[]`, and no
`dispatch_namespaces` binding appears in any of the 8 `wrangler*.toml` in this repo. Green
field; there is no estate to migrate.

**`caches.default` is disabled inside a dispatch namespace.** Grepped `src/` for
`caches.default` and `caches.open` — **zero hits**, so we are clean. It would have failed
silently on the first namespaced deploy.

## Quoted from Cloudflare's docs

Pricing and limits pages, read 2026-08-12.

| | |
|---|---|
| Plan | **$25/mo self-serve**, dashboard purchase — **not** Enterprise-only |
| Included | 20M requests, 60M CPU-ms, 1,000 scripts |
| Overage | $0.30 / additional million requests · $0.02 / additional million CPU-ms · $0.02 / additional script |
| Billing across the chain | *"only charges for 1 request across the chain of dispatch Worker → user Worker → outbound Worker"* (CPU counts across all three) |
| Duration | *"No charge or limit for duration"* |
| CPU per invocation | **30 s** standard — **15 minutes** for Cron Triggers and Queue Consumers |
| Scripts | *"Cloudflare provides an unlimited number of scripts"* — 1,000 is a **billing threshold, not a cap** |
| Durable Object namespaces | *"do not have a limit"* |
| Tags | max **8 per script** |
| API | 1200 req / 5 min per token · 200 req/s per IP · **account API token quota 500** |

Per-user-Worker bindings are documented as isolated by construction: *"Each User Worker can
only access the bindings explicitly attached to it."*

## The real ceiling is KV

```
KV namespaces      1,000 per ACCOUNT   (same on Free and Paid)
mupot declares     2 per pot           (SESSIONS, OAUTH_KV)
                   ─────────────────
ceiling            ~500 pots
```

**Money is not the constraint; a platform quota is.** No amount of credit buys pot #501.

D1 is a non-issue — 50,000 databases per account, 10 GB each.

Two fixes, and the cheap one is cheap **now**: collapse to one KV per pot with prefixed
keys (→ ~1,000 pots), and file a Cloudflare limit-increase request. Doing the collapse
before the provisioner is written is a config change; doing it at 400 pots is a migration.

Note the **account API token quota of 500** lands on the same number for an unrelated
reason. Any design that mints a token per pot hits it at the same point.

## Constraints that shape the provisioner

**No bulk-update API.** Rolling a code change to N pots is your own scripted per-script
`PUT` loop. Tags support bulk *discovery and deletion*, not push. Design the rollout
mechanism as part of the provisioner, not after it.

**No staged rollout either** — `versions upload` does not accept `--dispatch-namespace`.
Verified above. There is no gradual-deployment safety net for user Workers.

**Two ways to attach per-pot bindings**, and they differ in kind:

1. **REST** — `PUT /accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{name}`,
   multipart, with `metadata.bindings: [{type:"d1",…},{type:"kv_namespace",…}]`. Inline,
   no config file. **Primary for a provisioner.**
2. **CLI** — `wrangler deploy --dispatch-namespace`, reading a generated per-pot
   `wrangler.<slug>.toml`. This is what `plugin/tools.py` already does (see the existing
   `wrangler.alpha/.house/.digid.toml`). Works, but means N config files on disk.

**Server-derive every slug.** Pot, department, squad and agent slugs must come from the
server, never from caller input — the same primitive that closed the slug-squatting
finding in `bootstrap_self`. A caller-chosen identifier in a multi-tenant registry is an
addressing DoS.

**Outbound Workers** sit between a tenant Worker's `fetch()` and the internet — the
egress-audit lever for the isolation gate. They do **not** intercept Durable Object calls
or mTLS fetches.

**Routing:** wildcard zone route `*.mupot.mumega.com/*` on the dispatch Worker, parse the
hostname label, `DISPATCHER.get("mupot-" + slug)`.

## Not stated in the docs — ask, do not assume

I did not find any of these written down: dispatch namespaces per account, user Workers per
namespace, script size inside a namespace, subrequest and startup limits for a namespaced
script, or bindings per Worker. The limits page covers platform constraints rather than
per-Worker execution.

General Workers limits most likely apply. That is a reasonable guess and it is **not** a
verified fact — treat it as an open question for Cloudflare.

## A lead worth testing, not a conclusion

The **15-minute CPU ceiling for Cron Triggers and Queue Consumers** (vs 30 s standard) is
interesting against the long-running-agent problem: today long digests die at roughly 111 s
median under prime-agent. Fifteen minutes is two orders of magnitude of headroom, and
duration is neither billed nor bounded.

This has **not** been tested. It is recorded as a lead because a plausible mechanism that
explains a symptom is not the same as the cause — a lesson this repo learned expensively in
mupot#919.
