# Asha-Luna Machinery Candidate (design + bundle, no activation)

**Status:** CANDIDATE — local bundle only. Nothing enabled, started, minted,
modified, pushed, or deployed. No config applied, no unit installed.
**Date:** 2026-09-13 · **Author:** mupot_builder (task t_bc14f72c)
**Gate:** River's decision request `asha-luna-machinery-20260913` gates promotion.
**Bundle:** [`./asha-luna-machinery/`](./asha-luna-machinery/README.md)

---

## 1. Problem: Asha cannot receive work, and the one path that could answer runs the wrong identity

Three verified dead ends:

1. **The inbox keystone.** mupot dispatch delivers **zero** `routine.run/v1` envelopes
   to Asha's inbox (`docs/spine/the-keystone-agent-receiving.md`). The capture→responder
   pair is already retired (`~/.fleet/retired-units-20260815/`) and would answer nothing
   even if resurrected.
2. **The responder launches the default profile.** The retired `asha-responder.service`
   sets `RESPONDER_BIN=hermes` with no profile flag; `prime-responder.py`'s hermes argv
   branch (`_argv`, file:469-475) builds `[RESPONDER_BIN, "--in", WORKDIR, "-z", prompt]`
   — the `-p` flag is not a hermes top-level option, so every reply ran under the DEFAULT
   profile, not Asha.
3. **No Asha-shaped runtime exists.** The only Luna runtime — the `prime-opencode`
   Hermes profile, `gpt-5.6-luna` / `opencode-go` — carries a **Mubot** SOUL
   (`~/.hermes/profiles/prime-opencode/SOUL.md`), is stopped, and its provider is
   currently 429-capped. The other "luna" artifacts (`herdr-fleet/start-luna.sh` →
   prime-agent/`@cf/deepseek-ai/deepseek-v4-flash-0731`) are a different, stale harness.

The revival strategy (parent t_4f1403e6,
`docs/research/2026-09-13-asha-brain-mupot-native-revival.md`) already replaced the
receiving surface: **Kanban is the work rail** — cards are the durable envelope, the
`running → done/blocked` transition is the receipt, no inbox delivery dependency.
This candidate builds the Asha-shaped executor that rail dispatches to.

## 2. Evidence (verified this session, 2026-09-13)

| # | Fact | Evidence |
|---|---|---|
| E1 | Live Asha `e211b0fb-6ebf-4aab-bac5-6129ce6075e0`, squad-core, owner River | `docs/spine/agents/asha.md:7`; MU.100.001 §3.1 |
| E2 | `asha-agent-bound.token` exists, mode 600, 70 bytes | `stat` → `600`/`70`; sha256 `9b9068fe…` (pinned in `hashes.pins`) |
| E3 | `asha-inbox-capture` + `asha-responder` retired (disabled/dead) | units parked in `~/.fleet/retired-units-20260815/`; no `asha-*` unit registered with systemd; no responder/watcher process running |
| E4 | Responder `RESPONDER_BIN=hermes` → launches DEFAULT profile (`_argv` has no profile flag) | retired unit env line 15; `prime-responder.py:469-475` hermes branch |
| E5 | Only Luna runtime = `prime-opencode` profile, `gpt-5.6-luna` / `opencode-go` (`base_url https://opencode.ai/zen/go/v1`, `api_mode codex_responses`) | `~/.hermes/profiles/prime-opencode/config.yaml`; `hermes profile list` → `prime-opencode gpt-5.6-luna stopped` |
| E6 | Luna runtime has the WRONG SOUL (Mubot), stopped, provider 429-capped | `~/.hermes/profiles/prime-opencode/SOUL.md` → "You are **Mubot**"; `hermes profile list` → stopped; 429 per task evidence (not re-probed) |
| E7 | Guardrails live in shared machinery, not per-seat code | `prime-responder.py:19-32` (safety), `:84-87` (parking lanes), `:109-119` (bounds), `:122-140` (auto-mark + SYSTEM), `inbox-watch.py:2-10` (lease→spool→ack, singleton) |
| E8 | No `asha` profile or alias exists anywhere | `hermes profile list` (no asha row); `~/.local/bin/` (no `asha`) |

## 3. Candidate design (six decisions)

1. **Dedicated Hermes profile named `asha`** — `~/.hermes/profiles/asha/` (NOT created
   by this bundle). Config + SOUL templates in the bundle.
