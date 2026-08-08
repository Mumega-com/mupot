# Decision: retire the product-organism YAML fleet (path c)

**Status:** DECIDED — tech-grok build for mupot task `938ca06d-ceda-458c-8399-e5cec398696b`
**GitHub:** [Mumega-com/mumega-com#595](https://github.com/Mumega-com/mumega-com/issues/595)
**Date:** 2026-08-04
**Machine registry:** [`organisms-decisions.json`](./organisms-decisions.json)
**Archive:** [`archived-organisms/`](./archived-organisms/)

This document is the deliverable for the organisms redesign decision task.
It chooses **(c) explicit retirement** over systemd-daemon revive **(a)** or
step-once batch **(b)**.

## Verdict

**Retire** the `~/.mumega/organisms/*.yaml` product-organism fleet and keep
`organ-daemon.timer` / `organ-daemon.service` **disabled**. Do **not** schedule
`sos.services.operations.organism` (or the `scripts/product-organism.py`
redirect) as a 300s batch job.

SOS `organism.py` remains a valid **long-lived daemon** for deliberately
enabled projects via its own runbook
(`SOS/docs/runbooks/sos-organism.service.md`). That path is opt-in and separate
from the retired YAML fleet. Revisit only with an explicit enable decision —
never by re-arming organ-daemon oneshot + timeout.

## Why not (a) or (b)

| Path | Rejected because |
|------|------------------|
| **(a)** `organism@<name>.service` forever-loop | 9/10 YAML configs are `paused` since 2026-04-25; enabling daemons would re-wake paused work. This lane is branch-only — no deploy. The YAML files are not read by `organism.py` anyway (CLI `--projects` only). |
| **(b)** `--once` / step-once batch | `Organism.step()` already exists for tests/manual kicks. Wiring organ-daemon-style batch scheduling back onto a forever-loop process recreates the exact semantics mismatch that burned ~50 min twice daily. |

## Defect that forced the decision

Found 2026-08-03 (brain-rot audit):

1. `organism.py` is `while True` (daemon).
2. `organ-daemon.service` ran `scripts/run-all-organisms.py`, which invoked each
   organism under `subprocess.run(..., timeout=300)`.
3. Result: **10/10 timed out every run**, twice daily — nothing useful shipped
   for weeks, and nothing noticed.
4. Four crontab lines called `product-organism.py <name>` with **positional**
   args after the CLI required `--projects` — fast-fail every fire.
5. Host cleanup already landed 2026-08-03: timer+service disabled, cron lines
   removed (backup: `~/.mumega/crontab-backup-20260803-pre-organ-clean.txt`).

## Per-organism decisions

All ten **product-organism configs** are **retire**. Project work may continue
elsewhere; the YAML heartbeat fleet does not.

| Organism | Prior YAML status | Decision | Reason |
|----------|-------------------|----------|--------|
| dentalnearyou | paused | **retire** | Hadi bulk pause 2026-04-25; reopen via mupot/squad, not YAML heartbeat |
| digid | paused | **retire** | Bulk pause; digid mind is a separate SOS fork path |
| gaf | paused | **retire** | Bulk pause; SaaS work via brain/squad |
| letsbefrank | paused | **retire** | Bulk pause; no live consumer |
| musicalunicorn | paused | **retire** | Bulk pause; no live consumer |
| pecb | paused | **retire** | Bulk pause; no live consumer |
| prefrontal | paused | **retire** | Restructuring pause; cron previously contradicted brain pause |
| realm-of-patterns | paused | **retire** | Bulk pause; TROP rhythm is SOS trop-* / pulse when deliberate |
| stemminds | paused | **retire** | Bulk pause; no live consumer |
| viamar | active | **retire** | YAML said active but code never loaded it; live work is mupot GEO/routines |

## Scheduler invariants (must hold)

1. `organ-daemon.timer` — **disabled**, not re-enabled.
2. `organ-daemon.service` — **disabled**; its oneshot+timeout shape is retired.
3. No crontab line invokes `product-organism.py` / `organism.py` / `run-all-organisms.py`.
4. No batch scheduler may call `organism.py` without an explicit `--once` (or
   equivalent) mode that exits — and even then only for a project with a
   deliberate **run** decision. Today there are **zero** run decisions.
5. Optional SOS daemon enable uses the SOS runbook unit (`Type=simple`,
   `Restart=always`), never organ-daemon.

## What landed in-repo

- This decision + `organisms-decisions.json` (machine lock).
- Exact copies of the ten YAML files under `archived-organisms/`.
- Retired markers under `deploy/retired/` documenting host units that must stay off.
- `tests/organisms-retirement.test.ts` — fails if a name drops out, a decision
  flips to `run` without archive/doc alignment, or path (c) wording is lost.

## Host follow-up (human-gated — not done by this branch)

- Leave `~/.mumega/organisms/*.yaml` in place or move aside after merge; archive
  in git is authoritative.
- Keep `~/.config/systemd/user/organ-daemon.{service,timer}` disabled (or delete
  after merge approval).
- Do **not** `systemctl --user enable --now organ-daemon.timer`.

## Revisit only if

- A named project needs daily morning/noon/evening pulses **and** a human
  enables a proper `Type=simple` systemd unit per the SOS organism runbook, **or**
- A true step-once CLI is added to `organism.py` **and** a new scheduler is
  designed around exit semantics (not 300s kill of `run_forever`).
