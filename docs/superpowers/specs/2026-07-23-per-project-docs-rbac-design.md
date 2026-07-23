# Per-Project Docs — editable, RBAC-scoped, agent-accessible knowledge

**Status:** Design, drafted 2026-07-23. Tooling choices (editing CMS, policy
engine, block-granularity) pending live research (in flight). Awaiting dyad-gate.
**Thesis owner:** Hadi, 2026-07-23 — *"ClickUp has ClickUp Docs; how do we keep
the information about each mupot and each project? Reuse Inkwell's RBAC. Give
mupot editability of the website + RBAC text + a kind of RBAC for agents to
access the information."*
**Builds on:** Inkwell content-tier RBAC (`src/content.config.ts` tierFields +
`workers/inkwell-api/src/middleware/content-tier.ts`), mupot project memory
(`project_remember`/`project_recall`/`project_context`), mupot agent tokens
(`mint_agent_token`/`grant_agent_capability`). The third owner surface beside
chat + board (see the owner-experience artifact, 2026-07-23).

## Thesis

Each pot and project needs a **Docs** surface — the ClickUp-Docs equivalent —
but unlike ClickUp's dead storage, mupot's docs are a **live shared substrate**:
the *same* knowledge a human reads and edits is what the mubot reads to act and
writes to as it learns. Docs = project memory = the mubot's context. One store,
three surfaces: **chat** (talk to it), **docs** (read/edit what it knows),
**board** (watch it work).

The RBAC spine already exists and is enforced. This spec **reuses** it — it does
not rebuild access control — and adds the missing pieces: a human editing
surface, finer (block-level) granularity, the agent-access bridge, and the
docs↔memory unification.

## What already exists (reuse, do not rebuild)

**Inkwell content-tier RBAC** — verified 2026-07-23 in `src/content.config.ts`:

```
tier: public | squad | project | role | entity | private   (6-tier, default public)
entity_id:        owning entity — must match the entity_id CLAIM in the session token
permitted_roles:  role allowlist — caller must hold one, regardless of tier
```

- Enforced by `workers/inkwell-api/src/middleware/content-tier.ts`, applied
  per-collection via `...tierFields`.
- The schema **already models `type: 'agent' | 'human'`** — agent-vs-human
  access is in the data model, not a new idea.
- Enforcement is **token-claim driven** — the caller sees an item only if its
  token's `entity_id` claim / roles satisfy the item's `tier` + `permitted_roles`.

**mupot agent identity** — `mint_agent_token` (agent-bound bearer),
`register_agent_key` (Ed25519), `grant_agent_capability` (least-privilege). These
mint the **claims** that content-tier enforcement reads.

**mupot project memory** — `project_remember`/`project_recall` (shared
project-scoped store, every participant reads the same context), `project_context`
(the unified "where is this project" assembled read).

## The composite (the design in one line)

**Inkwell tiered-MDX (storage + RBAC + enforcement) + mupot agent tokens (the
claims that drive it) + mupot project memory (the same store) = editable,
RBAC-scoped, agent-accessible project docs.** ~70% is reuse.

```
                 ┌── human (session token: entity_id, roles) ──┐
edit / read ─────┤                                             ├──▶ content-tier.ts
                 └── agent (mupot token: entity_id, caps) ──────┘      (tier + permitted_roles gate)
                                                                          │
   project docs (MDX, tier:'project'…'private') ◀──── same store ────▶ project_recall / project_remember
                                                                          │
                                                              the mubot's working memory
```

## Tooling decisions — RESEARCH VERDICT (2026-07-23): compose + extend, do NOT adopt

> Verified pass: no single OSS project does "editable RBAC content +
> agent-accessible" — the answer is **extend Inkwell + one policy point**, not
> adopt a CMS. Full sources:
> `docs/inkwell-cms-rbac-agent-access-research-2026-07-23.md`.

