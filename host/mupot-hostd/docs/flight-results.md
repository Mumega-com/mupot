# Flight results — hostd-canonical-host-20260910

## Flight 1
PASS (contracts + dual-consumer fence). Gate: hadi-grok.

## Flight 2 (read-only host)

Implemented Tasks 2–6. GATE-F2 AMEND **`served-context-unwired`** addressed:

- `Store::list_observations` + `load_observations_from_store`
- `HostState` loads from Store; `context` serves via that join
- Kill-witness: `kill_witness_served_context_requires_store_load`
- Hermes `870a5024` remains fenced

### Live read verification — 2026-09-11/12

- Production Mupot adapter now calls `POST /actions/boot_context` over HTTPS with
  the credential loaded from a same-user private file. The daemon does not call
  `connect`, mint, inbox, ACK, or SSE operations.
- The available `hadi-codex` bearer resolved to
  `087a816b-ab9f-400f-8d53-f6f97b94a725`. A boot request for canonical Rava
  `e9597210-edc5-4de5-80cd-b9cbea8ff422` returned `Conflict`; hostd did not
  adopt the requested or documentary identity.
- With the matching Hadi Codex principal, one foreground socket boot and one
  context request succeeded. The returned packet contained two labelled facts,
  with source systems `mupot` and `herdr`.
- Mirror on the VPS was found cleanly stopped rather than crashed. The existing
  `mirror.service` and configured `mirror-outbox-drain.service` were started and
  enabled. Direct/proxied health and an authenticated search passed. No Mirror
  data was changed by this read check.

## Flight 3 (approved private write — fixture first)

Tasks 7–9 implemented in crate. Gate: hadi-grok. Hermes lane dropped.

- Exact-action Approval + durable outbox; free-text ≠ token
- `propose` / `commit` wired; bare `write` stays UnsupportedContract
- Canary fixtures green; `live_private_object` ignored (no Hadi four facts / local config)
- Hermes `870a5024` remains fenced

### Live write prerequisites — current

- Inkwell conditional revision support is implemented on branch
  `codex/inkwell-kb-cas` in `Mumega-com/mumega-com` (draft PR #1229). It adds an
  authenticated complete-object read and an atomic `expected_revision` update;
  211 focused/qNFT tests and repository lock checks passed.
- Live F3 remains blocked: PR #1229 is not deployed, no Rava bearer is installed
  on this Mac, and the current commit engine still uses fixture Inkwell/Mirror
  writers. A successful Hadi Codex read is not a Rava write authorization.
