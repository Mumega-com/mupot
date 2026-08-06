# Task 10 Review: MCP Parity

## Verdict

**Changes requested.** The reviewed `1edff8e` package registers exactly the 13 required tools, exposes no generic `needs_you_resolve`, applies the intended observer/member/admin capability floors, hides ordinary Routine/run reads through the shared Project access layer, permits a member of the responsible writable squad to Run now, and uses the read-only Needs You projection. The gate still has one Critical and five Important findings. Three are Task 10 adapter/test defects; three are unresolved shared-source dependencies from Task 9 that remain reachable through MCP or make REST/MCP parity false.

## Findings

### Critical - Proposal replay can execute after current Project and squad authorization is revoked

**Classification:** Shared-source dependency surfaced through Task 10 MCP, not duplicated authorization logic in the adapter.

**Files:** `src/mcp/routines.ts:293`, `src/mcp/routines.ts:294`, `src/routines/actions.ts:1201`, `src/routines/actions.ts:1206`, `src/routines/actions.ts:1210`, `src/routines/actions.ts:1215`, `src/routines/actions.ts:1225`, `src/routines/actions.ts:1231`, `tests/mcp-routine-tools.test.ts:227`, `tests/mcp-routine-tools.test.ts:239`

`routine_proposal_submit` delegates directly to `submitRoutineProposal`, which loads the tenant-scoped run, exposes assignment/correlation classifications, and processes stored action replay before checking current Project readability and responsible-squad authority. A formerly assigned agent can therefore replay a succeeded or waiting action and receive its stored result after grant revocation; more seriously, a replay whose action is still `running` calls `executeRoutineAction` before the live authorization checks and can continue Task/Flight-producing work.

The ordering also preserves the Task 9 existence oracle: an unreadable existing run can return `assigned_agent_mismatch`, `action_key_conflict`, or a replay result while an absent run returns `run_not_found`. Exact assignment is necessary but does not replace current Project hiding and source capability checks.

Required correction: enforce tenant plus current Project-read hiding and responsible-squad authorization before assignment, correlation, state, and every replay branch, returning `run_not_found` for unreadable runs. Add MCP tests for revoked grants across succeeded, waiting, and running replay, plus unreadable existing-versus-missing IDs.

### Important - MCP cancellation reports success without cancelling or classifying the correlated runtime work

**Classification:** Shared-source dependency surfaced through Task 10 MCP, not an MCP-specific cancellation implementation.

**Files:** `src/mcp/routines.ts:248`, `src/mcp/routines.ts:253`, `src/mcp/routines.ts:254`, `src/routines/actions.ts:1127`, `src/routines/actions.ts:1153`, `src/routines/actions.ts:1162`, `src/routines/actions.ts:1167`, `src/routines/actions.ts:1180`, `tests/mcp-routine-tools.test.ts:186`, `tests/mcp-routine-tools.test.ts:188`, `tests/mcp-routine-tools.test.ts:190`

The MCP handler returns the shared action's `{ run_id, duplicate }` success result. That action only marks the RoutineRun/action rows cancelled and writes one `cancelled` event. It never invokes the correlated Flight/runtime control path, updates the control Task, or records whether cancellation was confirmed versus merely requested. A running Flight or claimed out-of-transaction action can therefore continue after MCP reports successful cancellation, leaving real work after the run has been made terminal.

The MCP test cancels a newly queued run, checks duplicate and terminal classification, and never seeds a correlated Task/Flight or races dispatch/action completion. It therefore cannot prove the design's cancellation semantics.

Required correction: fix cancellation in the shared Routine action, persist requested plus confirmed/unconfirmed outcomes, coordinate the child Flight/runtime and Task state, and return that durable classification through both REST and MCP. Cover correlated children and races through the MCP interface.

### Important - The MCP adapter repeats Task 9's unsafe denylist Run serializer

**Classification:** Task 10 adapter defect.

**Files:** `src/mcp/routines.ts:112`, `src/mcp/routines.ts:113`, `src/mcp/routines.ts:220`, `src/mcp/routines.ts:234`, `src/mcp/routines.ts:244`, `src/routines/types.ts:63`, `src/routines/types.ts:68`, `src/routines/types.ts:70`, `src/routines/types.ts:75`, `tests/mcp-routine-tools.test.ts:76`, `tests/mcp-routine-tools.test.ts:168`, `tests/mcp-routine-tools.test.ts:180`

