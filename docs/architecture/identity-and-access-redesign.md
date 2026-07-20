# Identity & Access Redesign

**Status:** Design. Fresh-eyes audit + target model, 2026-07-20 (Hadi direction).
Feeds the roadmap: **v0.26 Identity & Scoped Access**. Companion to
[console-navigation-consolidation.md](console-navigation-consolidation.md) (the
access surfaces are five of the menus that must converge) and
[sovereign-core-operated-presence.md](sovereign-core-operated-presence.md) (guest
presence needs exactly the token-scoping this doc introduces).

## The complaint (operator, 2026-07-20)

> Tokens/agents are defined in three different places; we call agents "people";
> the API-key menu is confusing; there's no way to fine-grain an API key; and the
> API key doesn't give you the MCP address.

All five are confirmed in code. Several are worse than described.

## Root cause

**Authorization lives on the *member*, not the *token* — and "agent" is bolted
onto "member" through a nullable weld.** Every symptom flows from this.

### Current model (mapped)

| Table | Migration | Role |
|-------|-----------|------|
| `members` | `0002` | "humans as first-class nodes… one person" — the token principal |
| `member_tokens` | `0002` + `0019` | hashed API keys; `channel` ∈ workspace/im/dashboard; `agent_id` (0019) welds a token to an agent, or NULL = human principal |
| `capabilities` | `0002` | `member × scope(org/department/squad) → level(owner/admin/lead/member/observer)` — **the real RBAC** |
| `agents` | `0001` | org/work units (slug, model, squad) — a **separate plane** |
| `agent_keys` | `0018` | Ed25519 runtime signing keys — a **third** credential type |

So identity is a **two-plane weld** (member-plane ⟷ agent-plane, joined by a
nullable `member_tokens.agent_id`), plus a separate runtime-key plane. There is no
single "principal" concept.

### The five confirmed defects

1. **Three-plus places.** A single "who can do what" is spread across `members`,
   `member_tokens`, `capabilities`, `agents`, and `agent_keys`. Lived proof: `kasra`
   exists as a member (`14136dec`, org-admin) **and** as an agent (`ea2b0370`), and
   ended this session holding **two tokens of disjoint power** — one agent-bound but
   squad-only, one org-admin but not agent-bound. Neither could both dispatch a
   flight *and* administer a squad. That is the two-plane weld leaking into daily use.

2. **Agents are called people.** `members` is documented as "one person," yet
   `mint_agent_token` mints an agent **into** `member_tokens` as a member. An agent
   becomes a member/person. "Is kasra a person or an agent?" — both, in different
   tables.

3. **≥4 divergent mint paths.** `mintMemberToken` (dashboard `/admin/keys/mint`,
   label-only), `mint_agent_token` (MCP, agent-welded, returns an endpoint),
   `connect` (session-local claim), and bootstrap-owner. No single "create a key"
   flow; each behaves differently.

4. **No per-key fine-grain (the security-relevant one).**
   `mintMemberToken(env, memberId, label, channel)` has **no scope parameter**.
   A token inherits its member's **entire** capability set. You cannot mint a key
   scoped to "read tasks in project X" or "only the CRO tools." A leaked laptop key
   carries the member's full authority. The token is an *authenticator*, never an
   *authorization scope*.

5. **The key doesn't carry its address.** `/admin/keys/mint` returns a token with a
   label. The MCP endpoint and the paste-ready client config live on a **different**
   surface (`connect.ts`). Mint and connect are two screens; you get a key, not a
   way to use it.

## Target model

Three moves. They converge — each unlocks the next, and together they also deliver
the guest-presence check-in/out and the v0.26 governed-tool grant/binding.

### 1. One principal, honestly typed

Collapse the member/agent weld into a single principal with a discriminator:

