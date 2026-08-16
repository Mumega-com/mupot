# Flight Muster — the crew half of preflight

> Status: **spec, not built.** Consolidates five orphaned issues (#837, #882, #902, #910, #883)
> into one surface. Companion to [flight-operations.md](./flight-operations.md) — that doc
> covers *readiness* and *clearance*; this one covers **crew**.

## The gap, stated precisely

`src/flight/preflight.ts` scores six signals: context, tools, budget, progress-per-step,
recent progress, step latency. It answers "is this flight ready to fly."

It has **no signal for who is flying.** Not the agent, not the model, not the harness, not
the role. A flight whose entire crew is dead scores exactly the same as one fully staffed,
because crew is not an input to `readinessScore()`.

`src/flight/clearance.ts` answers the orthogonal question — "does this flight's airspace
overlap one already in the air" — and its own module header already names the ceiling:

> **META-OMISSION BYPASS (F4):** a flight that declares no scope is opaque and collides with
> nothing … Inherent ceiling of self-declared scope; the tower only sees what flights
> honestly declare.

Muster is F4 applied to crew, and it fails harder — because a flight can declare its crew
*honestly* and still be wrong.

## Why declaration is not enough

Observed live on 2026-08-16:

| source | Athena's model |
|---|---|
| `agents/athena/BOOT.md` | `deepseek-v4-flash` |
| open PR #1001 | `deepseek-v4-pro` |
| actual tmux pane | `GPT-5.6 Luna` |

Three sources of record, three different answers, zero of them flagged. Had Athena
registered at flight start, she would have registered a lie — sincerely. She is not
lying; she does not know. Nothing in the system reads what she is actually running.

The obvious objection is that Athena is one bad case. She is not. The second agent checked
drifted too, and was found *while filing this spec*:

| source | River's model |
|---|---|
| `resolve_agent` (the mupot registry of record) | `deepseek-v4-pro` |
| actual tmux pane | `DeepSeek V4 Flash (2x usage)` |

Right family, wrong tier — which is the more dangerous shape, because it survives any check
that matches on family and it is exactly the axis the lens invariant below depends on. Two
of two agents checked are drifted. The sample is small; the base rate is not.

This is not a one-off. It is already filed five times, each capturing one face of it:

| issue | the face it captures |
|---|---|
| **#837** | presence/peers report stale identity — **session model strings never refresh** |
| **#882** | roster-of-record drift, verified live: asha unregistered, prime/river mismatched |
| **#902** | `presence_register` bypasses both runtime allowlists — any caller is dispatch-eligible |
| **#910** | split-brain presence — routine dispatch and `task_dispatch` read *different* surfaces |
| **#883** | Asha/Prime responder has no watch surface — silent stall is indistinguishable from idle |

Five issues, one defect: **the roster is self-declared, and self-declaration rots.**

The general law, already earned twice in this codebase: *static rots, dynamic is reliable.*
Static tokens, always-on daemons, and liveness signals all decay silently. A registration
stamped at flight start is a static token for identity.

## The rule

> **Declaration is the input. Observation is the gate.**

An agent declares what it intends to be. The muster **independently observes** what it
actually is. A flight departs only when the two agree. Disagreement is a NO-GO with a named
reason — never a silent coercion to whichever source was read last.

This is the same discipline `derivePresence()` already applies to time (`fleet/registry.ts`),
extended from *when did you last speak* to *what are you*.

## Data model

Extend the existing `fleet_agents` surface rather than adding a sixth presence source —
#910 exists because we already have two that disagree. `validReport()` in
`src/fleet/registry.ts` already accepts `agent_id`, `status`, `runtime`, `lifecycle`,
`squads`, `provider_contract`, `agent_type`, `member_id`. Add:

```ts
interface CrewDeclaration {
  agent_id: string
  role: FlightRole            // what job on THIS flight
  declared_model: string      // what the agent believes it runs
  declared_harness: string    // claude-code | codex | gemini-cli | prime | headless
  lens: Lens                  // see "Lens" below — the substitution invariant
}

interface CrewObservation {
  agent_id: string
  observed_model: string | null   // null = could not observe
  observed_harness: string | null
  observed_at: string             // stamp, parsed by the existing parseStamp()
  source: ObservationSource       // how we looked
}
```

`ObservationSource` is deliberately an enum, not a boolean — an observation from a live
process table is stronger evidence than one from a log line, and the muster must be able to
say which it had.

## Roles

Roles are flight-scoped, not identity-scoped. The same agent takes different roles on
different flights. What a role fixes is **authority**, not skill.

| role | authority | notes |
|---|---|---|
| `captain` | owns the flight plan, sequences the legs | one per flight, mandatory |
| `builder` | writes code on a branch | may be many; **never merges, deploys, or publishes** |
| `gate:correctness` | does it do what it claims | must not be the builder |
| `gate:adversarial` | can it be gamed, is the test vacuous | runs **parallel** to correctness, not after |
| `merge` | the only role that may merge to main | **non-delegable** |
| `watch` | notices when the flight stops making noise | closes #883 |

Two constraints that are not negotiable, both earned:

1. **Author is never gate.** A builder cannot hold either gate role on the same flight.
2. **Merge is non-delegable.** The fix for a single-server bottleneck is not a second
   server, it is fewer hand-turns.

## Lens — the substitution invariant

This is the part that is easy to miss and expensive to get wrong.

The two gate roles exist to be *independent*. Their independence comes from being different
models, not from being different names. If `gate:adversarial` fails and is substituted by a
model from the same family as `gate:correctness`, the muster still shows two filled roles and
two green checks — while the actual review has collapsed to a monoculture.

The gate does not fail loudly. It reports success and stops catching things. Which is the
worst failure shape we have: **failure that looks like rest.**

So each crew slot carries a `lens` — the model family, not the model name. And:

> **A substitution that reduces the number of distinct lenses across the gate roles fails
> the flight. It does not degrade it.**

Recorded evidence for why: single-lens Opus gating proved insufficient — a second, different
model blocked artifacts that the first had passed, repeatedly. And on the last flight, a
predicate that both the author *and* the adversarial reviewer passed was caught only by a
third lens. Two lenses is the floor, not the target.

## Failure taxonomy — replace vs demote vs hold

"If a model or harness fails, replace it or change the roles" is right, but *failed* is three
different states with three different remedies. Collapsing them is how a stalled agent gets
replaced (wasteful) or a dead one gets waited on (worse).

| state | observed as | remedy |
|---|---|---|
| **dead** | process absent, or heartbeat past TTL | **replace** — fill the role from the standby pool |
| **stalled** | process alive, no output progress, no error | **demote** to `watch`, fill the role, keep it seated |
| **blocked** | alive and *waiting on input* | **hold the flight** — a human keypress is not a crew failure |
| **drifted** | observed ≠ declared | **NO-GO** — do not auto-correct, surface it |

`blocked` is real and current: `mumcp` is sitting on a "Resume from summary / full session"
picker right now. It is not failed. Replacing it would discard a live session for nothing.

`drifted` deliberately has no auto-remedy. Silently trusting the observation would let a
compromised or misconfigured agent redefine its own identity by simply behaving differently —
the registry would follow it. #902 is that hole in its authorization form (any caller can
register itself as dispatch-eligible); auto-correcting drift would reopen it in identity form.

