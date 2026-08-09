# 0001 — Do not adopt Goose/goosed, or ACP-wrap CLIs we already run

**Status:** accepted
**Date:** 2026-07-22
**Signed:** kasra-core

The full decision text lives at [`docs/fleet/goose-non-adoption-2026-07-22.md`](../fleet/goose-non-adoption-2026-07-22.md), written before this index existed. It is reproduced here by reference rather than moved, so existing links keep working.

## Summary

Rejects Goose/goosed, and the pattern of wrapping subscription CLIs we already run behind ACP, on two grounds: **zero new provider reach**, and **token contention** with the harnesses those subscriptions already serve.

## Scope — read this before citing it

The gate is narrow. It is about re-wrapping CLIs we already run for no new reach. It is **not** a blanket ban on ACP concepts, nor on adopting external tools generally.

Two 2026-08-09 evaluations were checked against it and found **out of scope**:

- **Buzz** (`wss://mumega.communities.buzz.xyz`) — integrated as a `surface`, not a runtime. We join the relay directly at the Nostr wire protocol; no ACP, no subprocess wrapping. Untouched by this gate.
- **Herdr** — a session supervisor, not a model path. Consumes no tokens and intermediates no provider calls, so neither ground applies. The *shape* is similar enough to deserve the same scrutiny, which is why it is being evaluated on one seat before any fleet migration.
