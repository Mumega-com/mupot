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
| session runtime metadata | `deepseek-v4-flash` |
| `CLAUDE.md` (stale) | `Claude Opus 4.7` — **a different family entirely** |

I recorded two sources when I filed this. The gate reviewer found **four**, including a stale
one naming a different vendor. Right family / wrong tier is the more dangerous shape, because it
survives any check matching on family — and family is precisely the axis the lens invariant
depends on. A different-family entry in a fourth source is worse still: it means a naive reader
could conclude the lens requirement is satisfied by an agent that has not run that model in
months.

Two of two agents checked are drifted, and the one I looked at closely was worse than I first
measured. The sample is small; the base rate is not.

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

And the rule turns back on the muster itself: `muster.mustered` certifies that
`observed == declared`, which makes **the certification its own kind of seal** — it must stay
re-verifiable against the observation records it names, never against a summary of them. A
muster verdict nobody can re-derive is a relay. See ["A seal is a claim about a file"](#a-seal-is-a-claim-about-a-file-f3)
for the rule and the four ways it was violated the night this was written.

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

It is also a **static constraint, not only a substitution-event check** (F5): at every muster,
the count of distinct model families among the *filled* gate roles must be ≥ 2. Enforcing it
only on substitution lets a flight muster into a monoculture from a cold start and pass,
because no substitution ever occurred. Check the standing state, not just the transition.

### The lens source must be harness-independent (F1)

> **The pane string is a declaration by another name.**

This is the sharpest finding in the gate verdict on this document, and it breaks the naive
version of everything above.

The tmux pane string — the source that caught both drift instances in §"Why declaration is not
enough" — is **printed by the harness**. It is the harness's own claim about which model it is
running. That is a declaration wearing an observation's clothes. If a harness is misconfigured,
wrapped, or proxied, then `observed == declared == wrong`: the muster reports agreement, and the
lens invariant certifies a monoculture *as* diversity. The gate then fails in exactly the silent
way this document exists to prevent.

So the acceptable source depends on **what** is being observed:

| observing… | acceptable sources, strongest first |
|---|---|
| **liveness** | process table · pane activity · heartbeat TTL |
| **identity** | pane capture · session runtime metadata |
| **lens** | **provider contract · API-side attribution · behavioural probe** — pane capture is NOT sufficient |

Pane capture remains legitimate for liveness and identity. For **lens** it ranks below any
provider-side signal, because only the provider can attest which model actually served the
tokens. A muster that cannot obtain a harness-independent lens source reports `lens_unverified`
and treats it as it treats `crew_unobservable` — a NO-GO reason, not a shrug.

The general form, which is the whole document in one line: **an observation is only as
independent as the party that produced it.** Reading a value from the thing being measured is
not measurement.

#### Known limit: the required source may not exist

This is not a hypothetical gap, and a build must confront it before writing any code.

An independent check of `prime-agent`'s `openai-codex-responses` provider found that it
initialises `output.model` from the **requested** `model.id` *before* the upstream request is
made — verified in the shipped bundle, where `response.id` is stored but `response.model` is
never substituted back. So the session log's model field is a **routed label, not API-side
attribution**: it records what was asked for, never what answered. A direct provider-side
readback was then attempted and refused (401 upstream, 403 at the backend).

For that harness, today, **no harness-independent lens source is obtainable at all.**
`lens_unverified` is therefore not a rare edge case there — it is the default state, and the lens
invariant is *unenforceable* rather than merely unverified.

A build must decide, explicitly, which of these it does — and say so in the code, not in a
comment:

1. treat `lens_unverified` as a hard NO-GO, which grounds every flight on that harness until
   attribution exists;
2. accept a declared lens under a recorded, expiring exception with the risk named;
3. obtain attribution another way — a behavioural probe **(a pre-validated classifier with
   demonstrated family separability and confidence bounds)**, or a provider relationship that
   returns the serving model.

The qualifier on the probe is not pedantry, and leaving it off reopens this section's own hole:
a one-shot "which model are you?" prompt is answered *by the model*, which makes it a self-report
with extra steps — F1 again, one layer down. A probe only counts as attribution if it was
validated in advance against known models and can state its separability and confidence. An
unvalidated probe is a declaration that has learned to sound like a measurement.

What it must not do is let an unverifiable lens quietly satisfy the diversity constraint. That
converts this document from a gate into a decoration, which is the failure it was written to
describe.

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

### stalled vs blocked needs a named discriminator (F2)

> **`stalled` and `blocked` are discriminated by observation, never by guess.**

The table above asserts a distinction the machinery may not be able to draw. **Alive, no output
progress, no error** describes both states equally. Left unresolved, the taxonomy has four names
and three observable states, and the gap is not cosmetic:

- **false `stalled`** (it was actually waiting on input) → the role is filled and the flight
  departs while a crew member sits at a prompt. That is precisely the dead-crew hole the muster
  exists to close, reintroduced by the remedy.
- **false `blocked`** (it was actually stalled) → a flight holds, or a live session is discarded.

Candidate discriminators, in order of strength — a v1 implementation must name which it uses:

1. **Harness input-wait state** — the harness knows it is at a prompt; if it exposes that, it is
   decisive.
2. **Attached clients** — an interactive session with an attached client and a rendered prompt is
   blocked; a detached one producing nothing is stalled.
3. **Last-line shape** — a rendered prompt or menu as the final pane content indicates blocked.
   Weakest: it reads harness output, so it inherits the F1 problem.

**Default when none is available: `blocked` (hold), not `stalled`.** The asymmetry is deliberate
and the cost is stated rather than hidden — holding a flight is recoverable and visible; departing
with a crew member who is actually waiting is the failure this document was written about. Prefer
the machine that stops loudly over the one that proceeds quietly.

`drifted` deliberately has no auto-remedy. Silently trusting the observation would let a
compromised or misconfigured agent redefine its own identity by simply behaving differently —
the registry would follow it. #902 is that hole in its authorization form (any caller can
register itself as dispatch-eligible); auto-correcting drift would reopen it in identity form.