## Where it plugs in

Muster produces one boolean and one reason list — the same shape `preflightCheck()` already
returns, so it composes without changing the control law:

```ts
// src/flight/muster.ts — pure, no I/O, matching preflight.ts / clearance.ts discipline
export function musterCheck(
  declared: CrewDeclaration[],
  observed: CrewObservation[],
  plan: FlightPlan,
  opts: MusterOptions = {},
): MusterResult   // { mustered, crew, holds, reasons }
```

Reasons are named, never generic: `role_unfilled`, `identity_drift`, `lens_collapse`,
`author_is_gate`, `merge_delegated`, `crew_unobservable`, `crew_blocked`.

`dispatchFlight` already gates on `preflight.go && clearance.cleared`. It becomes:

```
preflight.go && clearance.cleared && muster.mustered
```

Three orthogonal questions, one departure decision:

- **preflight** — is the *work* ready?
- **clearance** — is the *airspace* free?
- **muster** — is the *crew* real?

## The flight's place in the whole

Each flight declares `objective_id` / `goal_id` — `clearance.ts` already parses both, and
today uses them only to raise a WARN on overlap. The muster reuses them to answer the
question a captain should have to answer before departure: **what does landing this flight
change about the totality of work?**

Concretely: a flight that names no objective is invisible to clearance (F4) *and*
unrankable by any future brain. Requiring the field at muster closes both at once, at zero
extra cost — the parser exists.

## Observation sources — what we can actually read today

Nothing here needs new instrumentation. Every source already exists:

| source | strength | reads |
|---|---|---|
| host process table | strong | harness binary, uptime, CPU — proves *alive* |
| tmux pane capture | strong | **the model string the harness itself prints** — proves *identity* |
| `fleet_agents.last_reported_at` | medium | `derivePresence()`, already built |
| systemd unit state | weak | says `active` for a hung service — see below |
| service health endpoint | strong | but must have a timeout, and the timeout must be a NO-GO |

The systemd caveat is not hypothetical. Observed the same day this spec was written: Mirror
reported `active (running)`, held its port open, logged `Application startup complete` — and
did not answer `/health` in 30, 57, or 44 seconds across three probes. Unit state is a claim
about a process, not about a service.

**A source that times out is not a source that says yes.** `crew_unobservable` is a NO-GO
reason, not a shrug.

## Explicitly out of scope for v1

- **Automatic crew provisioning.** Muster *checks* the crew; it does not spin one up. That
  stays where flight-operations.md already parks it (post-0.19).
- **Cross-tenant crew.** Same rule as `compareMeta` — an agent in another tenant is not crew.
- **Muster as a lock.** Like clearance, this is advisory-at-dispatch. It cannot stop an agent
  that never registered from doing work anyway. It raises the floor; it is not a mutex.

## Why this is worth building before the ranker

The brain work (Track 2) needs a roster it can trust. A ranker that assigns work to agents
whose identity, liveness, and lens are self-declared and stale will produce a correct-looking
assignment that no test can falsify — the same shape as the fabricated-receipt cluster
(#1085, #1017, #896, #899).

Fix the instrument before building the thing that reads it.