```sql
-- principals: the ONE identity table (supersedes the members/agents weld for authN).
CREATE TABLE principals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('human','agent')),
  handle       TEXT NOT NULL,                 -- email for humans, slug for agents (unique per kind)
  display_name TEXT NOT NULL,
  -- human-only: telegram_chat_id, login identity (nullable)
  -- agent-only: model, squad_id, runtime status (nullable)
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

A principal **is** the person or the agent. No nullable `agent_id` gymnastics, no
"agent-as-member." The UI names them correctly — **People** and **Agents** are two
views over one principal table, filtered by `kind`. (Migration keeps `members`/
`agents` as compatibility views during transition; see Migration below.)

### 2. Token-scoped grants (the core fix)

Attach the grant to the **token**, not only the principal:

```sql
-- Each token carries its OWN grant set. A token can never exceed these,
-- even if its principal holds more. This is the capability ceiling per key.
CREATE TABLE token_grants (
  token_id     TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('org','department','squad','project')),
  scope_id     TEXT,                          -- null for org
  capability   TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
  resource     TEXT,                          -- optional finer filter: project id, tool-class, action-class
  PRIMARY KEY (token_id, scope_type, scope_id, resource)
);
-- access_tokens (renamed member_tokens): id, principal_id, token_hash, label,
-- channel, expires_at (NEW — enables guest/TTL keys), revoked_at.
```

- **Effective authority = intersect(principal capabilities, token grants).** The
  token is a *scoped* view of the principal's power — least-privilege by construction.
- Adds **`project`** to the scope types (the current constraint is org/department/
  squad only — Project isn't even expressible in RBAC today, a gap the Project pivot
  exposes).
- Adds **`expires_at`** — enables the guest/TTL credential the Operated-Presence
  check-in/out needs. Same table, same mechanism.
- Adds an optional **`resource`** filter (a project id, a tool-class like
  `cro:*`, an action-class like `read`/`draft`/`write`/`publish`) — this is the
  fine-grain Hadi asked for, and it is the same shape as the v0.26 governed-tool
  action classes, so the two land as one system.

### 3. One "Create access key" flow that bundles the address

A single surface (dashboard **Access** + MCP `create_key`) that in one screen:

1. Pick the **principal** (an existing person/agent, or "new agent").
2. Pick the **scope** — the fine-grain: which scope, which capability, optional
   project/tool-class filter, optional expiry. Presets: *Full (principal ceiling)*,
   *Read-only*, *This project only*, *Guest (scoped + TTL)*.
3. Receive, once: the **show-once token** + the **MCP endpoint** + **paste-ready
   config** for Claude Code / Cursor / Codex / curl (reuse `connect.ts`, already
   built) + the OpenAPI address for GPT Actions.

This kills the four divergent mint paths (they become one service with presets) and
guarantees the key always ships with its address and a working config.

## Migration (non-breaking)

1. **Additive first.** Add `access_tokens.expires_at`, `token_grants`, and the
   `project` scope value behind a feature flag. Existing tokens get an implicit
   "full principal ceiling" grant row so behavior is unchanged.
2. **Principal view.** Introduce `principals` as a unifying view/table; keep
   `members` and `agents` as compatibility views so nothing breaks mid-migration.
   Stop the `mint_agent_token`-into-members behavior; agents become `kind='agent'`
   principals.
3. **One mint service.** Route all mint paths (`/admin/keys/mint`,
   `mint_agent_token`, connect) through one `createAccessKey(principal, grants,
   ttl)` that returns token + endpoint + config. Old entrypoints become thin
   wrappers, then are removed.
4. **Enforce the ceiling.** `buildAuthContext` intersects principal capabilities
   with token grants on every request (the directory-door zero-cap ceiling in
   `src/mcp/oauth-authorize.ts` is the existing pattern to generalize).

## Invariants

1. A token's effective authority is **≤** its principal's capabilities, always
   (intersection, fail-closed).
2. A token with `expires_at` in the past authenticates to nothing.
3. Capability resolution stays **live** (re-resolved per request); revocation of a
   token or a grant takes effect immediately.
4. `mint`/`create_key` always returns the MCP endpoint and a paste-ready config.
5. One principal table is the source of truth for authN; People and Agents are
   `kind`-filtered views, never separate identity systems.
6. No model-selected principal, scope, or credential (matches the v0.26 rule).

## Why this is one job, not four

The same `token_grants` + `expires_at` mechanism delivers:
- **Fine-grained API keys** (the operator complaint),
- **Guest presence / check-in-out** (scoped + TTL credential — see operated-presence doc),
- **v0.26 governed-tool grant/binding** (action-class scoping on the token),
- and it **retires the split-token RBAC edge** that held a flight during this session.

Fixing identity once clears all of them.

## Prior art & final design decisions (2026-07-20 research)

Researched how comparable systems solve this (AWS STS, Macaroons/Biscuit, GitHub
fine-grained PATs, SPIFFE/SPIRE, Google Agent Identity, MS Entra Agent ID, Teleport/
CyberArk PAM, GitOps). Full map: `agents/kasra/designs/MUPOT-IDENTITY-PRIOR-ART-2026-07-20.md`
(mumega.com repo). Our core bets are validated — the industry independently landed the
same shapes — with five concrete adjustments folded in below.

**Who the audience is (the framing this all serves).** Agents are the **primary**
operators; humans (owners) are the **exception** — bootstrap, approve, audit. Setup
is done *by an admin agent through MCP tools*, not by a human in a dashboard (proven
this session: an entire project + agents + tokens + a governed flight, provisioned
via MCP, zero dashboard). This is deliberately contrarian versus every current agent-
identity product (Entra/Google/Auth0/MCP all keep a human at the center) — and it's
correct for a pot, **provided we keep the human-accountability lineage** (see D4). It
also reprioritizes: the dashboard is a thin bootstrap/oversight shell, not 24 menus.

**D1 — Keep grants DB-side; do NOT adopt self-describing tokens.** Macaroons/Biscuit
attenuate authority inside the token (offline), but then need revocation lists or short
TTLs to revoke. Our DB-side `token_grants` gives *instant* revocation and live
re-resolution — a strength, not a gap. Decision: stay DB-side.

**D2 — `expires_at` is MANDATORY at mint, not optional.** Of GitHub / Stripe / OpenAI /
Cloudflare scoped keys, only GitHub fine-grained PATs *enforce* an expiry ceiling — and
it's the most security-forward of the four. Stripe/OpenAI having no expiry is a named
sprawl source (CyberArk 2025: machine:human identity ratio **82:1**). Decision: every
`access_token` carries a required `expires_at`; a non-expiring key is an explicit,
owner-gated exception, never the default. (Supersedes the earlier "add expires_at"
phrasing — it's mandatory, not additive-optional.)

**D3 — Session-admin: intersection math is right, but ADMIN-tier elevation must be
approval-gated.** Our `intersect(principal, token_grants)` is mechanism-identical to AWS
STS AssumeRole (session-policy ∩ role-policy) — validated. But every mature PAM
(Teleport, CyberArk) gates *admin-tier* elevation behind an approval step by default;
auto-approve is a narrow explicit opt-in. So: **session-admin at `capability='admin'`
requires an approval gate** (owner-authorized or policy-bound); lower-tier scoped grants
auto-issue. This is the "sudo for agents" model done safely — Zero Standing Privilege
over the fat org-admin token, elevate-for-task, auto-expire.

**D4 — Add `owner_principal_id` on agent principals (human-accountability lineage).**
SPIFFE, Google's Agent Identity, and MS Entra Agent ID all treat an agent as a distinct
first-class principal (validates `principals.kind='agent'`) — but none drop the human
lineage, and the MCP auth spec makes no agent/human distinction at all, so we own the
mapping. Every agent principal references the human owner accountable for it. Keeps
"agent as primary" from becoming "agent with no one accountable."

**D5 — Mint UI: template-gallery-first (Cloudflare pattern).** Present named scope
presets before the custom-grant grid — already the plan; prior art confirms the ordering.

**Traps to design against (each confirms a fix-map finding):** fail-open elevation
(CISA AA22-074A → our BLOCK "empty grants ⇒ zero, never full"); standing admin as the
unexamined default (Zero Standing Privilege → session-admin over standing org-admin);
credential sprawl treated as inevitable (82:1 ratio → mandatory expiry + one create-key
flow + the de-dup cleanup).

### Session-admin (sudo for agents) — first-class use of `token_grants`

```
owner (human, once) ──bootstrap──▶ first admin agent gets a session-admin capability
                                          │
   admin agent ──elevate(task)──▶ token_grant{ capability:'admin', expires_at:+Nmin,
                                               scope: … }  ── APPROVAL-GATED (D3)
                                          │  … does setup via MCP …
                                          ▼
                                   auto-expire ⇒ back to zero standing power
```

A session-admin grant is an ordinary `token_grants` row (`capability='admin'` +
`expires_at`), never a `capabilities` write on the principal — so checkout/expiry
removes it completely. Same table, same intersection, same fail-closed rules as guest
presence and fine-grained keys. One mechanism, three payoffs.
