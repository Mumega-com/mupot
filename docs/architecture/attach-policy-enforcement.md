# Attach policy enforcement

A project attached to a pot through `seed_attach` (see `seed-v1.md`) works under four rules about the
evidence it leaves and who may decide. Each rule is enforced by a tool refusal or a CI check, never by
prose alone. This page lists, per rule, the one function that enforces it, the refusal a caller sees, and
the test that proves it (every refusal was mutation-checked: removing the guard makes its test fail).

| Rule | Enforcer (the one shared function) | Refusal | Tests |
|---|---|---|---|
| A receipt's artifact and hash must be well formed, not placeholders | `verifyTaskArtifactShape`, `src/tasks/artifact-verification.ts`. Every review-entry path calls it: `task_submit_result`, `task_update`, REST task PATCH, runtime receipts, in-Worker execution | `artifact_verification_failed` with `detail.reason` = `artifact_placeholder`, `sha256_placeholder`, `sha256_malformed`, `sha256_not_claimed`, `no_artifact_claimed`, `disallowed_path`, `refusal_prose`, `no_result` | `tests/artifact-verification.test.ts`, `tests/task-submit-result.test.ts` |
| Nobody gives a verdict on their own task | the verdict write itself: `buildVerdictStatements`, `src/tasks/service.ts` (its `UPDATE ... WHERE`), using the fragments in `src/tasks/verdict-independence.ts`; `evaluateVerdictGates` runs the same fragments as the pre-check | `409 self_verdict` | `tests/verdict-independence-matrix.test.ts` |
| Effectful tools with a `dry_run` argument default to the dry run | CI ratchet `scripts/check-effectful-tools-dry-run.mjs` (job `effectful-tools-dry-run`) | build fails | `tests/check-effectful-tools-dry-run.test.mjs` |
| A deploy on a seed-attached project needs a canary receipt and a rollback line | `checkDeployPolicy`, `src/projects/deploy-policy.ts`, called inside `deployProject` (the MCP tool, the REST route and the dashboard button all go through it) | `409` with `canary_receipt_required`, `canary_receipt_not_found`, `canary_receipt_wrong_project`, `canary_receipt_not_canary`, `canary_receipt_not_passed`, `canary_receipt_stale`, `canary_receipt_self_certified` or `rollback_required` | `tests/project-deploy-policy.test.ts` |

## Receipt shape

The gate is a shape check, not a byte check: it cannot read the file the artifact names. It refuses
an all-zero digest, any digest that is one repeated character, a short unit repeated to fill 64
characters (`deadbeef` repeated, `ab` repeated), a counting run, a `SHA256:` value that is not exactly
64 hex characters (the whole token after the label is judged, so a 65-character value is refused rather
than truncated), and an `Artifact:` that is empty or a stand-in word (`TBD`, `N/A`, `<path>`,
`${ARTIFACT}`, `path/to/...`). Every `SHA256:` label in the body is judged, so a real digest placed after
a placeholder does not launder it. Real results are not refused: a markdown link, a parenthesised path,
backticks or a URL autolink around the artifact are unwrapped and the target is judged; a `sha256:` /
`sha256-` prefix and a `-dirty`-style suffix on the digest are tolerated; and a `SHA256:` label is judged
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
  supervisory path). It never waives a direct party.
- `owner_override`: the org owner's explicit `override_self_verdict: true`, recorded in the verdict note.
- the `gate:agent-self-completion` lane waives the rule by construction.

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
deployer, an agent owned by or bound to a deployer identity, or a member who owns, is bound to, or holds
the key of the agent the deployer is acting through. An archived canary does not vouch. One canary backs
one deploy: the deploy's receipt records `canary:<task id>:` in `deployment_id` (the table is append-only),
the check refuses a canary already recorded for the project, and the receipt INSERT itself refuses a second
claim, so two concurrent deploys cannot both use it. (A losing racer can still leave one bookkeeping task and
flight behind; its receipt, which is the record of the deploy, is refused.) Binding the canary to a specific
commit is not done: the canary is not recorded against a commit anywhere.

Entry points covered, all through the same check:

- `deployProject`: the `project_deploy` tool, `POST /api/projects/:id/deploy`, and the dashboard deploy button;
- the dashboard "dispatch flight" button, which now shows the refusal instead of redirecting;
- Studio dispatch (`dispatchStudioFlight`: `POST /api/studio/dispatch` and the Studio API `/dispatch`), when its
  `repoUrl` is the repository of a seed-attached project (matched by GitHub owner/name, else by normalised URL).
  It needs `canary_receipt` and `rollback` in the body. A Studio dispatch does not consume the canary.

Not covered, by design: `task_create` and ordinary task or flight creation. The policy guards deploy entry points
only; it does not stop a member from creating a task that describes a deploy.

The check runs before anything is written: a refusal leaves no `deploy_status` flip, no task, no flight
and no deployment receipt. The accepted evidence is recorded in the dispatched task body and the flight
`receipt_refs`. Projects that are not seed-attached are unaffected.

The REST route takes `canary_receipt` and `rollback` in its JSON body; the dashboard's one-click button
cannot carry them and answers a seed-attached project with a readable `409`. `project_deploy` is the only
deploy-class tool; a test pins that list so a new one has to be added to this policy on purpose.
