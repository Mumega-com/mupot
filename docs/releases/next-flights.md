# Next release flights

This is the execution runway from the current `0.30.0` source cut to the next
tagged stable release, followed by the first `v0.31.0` runtime flight. Version
ownership remains in [ROADMAP.md](../../ROADMAP.md); the shipped record remains in
[CHANGELOG.md](../../CHANGELOG.md).

## Release truth at 2026-09-01

| Surface | Exact state |
|---|---|
| Current `main` | `55c1c3efc194b352550e1b3f6b19e6e96e200ff1` (`0.30.0`) |
| Current production | `16390d1ea4b9684286237a12443e979e84cb7cdd` (`0.30.0`, `clean:true`) |
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
| A | Freeze the v0.30 candidate | One immutable `main` SHA after #1250, #1251, and #1252; no later merge contaminates its evidence | Push CI and CodeQL green at the frozen SHA; Athena exact-head release gate | **NEXT** |
| B | Build the v0.30 evidence bundle | Fresh install, upgrade, host, permission, lifecycle, external-PR, recovery, browser, runtime, MCP, and ACK receipts from the frozen SHA | `mupot-v030-prepublication-readiness/v1` prerequisites pass without reconstructed evidence | Pending A |
| C | Publish and soak `v0.30.0-rc.1` | RC tag, prerelease, exact deployment, smoke, soak, and release-candidate receipt | Separate Hadi approval for tag and deployment; no merge after the RC receipt | Pending B |
| D | Publish `v0.30.0` stable | Stable deployment, tag, GitHub Release, release-integrity receipt, and final readiness receipt at one SHA | Separate Hadi approvals for stable deployment and publication; Athena verifies the final bundle | Pending C |
| E | Converge the v0.31 receiver | One default-disabled Mupot-to-Codex receiver and host runner, built from the Hadi-admin operational implementation plus the Hadi-dev contract and policy lane | Required CI, identity/seat adversarial gate, replay proof, and one separately approved synthetic live canary | Post-v0.30 |

Any merge after Flight A invalidates Flights B and C. Land the correction through the
normal exact-head gate, freeze the new `main`, and restart from Flight A. No prior RC
receipt rolls forward to a different commit.

## v0.30 scope boundary

The following work is useful but excluded from the `v0.30.0` stable contract:

| Work | Routing |
|---|---|
| #1246 device grant | `v0.31.0` identity/onboarding; restack and re-gate |
| #1247 missing-token 503 | Post-`v0.30.0` patch candidate; rebase and exact-head gate |
| #1248 tenant path dispatcher | `v0.33.0` distribution/self-hosting surface |
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
