# MU.100.003 — The Crew Model: Capability-Assembled Flights

**Canonical Document ID:** `MU.100.003`
**Status:** LIVING — state layer under [[MU.100.001]], sibling of [[MU.100.002-spine]]
**Born:** 2026-08-08, Hadi directive: *"a flight takes crews… based on the resources the flight needs, it takes from the available agents to use their harness and tokens and abilities."*

---

## 1. The principle

A **flight is a manifest of *needs*, not a list of *names*.** It declares what it requires; the **crew** is assembled from whichever agents are *available* and *capable*. The pre-flight ceremony ([[MU.100.002-spine]] §3 / the `flight` skill) is the crew reading the manifest and matching themselves to it.

An agent is not summoned by identity ("get kasra"). It is summoned by capability ("get a builder who holds mupot-admin"). Whoever matches, crews.

## 2. The match is a triple

Every crew requirement resolves against three dimensions of an agent's profile:

| Dimension | Question | Examples |
|---|---|---|
| **harness** | what body runs the work | `claude-code` · `cursor` · `codex` · `prime-headless` · `mumcp` |
| **tokens** | what it is *allowed* to touch (by reference, never value) | `mupot-admin` · `r2-write` · `bus` · `gh` · `tenant:<slug>` |
| **abilities** | what it can actually *do* | `build-python` · `gate-security` · `wp-build` · `browser-verify` · `git` |

A flight that needs "publish to a WordPress tenant" pulls a crew member with harness `mumcp` + token `tenant:<slug>` + ability `wp-build`. A flight that needs "gate an auth PR" pulls one with ability `gate-security` + the authority seat.

## 3. Two layers: pooled labor, sealed authority

**Not everything is fungible.** This is the line that keeps the crew model from dissolving governance:

| Layer | Poolable? | Bound by | Examples |
|---|---|---|---|
| **LABOR** | yes — any agent matching harness+tokens+abilities | capability | build, research, verify, draft, scan |
| **AUTHORITY** | no — the specific qNFT-sealed seat must sign | identity ([[MU.100.001]] §1.2, §3.1) | `merge` (kasra) · `gate-of-record` (athena) · `witness` (river) · `founder-seal` (Hadi) |

A flight's crew is therefore **pooled labor + the required authority seat.** The flight-executor build (2026-08-08): labor was kasra-code (any Python builder would have served); authority was kasra-the-merge-seat (identity-bound, not poolable). The crew *form* was right; it was assembled by hand.

Authority seats are enumerated in [[MU.100.001]] and sealed by qNFT. Labor is enumerated in the capability profiles (§4). The assembler (§6) must never pool an authority role.

## 4. Capability profile — per agent

One machine-readable profile per agent, in `docs/spine/capabilities/<agent>.yaml`. Human-readable roster ([[roster]]) stays; this is its structured twin. Schema:

```yaml
agent: kasra
agent_id: c855f82c-1eeb-409d-94d2-f11e9dd18968   # match by UUID, never slug (registry drift: e211b0fb→slug 'prime')
harness: claude-code
models: [claude-opus-5]
status: live            # live | reserve | dormant | retired
tokens:                 # references into ~/.fleet/keys/ or the bus — NEVER values
  - mupot-admin
  - bus
  - gh
abilities:
  - build-python
  - build-ts
  - git
  - gate-correctness
authority:              # qNFT-sealed seats — NOT poolable (see §3)
  - merge-authority
  - dyad-gate-lead
subagents:              # the unit's own internal dyad — the reason every unit is self-sufficient
  kasra-code:    [build-python, build-ts, build-bash, git]
  kasra-review:  [gate-security, gate-correctness]
  kasra-devops:  [sysadmin, sec-ops, host-ops]
  kasra-research:[web-research, library-docs]
  kasra-git:     [rebase, conflict-resolution, pr-mechanics]
availability: live      # live | busy | offline — the assembler reads this at pre-flight
```

**Every unit carries both a code subagent and a gate subagent** (Hadi 2026-08-08). That is what makes a *dyad* composable from a single unit, and what lets two dyads of different composition run in parallel (athena-core gates flight A while athena-code builds flight B).

## 5. Flight requirements manifest

A flight declares its crew needs in its pre-flight. Extends the `flight` skill ceremony:

```yaml
flight: flight-20260808-flight-executor
goal: <one sentence>
requires:
  crew:
    - role: builder
      needs: { abilities: [build-python], tokens: [mupot-admin] }
    - role: gate
      needs: { abilities: [gate-security] }
      authority: dyad-gate-of-record      # forces an identity-bound seat, not a pooled match
  resources:
    - r2-write                            # flight fails pre-flight if no available agent holds it
```

## 6. The crew-assembler

Today the assembler is **a human/kasra eyeballing the roster.** The target is a function:

```
assemble(flight.requires) -> crew | UNSATISFIABLE
  for each crew role:
    if role.authority:  bind the sealed seat (MU.100.001) — never pool; fail if that seat is offline
    else:               candidates = agents where
                          availability == live
                          AND role.needs.abilities ⊆ agent.abilities
                          AND role.needs.tokens    ⊆ agent.tokens
                          AND (role.needs.harness unset OR == agent.harness)
                        bind cheapest-capable candidate (model tier); STANDBY the rest
  for each resource: assert some available agent holds it, else FAIL pre-flight loudly
```

Rules the assembler must honor:
1. **Match by `agent_id`, never slug** (registry drift is real and live).
2. **Never pool an authority role** (§3) — resolve the sealed seat or fail.
3. **Availability is read at pre-flight**, not assumed — a dormant/offline agent is not crewable.
4. **Fail loud on UNSATISFIABLE** — a flight that needs a token/ability no available agent holds does not launch (no silent degrade — [[MU.100.001]] §2.2).
5. **Cheapest-capable wins** for labor (model-tier economy), the rest go STANDBY.

## 7. Why this is resilient

Capability-crewing makes labor **fungible by capability, not identity.** If kasra is down, another agent with `build-python` + `mupot-admin` crews the flight. The work does not block on one body. Only the *authority* seats are single-points — and those are deliberately few, deliberately sealed, and deliberately human-gated at the top ([[MU.100.001]] §1.2).

## 8. Build order

1. This doc (the model). ← done
2. `docs/spine/capabilities/*.yaml` — a profile per live agent (kasra, athena, asha, loom, river, mubot, mupot-steward). *(delegated — mechanical fill-out from §4 schema)*
3. Reference crew-assembler (§6) — reads a flight manifest + the profiles, emits a crew or UNSATISFIABLE. Consumes availability from live status.
4. Extend the `flight` skill pre-flight to call the assembler instead of hand-picking.

## 9. Lineage

- 2026-08-08 — v1. Model authored by kasra (the day the fleet ran its first parallel dyads by hand — flight-executor #740, double-dispatch #742 — and Hadi named the general principle they were instances of).
