# mupot Substrate Contract (the standard)

> The canonical pattern for how a mupot is built so it is **safe, swappable, forkable, updatable, and sovereign.**
> Status: v0 draft, 2026-06-16. Dogfood reference = the mumega pot. Sets the standard every pot (viamar next) inherits.
> Companion: [posthog-lessons.md](./posthog-lessons.md) (grounded research the isolation model is built on).

## Why this exists
Tenants must be able to **develop alongside us** — build their own roles experience + comms channel — without (a) breaking the core, (b) breaking each other, or (c) losing the ability to pull our security updates. This contract is the boundary that makes that safe. It is the anti-`resident-cms`: *coherence is not imported* — the core never imports tenant code, tenant code never edits the core.

## Three layers

```
┌─────────────────────────────────────────────────────────┐
│  CHILD OVERLAY  (tenant-owned)                            │  ← roles experience, comms channel,
│   runs as a metered CHILD WORKER, through sealed ports    │     admin panels. Per-tenant. Forkable.
├─────────────────────────────────────────────────────────┤
│  KERNEL PORTS  (parent-sealed, VERSIONED contracts)       │  ← brain · pub/sub · memory · model ·
│   the LEGO sockets — implementation-agnostic interfaces   │     storage · auth · comms
├─────────────────────────────────────────────────────────┤
│  DEFAULT ADAPTERS  (parent-owned)                         │  ← CF Queues, D1, Vectorize, Workers AI,
│   our bricks behind each port — swappable (BYO)           │     Google OAuth … swap per tenant/tier
└─────────────────────────────────────────────────────────┘
```

- **Parent core (we own):** kernel ports + default adapters + the platform experience + security. Sealed.
- **Child overlay (tenant owns):** their roles/comms/admin experience, built ONLY against the ports. A fork (WP child-theme): customize the child, never the parent; `mupot update` merges parent security fixes — clean, because the tenant never touched core.

## Kernel ports (LEGO sockets — swap the brick, keep the socket)
Each port is a sealed interface with a **version**. Default adapter is ours; a tenant/tier may swap it (BYO).

| Port | Contract (verb sketch) | Default adapter | Swappable to |
|---|---|---|---|
| brain | `decide(state) → ranking` | sovereign brain (#70) | YC-CEO brain, BYO |
| pub/sub | `publish(event)` / `subscribe(handler)` | CF Queues (+ overflow/DLQ) | Redis, NATS, … |
| memory | `recall(q)` / `remember(x)` | Vectorize + D1 | BYO vector store |
| model | `complete(prompt)` | Workers AI | BYOK (OpenAI/Anthropic/…) |
| storage | per-tenant `get/put` | D1 + KV + R2 (per-pot) | — (always tenant-scoped) |
| auth | session / capability | pot OAuth + RBAC | (sealed — see invariants) |
| comms | `send(channel, msg)` | bus / Telegram / WhatsApp | tenant's main channel |

**Versioning (the trap PostHog hit — we avoid it):** the child manifest declares `mupotPortVersion: "1"`. Additive port changes are safe (old overlays keep working). Breaking changes bump the version AND ship a **migration shim** in the parent, so `mupot update` never silently breaks a live overlay. Declaring the version now costs nothing; omitting it costs a migration sprint later.

## Overlay isolation (how tenant code runs without breaking anything)
Lessons stolen from PostHog's HogVM, translated to Cloudflare:

1. **Child Worker, never inline eval.** Overlay code runs in its own Worker (dispatch namespace + service binding), V8-isolated from core, with explicit `limits.cpu_ms` + the 128MB memory ceiling. The core Worker never `eval`s tenant code.
2. **Sealed network port — no raw `fetch`.** Overlays call `env.NETWORK_PORT.fetch(url, opts)` — a parent-controlled proxy enforcing per-tenant domain allowlists + rate limits. The overlay never holds a raw fetch reference (PostHog's "separate fetch service" pattern).
3. **No direct storage.** Overlays touch KV/D1 only through sealed storage-port calls (tenant-scoped) — never a raw binding.
4. **Pre-deploy validation.** `validate_overlay()` runs before activation — rejects obvious infinite loops / contract violations.
5. **Immutable inputs.** Hooks receive frozen inputs, return transformed outputs; no global mutation.

## Sealed vs open (the one-way door)
- **SEALED (parent-only, overlay can NEVER reach):** auth + session minting, capability/RBAC enforcement, the bus seam, cross-tenant isolation, the port contracts themselves. A tenant cannot weaken these even with malicious overlay code.
- **OPEN (overlay owns):** roles experience, admin panels, comms-channel logic, adapter *choice* (which brick behind a port, within tier).

## Invariants
1. **Per-tenant storage by construction.** Separate D1/KV/R2 per pot — never shared tables with a `tenant_id` column (PostHog's shared-ClickHouse adjacency risk). Cross-pot isolation is the deployment boundary (mupot-viamar ≠ mupot).
2. **Feature parity: managed == sovereign.** The parent core is identical whether mumega runs the CF account (managed) or the tenant does (sovereign fork). The difference is operational, not functional. No cloud-only feature drift (PostHog's mistake).
3. **Sealed ports survive bad bricks + bad overlays.** Swapping an adapter or shipping buggy overlay code can degrade the tenant's OWN pot — never auth, isolation, or another pot.
4. **Upstream-mergeable.** The overlay never edits core files → `mupot update` (parent merge) is always clean.
5. **Access-follows-dock.** Working in a pot = an attached, scoped, revocable session (the dock model). Detach = access gone. The tenant always holds the airlock.

## Ops trip-wires (from PostHog self-host post-mortem)
- Generate a random `POT_SECRET` at `mupot init`; **fail loud on a default value.**
- No hardcoded service URLs — CF service bindings are name-resolved.
- Pub/sub: overflow + dead-letter queue wired from day one (one bad overlay can't stall ingestion).

## Build sequence (dogfood-first)
1. This contract doc (here) + the PostHog reference brief.
2. Carve the core↔overlay boundary in code; designate the **first ports** (start with the two closest to swappable: **model + brain**) with `mupotPortVersion: 1`.
3. `mupot update` (upstream sync) so any fork can always pull parent security.
4. Reference **child overlay on the mumega pot** (a role-based admin section) — the proof.
5. viamar forks + fills its roles/comms overlay against the sealed ports.
