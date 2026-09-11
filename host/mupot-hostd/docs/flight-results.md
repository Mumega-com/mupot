# Flight results — hostd-canonical-host-20260910

## Flight 1
PASS (contracts + dual-consumer fence). Gate: hadi-grok.

## Flight 2 (read-only host)

Implemented Tasks 2–6. GATE-F2 AMEND **`served-context-unwired`** addressed:

- `Store::list_observations` + `load_observations_from_store`
- `HostState` loads from Store; `context` serves via that join
- Kill-witness: `kill_witness_served_context_requires_store_load`
- Hermes `870a5024` remains fenced

## Flight 3 (approved private write — fixture first)

Tasks 7–9 implemented in crate. Gate: hadi-grok. Hermes lane dropped.

- Exact-action Approval + durable outbox; free-text ≠ token
- `propose` / `commit` wired; bare `write` stays UnsupportedContract
- Canary fixtures green; `live_private_object` ignored (no Hadi four facts / local config)
- Hermes `870a5024` remains fenced
