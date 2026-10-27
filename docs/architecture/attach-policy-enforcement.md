# Attach policy enforcement

A project attached to a pot through `seed_attach` (see `seed-v1.md`) works under four rules about the
evidence it leaves and who may decide. Each rule is enforced by a tool refusal or a CI check, never by
prose alone. This page lists, per rule, the one function that enforces it, the refusal a caller sees, and
the test that proves it (every refusal was mutation-checked: removing the guard makes its test fail).

| Rule | Enforcer (the one shared function) | Refusal | Tests |
|---|---|---|---|
| A receipt's artifact and hash must be well formed, not placeholders | `verifyTaskArtifactShape`, `src/tasks/artifact-verification.ts`. Every review-entry path calls it: `task_submit_result`, `task_update`, REST task PATCH, runtime receipts, in-Worker execution | `artifact_verification_failed` with `detail.reason` = `artifact_placeholder`, `sha256_placeholder`, `sha256_malformed`, `sha256_not_claimed`, `no_artifact_claimed`, `disallowed_path`, `refusal_prose`, `no_result` | `tests/artifact-verification.test.ts`, `tests/task-submit-result.test.ts` |
| Nobody gives a verdict on their own task | the verdict write itself: `buildVerdictStatements`, `src/tasks/service.ts` (its `UPDATE ... WHERE`), using the fragments in `src/tasks/verdict-independence.ts`; `evaluateVerdictGates` runs the same fragments as the pre-check | `409 self_verdict` | `tests/verdict-independence-matrix.test.ts`, `tests/self-completion-producer-authority.test.ts` |
| Effectful tools with a `dry_run` argument default to the dry run | CI ratchet `scripts/check-effectful-tools-dry-run.mjs` (job `effectful-tools-dry-run`) | build fails | `tests/check-effectful-tools-dry-run.test.mjs` |
| A deploy on a seed-attached project needs a canary receipt and a rollback line | `checkDeployPolicy`, `src/projects/deploy-policy.ts`, called inside `deployProject` (the MCP tool, the REST route and the dashboard button all go through it) | `409` with `canary_receipt_required`, `canary_receipt_not_found`, `canary_receipt_archived`, `canary_receipt_wrong_project`, `canary_receipt_not_canary`, `canary_receipt_not_passed`, `canary_receipt_stale`, `canary_receipt_self_certified`, `canary_receipt_reused` or `rollback_required`; and Studio dispatch of such a project's repository is refused with `409 studio_dispatch_seed_attached_use_project_deploy` | `tests/project-deploy-policy.test.ts`, `tests/repo-identity.test.ts` |

## Receipt shape

