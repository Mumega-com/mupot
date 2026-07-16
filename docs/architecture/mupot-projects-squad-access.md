# mupot Projects — repo-bound, squad-access-controlled (DRAFT, 2026-07-16)

> Status: **design draft**, informed by a comparables research pass in flight. Not built.
> Origin: Hadi, 2026-07-16 — "mupot support projects, they should have squad access, squads
> should be able to work projects... currently on codex desktop i handle it with folders and
> for claude i handle it by a gh repo... mupots can have a gh repo for each project and squad
> access to that." Tracking: mumega.com#409.

## The gap (verified against current code, 2026-07-16)

A pot today has **tenant-wide** GitHub reach, not per-project:

- `squads` table (`migrations/0001_init.sql`): `id, department_id, slug, name, charter` —
  squads sit under a **department**, with **no repo binding at all**.
- `src/integrations/github-repo-write.ts` — the pot's GitHub "hands": write an agent def,
  assign an issue to Copilot. Operates against **one repo per call**, no project/squad
  scoping — any capability-gated caller can target any repo string it's given.
- `src/integrations/github-projects.ts` (tagged `#22`, same epic as the pending "Brain=ATC"
  board item) — imports items from a **GitHub Projects v2 board** and routes them to agents
  by name-match on an "Agent" field. This is real, shipped plumbing for *task routing*, not
  a *repo-access* model — it doesn't grant a squad access to anything, it just reads a board.

**Net: no first-class "Project" entity exists.** A pot cannot say "squad X may touch repo Y,
squad Z may not" — GitHub reach is tenant-wide and capability-tier-gated, not project-scoped.

## Hadi's working pattern (the model to mirror)

| Runtime | Project boundary today |
|---|---|
| Codex Desktop | a local **folder** = one project |
| Claude Code | a **GitHub repo** = one project |
| mupot (proposed) | a **GitHub repo** = one project, **+ squad-level access grant** |

## Proposed shape (draft — pending research validation)

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,              -- = env.TENANT_SLUG, server-derived, never request-supplied
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  github_repo   TEXT,                       -- 'owner/repo', validated against github-repo-write.ts's REPO_RE
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant, slug)
);

CREATE TABLE project_squad_access (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  squad_id      TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  access_level  TEXT NOT NULL DEFAULT 'write',   -- read | write | admin — TBD against research
  granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, squad_id)
);
```

**Enforcement point:** `github-repo-write.ts`'s `writeAgentDef`/`assignIssueToCopilot` (and
`github-projects.ts`'s import) would resolve `repo` from the calling squad's granted
`project_squad_access` row instead of accepting an arbitrary repo string — closes the
"any capability-gated caller can target any repo" gap noted above.

## Architectural note — this is the SAME pattern as the CMS-adapter port

This is not a new mechanism. It's [[feedback_cms_as_addon_uniform_port]] applied to GitHub
repos as a resource type, and it should ride codex's `AddonManifestV1` connector/capability
model (branch `codex/addon-framework-design`) rather than invent a parallel one:

- **Connector slot** = the project's GitHub repo binding (the credential/target).
- **Capability grant** = squad access to that project (read/write/admin), human-gated,
  addon-owned receipt — same shape as a CMS content-write capability.
- **Receipt** = every repo write already flows through `github-repo-write.ts`'s fail-closed
  discipline; extending it to be project-scoped keeps the audit trail intact.

Do not build `projects`/`project_squad_access` as a bespoke parallel table design without
first checking whether the addon framework's connector-slot schema can express it directly —
coordinate with whoever owns that branch before implementation (same discipline as the CMS
port build spec).

## Open questions (for the research pass + Hadi)

1. Access levels — read/write/admin, or simpler read/write only (matches GitHub's own
   coarse-grained repo permission model, or Linear's per-project membership)?
2. Can a squad have STANDING access to a project, or is access itself gated per-task
   (propose→approve, mirroring the capability-grant pattern)? Leans toward: project
   membership = standing (like a GitHub team on a repo), individual WRITES inside it may
   still be gated per the usual sensitive-surface rules.
3. Does `github-projects.ts`'s board-import become project-scoped too (only import items
   for repos this pot has a `projects` row for), or stay tenant-wide?
4. Relationship to `department_id` on squads — is a project cross-cutting (any squad in
   any department can be granted access), or does it live under one department?

## Worked example to design against

The mumcp/mcpwp work this session (issue #370, CMS-adapter port, Slice A shipped) is itself
a natural "project" instance: repo = `Mumega-com/mcpwp` (+ `mumcp-claude-plugin`), squad =
whichever squad owns CMS-adapter work, human collaborator = Bardia (`hrahimi270`,
[[reference_bardia_hrahimi270_mcpwp_contributor]]) actively shipping on the same repo outside
mupot entirely. A real Projects feature should be able to represent "Bardia's human PRs +
mupot squad's agent PRs, same repo, same project, coordinated" — that's the concrete test.
