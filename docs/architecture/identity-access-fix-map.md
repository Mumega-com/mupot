# Identity & Access — Fix Map

**Status:** Audit synthesis, 2026-07-20. Three parallel deep audits (security /
simplicity / durability) of the identity/access subsystem, grounded in code and in
**live D1 data**. Companion to
[identity-and-access-redesign.md](identity-and-access-redesign.md) (the target
model) — this doc is *what's actually wrong now* and *the order to fix it*.

The reassuring headline first: the **authN core holds**. The adversarial pass tried
to break the mint escalation guard, identity-ambiguity handling, the `connect`
session-local binding, tenant pinning, and the OAuth directory door — **all fail
closed**. The just-merged mint fix (`d391239`) was gated GREEN. The defects are on
the **mint/authorization surface** and in **design invariants to lock before
guest/TTL ships** — not in the front door.

## What's bigger than the redesign doc captured

1. **A third human-identity plane: `users`.** `users` (web-login, `role` owner/
   admin/member — `0001_init.sql:64`) and `members` (token principal — `0002`) are
   **two disjoint identity tables with no FK or join between them**. `AuthContext`
   carries `userId` and `memberId` as separate optional fields (`types.ts:319-328`).
   A dashboard-owner with no `members` row is **403'd on every squad/department
   capability check** (`capability.ts:210-218`) — the bridge (`legacyRoleSatisfies`)
   is org-scope only. So the redesign's `principals` must fold in **three** planes
   (users + members + agents), not two.
2. **Six mint paths, not four** — `mintMemberToken` (via two routes with two
   different authz checks), `mintAgentBoundToken`, `mintScopedKey`, invite-accept
   (hand-rolled inline duplicate), `mintDirectoryToken`, bootstrap-owner.
3. **Three parallel RBAC systems** — `capabilities` (the real one), `gate_grants`
   (free-text, checked by a separate `hasSurfaceCap`), and `memberships` (legacy
   agent×squad). Same job, three tables, three check functions.
4. **Five duplicated "is admin" implementations** — `isAdmin`, `isAdminPlus`×3,
   `legacyRoleSatisfies`, plus `canOnOrg/Department/Squad` reimplementing the
   capability middleware inline.

