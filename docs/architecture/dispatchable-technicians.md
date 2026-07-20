# Dispatchable Technicians — governed heterogeneous agent labor

**Status:** Shipped (preview), 2026-07-20. Code: `scripts/cursor-worker.py`.
Depends on the task self-close gate (PR #417) and the MCP-client connect flow
([connect-mcp-client.md](../connect-mcp-client.md)).

## The one-line significance

**mupot can now safely use *any* agent — cheaper, faster, a different vendor,
externally hosted — as verified, dispatchable labor, without trusting it.** The
pot gates the output; the agent is *verified, not trusted*. That is the whole
operations-layer thesis made concrete.

## What was proven

A mupot task can be dispatched to a **headless third-party agent** (here: the
`cursor` agent = xAI Grok via Cursor CLI, ~$2/$6 per M tokens), which does the
work in isolation and returns a **PR that a governed gate must approve** before it
merges. The agent cannot mark its own work done. First live run: a dispatched task
→ Grok wrote correct, domain-aware tests → verified green → PR #419 → task in
`review` for the Kasra gate. No human in the execution loop; a human/Kasra only at
the gate.

```
mupot task (assignee = a technician agent)
   │  poll + claim (→ in_progress)
   ▼
isolated git worktree  ──►  headless agent (cursor-agent -p --force, mupot MCP available)
   │                              writes code, commits — never pushes, never merges
   ▼
TRUSTED driver: verify (must commit + tsc clean — no fake-green) → push → open PR
   │
   ▼
task → review (gate_owner set)  ──►  Kasra-core / human GATES the PR  ──►  merge → done
```

## Why it's safe — the composition, not the agent

The safety is **structural**, not a matter of the agent behaving:

1. **No self-close (PR #417).** An assignee agent cannot transition its own task to
   `done` from any done-reachable state — its work is *forced* through
   `review → gate → done`. So a dispatched technician's output is gated by
   construction. (This hole was found live when a dispatched agent marked a task
   `done` with zero work; it took four adversarial gate rounds to close provably.)
2. **Least privilege.** The agent writes code in an isolated worktree and never
   touches the remote. The *trusted driver* pushes and opens the PR; the agent
   holds only a `member`-scoped pot token.
3. **Verify, not trust.** The driver refuses to deliver unless the agent actually
   committed and `tsc` is clean — a self-reported "done" is never evidence.
4. **Isolation.** One git worktree per task — no two agents share a checkout (a
   collision lesson learned the hard way this session).

Because of (1)–(4), the *trust model inverts*: you don't need a trustworthy agent,
you need a trustworthy **gate**. That lets you reach for the cheapest/fastest agent
that can do the job and let the pot enforce correctness.

## Why this matters (the thesis)

- **mupot is the governance layer for AI labor.** Any MCP-speaking agent —
  Claude, Grok, Codex, a customer's own — becomes dispatchable, gated labor under
  one pot. Heterogeneous, multi-vendor, multi-model work with a single audited
  control plane.
- **It unlocks the economics.** A Grok technician at ~$2/$6-per-M producing
  *gated* PRs is cheap labor made safe by governance — exactly the margin the
  reseller/agency model needs (cheap execution + trustworthy gate = the operated-
  presence value). See [sovereign-core-operated-presence.md](sovereign-core-operated-presence.md).
- **It generalizes the "receipts not grades" law.** The pot stopped trusting
  self-reported completion and started requiring a gated receipt. That is the
  minimum viable property for *any* autonomous multi-agent system that isn't a
  liability.

## How to run it

```bash
# one task (default), dry-run first
DRY_RUN=1 python3 scripts/cursor-worker.py
python3 scripts/cursor-worker.py

# knobs (env): MAX_TASKS, TIMEOUT, MODEL, SANDBOX=1 (untrusted tasks),
#              GATE_OWNER, CURSOR_AGENT_ID, REPO
```

The technician picks up tasks assigned to its agent id on the pot, in status
`open`. It delivers each as a PR and moves the task to `review`. Kasra-core (or any
gate-owner) reviews the PR — diverse-model adversarial gate for security-core
surfaces — then merges and verdicts the task closed.

## What's next (follow-ups, not done)

- Run the driver as a cron/systemd loop → a standing technician, not one-shot.
- `--sandbox enabled` by default once the tool surface it needs is confirmed to
  work sandboxed (required before pointing a technician at untrusted/customer work).
- Evidence-required `done` at the pot layer (task = ATC, #22) — the fuller gate
  beyond no-self-close.
- Multiple technicians of different models on one board; route tasks by
  cost/capability (cheap technician for mechanical, Opus for the hard reasoning).