2. **Asha SOUL + findings law** — identity, cause, and MU.100.001 §2.2 verbatim
   (VERIFIED / REFUTED / UNPROVEN; three-part form; no guessing). Overrides the wrong
   Mubot SOUL by construction (different profile dir, never edits prime-opencode's).
3. **Model route Luna, configurable per-fork value** — the profile's `model` block is a
   copy of the proven prime-opencode route (`gpt-5.6-luna` / `opencode-go` /
   `base_url` / `api_mode`); forking = editing the two marked keys, proven by
   `ASHA_SMOKE_EXPECT_MODEL/PROVIDER` overrides. The route never lives in responder
   code (machinery stays fork-agnostic, `prime-responder.py:479-486` route-override
   pattern respected).
4. **Unit drop-in** (`asha-responder.service.drop-in`) sets `RESPONDER_BIN` to the
   `asha` alias and `RESPONDER_FLAVOR=hermes` — the hermes argv branch then runs the
   RIGHT profile. The alias (`asha` → `hermes -p asha "$@"`) mirrors the proven
   `prime-opencode` launcher.
5. **`RESPONDER_EXECUTE_ROUTINES` and `RESPONDER_TASKS` pinned OFF (fail-closed)** —
   routine/task envelopes keep parking in `spool/routines|machine` lanes; the kanban
   rail is the work rail, not the responder. Enabling either is a separate, gated
   activation decision.
6. **Preserve durable capture, singleton, staleness, rate, and credential stripping** —
   by construction: the candidate changes no code in `~/.fleet/prime/`. `hashes.pins`
   fingerprints the machinery so the smoke proves it byte-identical.

## 4. Bundle inventory

`docs/research/asha-luna-machinery/`

- `config.asha.yaml` — profile config template (model route, kanban rail, lean memory)
- `SOUL.asha.md` — Asha SOUL + findings law template
- `asha.alias.sh` — launcher alias template (`hermes -p asha "$@"`)
- `asha-responder.service.drop-in` — unit drop-in template (routing + guardrails)
- `hashes.pins` — sha256 pins: token, responder, watcher, retired units
- `smoke-asha-luna-candidate.sh` — deterministic smoke (below)
- `README.md` — manifest + install targets

Install targets are promotion-time only; the README states them so nothing here is a
build step that runs on its own.

## 5. Deterministic smoke (the proof)

`smoke-asha-luna-candidate.sh` — read-only, no network, no model calls, exit 0 = all PASS.

- **`baseline` (default):** proves (a) templates resolve to the exact profile
  (`asha`, alias `-p asha` ×1) and exact model route (`gpt-5.6-luna` / `opencode-go` /
  `base_url` / `api_mode`); (b) findings law markers in the SOUL; (c) drop-in routing
  + fail-closed flags; (d) fingerprints match `hashes.pins` (nothing minted/modified
  since authoring — including token mode 600); (e) **no activation**: no `asha`
  profile, no `asha` alias, no `asha-*` systemd units, no responder/watcher
  processes, retired units still parked, capture spool surface intact.
- **`promotion-ready`:** after the gates fire — verifies installed profile/SOUL/config,
  alias, and drop-in match the templates exactly (still read-only).
- Fork proof: override `ASHA_SMOKE_EXPECT_MODEL` / `ASHA_SMOKE_EXPECT_PROVIDER` to
  assert a different composed route.

Authoring receipts (run this session): baseline → exit 0, all PASS; negative run
(expect-model=bogus) → exit 1, model check FAIL (assertions bite); fixture
promotion-ready → exit 0.

## 6. What is NOT done (and must not be, by this bundle)

- No profile created, no alias installed, no unit restored/enabled, nothing started.
- No token minted/modified/read-into-repo (only `stat` + sha256 fingerprint, never contents).
- No deploy, no PR, no push, no inbox consume, no cron, no board changes.
- The Luna provider 429 cap is a promotion-gate risk noted, not probed or worked around.

## 7. Promotion path (all gates required; River's first)

1. **River** decides `asha-luna-machinery-20260913` (stateful-vs-stateless shape +
   seat approval). Candidate is deliberately neutral: card-shaped work suits either.
2. **Kasra-core** flips: create profile from templates, install alias, restore base
   unit + drop-in, `systemctl daemon-reload`.
3. **Hadi** deploy/activation gate per AGENTS.md house rules.
4. Run `smoke-asha-luna-candidate.sh --mode=promotion-ready` → exit 0, then enable.
   Rollback = reverse the three install steps; cards remain durable on the board.

## 8. Out of scope

- Fixing the `routine.run/v1` inbox keystone itself (its own card; the rail routes
  around it per parent design §8).
- Enabling `RESPONDER_EXECUTE_ROUTINES` / `RESPONDER_TASKS` (separate gated decision).
- The stale `herdr-fleet/start-luna.sh` prime-agent harness (not this route's runtime).