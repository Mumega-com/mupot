# Grant Existing Agents Cross-Squad Capabilities

Date: 2026-07-12
Status: approved
Issue: https://github.com/Mumega-com/mupot/issues/336

## Goal

Allow an authorized operator to grant an existing, stable agent identity a capability on an
additional squad through MCP without creating another agent, member, or token. This unblocks
governed cross-squad flights while preserving Mupot's server-derived identity and capability
ceilings.

## Chosen Interface

Add this MCP provision tool:

```text
grant_agent_capability {
  agent: string,
  squad: string,
  capability: "observer" | "member" | "lead" | "admin"
}
```

`agent` and `squad` accept an exact ID or an unambiguous slug. The response returns the resolved
agent, target squad, bound member ID, resulting capability grant, and whether the operation
created or updated the grant. It never returns or modifies a raw credential.

## Identity Resolution

The target principal is derived from `member_tokens`, not request text:

1. Resolve the canonical agent row.
2. Select distinct active member identities from non-revoked tokens whose `agent_id` equals the
   resolved agent ID and whose member row is active in the current tenant.
3. Reject zero identities as `agent_identity_unminted`.
4. Reject more than one identity as `agent_identity_ambiguous`.
5. Use the one resolved member ID as the capability recipient.

Multiple active tokens welded to the same member remain one identity and are valid. Revoked
tokens and inactive members do not participate in resolution.

## Authorization

The caller's identity and capabilities remain server-derived from its bearer token.

- The caller must hold `admin` on the target squad through normal org/department/squad
  inheritance.
- The requested capability cannot rank above the caller's effective capability on that target
  squad.
- Capability must be one of `observer`, `member`, `lead`, or `admin`; `owner` is intentionally
  excluded because ownership is an organization-level constitutional role.
- Existing cross-tenant, inactive-token, and ambiguous-slug protections remain unchanged.

## Persistence

Move the capability grant write into a shared member service used by both the existing HTTP member
admin route and the new MCP tool. The service performs an idempotent delete-then-insert D1 batch so
SQLite `NULL` scope behavior cannot create duplicate grants. For this tool, scope is always the
resolved target squad.

The operation emits an attributed `org.provisioned` event with kind `capability`, the target squad,
agent, member, capability, and caller member ID. Event delivery is best-effort after the
authoritative D1 write, matching existing provision semantics.

## Failure Contract

| Condition | MCP result |
|---|---|
| Missing or ambiguous agent/squad reference | existing resolver `404` or `409` behavior |
| Caller lacks target-squad admin | `403 forbidden` |
| Requested capability exceeds caller rank | `403 cannot_grant_above_own_rank` |
| No active bound member identity | `409 agent_identity_unminted` |
| Multiple active bound member identities | `409 agent_identity_ambiguous` |
| Unsupported capability | `400 invalid_capability` |
| D1 write does not commit | typed receipt/write failure; no success response |

## Compatibility

No schema migration is required. Existing agent tokens immediately inherit the new capability
because authentication resolves grants by member ID on each request. Existing HTTP member grants,
token minting, agent attach, and single-squad behavior remain compatible.

## Verification

Tests must prove:

1. The tool is advertised with an exact JSON schema.
2. One active bound member receives the target squad grant.
3. Re-granting updates rather than duplicates the capability.
4. Multiple tokens for the same member are accepted as one identity.
5. Unminted, ambiguous, inactive, unauthorized, and above-ceiling cases fail closed.
6. No token value appears in the response or emitted event.
7. Product's existing stable identity can dispatch, read, and land a zero-budget flight spanning
   the materialized tenant-zero squads after grants are applied.

Production proof must use a temporary owner provisioning credential and a temporary Product
verification credential only where needed. Both must be revoked after D1 receipts are captured.
No VPS service changes, customer data, public publication, DNS, payment, or credential rotation are
authorized by this feature.
