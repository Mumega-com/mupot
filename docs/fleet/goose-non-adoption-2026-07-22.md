# Formal gate decision: Goose / goosed non-adoption

**Status:** ACCEPTED (kasra-core) — deliberate fleet gate decision, 2026-07-22.
**Task:** mupot `580f27d7-92b7-4693-b172-bfc7f2cf54da`
**Replaces:** mupot `e89df2c2-72e8-4013-bddd-81153f01610b` (rejected on **PROCESS**, not conclusion — see Process note).
**Technical basis:** PR #483 commit `b8070e2` (reused below; conclusion unchanged).

This document is the deliverable. No Goose / `goosed` adapter is built. Non-adoption
is an explicit, gated decision — not a silent scope substitution inside a differently
titled task.

## Gate verdict (kasra-core)

**kasra-core reviewed and ACCEPTS the non-adoption conclusion.**

Accepted because:

1. **Native-CLI-subscription model** — the fleet substrate is Claude Code / Codex /
   Gemini CLI (and peers already on the attach allow-list), not raw-API-key providers.
2. **ACP only wraps runtimes we already run directly** — Goose reaches those CLIs via
   ACP; adopting it adds a redundant wrapper with **zero new provider reach**.
3. **Token contention** — Goose would drain the same subscription tokens already used by
   Hermes / Codex and other live fleet agents on the host.
4. **Pilot already done** — Goose `1.43` installed and ran, then removed clean with no
   secrets persisted; no further pilot work is required for this gate.

## Process note (why this task exists)

Task `e89df2c2` was titled / done-when'd as *onboard a goosed-backed fleet agent*. The
work that landed (PR #483 / `b8070e2`) correctly concluded **non-adoption**, but did so
by substituting scope inside that differently titled task. That substitution was
**rejected on PROCESS**, not because the technical conclusion was wrong.

This task (`580f27d7`) is the correctly scoped replacement: formalize the non-adoption
as an explicit gate decision. The technical reasoning in `b8070e2` stands and is
accepted; only the process record is corrected here.

## Decision

**Do not** add `goose` / `goosed` to the fleet attach allow-list, connectors, or host
runtime packs. **Do not** onboard a goosed-backed agent as a boxed least-privilege
mupot fleet runtime.

The fleet runtime layer is already complete via:

- **native CLI subscription** fleet agents (Claude Code, Codex, Gemini CLI)
- **mupot** coordination (signed attach, presence, inbox, gate)
- **mumega-brain** deciding work

## Technical basis (from PR #483 / `b8070e2`, reused)

Pilot: Goose `1.43` installed and ran (OpenRouter key capped; Gemini free-tier quota
exhausted), then removed clean with no secrets persisted.

Our providers are **native CLI subscriptions**, not raw-API-key providers. Goose only
reaches those native CLIs via ACP. Adopting it would:

1. **Wrap runtimes we already run directly** — Claude Code (= kasra), Codex (= GPT),
   AGY (= Google) — adding a redundant layer with zero new provider reach.
2. **Drain the same subscription tokens** — contention with Hermes/Codex and other live
   fleet agents on the host.
3. **Miss Goose's actual value** — aggregating many raw-API providers. That model does
   not apply to our subscription-first fleet.

### What stays in scope

| Keep | Skip |
|------|------|
| Native CLI runtimes already on the attach allow-list (`claude-code`, `codex`, `hermes`, …) | `goose` / `goosed` as a fleet `runtime` slug |
| ECC as client-side operator craft (see `docs/architecture/ecc-as-agent-runtime.md`) | Any Goose connector under `connectors/` |
| Signed attach + inbox + control receipts for native shells | ACP wrapper path that re-enters the same CLIs |

### Enforcement (unchanged substrate)

- `VALID_RUNTIMES` in `src/fleet/attach-routes.ts` does **not** include `goose` or
  `goosed`; attach of either slug is `400 bad_request`.
- A future adapter PR must reverse this gate deliberately (this doc + allow-list +
  tests together).

## Revisit only if

A future model shift makes raw-API multi-provider aggregation the primary reach path
**and** native CLI subscriptions are no longer the fleet substrate. Until then, treat
Goose as out of scope for `runtime-adapter/v1` fleet hosts.
