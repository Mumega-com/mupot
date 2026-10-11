# Approving elevation requests over MCP

An agent asks for named, time-limited actions with `request_elevation`. A human decides. Until now the
human half existed only on the dashboard. `elevation_decide` lets a human org admin decide from their own
MCP session, and `elevation_status` shows that human exactly what they would be granting.

## One decision function

`elevation_decide` calls `decideElevationRequest` (`src/auth/elevation.ts`), the same function the dashboard
route `POST /auth/elevation/requests/:id/decide` calls. Authority, scope, the requester-is-not-the-decider
rule, session liveness, narrowing-only, and the single atomic status flip are all enforced there, once. The
tool contains no second copy of any of those predicates. It only supplies the inputs a dashboard session
supplies, behind a floor that is stricter than the dashboard's.

## What is stricter over MCP

| Rule | Behaviour |
|---|---|
| Human only | Agent-bound tokens, seat, harness and directory-consented sessions, and any member row that belongs to an agent are refused `403 human_accept_required`. |
| Org admin | Requires an org-scope admin grant on the ambient capability set. A squad admin can still decide on the dashboard. |
| No step-up | Approving a sensitive action (the dashboard's reauth set) is refused `reauth_required`. The caller may pass `actions` to approve only the non-sensitive subset. Deny never needs step-up. |
| Bound to a live dashboard session | The grant records one of the approver's own live web sessions and ends when it ends. With none, the call is refused `web_session_required`. |
| Receipt | Every decision, and every refusal after the request is resolved, writes one `mutation_audit_entries` row (`handler = elevation_decide`). The decision note is tagged `[via mcp]`. |

A request whose agent session has ended is refused `agent_session_ended` and is denied, exactly as on the
dashboard. A request is never decided twice: the second call returns `already_decided` and grants nothing.

## Seeing what you approve

For a human org admin, `elevation_status` returns the pending requests they have authority over. Each shows
the action keys and labels, the effect and its note, the scope (with the squad or department name), the
duration, the reason, the requesting agent and session (and whether that session is still live), when the
decision window closes, and whether the request can be approved over MCP. The view is read-only. An unknown
id and an out-of-authority id read the same. An agent calling `elevation_status` still sees only its own
session.

## Decisions to review

- No second factor over MCP beyond the human floor: sensitive grants stay dashboard-only.
- The grant is bound to a dashboard session rather than to the MCP token, because the ledger requires a web
  session for the approver. Binding to the token would need a schema change.