## SECURITY findings

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| S1 | **HIGH (live)** | The "scoped key" is **not scoped** and **mutates the principal**. `mintScopedKey` issues a plain member token (inherits the member's *full* caps — an "observer" preset key for an admin is a full-admin key; `denies` is documentation only) **and** writes a rank-max standing `capabilities` row that **survives key revocation**. Minting a credential permanently elevates the principal. | `dashboard/keys.ts:144-244`, `role-presets.ts:57-60` |
| S2 | MED-HIGH (latent) | Channel ceiling not enforced at a single chokepoint — `authenticateMember` (`/actions`, resolveAuth fallback) resolves **full** caps with no zeroing, unlike the two OAuth paths. Latent landmine the day any directory/TTL raw exists. | `mcp/index.ts:239-251` vs `oauth-authorize.ts:272` |
| S3 | MED | No token TTL — a leaked human workspace/im/dashboard key is valid until manual revoke; for an org-admin member = total org compromise. | `member_tokens` schema (`0002`) |
| S4 | **BLOCK (proposed)** | Guest/TTL default must **fail closed**: if "no `token_grants` rows ⇒ full ceiling" becomes the rule, a guest token minted with grants omitted authenticates at full principal power. Back-compat full-ceiling must be an **explicit written row**, never inferred from absence. | redesign doc §migration |
| S5 | MED | `token_grants` PK `(token_id, scope_type, scope_id, resource)` with nullable columns won't dedupe in SQLite (`NULL != NULL`) — duplicate/contradictory grants possible. Use a `''` sentinel for org/no-resource. | redesign doc §2 |
| S6 | LOW/MED | `project` scope isn't in `hasCapability`; when added, unknown scope must **deny**, else a `project` grant is silently ignored and falls back to broader authority. | `capability.ts:77-105` |
| S7 | LOW | Defense-in-depth: `resolveCapabilities`/`loadAgent`/`loadSquad` aren't tenant-filtered (safe only because one D1 = one pot). Keep every `principals` lookup tenant-pinned. | `capability.ts:44-57` |

**Security invariants the redesign MUST hold** (non-negotiable):
1. `effective = intersect(principal, token_grants)`; **empty grants ⇒ zero**, never full.
2. **Mint never mutates the principal** — writes to `token_grants`, never `capabilities`.
3. **One `buildAuthContext` chokepoint** every door calls; ceiling + `expires_at` + intersection enforced there only.
4. **Expiry at the sink, server clock, fail-closed**, on every door.
5. **Revocation immediate + complete** — no residual standing power.
6. **Tenant always from env**, at every lookup.
7. **Ambiguity structurally impossible** under `principals` (one row/identity), not just refused.
8. **Unknown scope_type ⇒ deny**; `''` sentinel (not NULL) in the grant PK.

## DURABILITY findings (live D1 confirmed)

| Class | Live state today | Cleanup |
|-------|------------------|---------|
| **Ambiguous agent identity** | **2 live**: kasra `ea2b0370` (members `6acf3f46`+`7d2afb20`) and **Codex** `1eb0e718` (`281b8b0c`+`149866ac`). Mint fix stops *new* ones; does not self-heal these. | Pick canonical (earliest w/ grants), migrate live token(s) to winner, revoke loser's tokens, suspend loser member. |
| **Escalation-guard violated** | **2 live**: email-null agent members holding **org-admin** — `6acf3f46` (Kasra), `7f4d1c31` (Loom). Mint code never grants this → a legacy/manual path did. | Human decision (is an agent identity *allowed* org-admin?) — this is the P0 the `principals` split exists to make expressible. |
| **Duplicate-member churn** | **6 groups**: mumcp×4, Mupot Product×3, Kasra×2, DME×2, Fleet Consumer×2, Codex×2 — mostly 0 live tokens (pre-fix churn). | Keep the member with most live tokens/caps; suspend the rest. |
| **Orphan tokens / dangling agent_id** | **0 today** — but app-layer-only (no DB FK); regressions silent. | Run the detection query as a **scheduled** integrity check. |
| **"Scoped" grant on the member** | Every historical `mintScopedKey` grant widened the member, not the token (= S1). | Audit which members got capability bumps via this path meant to be token-only. |

**Migration mechanics (repo-specific, cited):**
- Forward-only migrations (`d1_migrations`); **no down-migrations**; each pot applies independently (collision hazard).
- **D1 can't ALTER-add a FK or a CHECK.** Widening a CHECK = table rebuild.
- `capabilities`, `member_tokens`, `gate_grants` have **no incoming FK** → adding `project` scope is the **simple rebuild** (`0020` pattern). `members` **is** referenced (`0004/0005/0058`) → **never rebuild it**; `principals` must be a **VIEW** over `members ∪ agents` (zero drift) or additive table, never a rebuild (else the `0049` FK-cascade hazard).
- **Backfill the implicit full-ceiling grant in the *same* migration** as `token_grants` creation — a separate script leaves a window where live tokens resolve zero grants = self-inflicted lockout.
- **Mint is not idempotent** (`mintAgentBoundToken`, `mintScopedKey` both mint a new token per call) — the unified `createAccessKey` must take an idempotency key.

## SIMPLICITY findings — the collapse map

| Current | → Target | Win |
|---------|----------|-----|
| `users` (web-login) | merge into `principals` `kind='human'` | kills the users/members split (worst-understood gap) |
| `members` + `agents` | merge into `principals` (`kind`) | "is kasra a person or agent" gone |
| `member_tokens` | `access_tokens` (VIEW), `+expires_at` | per-doc |
| `capabilities` | stays = principal ceiling; `token_grants` intersects | the intersect invariant |
| `channel_capability_grants` | merge into `capabilities` (or grant `source` tag) | one grant table |
| `gate_grants` | merge into `token_grants.resource` | kills 2nd RBAC + `hasSurfaceCap` |
| `memberships` (legacy) | delete → `capabilities` scope rows | oldest redundant table gone |
| `agent_keys`, `agent_inbox_fences` | keep (orthogonal: signing/transport), FK to `principals` | out of scope, adjacent |
| 6 mint paths | one `createAccessKey(principal, grants, ttl)` | per-doc §3 |
| 5 admin-checks | one `isOrgAdmin(auth)` export | free, zero-risk |
| `canOn{Org,Dept,Squad}` | call `hasCapability` directly | 3rd parallel authz-impl gone |
| 5 access screens | People + Agents (views) + one Create-key + Organization | one create-key flow |

## The fix sequence (ordered by leverage × risk)

**Phase 0 — free / immediate (no schema, no behavior change)**
- Collapse the 5 admin-checks into one exported `isOrgAdmin(auth)`; delete `canOn*` in favor of `hasCapability`.
- Turn the 3 durability detection queries (ambiguous agent · escalation-guard violation · orphan token) into a **scheduled integrity check** (cron or CI gate).

**Phase 1 — stop the live bleed (security)**
- **S1: rebuild `mintScopedKey` off `capabilities`.** Until `token_grants` exists, at minimum stop writing standing principal grants on mint and label the key honestly. This is the one HIGH that deceives operators + persists privilege today.
- Route invite-accept through the shared mint (kill the 6th path).

**Phase 2 — data cleanup (durability, needs Hadi calls)**
- De-dup the 2 ambiguous agents (kasra, Codex) — migrate tokens to canonical, suspend losers. **Confirm no live runtime uses the loser token first** (kasra's `f8b37242` roadmap-board is off-host).
- Decide the 2 escalation-guard violations (should an agent identity hold org-admin at all?).
- Suspend the 6 duplicate-member churn groups.

**Phase 3 — the model (additive migration, v0.26)**
- `member_tokens.expires_at` (ALTER ADD COLUMN).
- `capabilities`/`token_grants` `scope_type` widened to include `project` (simple rebuild; land both CHECKs in one migration; `''` sentinel not NULL; `hasCapability` extended + unknown-scope-deny).
- `token_grants` table + **same-migration backfill** of explicit full-ceiling grants.
- `principals` as a **VIEW** over `members ∪ agents ∪ users`; migrate write paths to one `createAccessKey` (idempotency key); then flip principals to source-of-truth.
- One `buildAuthContext` chokepoint enforcing ceiling + expiry + intersection for **every** door.

**Phase 4 — guest/TTL + one Create-key screen**
- Guest credential = `token_grants` + `expires_at`, **fail-closed** (S4 non-negotiables). Checkout = revoke token; never a principal grant.
- One Create-key surface returning token **+ endpoint + config** (reuse `connect.ts`).

## Roadmap
Phase 0–1 are near-term hardening (can land before v0.26). Phase 2 is an ops task
(Hadi decisions). Phase 3–4 are the **v0.26 Identity & Unified Access** must-ship,
now with the security non-negotiables, the migration mechanics, and the data-cleanup
gate made explicit. See [ROADMAP](../../ROADMAP.md) v0.26.
