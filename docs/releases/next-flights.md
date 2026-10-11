# Next release flights

This is the execution runway from the `v0.31.0` tag ("Office", 2026-09-29) to the next
tagged release, `v0.32.0`. Version ownership remains in [ROADMAP.md](../../ROADMAP.md);
the shipped record remains in [CHANGELOG.md](../../CHANGELOG.md). Rewritten 2026-10-11;
the v0.30 flight queue it replaces is superseded by the tags that shipped.

## Release truth at 2026-10-11

| Surface | Exact state |
|---|---|
| Current `main` | Far past the tag — read `git rev-list --count v0.31.0..origin/main` and `git rev-parse origin/main`; not pinned here. Migrations 0182 onward are unreleased. |
| Current production | Read live `/health`; it moves independently of `main` and of tags. |
| Latest tagged stable release | `v0.31.0` — annotated tag at `52299bab`, 2026-09-29, with GitHub Release "v0.31.0 — Office" |
| Next stable candidate | `v0.32.0` — "Agents as themselves and governed autonomy" |
| Planned branch | `release/v0.32.0`, created from the approved frozen SHA in step 6; not claimed to exist yet. `release/v0.31.0` was never cut; there is no `v0.31.x` patch path. |

Code on `main` is not necessarily deployed; deployed code is not necessarily stable; a
stable claim requires the exact tag, GitHub Release, deployment, release receipts, and
final readiness verdict to agree.

## Ordered flight queue — v0.32.0

Flight identifiers are assigned only when a flight is launched. The steps below own the
order and acceptance boundary. They are the release contract in ROADMAP.md.

| Order | Step | Done when |
|---|---|---|
| 1 | Seats without manual mint | A member's Claude Code, Codex, and ChatGPT threads each act under their own seat agent with no manual token mint. Record development canaries on the flight parent (one read-only call each under `SEAT_AUTO_ENROLL=1`, seat rows read back); final acceptance requires all three canaries to be regenerated at and bound to the frozen `release_sha` in step 5 |
| 2 | Loop brakes | Dry-run default, pause, per-task retry ceiling, and human-only release are deployed and covered by tests |
| 3 | Close P0 #1565 | Issue closed with the fix on `main` |
| 4 | Close admin-tool disclosure | #1608 and #1609 (the #1596 phase-1b disclosure items) closed; #1596 itself is the Cloudflare Forge adoption epic and is not required to close |
| 5 | Freeze and gate | One frozen `release_sha`; repository-required independent gate owners/lenses GREEN and CI green at that SHA. Deploy the candidate through the authorized deployment path before final canaries; record the target/runtime endpoint and `/health` readback proving deployed SHA equals `release_sha`. Regenerate Claude Code, Codex and ChatGPT seat canaries against that verified runtime; bind their endpoint, actor/seat readbacks and observed deployment SHA to `release_sha`. Build and pass `mupot-v032-prepublication-readiness/v1` from fresh bound receipts, including permission/installation evidence (schema and checker defined before the freeze) |
| 6 | Cut and publish | Separately authorized `release/v0.32.0` cut, annotated tag and GitHub Release all resolve to the approved `release_sha` |
| 7 | Verify published stable | Observe stable deployment at that same SHA; export published tag/Release/artifact and live deployment evidence; pass `release-integrity-check.json` and the version-specific final postpublication readiness check; attach the independent final verdict. Stable completion requires all published surfaces, receipts and verdicts to agree on `release_sha` |

Any change that replaces the frozen candidate `release_sha` invalidates its evidence:
land the correction through the normal gate, re-freeze, and restart step 5, including
candidate deployment verification and all three final seat canaries. Unrelated `main`
merges do not change an already frozen candidate. A pre-freeze canary or a receipt
bound to another SHA cannot be carried into the final bundle.

## Evidence hygiene — read before building the aggregate bundle

The host-side receipts directory for the Codex attach contains two receipts dated
2026-08-30, **both `status: "fail"` with `release_sha: null`**. It is the only Host-Go-shaped
bundle on the host, and it has neither `manifest.json` nor `cutover-gate.json`.

A glob such as `*-check.json` when assembling the aggregate evidence directory **will sweep
these in**. Exclude that directory explicitly (it holds two `status: fail` receipts with `release_sha: null`), or move it aside first. The contract's own rule —
an unbound historical outer bundle cannot admit a bound prior bundle — means including it
does not merely add noise, it invalidates the bundle.

Verified state of the prepublication receipts as of 2026-09-04: **1 of 11 exists**
(`mupot-github-app-permissions/v1`, passing 35/35). That is a historical inventory,
not permission to reuse its then-current GitHub state. Export fresh app permissions and
installation status and regenerate the permission receipt at the v0.32.0 freeze, even
though that receipt type is independent of source SHA. Produce the other ten receipts
fresh from the frozen SHA. Retain historical bytes as history, not current acceptance.

## Authority boundary

This runway authorizes documentation, branch preparation, tests, and evidence
collection. It does not authorize a merge, tag, GitHub Release, deployment, migration,
credential operation, or real customer task.