The gate is a shape check, not a byte check: it cannot read the file the artifact names. It refuses
an all-zero digest, any digest that is one repeated character, a short unit repeated to fill 64
characters (`deadbeef` repeated, `ab` repeated), a counting run, a `SHA256:` value that is not exactly
64 hex characters (the whole token after the label is judged, so a 65-character value is refused rather
than truncated), and an `Artifact:` that is empty or a stand-in word (`TBD`, `N/A`, `<path>`,
`${ARTIFACT}`, `path/to/...`). Every `SHA256:` label in the body is judged, so a real digest placed after
a placeholder does not launder it. Real results are not refused: a markdown link, a parenthesised path,
backticks or a URL autolink around the artifact are unwrapped and the target is judged; a `sha256:` /
`sha256-` prefix and a `-dirty`-style suffix on the digest are tolerated, as is a bold or code-span label
(`**SHA256:**`, `**SHA256**:`, `` `SHA256:` ``); and a `SHA256:` label is judged
only when its value looks like a hash attempt (hex of 32+ characters, a template such as `<hash>`, or hex or
a placeholder word on the receipt's own line-initial label). Prose (`SHA256: see above`) and a short hex on a
non-primary label (`Commit SHA256: abc1234`) are ignored, not refused. A well-formed digest that matches nothing is still undetectable here;
byte verification belongs to an evidence store the server can read.

## Verdict independence

The parties to a task's work are its assignee (agent or human), every agent that submitted a result for
it, and every agent or member recorded as running it. Only the stages where the work was actually run count
(`runtime_consumed`, `completed`, `failed`); an operator's `reset_terminated` marker records the operator's
member id but does not make them a runner, so an admin who reset a lease can still decide. A decider is refused when it is a party
(`direct`) or acts for one (`affiliated`): a member who owns, is bound to, or holds the key of a party
agent, or an agent owned by or bound to the human assignee.

The rule is re-asserted inside the verdict `UPDATE`'s own `WHERE`, so a party change between a caller's
check and the write cannot land a self-verdict. All verdict surfaces (MCP, REST, chat approval, the
harness-attested origin path, the office approval tool) write through that one builder.

Exemptions are explicit values on the write input, never a default:

- `admin_supervisory`: an org owner or admin who is only *affiliated* with the assignee (the existing
  supervisory path). It never waives a direct party or an affiliation where the decider owns any party agent.
- `owner_self`: a member who owns every party agent they are affiliated with and is bound to none
  of them may decide with two current, independent passing review lenses. This also permits an owner
  who minted the assignee's key on MCP and Telegram; Telegram still refuses non-owner key minters.
- `owner_override`: the org owner's explicit `override_self_verdict: true`, recorded in the verdict note.
- the `gate:agent-self-completion` lane exempts only the agent that produced the task's current result, and only while that agent is also the task's current assignee. "Produced" is read from the append-only `task_result_submissions` ledger: the execute landing and `task_submit_result` each write a row (carrying the exact submitted `result_text`) in the same batch as the move to review, and the producer is the submitter of the latest row for this tenant whose `result_text` equals the task's current result (a result replaced by any other writer, such as the CI sync, no longer matches). A submission that an unreversed rejection came after is spent: the same text written back by another path does not revive it, and only a fresh submission does. Producer, assignee, the lane itself and a present result are all re-read inside the write's `WHERE`, so a reassignment or re-gate after the check cannot land it. The assignee alone is not authority, because it can be changed outside review. With no ledger row, or a legacy row without `result_text`, the exemption does not apply and the decider is judged like on any other lane. Any other decider on that lane (including an org owner or admin who is a direct party) is judged like every other lane and needs `owner_override`; that override still requires the task to be on the lane at write time.

An org admin who both owns a party agent and is bound to it is intentionally refused even with
valid lenses: the binding excludes `owner_self`, and ownership excludes `admin_supervisory`.
The only remaining exception is the explicit `owner_override`, which requires the legacy
`auth.role === 'owner'`; an org admin or owner capability grant alone does not enable it.
MCP member authentication sets `auth.role` to `member`, so that override is unavailable to
those callers even with `override_self_verdict: true`. Use an independent decider; this restriction
is intentional and does not call for widening MCP authority.

A task sent back from `rejected` to `in_progress` (by an update, an execute claim or a runtime consume) has its rejected result cleared, so it can re-enter review only through a fresh submission by whoever does the rework. A verdict reversal restores the same work to review and cannot change the assignee in the same call.

Known and deliberate: two agents that share an owner may review each other's work on their own
authority (this was already the documented behaviour of the harness-attested origin path). Tightening
that is a separate policy decision.

## Dry-run defaults

`scripts/check-effectful-tools-dry-run.mjs` reads every tool declaration in `src/mcp/*.ts` with the
TypeScript compiler API and the annotation table. A tool that declares `dry_run`, and is not annotated
read-only, must read the argument back only as a comparison against `false`. A comparison against `true`,
a truthiness test, a `??`/`||` default, a schema `default: false`, a tool that never reads it back, or a
`dry_run` property outside a recognised declaration all fail. An exemption is a named entry with a
justification in the script's `ALLOW` map; a stale or redundant entry also fails. The two tools
that carry the argument today (`router_tick`, `seed_attach`) both default to the dry run.

## Deploy on a seed-attached project

A project is seed-attached when `project_seeds` holds a row for it. For such a project a deploy must carry:

- `canary_receipt`: the id of a task **in the same project**, gated by `gate:canary` (the gate lane is
  held only by principals an admin granted it to, which is what makes it a canary rather than any task),
  currently `approved` (or `done`) with its latest verdict an un-reversed approval, approved within the
  last 24 hours, by someone other than the caller deploying;
- `rollback`: a non-empty line (at most 500 characters, not a placeholder word).

"Someone other than the deployer" is affiliation, not raw ids: the approver is refused when they are the
deployer, an agent owned by, bound to, or keyed to a deployer identity, or a member who owns, is bound to, or holds
the key of the agent the deployer is acting through. An archived canary does not vouch. One canary backs
one deploy: the deploy's receipt records `canary:<task id>:` in `deployment_id` (the table is append-only),
the check refuses a canary already recorded for the project, and the receipt INSERT itself refuses a second
claim, so two concurrent deploys cannot both use it. The claim is the receipt INSERT, which comes after the
`deploy_status` flip and the task and flight dispatch: the receipt is immutable and carries the flight id, so
it cannot be written first without losing that id. A losing racer therefore still flips `deploy_status` to
`deploying` and can leave one bookkeeping task and flight behind; only its receipt, which is the record of the
deploy, is refused. Moving the claim ahead of the dispatch needs a reservation row (a migration) and is not done. Binding the canary to a specific
commit is not done: the canary is not recorded against a commit anywhere.

Entry points covered, all through the same check:

- `deployProject`: the `project_deploy` tool, `POST /api/projects/:id/deploy`, and the dashboard deploy button;
- the dashboard "dispatch flight" button, which shows the refusal instead of redirecting.

Studio dispatch has no canary path. `dispatchStudioFlight` (`POST /api/studio/dispatch` and the Studio API
`/dispatch`) refuses outright, with `409 studio_dispatch_seed_attached_use_project_deploy`, any `repoUrl` that is
the repository of a seed-attached project, before any slot is reserved, any agent launched, or any task or
flight written. Use `project_deploy`. Repositories are compared by identity, not by string: scheme, userinfo,
port, host case, a trailing-dot host, percent-encoding (each path segment decoded on its own, at most 3 passes; a segment that has a bad escape or is still changing after the third pass makes the identity unsure, which matches), repeated trailing slashes and
`.git`, `ssh://` and scp-style forms, the `www.`, `api.` and `codeload.` GitHub hosts, and anything after
owner/repo (`/tree/main`) all fold to one repository. When unsure the match is coarser, so the refusal errs
toward refusing: an owner-only GitHub URL matches every repository of that owner.

Not covered, by design: `task_create` and ordinary task or flight creation. The policy guards deploy entry points
only; it does not stop a member from creating a task that describes a deploy.

Not covered yet: `cursor_dispatch` (`src/mcp/cursor.ts`). It launches Cursor cloud runs against any `repo_url`
and has no seed-attached check, so it is a way around the Studio refusal for a seed-attached project's
repository. Tracked as a follow-up issue.

The policy check (every refusal code except the concurrent-claim case above) runs before anything is written:
such a refusal leaves no `deploy_status` flip, no task, no flight and no deployment receipt. The accepted evidence is recorded in the dispatched task body and the flight
`receipt_refs`. Projects that are not seed-attached are unaffected.

The REST route takes `canary_receipt` and `rollback` in its JSON body; the dashboard's one-click button
cannot carry them and answers a seed-attached project with a readable `409`. `project_deploy` is the only
deploy-class tool; a test pins that list so a new one has to be added to this policy on purpose.