| Piece | Decision | Why (research) |
|---|---|---|
| **Human web-editing** | **Extend Inkwell** (git + MDX + Zod `tier`). A light web-edit over MDX. | Git-CMSs (Keystatic/Tina/Decap/Outstatic/Sveltia) have **zero real RBAC** — git-write = edit everything, *weaker* than Inkwell's existing doc-level `tier`. Payload/Directus have real field-RBAC but **force a Node server + Postgres/Mongo** (breaks CF-native). |
| **Block-level "rbac text"** | **remark-directive** (`:::tier{squad}`) or `<Tier require="squad">` MDX component, **server-side stripped** at build/edge-render. | **No OSS MDX plugin exists** for role-based block stripping (confirmed gap). Small greenfield — the MDX analog of a Postgres RLS row-predicate, applied per block. |
| **Agent-access policy** | **ONE policy point: extend `content-tier.ts`** so human session tokens AND agent mupot tokens flow through the *same* tier/role check. **No parallel agent-RBAC system.** Escalate to **Cerbos WASM PDP** only if policy outgrows middleware. | OpenFGA/Ory-Keto/SpiceDB all **need a persistent server + Postgres-class DB** — don't fit Workers. **Cerbos** is the one CF-fit (DB-less YAML PDP; Hub ships an in-edge WASM PDP). D1 has no native RLS → hand-rolled Worker predicate. Reinforces [[feedback_authz_portable_authn_delegated]] + [[feedback_cms_as_addon_uniform_port]]. |

**Non-fits to avoid** (all break CF-native / no-forced-Postgres): Payload,
Directus, OpenFGA, Ory Keto, SpiceDB, Sanity Enterprise roles.

**MCP caveat:** the 2026 MCP auth spec (OAuth 2.1) ships only coarse scopes
(`mcp:tools`/`resources`) — fine-grained per-tool/per-doc enforcement must be
built on top regardless of engine. The agent's tier/role claims (not MCP scopes)
carry the access decision.

## Build slices (epic — ordered)

1. **One policy point (keystone).** Extend `content-tier.ts` so BOTH a human
   session token AND an agent mupot token resolve through the *same* tier/role
   check — the agent's `entity_id`/roles/capabilities are just another claim set.
   No parallel agent-RBAC. This is the reference gate everything else calls; build
   first. Conformance: a human and an agent with identical claims see identically.
2. **Docs↔memory unification.** The project docs surface reads/writes the SAME
   store `project_recall`/`project_remember` use — a doc edit teaches the mubot; a
   mubot lesson surfaces as a doc. No second store (v0.24 constraint).
3. **Per-project Docs view** (dashboard) — browse/search a pot's knowledge,
   RBAC-filtered through slice-1's policy point to the viewer (human or agent).
   The third owner surface beside chat + board.
4. **Human web-editing (extend Inkwell).** A light in-browser MDX editor over the
   git+MDX store — NOT a headless CMS. Every edit is `tier`-tagged and receipted;
   sensitive-tier writes gated.
5. **Block-level "rbac text".** A remark-directive / `<Tier require="…">` MDX
   component, server-side stripped at build/edge-render, so one doc mixes
   public + private text. Greenfield (no OSS to lean on).
6. **Cerbos WASM PDP (deferred, conditional).** Only if slice-1 middleware policy
   outgrows what hand-rolled code should hold — swap the decision fn for an
   in-edge Cerbos PDP. Do NOT build day-one; middleware first.

## Non-negotiables

- Reuse the existing tier model + `content-tier.ts` enforcement — do NOT fork a
  second RBAC system.
- Docs and project memory are ONE store — no dead-storage duplicate.
- Agent access is token-claim + capability driven, least-privilege, never a
  blanket read. Sovereignty by construction: a pot's docs never leave the pot.
- Every edit (human or agent) is receipted; sensitive-tier writes are gated.

Each slice dyad-gated (Kasra-core + diverse second-eye) before merge. Branch-only.
