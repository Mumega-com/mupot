# Temporary Admin Tokens for Codex

**Status:** Approved design

**Date:** 2026-08-01

## Goal

Let a Mupot owner issue Codex a full organization-admin credential for a bounded
period without permanently promoting the Codex member identity. The first
operational use is a seven-day token installed in Codex Desktop on the Mumega
server.

The change is complete only when:

- an owner can mint an Admin preset token for Codex even when Codex does not
  already hold `admin@org`;
- the grant belongs to that token, not to the Codex member;
- the token expires automatically after the selected lifetime;
- revoking the token immediately removes its authority;
- the token cannot exercise `owner`, mint owner credentials, or cross tenants;
- existing Codex and Mupot credentials retain their current authority;
- Codex Desktop uses the protected token without exposing it in chat, logs, or
  receipts; and
- a live `boot_context` plus an authorization probe proves the desktop client is
  the Codex agent with effective `admin@org` before the rollout is accepted.

## Problem

The scoped-key screen currently implements attestation only. It verifies that a
member already holds the selected preset, then issues a normal member token. This
correctly stopped key minting from leaving a standing capability behind, but it
also removed the owner's safe temporary-elevation path. An owner selecting the
Admin preset for Codex receives `member_lacks_capability`, and the UI offers no
bounded recovery operation.

Granting `admin@org` to the Codex member first is not an acceptable substitute.
Every ordinary token for that member would inherit the standing grant, and token
revocation or expiry would not remove it.

## Product Decisions

### Admin is not owner

The temporary token receives the existing Admin preset at organization scope.
It can manage people, tokens, departments, squads, agents, settings, content,
and gated outreach where those surfaces already honor organization-admin rank.
It cannot exercise owner authority, mint owner-level credentials, or cross a
tenant boundary.

The existing strict rank ceiling remains: only an owner can mint an Admin token.
An admin cannot mint another admin credential.

### Expiry is mandatory

The dashboard offers `1 day`, `7 days`, and `30 days`, with `7 days` selected by
default. The server computes `expires_at` from its own clock. The client cannot
submit an arbitrary timestamp or a non-expiring value through this flow.

The show-once page displays the exact expiry in UTC. Active-key listings display
the expiry and distinguish active, expired, and revoked credentials.

### Elevation is an explicit owner delegation

Normal scoped keys continue to attest or scope down a member's existing
authority. Admin session elevation is a separate, explicit delegation:

- it is available only for the Admin preset;
- the authenticated minter must be an owner;
- the delegated rank must be strictly below the minter's rank;
- it is attached to one token and one tenant;
- it has a mandatory expiry; and
- it never writes to the member's standing `capabilities` rows.

This resolves the tension between ordinary token attenuation and session-admin
elevation. A token may exceed the recipient's standing rank only when an owner
created an auditable, expiring delegation for that exact token.

## Persistence Contract

Add an additive migration with two changes.

`member_tokens` gains nullable `expires_at TEXT`. Existing rows remain null and
retain their current revocation-only lifetime. Every token minted by the scoped
key screen after this change has a non-null expiry.

Add `token_grants`:

```sql
CREATE TABLE token_grants (
  id            TEXT PRIMARY KEY,
  token_id      TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE CASCADE,
  tenant        TEXT NOT NULL,
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('org','department','squad')),
  scope_id_key  TEXT NOT NULL DEFAULT '',
  capability    TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
  grant_kind    TEXT NOT NULL CHECK (grant_kind IN ('attestation','owner_delegation')),
  granted_by_kind TEXT NOT NULL CHECK (granted_by_kind IN ('user','member')),
  granted_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  UNIQUE(token_id, scope_type, scope_id_key)
);
```

`scope_id_key = ''` represents organization scope, avoiding SQLite's nullable
unique-key behavior. Application validation converts it to `null` in capability
objects. `expires_at` is repeated on the grant so an active grant can never
outlive its token; mint writes identical values to both rows.

The migration does not backfill `token_grants`. Absence of token grants on a
legacy token preserves the current principal-capability behavior. Every new
scoped-key token is marked by its non-null `expires_at` and must have exactly one
matching token grant; a missing grant on such a token fails closed to zero
authority. This explicit legacy/new distinction avoids interpreting an
accidental empty new grant set as full member authority.

## Minting Flow

Extend the scoped-key service with a server-derived lifetime and authenticated
minter identity. Validation happens before any write:

1. Resolve the preset and selected member in this tenant.
2. Resolve the minter's effective organization rank.
3. Require strict rank dominance over the preset.
4. Accept only the fixed lifetime choices.
5. For normal presets, require the member to already hold the capability and
   write an `attestation` token grant.
