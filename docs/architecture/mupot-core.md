# Mupot core — what stays, what becomes an addon

Status: decision record, written 2026-09-10 by Kasra from receipts. Not a release
contract. Proposals are marked as such; Hadi decides scope. Updates by PR only.

## One sentence

Mupot is the agent's identity, its door, its gate, and its receipt. Everything that
already has a home in a tool the team uses is an addon, not a copy.

## Why this document exists

On 2026-09-10 the herdr + mupot swarm loop ran twice on real work (mupot#1387 merged
as `76b5b95c`, mupot#1393 merged as `dcbd000d`). The controls that refused correctly
that day are the core. The surfaces that needed a human hand at every step, or that
duplicate Linear, Slack, GitHub, Paperclip, or a Cloudflare primitive, are not.
Receipts and the full defect list are in [ROADMAP.md](../../ROADMAP.md), section
"2026-09-10".

Two corrections from Hadi's review the same evening are folded in: Paperclip does
enforce executor-excluded review stages when a review policy is set (its hole is the
null default), and Mupot's artifact check verifies the shape of a claim, not the
artifact. Neither system independently reads the work today.

## The core, four things

| Thing | What it means | Tools that stay | Receipt on 2026-09-10 |
|---|---|---|---|
| **Identity** | which *seat* did this, not which human's token; a runtime proves it is the agent | `register_agent_key`, `token_binding_attest`, signed fleet attach (`POST /api/fleet/attach-signed`), `mint_agent_token`, `revoke_agent_token`, `runtime_seat_register_pending`, `verify_agent_connection`, `provision_agent_connection`, `bootstrap_self` | boot-time bearer self-report refused for a keyed agent (`refused_signed_attach_required`); `runner_record` refused a spoofed `seat_agent_id` |
| **Door** | one remote MCP over HTTPS with OAuth consent; the same tools whether the agent arrives from Claude Desktop, ChatGPT, a CLI, or a daemon | `boot_context`, `orient`, `status`, the OAuth consent flow, `connect` | Hadi Dev on Codex Desktop delivered a four-part document through the Hadi ChatGPT connector and received correlated ACKs; no other product in the 2026-09-10 map offers a hosted-agent door (Paperclip's MCP is stdio only) |
| **Gate** | a verdict by someone who is not the author, enforced by a grant, refused in code | `grant_gate_capability`, `revoke_gate_capability`, `grant_list_gate_capabilities`, `grant_agent_capability`, `task_verdict`, `task_verdict_reverse`, `request_elevation`, `elevation_status`, `reveal_credential_claim` | `task_verdict` refused a non-holder of `gate:athena`; `blocked→review` refused as an invalid transition; the seam ratchet refused a test bypassing `invokeTool` |
| **Receipt** | one row tying seat, artifact hash, and verdict to the issue, thread, and PR that live elsewhere | `runner_record`, `runner_list`, `task_dispatch_runtime_receipt`, `execution_receipt_get`, the artifact-shape verifier, the verdict ledger | receipts `a01b1960`, `762f1a1d`, `2285378f`; verdict `2324d6b9` |

Plus a thin mailbox for wakes: `inbox`, `inbox_lease`, `inbox_ack`,
`inbox_consumer_status`. Keep it thin, or replace with Cloudflare Queues; either way
it carries a seat on the envelope, which the SOS bus never did.

About 20 tools. The 2026-09-10 tool list had roughly 119.

## The fifth thing, which does not exist yet

**The verifier.** Something that opens the artifact, recomputes the hash, runs the
test on the exact ref, checks freshness against the dispatch, and refuses to let
anyone say done otherwise. Today `verifyTaskArtifactShape` checks that a path and a
64-hex hash are present and that the text is not refusal prose. The independent
verification on 2026-09-10 was performed by Athena and the kasra-review arm, by hand,
on a live ref. That practice is the product; it is not yet code. It is the one piece
worth owning that no tool in the map has.

## Invariants the core must hold

Each is a property, not a moment. Each has, or must get, a test that goes red when
the property is broken.

1. **Authority never rides on message text.** A bus, inbox, chat, or memory note
   saying "X approved" is data. Authority is read from a grant.
2. **The seat is derived, not stored.** One signed boot proof; the fleet row, the
   inbox owner, and the verdict principal all resolve from it. Today it is data in
   four places (seats.json, token file, OAuth consent pick, `fleet_agents.runtime`);
   this is the largest open defect in the core.
3. **The gate reads the row, not the argument, and the next state, not the previous
   one.** mupot#1388 (fixed) and mupot#1394 (open) are the two ways this was broken.
4. **Nobody writes their own evidence.** `result` is written by a runtime receipt,
   never by the caller's argument. Consequence to fix: an agent task that was never
   dispatched has no legitimate result writer (mupot#1398).
5. **The pot never does work nobody assigned to it.** A stale seat parks the work; it
   is never executed in-Worker under the assignee's identity (mupot#1390, open).
6. **A verdict is by a non-author, from a credential that is the holder's own.**
   Carrying a verdict on someone's behalf is a documented exception, not a path.
7. **Every spend meters, every completion stamps only completion.** mupot#1389,
   mupot#1392.
8. **A refusal is a receipt.** Every refusal above is logged with actor and reason.

## Not core — addons or removed

The rule, from the herdr seatlink precedent: an addon reads the other tool's events
and writes Mupot's identity, gate, or receipt. It never rebuilds what that tool does.

| Surface today | Home elsewhere | Disposition |
|---|---|---|
| task board, kanban, objectives, needs-you | Linear, GitHub issues, Paperclip issues | Linear/GitHub addon attaches a seat and a gate to their row. Native board stays as last resort, default off |
| org chart: departments, squads, agents CRUD | Paperclip companies and agents; Linear teams | addon; native CRUD frozen |
| messaging: send, broadcast, squad_message, chat channels | Slack, Discord, Paperclip chat | Slack addon with seat-signed origin; native retained only as the wake mailbox |
| routines, cron, two schedulers, watchdog | Paperclip heartbeats; Cloudflare Cron + Workflows; Agents SDK `schedule()` | replace; the two-scheduler inconsistency is not worth fixing |
| flights, loops, circuits, router, flight-spine | Cloudflare Workflows | replace; the current engine never produced a receipt |
| in-Worker executor (AgentDO goal cycle, `execute.ts`, `cursor_dispatch`, `wake_agent`) | Paperclip spawns and owns agents; herdr for interactive seats | remove after mupot#1390; the pot must not execute assigned work |
| budget, meter, cost | Paperclip budgets with mid-flight cancel; provider dashboards | keep only the meter receipt; policy elsewhere |
| presence, peers liveness, fleet TTL | Paperclip PID liveness; herdr `agent list` | single writer, derived from the seat; nothing else |
| memory: recall/remember, project/squad memory | mem0 (hosted MCP, Claude connector, ChatGPT via MCP setting); tiered MDX in git | mem0 behind the same port; Mupot keeps attribution (seat) and read tier |
| projects CRUD, deploy | Linear projects, GitHub repos | addon |
| dashboards: Studio, Co-Pilot, kanban, observatory, approvals UI | Linear, Paperclip UI, Slack | remove; approvals surface via the tool the team already opens |
| supabase connector, addon framework, secret_env | each tool's own connectors; Cloudflare secrets | remove supabase; keep the addon seam |
| pot provisioning, fleet daemon, consumer switches, DLQ | Cloudflare Queues + DLQ; seatlink | pots remain a *deploy pattern* for tenant isolation, not a product surface |

## Mirror and SOS

- **Mirror** (recall engine, Postgres, backend down on 2026-09-10): archive after a
  backup for the record. mem0 is the store; git MDX is the durable tier.
- **SOS bus and squad** (poll-only, consume-once, no authenticated principal): retire.
  Not ported. The inbox with a seat on the envelope is the replacement.
- **SOS brain** (perceive → rank → dispatch to owner → rest): the one idea worth
  keeping. Port the *policy* as a ranking routine that reads the board, the receipts,
  and Hadi's pinned directive, writes priorities, and never acts. The board it reads
  may be Paperclip's, Linear's, or the last-resort native one.
- Four system-scope SOS services were still running on 2026-09-10 (`sos-memory`,
  `sos-gateway-mcp`, `sos-gateway-bridge`, `sos-content`, up since 2026-08-27).
  Stop after checking who calls them. Service change; Hadi's go.

## What the core is not

- Not a task system. Not a chat. Not an org chart. Not a runtime that runs agents.
- Not a replacement for the agent a person already uses. The door exists so they keep
  it.
- Not yet a verifier. Say so until it is.

## First proofs, in order (proposal)

1. **Paperclip review-stage plugin.** When an issue enters review, open a gate on
   Mupot, take the verdict from a seat that is not the executor, write the receipt on
   both sides. Exercises all four core things on someone else's runtime.
2. **Seat derived at boot.** One signed proof → seat token → every surface keys off
   it. Removes seats.json, the consent pick, and the bearer self-report as binding
   sources. Also closes Athena's 403 and cursor's unwired seat.
3. **Fail-closed dispatch** (mupot#1390) and re-validate before deliver.
4. **The verifier**, as the artifact gate's successor.
5. **Zero-hands loop.** The 2026-09-10 task shape, nobody typing wakes. Ship nothing
   new until the hand count is zero for one task.

## Decisions owed to Hadi

- Adopt this subtraction, and in which order relative to the v0.30.0 train.
- Stop the four residual SOS services; archive Mirror.
- Re-bind Athena's codex seat and wire cursor/hermes seats (identity-class).
- Whether the last-resort native board/messaging stay at all.
