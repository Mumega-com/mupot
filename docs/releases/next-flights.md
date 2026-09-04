# Next release flights

This is the execution runway from the current `0.30.0` source cut to the next
tagged stable release, followed by the first `v0.31.0` runtime flight. Version
ownership remains in [ROADMAP.md](../../ROADMAP.md); the shipped record remains in
[CHANGELOG.md](../../CHANGELOG.md).

## Release truth at 2026-09-04

| Surface | Exact state |
|---|---|
| Current `main` | `0.30.0` — not pinned here; read `git rev-parse origin/main` |
| Current production | `0.30.0` — read live `/health`; last recorded deploy `4fd452eb0b6a618d1db2a18206eee8616d44f276`, `clean:true`, 2026-09-04 (#1312). Six PRs merged after it, so production trails `main`. |
| Latest tagged stable release | `v0.25.0` |
| Next stable candidate | `v0.30.0` |
| Next development release | `v0.31.0` |

The three states are intentionally different. Code on `main` is not necessarily
deployed; deployed code is not necessarily stable; a stable claim requires the exact
tag, GitHub Release, deployment, contract receipts, and final readiness verdict to
agree.

## Ordered flight queue

Flight identifiers are assigned only when a flight is launched. The names below own
the order and acceptance boundary; they are not reusable historical flight IDs.

| Order | Flight | Deliverable | Gate | State |
|---|---|---|---|---|
| A | Freeze the v0.30 candidate | One immutable `main` SHA with no later merge contaminating its evidence | Push CI and CodeQL green at the frozen SHA; Athena exact-head release gate | **RESTART REQUIRED** — see supersession below |
| B | Build the v0.30 evidence bundle | Fresh install, upgrade, host, permission, lifecycle, external-PR, recovery, browser, runtime, MCP, and ACK receipts from the frozen SHA | `mupot-v030-prepublication-readiness/v1` prerequisites pass without reconstructed evidence | Pending A |
| C | Publish and soak the RC | RC tag, prerelease, exact deployment, smoke, soak, and release-candidate receipt | Separate Hadi approval for tag and deployment; no merge after the RC receipt | Pending B — `v0.30.0-rc.1` exists but is superseded; a new RC is required |
| D | Publish `v0.30.0` stable | Stable deployment, tag, GitHub Release, release-integrity receipt, and final readiness receipt at one SHA | Separate Hadi approvals for stable deployment and publication; Athena verifies the final bundle | Pending C |
| E | Converge the v0.31 receiver | One default-disabled Mupot-to-Codex receiver and host runner, built from the Hadi-admin operational implementation plus the Hadi-dev contract and policy lane | Required CI, identity/seat adversarial gate, replay proof, and one separately approved synthetic live canary | Post-v0.30 |

Any merge after Flight A invalidates Flights B and C. Land the correction through the
normal exact-head gate, freeze the new `main`, and restart from Flight A. No prior RC
receipt rolls forward to a different commit.

## Supersession — 2026-09-04

`v0.30.0-rc.1` was tagged at `0bb9c256` on 2026-09-03. `main` is now 13 commits ahead of it.
By this document's own rule below, and release order step 7 in the contract, **no prior RC
receipt rolls forward** — the RC is superseded and Flights A and B must be re-run from a
newly frozen `main`.

Three PRs that this document's scope boundary routed OUT of `v0.30.0` have since landed on
`main` — #1246 (routed to v0.31.0), #1247 (routed to post-v0.30.0) and #1248 (routed to
v0.33.0). They were merged on 2026-09-04 at Hadi's direction as part of clearing the open-PR
backlog. The consequence is factual and unresolved: **the contents of `main` no longer match
the written scope of the v0.30.0 stable candidate.**

Two ways forward, and the choice is the owner's:

1. **Re-cut v0.30.0 to include them.** The scope boundary table below is then rewritten
   rather than merely annotated, and the security train section gains the three defects
   closed on 2026-09-04.
2. **Take the stable candidate from a commit that predates them.** This preserves the
   written scope but excludes three closed production vulnerabilities from the stable
   release, which is the harder position to defend.

Until that is decided, the rows below describe the plan as written, not the state of `main`.

## v0.30 scope boundary

The following work is useful but excluded from the `v0.30.0` stable contract:

| Work | Routing |
|---|---|
| #1246 device grant | `v0.31.0` identity/onboarding; restack and re-gate. **LANDED ON `main` 2026-09-04** — routing above is the plan as written, not the current state. |
| #1247 missing-token 503 | Post-`v0.30.0` patch candidate; rebase and exact-head gate. **LANDED ON `main` 2026-09-04** — routing above is the plan as written, not the current state. |
| #1248 tenant path dispatcher | `v0.33.0` distribution/self-hosting surface. **LANDED ON `main` 2026-09-04** — routing above is the plan as written, not the current state. |
| #1253 MCP self-registration | `v0.31.0` identity/onboarding; remains draft |
| #1254 enrollment chooser and seat key | `v0.31.0` identity/access; requires an independent exact-head security gate |
| `servathadi/cc#1` receiver engineering record | Evidence source for Flight E, not a Mupot product merge |

Closing or deferring an item is not a claim that its design is wrong. It protects the
stable candidate from scope drift and gives each surface its own evidence boundary.

## Flight E convergence inputs

The receiver flight starts only after `v0.30.0` is stable and pins these inputs before
any reconciliation:

- Mupot server receipt implementation: #1249 merge `16390d1e`;
- Hadi-dev contract/reference head `f52f89daca4701cb4e4a0edfc393745a61bb2d75`,
  package subtree `f72c70101dd1ddf2deaaf027bfde68d2eacb2f47`;
- Hadi-admin operational package subtree
  `807eb57b894945c74c101104f6c4af4708471df5`;
- private engineering record `servathadi/cc#1` at the exact reviewed head used by
  the flight.

The Hadi-admin package is the executable base. Hadi-dev contributes the canonical MCP
mapping, identity normalization, fixed receipt transport, plain-record/no-fetch
hardening, host-policy gates, plugin packaging, and cross-harness contract. The trees
must be reconciled requirement by requirement; they must not be mechanically merged or
allowed to become a third receiver.

Flight E is complete only when:

1. one canonical package and runner remain;
2. bearer-derived agent identity and server-authorized seat selection agree across
   `check_in`, inbox lease/ACK, and send;
3. CI reproduces both source suites, dry runs, secret scans, no-network assertions,
   quarantine, artifact mismatch, and zero-duplicate replay cases;
4. a bounded synthetic live canary produces one exact chain:
   `dispatch -> lease -> accepted start -> runtime consumption -> correlated ACK ->
   artifact hash -> review -> independent verdict`;
5. persistent service installation and real-seat activation remain separately approved.

## Authority boundary

This runway authorizes documentation, branch preparation, tests, and evidence
collection. It does not authorize a merge, tag, GitHub Release, deployment, migration,
credential operation, App Server start, persistent service installation, ACL change, or
real customer task.
