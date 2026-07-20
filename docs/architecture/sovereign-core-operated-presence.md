# Sovereign Core, Operated Presence

**Status:** Design + positioning. Approved in direction by Hadi 2026-07-20.
Feeds the roadmap (v0.26 precursor, v0.29 Distribution & Commercial Operations,
v1.0 GA). This document names *what we sell and how work crosses pots*; the
[ROADMAP](../../ROADMAP.md) owns *which version ships each piece*.

## Thesis

We do not sell software. We sell **operation**.

The mupot core is open and free to self-host — that is what makes the sovereignty
claim *true*, and it is the trust asset an auditor can read. What is genuinely
hard, and therefore what customers pay for, is **operating a pot well**: hosting
it, supporting it, and — the premium — having the Mumega team **check into** a pot,
set it up, and run it.

This resolves the honest critique of the sovereignty pitch (it reads as
"available today / effortless" when self-hosting is real work): sovereignty is
**real and free**; **effortless operation is paid**.

## Three tiers

| Tier | What the customer gets | Support | Price |
|------|------------------------|---------|-------|
| **OSS mupot** (self-host) | Fork the open core, run on their own Cloudflare account, receive the **public update stream**. Complete, sovereign pot. | None (community / self-serve) | Free |
| **mupot.mumega.com** (managed SaaS) | We host and run their pot: updates applied, SLA, support. | Full | $ subscription |
| **Operated Presence** (agency) | The Mumega team **checks into** their pot (self-hosted *or* SaaS), sets up agents + automations, operates it. Metered. | Full + hands-on | $$ metered presence |

Rules that make the boundary clean:

- **Free = public updates only, on their own.** A non-paying self-hoster gets the
  release stream and nothing else. Zero support burden on us.
- **Support is gated by payment**, independent of where the pot runs. A paying
  self-hoster gets support (and can invite Operated Presence); a non-paying one
  does not.
- **What we build inside a customer pot stays theirs.** Presence sets things up
  and leaves; the customer owns the result.

## Open-core line

**Core fully open; monetize the *service*, not features.** The whole sovereign
pot is OSS — a self-hoster gets a real, complete pot, so trust stays maximal.
Customers pay for hosting + support + presence, not to unlock capabilities.

Surfaces that only make sense in the managed/agency context — the **multi-pot
portfolio hub** and the **presence-metering / billing** rollup — simply *live* on
mupot.mumega.com because that is where they are meaningful, not because they are
license-gated. A self-hoster running a single sovereign pot never needed them.

License: the repo ships the **Mumega Sustainable Use License** (fair-code —
source-available, free to self-host, hosting/resale rights reserved). This
already supports the model. To verify before commercial launch: the license text
explicitly covers (a) no support obligation without payment and (b) no reselling
mupot *as a hosted service*.

## Project as the heart; pot as the sovereign substrate

The unit a human works in is the **Project**, not the pot. A pot is a sovereignty
and execution boundary (one D1 = one pot = one tenant's data). A Project is the
outcome. This is already the v0.24 vocabulary — extended here across pots:

```
        PORTFOLIO PLANE  (mupot.mumega.com — where the operator works)
        Projects · assignable agents · one unified queue
                 |             |             |
            ┌────┘        ┌────┘        └────┐
        mumega pot     dme pot      viamar pot     ← sovereign pots (each its own D1)
        (D1)           (D1)         (D1)             data never crosses the boundary
```

A Project may draw on **multiple pots**. It does not merge their data — that
would break sovereignty. It **references** work in each pot and executes there via
Operated Presence. Project = the heart; check-in/out = the multi-pot *execution
verb*.

## Operated Presence — the check-in / check-out mechanism

The agent goes *to* the work. It operates **inside** the customer's pot, natively,
using that pot's own RBAC, audit ledger, and receipts. Nothing leaves the
customer's boundary; the customer watches every guest action in their own ledger
and can force-checkout at any instant.

1. **Check-in.** The customer pot mints a **guest credential** for the visiting
   agent: least-privilege capabilities, a **capability ceiling**, and an
   **expiry**. This is the existing `mint_agent_token` path extended with a
   `guest` channel + TTL. The customer (or a pre-set policy) approves — a signed
   request, on the Fleet-Control signed-control-plane template.
2. **Work.** The visiting agent (e.g. kasra, cursor, a mumega squad) sets up the
   customer's environment — provisions *their* agents and automations, files
   *their* tasks/flights — all recorded in the **customer's** audit ledger.
3. **Check-out.** The credential auto-expires or the customer revokes it. Standing
   access returns to zero. The setup stays; the customer owns it.
4. **Meter.** Guest presence (session-time / actions / flights) rolls up in the
   customer pot's `meter` and produces a **tamper-evident invoice** (signed
   receipts) — Stripe-Connect-% for reseller/agency splits.

This is the [dock model](../../README.md) (dock = access, undock = revoked) and
**no-standing-admin** (mint → use → revoke) turned into a billable service.

### The one risk to nail
The guest trust boundary. A guest credential must be **least-privilege +
time-boxed + capability-ceilinged + customer-revocable**, and every guest action
must land in the **customer's** ledger. Reuse the directory-door zero-capability
ceiling pattern already in `src/mcp/oauth-authorize.ts`. This is a mandatory
diverse-gate (dual-vendor adversarial) surface when built — a guest token is a
cross-tenant authority vector if the ceiling is wrong.

## First paid flight: DME

DME activation is blocked precisely because there is no clean way for the Mumega
team to enter the DME environment and set it up. **Operated Presence is that
mechanism.** The first check-in flight = the Mumega team docks into the DME pot,
provisions DME's agents + automations, checks out — and it is the first metered
presence. One flight unblocks DME *and* proves the commercial model.

## Honest gradient (replaces the oversold table)

The deployment gradient is the **pricing ladder**, marked by what actually ships:

| Mode | Status | Tier |
|------|--------|------|
| Managed (we host) | shipped | SaaS $ |
| Your Cloudflare (`wrangler deploy`) | shipped — how mumega/DME run today | OSS free / SaaS $ |
| Your servers (workerd + storage adapters) | adapter-layer, partial | OSS free (DIY) |
| On-prem / air-gap | planned | OSS free (DIY) + presence $$ |
| Edge (Jetson-class) | planned | exploratory |

workerd runs the coordination layer off-cloud today; Vectorize + Workers-AI have
no off-CF path yet ([mupot#411](https://github.com/Mumega-com/mupot/issues/411)).
Rows past "Your Cloudflare" are the adapter roadmap, not a one-command deploy.

## Roadmap pointers

- **v0.24 (shipping):** single-pot Projects + narrow cross-pot Project Link — the
  foundation this extends.
- **v0.26:** governed tools introduce scoped credentials without exposing raw
  secrets — the **guest-credential** primitive is the same governance family
  (precursor).
- **v0.29 (Distribution & Commercial Operations):** Operated Presence (metered
  check-in/out), tier entitlements (OSS / SaaS / agency), support-gating for
  self-host, and the public update channel for the free tier.
- **v1.0 GA:** at least one real business (Mumega/DME) operated end-to-end through
  a Project, presence metered and billed.