But **no auto-remedy is not the same as no remedy** (F4). Without a named path out, a drifted
agent is parked permanently and the rule gets disabled the first time that blocks real work.
The adjudication path:

1. The muster records the disagreement with every source and its value — never a single
   "correct" answer.
2. A **third party** adjudicates: not the drifted agent (it is the subject) and not the sole
   author of the record (it is an interested party).
3. Resolution is by **harness-independent source** where the field is lens; by operator ruling
   where no such source exists.
4. The registry is corrected to the adjudicated value, and the adjudication is recorded with its
   source. The agent does not correct its own entry.

This is not hypothetical: the gate reviewer of this very document is one of its two drift
instances, and recused himself from ruling on his own disposition — requiring independent
confirmation before it lands. That is the path working before it was written down.

## A seal is a claim about a file (F3)

> **A SEAL IS A CLAIM ABOUT A FILE AND MUST BE VERIFIED AGAINST THE FILE.**
> `muster.mustered` certifies `observed == declared`; the certification is itself a seal and
> must be re-verifiable against the observation records it names — never against a summary of
> them. Announcement ≠ text; relay ≠ evidence.

Same discipline as the rest of this document, applied to documents instead of agents. An agent
declares its model and the muster observes it; a coordinator declares a seal and the reader must
observe the text. A seal accepted without reading the artifact is a relay, and a relayed verdict
is what put a vacuous predicate one merge away from `main` in #1076.

The evidence is from the evening this spec was gated, and all three failures were sincere — every
author accurately reported their own intent while the file lagged behind it:

- **"we are 100% aligned"** — announced while the amendments were still unwritten.
- **"charter v1.2 sealed"** — announced while the amendment it named still carried the superseded
  text verbatim.
- **A6 collided.** Two principals stamped different amendments with the same number, in two copies
  of the charter, sixty seconds apart, neither seeing the other's write.
- **An amendment cited from memory that no file ever contained** — caught by its own author during
  reconciliation.

The A6 collision is this document's defect class demonstrated live: two principals writing one
shared artifact with no claim, which is the airspace collision `clearance.ts` already exists to
catch. It also produced the corollary:

> **The HOST is a shared `artifact_ref`.** Host remediation takes a claim the same way a file
> does. Two agents acted on host memory the same evening with neither declaring one.

### The rule is symmetric

> **A correction is also a claim about a file, and must be verified against the file before it is
> applied.**

The failures above are all one direction — text lagging an accurate announcement. The same evening
produced the other direction: an agent inferred from message traffic that a ruling had not
happened, and moved to edit the governing document to mark a *correctly sealed* clause as open.
The file had carried the ruling, with its timestamp, the whole time. It would have been the first
event to make the record **less** accurate rather than more, and it was performed while invoking
the seal rule.

And a fourth shape, subtler than the rest: **a substring match reported as its context.** One
agent grepped the charter for the revoked v1.1 phrasing, found it, and reported the clause as
unfixed — but the match was inside the sentence *revoking* it. The string that proved the defect
was the string that fixed it. The same error produced a host process count of 46 when the truth
was 24, because the matcher was hitting socket paths and wrapper shells rather than processes.

So the general form covers all four:

> **A claim about a file — a seal, a correction, or a grep result — must be verified against the
> file in context. A match is not a reading.**

Every one of these was sincere, and every one was caught only because somebody opened the
artifact. That is the argument for making verification mechanical rather than cultural: it caught
three different agents in one evening, and nothing in the system would have caught any of them.

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
`lens_unverified`, `author_is_gate`, `merge_delegated`, `crew_unobservable`, `crew_blocked`.

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
| tmux pane capture | strong for liveness/identity, **insufficient for lens** | the model string the harness itself prints — see F1 above: the harness attesting to itself is a declaration, not an observation |
| provider contract / API-side attribution | **required for lens** | which model actually served the tokens — the only harness-independent source |
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
