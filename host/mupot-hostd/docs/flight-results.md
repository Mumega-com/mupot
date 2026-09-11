# Flight results — hostd-canonical-host-20260910

## Flight 1
PASS (contracts + dual-consumer fence). Gate: hadi-grok.

## Flight 2 (read-only host)

Implemented Tasks 2–6. GATE-F2 AMEND **`served-context-unwired`** addressed:

- `Store::list_observations` + `load_observations_from_store`
- `HostState` loads from Store; `context` serves via that join
- Kill-witness: `kill_witness_served_context_requires_store_load`
- Hermes `870a5024` remains fenced
- F3 not started

Live Herdr ingest requires `MUPOT_HOSTD_LIVE_HERDR=1` (adapter still constructed).
