# Console & Navigation Consolidation

**Status:** Design + audit. 2026-07-20 (Hadi direction: "majority of our menus are
not really functioning"). Feeds the roadmap: **v0.25 Console Consolidation**.
Companion to [identity-and-access-redesign.md](identity-and-access-redesign.md)
(five of these menus are the access surfaces that must converge) and the
[project-centered spec](../superpowers/specs/2026-07-17-project-centered-workspace-design.md)
(which deferred exactly this consolidation past v0.24).

## Why now

Adding **Project** as the organizing center makes a large part of the current
navigation redundant, duplicated, or orphaned. The project-centered spec said so
explicitly — it "does not yet remove or redirect Fleet, Radar, Control Tower,
Economy, or Access surfaces… consolidation happens after project attribution is
deployed." Project attribution is now deployed (v0.24). This is that consolidation,
plus the broken/orphaned menus a code audit surfaced.

## Audit — every sidebar item (code-grounded, 2026-07-20 @ `de629642`)

Nav lives in `src/dashboard/index.ts:3141-3280`; handlers on `dashboardApp`.

| Menu | Route | Status | Evidence | Disposition |
|------|-------|--------|----------|-------------|
| Home | `/` | functional | `index.ts:235-267` real observatory+approvals | **keep** (landing) |
| Projects | `/projects`, `/:id` | functional (most built-out) | tabs Overview/Work/Board/Team/Activity/Evidence wired (`projects.ts:1153-1409`) | **keep — the center** |
| Work | `/send` | partial/misleading | `index.ts:4140-4168` compose-form only, no work list | absorb → Project **Work** tab |
| Approvals | `/approvals` | functional | `index.ts:451-457` real gate queue | keep (cross-project) |
| Departments | `/admin/divisions` | **redundant** | `index.ts:3177` — same href as Squads | merge |
| Squads | `/admin/divisions` | **redundant** | `index.ts:3178` — identical href; page titled "Organization" | absorb → Project **Team** tab |
| Agents | `/agents` | functional | `index.ts:990-1007` real roster | absorb → Project **Team** tab |
| Tasks | `/send` | **redundant** | `index.ts:3191` — dup of Work | remove dup |
| Pull requests | `/flights` | functional (accepts `?project_id=`) | `index.ts:821-834` | absorb → Project **Work/Evidence** |
| Verifications | `/verifications` | functional | `index.ts:604-607` real verdicts | absorb → Project **Evidence** |
| Fleet | `/fleet` | functional | `index.ts:867-910` bus-window + pot-native fallback | **consolidate** → Project **Team** |
| Radar | `/radar` | functional | `index.ts:852-862` real `loadFleetRadar` | **consolidate** → Project **Activity/Team** |
| Health | `/ops` | functional | `index.ts:463-470` real ops health | keep (workspace-level) |
| Addons | `/addons` | functional (admin-only) | `index.ts:504-523` real registry | keep |
| Control Tower | `/coordination` | functional | `index.ts:972-982` real journeys | **consolidate** → Project **Activity** |
| Economy · Spend | `/economy` | functional | `index.ts:555-564` real spend | absorb → Project cost view |
| Economy · Wallet | `/economy/wallet` | **stub (self-declared dead)** | `index.ts:572-587` "no backing model yet" | remove / exploratory |
| Economy · Marketplace | `/economy/marketplace` | **stub (self-declared dead)** | `index.ts:588-600` "not connected yet" | remove / exploratory |
| Economy · Billing | `/economy/billing` | partial (view-only) | `billing.ts` honest-empty; writes via HMAC API | keep view-only |
| Access tokens | `/members` | functional | `index.ts:1788-1799` | **merge → Access** |
| People & roles | `/admin/members` | functional | `index.ts:1165-1187` | **merge → Access** |
| Audit log | `/audit` | functional | `index.ts:610-616` | absorb → Project **Evidence** + keep workspace-level |
| Deployment | `/deployment` | functional | `index.ts:478-485` | keep |
| Directory sync | `/admin/github` | functional | `index.ts:1614-1777` | keep |
| Keys & secrets | `/admin/keys` | functional | `index.ts:1224-1321` | **merge → Access** |

### Orphaned — real pages with NO nav entry (reachable only by typing the URL)

| Page | Route | Evidence |
|------|-------|----------|
| Connectors CRUD (create/rotate/revoke 3rd-party secrets) | `/admin/connectors` | `index.ts:1452-1606` built; zero `href` anywhere |
| Brain | `/brain` | real D1-backed page, no nav link |
| Loops | `/loops` | real page, no nav link |
| Services | `/services` | real page, no nav link |
| Growth | `/departments/growth` | real page, no nav link |

### Top 5 "not really functioning"

1. **Departments and Squads are the same link** (`index.ts:3177-3178` → both `/admin/divisions`, one "Organization" page).
2. **"Work" is a compose form, not a work view** (`/send`, `index.ts:4140-4168`) — and it's listed twice (also "Tasks").
3. **Economy → Wallet / Marketplace are declared-dead in their own comments** (`index.ts:572-600`).
4. **`/admin/connectors` — a full CRUD surface with zero nav link.**
5. **`/brain`, `/loops`, `/services`, `/departments/growth` — four real pages, none in the menu.**

## Target navigation (project-centered)

Collapse ~24 scattered items into a small, honest set. Everything project-scoped
lives **inside** a Project; only genuinely workspace-level surfaces stay top-level.

```
Home
Projects            ← the center; each Project has tabs:
  · Overview  · Work (tasks + flights + PRs, project-scoped)
  · Team (agents + squads + live fleet/radar, project-scoped)
  · Activity (journeys + events, project-scoped)
  · Evidence (verifications + audit + receipts, project-scoped)
  · Settings
Approvals           ← cross-project decision queue (→ "Needs You", v0.25)
Access              ← ONE surface: people · agents · keys · connectors
                      (merges Access tokens + People & roles + Keys & secrets
                       + agent mint + the orphaned Connectors; see identity doc)
Operations          ← workspace-level only: Health, Deployment, Directory sync, Audit (workspace)
Addons              ← admin
```

Retired from the sidebar: Departments/Squads duplicate, standalone Fleet, Radar,
Control Tower, Verifications, Pull requests, Tasks, Economy Wallet/Marketplace
stubs (their live functions move into Project tabs or Access; the stubs are removed
or marked exploratory). Orphaned real pages (Brain/Loops/Services/Growth) either
get a home (under Operations or a Project tab) or are explicitly retired — no more
type-the-URL-only pages.

## Invariants

1. **No dead menu items.** Every sidebar entry renders real, current data or is
   removed. Stubs are not navigation.
2. **No duplicate destinations.** Two labels never point at one route.
3. **No orphaned real pages.** A working page is either in the nav or intentionally
   retired — never reachable by URL only.
4. **Project-scoped surfaces live in Project tabs**, not as top-level twins.
5. **Workspace-level surfaces** (Health, Deployment, Directory sync, workspace
   Audit, Addons, Access) stay top-level and are clearly workspace-scoped.
6. Consolidation is **redirect-first, remove-second**: a retired route 301s to its
   new home for one release before deletion, so no bookmark breaks silently.

## Sequencing

This pairs with the identity redesign: the **Access** menu in the target nav *is*
the identity redesign's single "Create access key" surface. Ship them together in
the same console pass so the access story lands whole.
