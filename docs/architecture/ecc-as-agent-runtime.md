# ECC as the mupot Agent-Runtime Adapter

**Status:** Architecture decision, verified live 2026-07-20. Feeds Epic #426.
This document names *how an ECC-optimized agent composes with a mupot pot* and
*why we adapt ECC rather than rebuild it*. It sits beside
[Sovereign Core, Operated Presence](./sovereign-core-operated-presence.md):
that doc names what we sell; this one names the runtime the operator runs on.

## Thesis: the microkernel exists to ADAPT, not rebuild

mupot is a governance microkernel. Its job is to make agent labor *governed,
receipted, and auditable* — not to re-implement the client-side craft of making
an agent good at its job. Those are two different layers, and they compose.

- **ECC** (`github.com/affaan-m/ECC`, MIT, `ecc-universal@2.0.0`) is the
  **client-side agent-optimization layer**: skills, hooks, instincts, memory,
  and security, applied across harnesses (Claude, Codex, Cursor). It makes the
  *operator* good.
- **mupot** is the **server-side governance substrate**: the kernel/ports,
  the task lifecycle, the gate, and FRC/receipt assurance. It governs the
  *output*.

They do not compete. An ECC-optimized agent attaches to a pot over MCP and its
work becomes governed, receipted labor:

> **ECC makes the operator good; mupot governs the output; the customer pays for
> operated presence.**

This is the same boundary the Operated-Presence model draws — sovereignty is
free, operation is paid — applied to the runtime: the *craft* of operating is
adopted off-the-shelf; the *assurance* around it is what we build and sell.

## Where it plugs into the kernel

ECC plugs in at the seam that already exists: the **Agent port + MCP seam**. A
pot already lets any agent attach over MCP and act as bound, member-scoped
labor (kasra is welded to the mumega pot this way). ECC is simply the
**agent-runtime adapter** on the *client* side of that seam:

```
[ ECC-optimized agent ]  ──MCP──▶  [ mupot Agent port ]  ──▶  gate ──▶ receipt
  skills · hooks · instincts          member-scoped, governed labor
  memory · security (client)          (server-side assurance)
```

We do **not** adopt ECC's code into mupot's codebase. ECC lives on the operator's
harness; mupot stays a clean microkernel. The contract between them is MCP + the
Agent port, nothing more.

## Proven receipts

Everything below was proven live this session; it is stated as fact.

### 1. The operator kit installs, non-destructively

```
ecc install --profile minimal --target claude \
  --with capability:content --with capability:social --with capability:research
```

lays down the **marketing operator kit** — article-writing, brand-voice,
content-engine, crosspost, x-api, market-research, seo — plus the **instinct
engine** (`continuous-learning-v2`). It manages **393 files**, tracked in
`install-state.json`, and is **non-destructive** (managed files are recorded and
reversible; nothing outside the manifest is touched).

### 2. Cursor auto-adopts ECC skills (canary-proven)

A unique canary token was planted *only* inside
`.cursor/skills/brand-voice/SKILL.md`. It then surfaced in output from a neutral
prompt that never named the skill. The only path from that file to the output is
Cursor auto-loading the ECC skill. Conclusion: **Cursor auto-adopts installed
ECC skills** — the optimization layer is live without the operator invoking it
by name.

### 3. The governance half is live end-to-end

mupot's task lifecycle now closes over MCP. The new **`task_verdict` MCP tool**
(shipped today, PR #425, commit `d73704d`) is the MCP twin of
`POST /api/tasks/:id/verdict`, reusing the same gate helpers
(`callerHoldsGateCapability`, `verdictPrincipal`, `writeVerdict`) so gate logic
never forks. Guards preserved on the new door: member+ on the squad, gate
capability named by `gate_owner`, status must be `review`, and — critically —
**self-verdict is blocked** (an assignee cannot approve its own work; org-owner
override is audited).

The **self-closing operator loop ran end-to-end** (task `774de7d9`):
board → technician → gated **PR #424** → verdict → done.

## Per-pot install recipe

For a marketing pot (e.g. DME), install the marketing loadout onto both the
Claude and Cursor targets:

```bash
# Claude operator
ecc install --profile minimal --target claude \
  --with capability:content \
  --with capability:social \
  --with capability:research

# Cursor operator (auto-adopts skills once installed)
ecc install --profile minimal --target cursor \
  --with capability:content \
  --with capability:social \
  --with capability:research
```

This gives the operator the article-writing / brand-voice / content-engine /
crosspost / x-api / market-research / seo kit plus the `continuous-learning-v2`
instinct engine, on whichever harness the operator drives.

## Governance wiring

The operator's output is governed by routing it through the pot's gate:

1. **ECC-operator produces work** (a draft, a PR, a content change) as
   member-scoped labor over MCP.
2. Work moves to **`review`**, routed to the pot's gate owner (`gate_owner`).
3. A **different principal** issues the verdict via **`task_verdict`** — the
   self-verdict block guarantees the operator cannot rubber-stamp itself.
4. The verdict writes a **receipt**.

**Provisioning gap found live:** the gate agent's token must hold the
`gate:<owner>` grant, and there is currently **no MCP tool to grant it**. Grants
are written by the preset-mint path into the `gate_grants` table
(`src/dashboard/keys.ts`); to onboard a gate agent today, insert the
`gate:<owner>` capability row directly into `gate_grants`. A
**`grant_gate_capability` MCP tool is a follow-up** so this becomes a first-class,
receipted operation rather than a manual insert.

## What we adopt vs skip

| Adopt (from ECC) | Skip / do not rebuild |
|------------------|-----------------------|
| Operator toolkit (content / social / research skills) | Any re-implementation of those skills |
| Instinct engine (`continuous-learning-v2`) | A parallel learning/memory system |
| Client-side security hooks | Client-side agent hardening from scratch |

mupot's remaining **unique build** is exactly the assurance layer ECC does not
provide: the **kernel / ports**, **FRC + receipts assurance**, and the
**gate-as-wedge**. That is where our effort goes; the operator craft is adopted.

## Bus-factor mitigation

ECC is **one maintainer + MIT-licensed**. To de-risk the dependency:

- **Fork** ECC into our org.
- **Pin** a version (`ecc-universal@2.0.0`).
- **Pull upstream on our terms** — review, then merge, never blind-track.

This keeps the adopt-don't-rebuild posture safe: we get the craft for free
without taking on single-maintainer supply-chain risk on a runtime our operators
depend on.