`safeRun` removes only `tenant`, `policy_json`, and `proposal_json`, then returns every other persistence field. MCP consequently exposes `occurrence_key` (including the caller's raw manual idempotency key), `lease_owner`, `lease_expires_at`, `retry_at`, and the proposal-welding `situation_digest`. This is the same public-DTO defect identified in Task 9, independently copied into the new adapter, so fixing only the REST serializer will leave MCP vulnerable and structurally divergent.

The test helper named `assertSafe` checks only the same three denied names. It does not assert an exact key set and its fixtures never populate the sensitive scheduler/weld fields.

Required correction: define one shared, explicit allowlisted public RoutineRun DTO and use it for REST and MCP create/replay, list, and get responses. Test exact keys using a leased/manual run with populated lease, retry, digest, proposal, and occurrence fields.

### Important - Actor-plane policy is local to MCP, so the required shared REST/MCP mutation rule is still false

**Classification:** Shared-source dependency; the Task 10 adapter locally mitigates MCP calls but does not establish structural parity.

**Files:** `src/mcp/routines.ts:178`, `src/mcp/routines.ts:193`, `src/mcp/routines.ts:206`, `src/routines/service.ts:270`, `src/routines/service.ts:355`, `src/routines/service.ts:394`, `src/routines/routes.ts:227`, `src/routines/routes.ts:247`, `src/routines/routes.ts:260`, `tests/mcp-routine-tools.test.ts:208`, `tests/mcp-routine-tools.test.ts:210`

Task 10 correctly rejects an agent principal before MCP create/update/lifecycle delegation. The shared `createRoutine`, `updateRoutine`, and `transitionRoutine` services, however, authorize only `workspace_admin` and do not require `actor_type === 'member'`. REST calls those same services without the MCP-only guard, so an agent-bound token backed by an org-admin grant can still create, edit, enable, pause, or archive policy. This is the unresolved Task 9 source defect and directly violates the design's one shared mutation rule.

The MCP suite checks only agent denial for `routine_pause` and never compares that result with REST. Passing the MCP test therefore demonstrates a surface-specific guard, not parity.

Required correction: enforce the human actor plane in the shared policy/lifecycle services and test agent-bound admin denial for create, update, enable, pause, and archive through both adapters.

### Important - Discovered JSON schemas are wider than the actual proposal and policy contracts

**Classification:** Task 10 adapter defect.

**Files:** `src/mcp/routines.ts:129`, `src/mcp/routines.ts:140`, `src/mcp/routines.ts:261`, `src/mcp/routines.ts:266`, `src/mcp/routines.ts:275`, `src/mcp/routines.ts:280`, `src/mcp/index.ts:2432`, `src/mcp/index.ts:2446`, `src/mcp/index.ts:2448`, `src/routines/proposal.ts:56`, `src/routines/proposal.ts:124`, `src/routines/proposal.ts:126`, `src/routines/proposal.ts:154`, `src/routines/proposal.ts:169`, `tests/mcp-routine-tools.test.ts:117`, `tests/mcp-routine-tools.test.ts:132`, `tests/mcp-routine-tools.test.ts:141`

The advertised proposal schema puts `kind` beside an `input.oneOf` but never discriminates the input branch by that kind. For example, `kind: "no_action"` with a create-task-shaped input satisfies the advertised schema even though the shared parser rejects it. Integer contracts such as `budget_micro_usd`, `max_attempts`, retry seconds, occurrence caps, and Flight budget are declared as JSON Schema `number`, and array uniqueness enforced by the proposal parser is absent from discovery. Thus generated MCP clients are told that values are valid which the tool will reject.

The central MCP validator does not repair this: it checks only top-level required/unknown keys and shallow scalar/array types, permits null for every optional field, and does not evaluate nested objects, enums, bounds, `oneOf`, patterns, or array contents. Downstream parsers generally fail closed, so this is not an authority bypass, but it violates Task 10's strict schema interface.

Required correction: publish discriminated action variants with exact nested schemas, use `integer` and `uniqueItems` where required, and align discovered constraints with the byte/instant rules enforced by the source parser. Validate representative accepted and rejected envelopes against the actual discovery schema.

### Important - The focused test does not implement the required structural parity and security gate

**Classification:** Task 10 test-gate defect.

**Files:** `tests/mcp-routine-tools.test.ts:76`, `tests/mcp-routine-tools.test.ts:108`, `tests/mcp-routine-tools.test.ts:132`, `tests/mcp-routine-tools.test.ts:147`, `tests/mcp-routine-tools.test.ts:169`, `tests/mcp-routine-tools.test.ts:186`, `tests/mcp-routine-tools.test.ts:227`, `tests/mcp-routine-tools.test.ts:246`

The suite is SQLite-backed and invokes real services; it is not merely mocked delegation. It also proves exact 13-tool discovery, no generic resolver, central capability floors, hidden ordinary Project reads, writable versus read-only Run now, basic assigned-agent welding, and rejection of several malformed cursors.

It does not call the REST apps or compare exact REST/MCP structures at all. Only `routine_run_get` is exercised over authenticated JSON-RPC; the remaining command checks call `invokeTool` directly. Schema assertions stop at root names/required fields, response safety is a three-name denylist, proposal replay covers only an immediately authorized succeeded action, cancellation covers no child control path, and cursor coverage has no positive continuation or Needs You cursor principal/expiry case. Consequently the explicit structural-parity requirement is untested and every defect above can pass the reported 60-test gate.

Required correction: add exact DTO and REST/MCP parity fixtures, execute each command through the MCP transport where transport behavior matters, and add the revoked-proposal, cancellation-control, positive pagination, and Needs You cursor binding cases described above.

## Verification

- Review basis: supplied `b2291c7..1edff8e` package and exact commit `1edff8efa0e30e74b917275a34e268ae8afff64e`.
- Exact-commit focused gate: 6 test files passed, 60 tests passed.
- Exact-commit `npm run typecheck`: passed.
- Concurrent uncommitted Task 9 fixes observed in the shared worktree were not treated as part of this reviewed package or as resolving these findings.
