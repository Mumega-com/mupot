# Goose (goosed) — fleet runtime non-adoption

**Status:** Won't adopt (decided 2026-07-22 after pilot install).
**Task:** mupot `e89df2c2-72e8-4013-bddd-81153f01610b`
**Supersedes:** original DONE WHEN that would onboard a goosed-backed fleet agent.

This document records *why Goose is not a mupot fleet runtime adapter*. It sits
beside [ECC as the mupot Agent-Runtime Adapter](./ecc-as-agent-runtime.md): that
doc names an adopted client-side craft layer; this one names a rejected
wrapper runtime.

## Decision

**Do not** add `goose` / `goosed` to the fleet attach allow-list, connectors, or
host runtime packs. **Do not** onboard a goosed-backed agent as a boxed
least-privilege mupot fleet runtime.

The fleet runtime layer is already complete via:

- **native CLI subscription** fleet agents (Claude Code, Codex, Gemini CLI)
- **mupot** coordination (signed attach, presence, inbox, gate)
- **mumega-brain** deciding work

## Why (pilot evidence)

Pilot: Goose `1.43` installed and ran (OpenRouter key capped; Gemini free-tier
quota exhausted), then removed clean with no secrets persisted.

Our providers are **native CLI subscriptions**, not raw-API-key providers.
Goose only reaches those native CLIs via ACP. Adopting it would:

1. **Wrap runtimes we already run directly** — Claude Code (= kasra), Codex
   (= GPT), AGY (= Google) — adding a redundant layer with zero new provider
   reach.
2. **Drain the same subscription tokens** — contention with Hermes/Codex and
   other live fleet agents on the host.
3. **Miss Goose's actual value** — aggregating many raw-API providers. That
   model does not apply to our subscription-first fleet.

## What stays in scope

| Keep | Skip |
|------|------|
| Native CLI runtimes already on the attach allow-list (`claude-code`, `codex`, `hermes`, …) | `goose` / `goosed` as a fleet `runtime` slug |
| ECC as client-side operator craft (see ECC architecture doc) | Any Goose connector under `connectors/` |
| Signed attach + inbox + control receipts for native shells | ACP wrapper path that re-enters the same CLIs |

## Enforcement

- `VALID_RUNTIMES` in `src/fleet/attach-routes.ts` does **not** include `goose`
  or `goosed`; attach of either slug is `400 bad_request`.
- Tests lock the rejection so a future adapter PR must reverse this decision
  deliberately (doc + allow-list + tests together).

## Revisit only if

A future model shift makes raw-API multi-provider aggregation the primary
reach path **and** native CLI subscriptions are no longer the fleet substrate.
Until then, treat Goose as out of scope for `runtime-adapter/v1` fleet hosts.
