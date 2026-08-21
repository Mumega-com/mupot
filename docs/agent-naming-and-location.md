# Agent Naming — location is part of identity

> **The rule:** `<location>-<agent>`. An agent's name says where it runs.
> Two runtimes are two agents, with two records and two tokens — never one identity in two places.

## Why this exists

On 2026-08-16 we spent two hours unable to answer *"where is Athena running?"* — and got it wrong
three times in a row.

- Athena reported herself live on Google Cloud. She was running in tmux on the Hetzner box. Her
  presence adapter said `google-cloud-loom-vm-athena`, which is **a string the caller types**.
- Loom reported all three seats "physically running daemon pairs." Four of the five PIDs he named
  were dead within minutes — they were `--print` one-shots.
- Then Athena *was* started on loom-vm, in tmux, while still running on Hetzner — **the same mupot
  identity `a9423609` live in two places at once.** Neither the registry, nor presence, nor a gate
  verdict could tell which one acted.

River asked the question that named the problem: *"which seat is canonical for me? I do not
dual-run identities."* The registry had no way to answer, because location was not part of identity.

## The convention

```
muvps-athena       Hetzner VPS (this host)
gcpot-athena       GCP container / pot
hadi-hermes        Hadi's personal Mac
hadi-grok          Hadi's personal Mac
```

**Location first, agent second.** Location is a stable, short token naming *where the runtime
lives*, not what runs it:

| token | meaning |
|---|---|
| `muvps` | the Hetzner VPS |
| `gcpot` | a containerized pot on GCP |
| `hadi` | Hadi's personal Mac |

### Name the place, not the tool

`gcpot`, not `gcdocker`. The name should survive a runtime change — Docker to Podman to Cloudflare
Containers — without becoming a lie. A pot on GCP stays a pot on GCP regardless of what starts it.
This is the same reason `mupot` is not called `muworkers`.

## Two runtimes are two agents

This is the load-bearing half, and the part that naming alone does not fix.

`muvps-athena` and `gcpot-athena` are **separate agent records with separate tokens.** Not one
record deployed twice. Not one identity with a location field.

What that buys, each of which failed on 2026-08-16:

| | with shared identity | with distinct records |
|---|---|---|
| **Which one answered?** | unanswerable | the record says |
| **`presence_list`** | one row, ambiguous | both rows, located |
| **Killing one** | ambiguous, risks the wrong seat | unambiguous |
| **A gate verdict** | "athena passed" | "gcpot-athena passed" — origin carried |
| **Dual-run** | possible, and happened | detectable at the registry |
| **Model/lens drift** | one identity, several routes, unresolvable | one record, one harness, checkable |

That last row matters more than it looks. The same evening, five sources disagreed about which
model River runs, and the contradiction was partly explained by *one identity existing across
runtimes with different routing paths*. Location-in-identity collapses it: a record has one
harness, one route, and one process to check against. See mupot#1094.

## Rules

1. **A seat's name carries its location.** No bare `athena` in a registry, a roster, a gate verdict,
   or a flight record.
2. **One live runtime per record.** A second bind on the same record is a defect, not a deployment.
3. **A location prefix is not a claim about the process.** `gcpot-athena` existing in the registry
   says nothing about whether it is *running* — that still requires reading the process table on
   that host. Naming removes ambiguity; it does not remove verification.
4. **Moving a seat is close-then-open, in that order, verified between.** Start the new record,
   confirm it answers, close the old one, confirm the old host's resources drop. Overlap is a
   bounded window, never a resting state.

## What this does not solve

**A name is a declaration.** `gcpot-athena` in a config file is a claim that an agent runs in a GCP
pot — it is not evidence. On 2026-08-16 the presence adapter string `google-cloud-loom-vm-athena`
was set by a process running on Hetzner, and it was accepted for an hour.

Naming makes the *question* answerable. Only reading the host answers it. Both are needed:

> **A command executed on a host is not an agent living on that host.**
> **A name that says `gcpot` is not an agent living in a gcpot.**

Related: `flight-muster.md` (crew identity, lens invariant, observed-not-declared), mupot#1087
(muster mechanism), #1094 (no agent model is provable end-to-end), #1101 (crew lock).