6. For Admin, require an owner and write an `owner_delegation` token grant even
   when the member lacks standing `admin@org`.
7. Resolve the canonical `agent_member_bindings` row for the selected member. If
   one exists, weld that `agent_id` onto the new token; if conflicting bindings
   exist, fail closed. Human member tokens retain a null `agent_id`.
8. Insert the token and token grant in one D1 batch.
9. Return the raw token exactly once with its endpoint, expiry, and Codex config.

If either insert fails, neither credential nor grant is committed. The raw token
is never persisted or included in an audit receipt.

## Authentication

Create one token-authority resolver used by both MCP bearer authentication and
the shared non-MCP member-bearer path. It performs these checks using the server
clock:

1. token hash and tenant match;
2. member is active;
3. token is not revoked;
4. token `expires_at` is null or in the future;
5. for a new expiring scoped token, exactly one active, unexpired token grant
   exists and matches the token expiry; and
6. delegated capability is returned in the request auth context.

Legacy tokens with null `expires_at` continue resolving live member
capabilities. New expiring tokens never fall back to member capabilities. This
prevents an expired, malformed, or partially written Admin key from inheriting
the member's authority.

All downstream authorization continues to use the existing `AuthContext`
capability checks. No route receives a special testing bypass.

## Dashboard and Codex Desktop

The scoped-key form adds a lifetime selector. Selecting Admin explains that the
credential is an owner-approved temporary delegation and that the Codex member
itself is unchanged.

The show-once result includes:

- the raw key;
- the absolute UTC expiry;
- the canonical Mupot MCP endpoint; and
- a paste-ready Codex `config.toml` block using Streamable HTTP.

For the Mumega server rollout, automation captures the show-once value directly
to a mode-`0600` protected token file and updates the existing Codex Desktop MCP
entry without printing the value. Configuration records only the protected path
and endpoint in receipts. The raw token must not appear in command arguments,
terminal output, git, chat, SOS, or durable logs.

The Codex MCP client name is `mupot`, not `mumega`, so product identity is clear.

## Error Handling

- Non-owner selecting Admin: `rank_ceiling`, HTTP 403.
- Unsupported lifetime: `invalid_lifetime`, HTTP 400.
- Missing token grant for a new expiring token: authentication failure, HTTP 401.
- Expired token or grant: authentication failure, HTTP 401.
- Revoked token or grant: authentication failure, HTTP 401.
- Partial D1 write: transaction/batch failure; no raw credential is presented.
- Desktop verification mismatch: rollout fails closed and the token is revoked.

Authentication deliberately does not distinguish malformed, expired, revoked,
or unknown bearer values to callers.

## Testing

Unit and integration coverage must prove:

- an owner can mint a seven-day Admin delegation for a member lacking
  `admin@org`;
- minting for the canonical Codex member welds the new token to the existing
  Codex `agent_id`, while a human member token remains unbound;
- an ambiguous or conflicting agent-member binding prevents minting;
- an admin cannot mint an Admin delegation;
- mint writes no standing member capability;
- token and grant share the same server-derived expiry;
- unsupported lifetimes are rejected;
- the raw token is returned once and only its hash is stored;
- an unexpired delegated token resolves `admin@org` on MCP and member-bearer
  paths;
- expired, revoked, missing-grant, tenant-mismatched, and inactive-member cases
  fail closed;
- legacy non-expiring tokens preserve their current behavior;
- ordinary scoped presets cannot elevate a member; and
- the generated Codex configuration uses the canonical endpoint and does not
  use SSE.

## Rollout and Acceptance

1. Run focused migration, mint, authentication, dashboard, and config tests.
2. Run the complete test suite and type check.
3. Deploy through the stamped Mupot release path and apply the additive
   migration.
4. Verify public health, release SHA, active Cloudflare version, and migration
   ledger.
5. Mint the seven-day Admin token for the canonical Codex agent member using the
   authenticated owner delegation path.
6. Store and configure the token locally without exposing it.
7. Restart or reconnect Codex Desktop if required.
8. Run `boot_context` and verify the canonical Codex agent/member IDs plus
   effective `admin@org`.
9. Exercise one reversible admin-read authorization probe. No production write
   is used solely as a test.
10. Record non-secret receipts: release SHA, token ID, member ID, agent ID,
    expiry, endpoint, verification time, and probe result.

The rollout is not complete merely because the token mints or the deployment is
healthy. Both Mupot authorization and Codex Desktop connectivity must pass.

## Out of Scope

- Owner-level temporary tokens.
- Cross-tenant delegation.
- Arbitrary custom expiration timestamps.
- Project- or resource-level grants.
- The broader users/members/agents principal unification.
- Automatic renewal. The owner must mint a new credential after expiry.
