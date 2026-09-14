# Telegram project onboarding

This runbook onboards one human into one existing Mupot project through Telegram.
Mupot remains the identity and authorization source; Hermes only relays an authenticated
Telegram update to `POST /im/webhook` and returns Mupot's reply.

The pilot must use a new participant-specific squad. A project invite grants a capability
on a **squad**, not directly on a project. That capability reaches every project linked to
the squad through `project_squad_access`. Reusing a general-purpose squad can therefore
expose every project linked to it, including projects not named in the invitation.

Onboarding does not grant organization admin, an agent or workspace token, merge, deploy,
publish, spend, or independent gate authority. Approval and rejection still require the
existing task gate grant, surface capability, conflict checks, and shared verdict predicate.

A project invite onboards a **net-new human** by default: `POST /api/members/invites`
without `member_id` mints a fresh, tokenless member at redemption. Redeeming that kind of
invite when its email already belongs to an existing member refuses with
`member_already_exists` and makes no partial writes (see the invite redemption tests). Do not
work around that by inviting an existing member's own email — use the bind-existing-member
path below instead.

### Binding a Telegram identity to an existing member

Pass `member_id` (the existing, active, same-tenant member's id) instead of `email` when
creating the invite:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{
    "member_id":"<existing-member-id>",
    "project_id":"<project-id>",
    "squad_id":"<participant-squad-id>",
    "capability":"member",
    "expires_in_seconds":3600
  }' \
  "$MUPOT_ORIGIN/api/members/invites"
```

`member_id` and `email` are mutually exclusive in the request body — the member's own email is
read server-side (so the UNIQUE email fence and the invite/receipt shape are identical to the
net-new path) and returned in the `201` response for the operator to confirm before delivery.
Creation refuses `member_not_found` (404 — also returned for a member in another tenant, a
deliberate collapse so this is never a cross-tenant existence oracle), `member_not_active`
(403, a suspended member), or `member_missing_email` (400, an IM-only member with no email on
file) before minting the invite. The actor's capability ceiling is the same
`actorRankOnSquad` path the net-new invite uses — no separate, looser rank check.

At redemption, `/start <pairing-code>` binds the authenticated Telegram identity onto the
**existing** member (an `UPDATE`, never an `INSERT`) instead of minting a new one; no new
member row, token, or display-name change results. Two conflict shapes both refuse with
`telegram_identity_conflict` and leave the invite retryable if the underlying condition is
transient: the target member already has a **different** Telegram identity bound, or the
Telegram identity sending `/start` already belongs to a **different** member. The target
member must still be `status='active'` at the moment of redemption (re-checked, not merely
at invite creation) — the atomic claim itself refuses to commit for a bind target that is no
longer active, so a member suspended between invite creation and redemption does not burn the
pairing code; it becomes usable again once the member is reactivated. The reply to the
participant is the same generic success/failure text as the net-new path — the redemption
error enum is never echoed into the chat (see the existing anti-oracle test).

## Behaviour change: IM verdict authority

`/approve` and `/reject` over Telegram now route through the SAME shared gate evaluator as the
HTTP and MCP surfaces (`evaluateVerdictGates` in `src/tasks/index.ts`), via a flat `AuthContext`
built with `role: 'member'` and the member's real, resolved capability grants
(`src/im/index.ts`'s `memberAuth`). The IM surface's own earlier hand-rolled gate-ownership and
surface-capability checks (`memberHasGateGrant`, `memberHasSurfaceGrant` — bare `gate_grants`
existence, no liveness join, no `gate:agent-self-completion` special case) are removed.

Net effect: **no principal can approve `gate:agent-self-completion` over IM after this change,
regardless of role or capability grants.** `memberAuth` (`src/im/index.ts:400-402`) hardcodes
`role: 'member'` for every IM principal — it never sets `role: 'admin'` or `role: 'owner'`,
and `evaluateVerdictGates`'s check for this gate (`legacyOwnerAdmin(auth)` in
`src/tasks/index.ts:93`) tests only that coarse role, never capability grant rows. So a
capability grant does not restore IM approval for `gate:agent-self-completion` either: with
`role` fixed at `'member'`, `legacyOwnerAdmin` is false no matter what the principal's real,
resolved capability grants contain. This was verified by execution — probes with an
org-scope-owner grant row and, separately, an org-scope-admin grant row were both refused.

This makes IM strictly narrower than HTTP for this one gate (a browser session carrying an
owner/admin role cookie can still approve it there) and brings IM to parity with MCP, whose
`auth.role` is likewise always `'member'` (see `reference_mupot_mcp_role_always_member`).
This closes the same class of divergence Kasra flagged in mupot#1319 BLOCK-2 and
mupot#1080/#1081 — IM's verdict gate previously used its own hand-rolled, laxer check
(`memberHasGateGrant`/`memberHasSurfaceGrant`) instead of the canonical HTTP/MCP predicate.
That deferred item is closed here, for the IM surface, by deletion rather than a third copy —
but the closure is "IM can no longer approve this gate at all," not "IM now evaluates the
same capability rows HTTP does."

If an operator relies on Telegram approval today for `gate:agent-self-completion`, that path
is gone after this change on any basis — coarse role or capability grant row. Decide those
verdicts on the dashboard (HTTP) as an owner or admin instead. Extending IM to carry this gate
(by consulting real capability grants the way HTTP does, rather than the coarse role check) is
future work, not part of this PR.

## Authority and credential boundaries

- Only an authenticated operator with the required department, project, and squad authority
  creates the participant squad, project edge, and invitation. Keep the operator bearer or
  session out of chat, command history, tickets, screenshots, and receipts.
- `IM_WEBHOOK_SECRET` is a Worker secret shared only with the Telegram/Hermes webhook
  configuration. Telegram supplies it as `X-Telegram-Bot-Api-Secret-Token`. Never accept a
  secret in the JSON body, and never log the header. Rotate the Worker and webhook ends as
  one controlled change; a mismatch seals the endpoint with `401`, while no configured
  Worker secret seals it with `503`.
- The invitation response contains a one-time `pairing_code`. Mupot stores only its SHA-256
  digest. Deliver the code directly to the intended participant, do not forward it or put it
  in a durable work item, and discard the operator copy after successful pairing.
- The participant receives no bearer, agent token, workspace token, bot token, or webhook
  secret. Telegram identity is derived only after the webhook-secret check from a private
  update whose immutable `message.from.id` equals `message.chat.id`.
- Use `set +x`. Load operator credentials through the approved protected binding. The
  examples below intentionally contain placeholders and must never be committed with values.

## Preflight

Do not begin a live pilot until independent review, merge, deployment approval, migration
application, and deployed-SHA readback are separately proven. Repository tests are not live
deployment evidence.

Set only non-secret identifiers in the shell. Load `MUPOT_OPERATOR_TOKEN` through the
approved protected mechanism without printing it.

```bash
set +x
export MUPOT_ORIGIN='https://<pot-host>'
export DEPARTMENT_ID='<department-id>'
export PROJECT_ID='<existing-active-project-id>'
export PARTICIPANT_SQUAD_ID='<filled-after-create>'
```

Before mutation, record:

1. `GET /health` and its exact clean release commit.
2. Migrations `0152_telegram_project_onboarding.sql` and then
   `0153_inbox_lease_attempt_reconciliation.sql` in the deployed migration ledger, in that
   order. Migration 0152 creates the onboarding/webhook receipts; migration 0153 adds the
   server-authoritative lease-attempt receipts used by the Hermes receiver.
3. `IM_WEBHOOK_SECRET` configured at both ends, without reading or recording its value.
4. The existing project is active and the intended department is correct.
5. The planned capability (`observer`, `member`, `lead`, `admin`, or `owner`) is no greater
   than the inviter's effective rank. Prefer the least rank the participant needs.

## Create the dedicated squad and exact project edge

Create a new squad for this participant or participant cohort. Do not reuse an operational
squad merely because it already has access to the target project.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"telegram-<participant>","name":"Telegram <participant>","charter":"Bounded human decisions for <project>."}' \
  "$MUPOT_ORIGIN/api/org/departments/$DEPARTMENT_ID/squads"
```

Copy only the returned squad ID into `PARTICIPANT_SQUAD_ID`. Link exactly that squad to the
one intended project. The pilot uses project access level `write` because routine/task
decision paths recheck a writable project edge; this project access level is separate from
the participant's squad capability.

```bash
curl --fail-with-body --silent --show-error -X PUT \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{"access_level":"write"}' \
  "$MUPOT_ORIGIN/api/projects/$PROJECT_ID/squads/$PARTICIPANT_SQUAD_ID"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  "$MUPOT_ORIGIN/api/projects/$PROJECT_ID/squads"
```

Read back the exact `(project_id, squad_id)` pair and access level. Also perform the reverse
check before inviting anyone:

```sql
SELECT project_id, access_level
FROM project_squad_access
WHERE squad_id = '<participant-squad-id>'
ORDER BY project_id;
```

The result must contain only the intended project. Stop if any other row exists. The invite
schema and service verify the named edge, but only this reverse check proves the squad does
not reach additional projects.

## Route intended decisions to the participant squad before inviting

The project edge is visibility, not decision routing. Before creating or delivering an
invitation, inventory every Routine answer and Task verdict the participant is intended to
make, then route each one through the existing authorized Routine/Task administration
surfaces to the exact `PARTICIPANT_SQUAD_ID`. Stop the onboarding if that routing is not
approved and readable; do not compensate by granting the participant another operational
squad.

- `/answer` requires the Routine policy's `responsible_squad_id` to equal
  `PARTICIPANT_SQUAD_ID`. A materialized run keeps that value in
  `routine_runs.policy_json`; route the Routine before materializing the human wait. Do not
  rewrite an in-flight policy snapshot to make a decision reachable.
- `/approve` and `/reject` require the Task's `squad_id` to equal
  `PARTICIPANT_SQUAD_ID`. The Task must remain attributed to the intended project, and the
  participant squad must retain `write` or `admin` on that project.
- A Task verdict also requires an independent gate policy and grant for its exact
  `gate_owner` (plus any existing surface grant). The project invitation grants only the
  selected squad capability. After redemption identifies the new member, issue and read
  back the separately approved gate grant before advertising the verdict action.

Read back the routing without selecting private decision bodies or credentials:

```sql
SELECT id, responsible_squad_id
FROM routines
WHERE id = '<routine-id>' AND project_id = '<project-id>';

SELECT id, json_extract(policy_json, '$.responsible_squad_id') AS responsible_squad_id
FROM routine_runs
WHERE id = '<run-id>' AND project_id = '<project-id>';

SELECT id, project_id, squad_id, status, gate_owner
FROM tasks
WHERE id = '<task-id>';

SELECT capability, principal_type, principal_id
FROM gate_grants
WHERE capability = '<task-gate-owner>'
  AND principal_type = 'member'
  AND principal_id = '<joined-member-id>';
```

Every Routine and Task routing row must name the participant squad, and the gate-grant
readback must be exact when a verdict is intended. `/needs` may still show view-only work
from another squad in an accessible project; only its server-provided `allowed_actions` are
authority. A missing `/answer`, `/approve`, or `/reject` action is a stop signal, not a reason
to add a broader grant.

## Create and deliver the invitation

Create the project invitation through the member surface. A project invite requires all of
`project_id`, `squad_id`, and `expires_in_seconds`; omitting them creates a different legacy
browser invitation. Keep the lifetime short and operationally realistic (maximum seven days).
This mints a **net-new human** at redemption. To bind Telegram onto an *existing* member
instead, pass `member_id` in place of `email` — see "Binding a Telegram identity to an
existing member" above.

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{
    "email":"<participant-email>",
    "project_id":"<project-id>",
    "squad_id":"<participant-squad-id>",
    "capability":"member",
    "expires_in_seconds":3600
  }' \
  "$MUPOT_ORIGIN/api/members/invites"
```

The `201` response is deliberately non-cacheable and returns the raw `pairing_code` once.
Before delivery, verify the response's `project_id`, `squad_id`, `capability`, expiry,
`includes_all_projects_linked_to_squad: true`, and access warning. Do not continue if any
field differs from the approved onboarding record.

Send the participant only this instruction through the approved direct channel:

```text
Open a private chat with the approved Telegram bot and send:
/start <pairing-code>
```

The command must be typed or pasted into the participant's direct private bot chat. A
forwarded command, group chat, mismatched sender/chat identity, expired code, reused code,
or Telegram identity already bound to another member has no onboarding effect. Success says
`Joined project <project-id>`; the member is active, tokenless, and holds only the selected
squad capability created by this flow.

## Participant commands

All commands after `/start` resolve the active member from the authenticated Telegram ID and
re-read current capabilities.

- `/needs` lists role-authorized attention across accessible projects. `/needs <project-id>`
  narrows it to one accessible project. The reply shows only server-provided
  `allowed_actions`; overflow is explicitly continued in the project dashboard.
- `/answer <run-id> <choice>` calls the existing Routine answer service. When choices exist,
  the choice is exact and case-sensitive. An invalid, stale, terminal, duplicate-domain, or
  conflicting answer does not create a second decision. An identical Telegram transport
  replay returns the stored reply without repeating the effect.
- `/approve <task-id>` and `/reject <task-id> <reason>` use the same gate evaluation and
  verdict writer as HTTP/MCP. Squad membership alone is insufficient. The task must still be
  in review, the member must still be active and authorized, the gate and any required
  surface capability must still be held, and conflict-of-interest checks must pass.
- Forwarded commands are refused. Never ask the participant to forward an invitation or a
  decision from another chat.

## Receipts, restart, and retry interpretation

Every accepted Telegram update reserves one row keyed by `(tenant, update_id)` before a
privileged intent is parsed. Inspect metadata without printing `response_text`, pairing
material, headers, or credentials:

```sql
SELECT tenant, update_id, telegram_user_id, request_digest, state,
       created_at, completed_at,
       response_text IS NOT NULL AS has_response
FROM telegram_webhook_receipts
WHERE tenant = '<tenant>' AND update_id = '<update-id>';
```

Interpret it narrowly:

- `completed` plus the same Telegram principal and digest is replay-safe. The stored response
  is returned and the effect is not run again.
- The same update ID with a different principal, text, or forwarding markers has a different
  digest and returns `409 update_conflict`. It must not be retried under the old update ID.
- `processing`, `unknown`, or a completed row without a readable stored response returns
  `409 update_in_progress`. A Worker or Hermes restart does not clear the fence. This state is
  **uncertain**, not permission to replay or delete the row.
- A new `/needs` update is safe for the participant to inspect current domain state. Do not
  manufacture a new `/answer`, `/approve`, or `/reject` update until an operator reconciles
  the domain receipt and confirms whether the earlier effect committed.

For an answer, reconcile the Routine action/run and its durable answer receipt. For a task
verdict, reconcile the task status and latest task verdict. Do not infer completion from a
Telegram 200 alone.

The outbound Hermes receiver uses a separate attempt-v3 custody chain. Before one message is
processed, the plugin reads strict server scope, durably records a random attempt ID together
with tenant, agent, effective seat, consumer mode/generation, and the non-secret owning-profile
fingerprint, then leases at most one message. An ambiguous restart reconciles that exact
attempt; attempt-originated work can be consumed only by `inbox_lease_ack({attempt_id})` after
the same profile owner and strict server scope are revalidated. A stale attempt cannot consume
a newer lease, a same-timestamp legacy consume cannot be rolled back by fenced attempt ACK,
and pre-v3 or owner-mismatched markers remain quarantined. Generic `inbox_ack` remains only for
non-attempt legacy work.

The pilot inherits a known non-atomic verdict caveat: `writeVerdict` changes the Task status
to `approved` or `rejected` before inserting the append-only `task_verdicts` receipt. An
interruption between those writes can leave a terminal-looking Task without its verdict
receipt while the Telegram update remains fenced as `processing`. Reconcile both the Task
status and the matching latest verdict row. If only one exists, record the mismatch as an
incident and leave the update fenced; do not delete the webhook receipt, manufacture a new
decision update, or claim the verdict completed. This onboarding slice does not repair that
inherited gap.

A Routine entering a human wait first commits its waiting/Needs You state, then attempts one
project-attributed terminal acknowledgement (`kind = 'ack'`) to the run's assigned agent.
The `routine.human-wait/v1` body tells the Hermes-side notifier what human action to surface;
it does not ask the assigned agent to send another Mupot acknowledgement. The stable
`request_id` remains the sender-scoped idempotency key. Through `inbox_lease`, this envelope
must therefore read as `expects_reply: false` with `reply_basis: ack_is_terminal`. Ordinary
`routine.run/v1` execution dispatch remains `kind = 'request'` and must read as
`expects_reply: true` with `reply_basis: request_id_field`.

Inspect the human-wait message by its stable request ID:

```sql
SELECT id, to_agent, project_id, kind, request_id, created_at
FROM agent_messages
WHERE request_id = 'routine-human:<run-id>:<action-key>';
```

If the ordinary form would exceed 128 characters, the request ID is
`routine-human:<64-lowercase-hex-sha256>`. `notification_pending: true` means the human wait
is durable but notification was not proven. Correct recipient liveness/project access, then
replay the same Routine proposal/action. The duplicate path retries with the same request ID;
sender-scoped idempotency permits one durable message and no duplicate push event. Do not
send an ad hoc replacement with a new request ID.

Historical human-wait rows written as `kind = 'request'` are audit records and are not
rewritten or backfilled. Replaying the same stable request ID against such a row conflicts
with the new ACK envelope and reports notification pending while leaving the historical row
unchanged. Reconcile it by exact message ID/request ID and persisted kind; suppress any
automated acknowledgement loop at the consumer, and record the legacy envelope as the reason
delivery could not be re-proven. Do not update the row in place or mint a replacement ID.

Before release, run the exact local seam gate:

```text
npx vitest run tests/routine-actions.test.ts tests/routine-dispatch.test.ts \
  -t 'routes propose mode through the existing Task review gate|preserves a legacy request-kind human-wait envelope during reconciliation|attributes Task, Flight, references, digest, and inbox envelope to the exact Project' \
  --reporter=verbose
```

Require all three tests to pass. This local gate proves envelope interpretation and replay
behavior only; it is not PR CI, deployment proof, or a live Telegram pilot receipt.

## Suspension, revocation, and exceptional updates

Suspend first when access must stop immediately:

```bash
curl --fail-with-body --silent --show-error -X PATCH \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{"status":"suspended"}' \
  "$MUPOT_ORIGIN/api/members/members/<member-id>"
```

Suspension revokes current web sessions and causes Telegram member lookup to fail closed for
subsequent commands. Then revoke the exact squad capability:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
  -H 'Content-Type: application/json' \
  -d '{"action":"revoke","scope_type":"squad","scope_id":"<participant-squad-id>"}' \
  "$MUPOT_ORIGIN/api/members/members/<member-id>/capabilities"
```

Read back both member status and capability absence. Revocation is checked at decision time:
an already displayed command is not a durable grant. Stale or terminal Routine answers and
task verdicts, wrong-project decisions, duplicate identical updates, and conflicting updates
must all leave new domain state unchanged.

There is no project-invite revocation HTTP route in this slice. Before redemption, an
approved database operator may expire one exact unused invite by ID:

```sql
UPDATE invites
SET pairing_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '<invite-id>' AND accepted_at IS NULL;
```

Require a one-row mutation receipt and read back only `id`, `accepted_at`, and
`pairing_expires_at`; never select or transmit `pairing_hash`. If the row count is not exactly
one, stop and investigate rather than widening the predicate.

## Rollback

Rollback removes authority; it does not drop additive migrations `0152` or `0153`, or erase
receipts.

1. Stop new ingress at the Telegram webhook/Hermes configuration if the transport boundary
   is suspect. Rotate `IM_WEBHOOK_SECRET` at both ends before reopening. Do not reveal the old
   or new value in the incident record.
2. Expire an unused invitation by exact ID as above. If paired, suspend the exact member,
   revoke the exact squad capability, and verify both readbacks.
3. Confirm `/needs` and a representative decision now refuse or show no authorized action.
   Preserve the Telegram, Routine, task-verdict, and agent-message receipts for audit.
4. Remove the project edge only after proving the squad is dedicated and no live Routine,
   task, provider binding, or other participant depends on it:

   ```bash
   curl --fail-with-body --silent --show-error -X DELETE \
     -H "Authorization: Bearer ${MUPOT_OPERATOR_TOKEN:?}" \
     "$MUPOT_ORIGIN/api/projects/$PROJECT_ID/squads/$PARTICIPANT_SQUAD_ID"
   ```

   A refusal is a stop signal: keep the member suspended/capability revoked and resolve the
   dependency rather than editing around the project invariant.
5. Do not delete webhook receipt rows to make a blocked update replay. Reconcile and preserve
   them. Do not reverse the additive migration during an incident.

## Pilot evidence checklist

- [ ] Independent review verdict is attached to the exact commit under deployment review.
- [ ] Direct deployment approval identifies the exact commit and tenant; no local test is
      represented as deploy authority.
- [ ] `/health` reports the expected clean release commit after deployment.
- [ ] The remote migration ledger includes `0152_telegram_project_onboarding.sql` followed by
      `0153_inbox_lease_attempt_reconciliation.sql`.
- [ ] `IM_WEBHOOK_SECRET` is configured at both ends; no credential value appears in evidence.
- [ ] The participant-specific squad exists and the reverse edge query returns exactly the
      intended project.
- [ ] The invitation response matches project, squad, capability, and expiry and includes the
      all-linked-projects disclosure.
- [ ] Only a pairing digest is stored; the raw pairing code was delivered once and discarded.
- [ ] `/start` succeeded in the intended private chat and created one active, tokenless member
      plus one squad capability.
- [ ] `/needs <project-id>` contains only authorized items and actions; a different project is
      absent or refused.
- [ ] One authorized answer or verdict has its domain receipt and completed Telegram receipt.
- [ ] Every intended Routine policy/run snapshot and Task names the participant squad; each
      intended Task verdict has its separate exact gate policy/grant readback.
- [ ] Task-verdict pilot reconciliation checks both Task status and the append-only verdict
      row; a status/receipt mismatch remains fenced and is reported as the inherited caveat.
- [ ] An invalid choice, unauthorized/wrong-project action, stale action, and conflicting
      update each have no new effect.
- [ ] An identical update replay returns the stored response without a second domain effect.
- [ ] A human-wait message, if applicable, is attributed to the project and correlated by the
      stable `routine-human:` request ID; pending notification is reported as pending.
- [ ] Suspension and capability revocation were rehearsed or executed under the pilot's
      rollback approval, with exact readback.
- [ ] Merge, deploy, publish, spend, token, and gate authority remain separate and are not
      claimed by the onboarding receipt.
