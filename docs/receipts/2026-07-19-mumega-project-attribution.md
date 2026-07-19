# Receipt: Mumega project attribution (2026-07-19)

**Reviewers:** kasra, hadi-codex  
**Pot:** https://mupot.mumega.com (tenant `mumega`)  
**Actor:** Cursor Auto (`cursor-auto`) via org-admin MCP token  
**Status:** Applied on the live pot; this PR records the plan + idempotent re-check script.

## Why

Projects landed in #389/#390, and the mumega pot already had:

- root project `mupot-development`
- child project `dme-integration`

…but most active work was still `project_id = null`, two DME tasks were on the parent project, and **mumega hq** (where Cursor Auto lives) had no project access edge — so agent tokens could not `project_list`.

## What changed on the live pot

### 1. Squad grants
| Project | Squad | Access |
|--|--|--|
| `mupot-development` | mumega hq (`813ca010-…`) | `write` |
| `dme-integration` | mumega hq (`813ca010-…`) | `write` |

Existing `squad-core` admin edges were left untouched.

### 2. Task moves onto `dme-integration`
| Task | GitHub |
|--|--|
| Roll out the DME Kubernetes Hermes Agent Host | mumega-com#425 |
| Deploy the signed project-link addon to Mumega and DME pots | mumega-com#426 |

### 3. Product tasks attributed to `mupot-development`
- dogfood: kasra→codex via mupot
- RuntimeAdapter + runtime-descriptor epic
- FLIGHT 1 — close the one-agent loop
- Coordinate the remaining #274 host-go prerequisite
- [kasra-review] Re-gate deactivate_agent P0 fix
- deactivate_agent tool + P0-safe 0049 migration

### 4. Missing DME Integration mirrors created on DME Delivery squad
Created open pot tasks (GitHub URL in body; MCP cannot set `github_issue_url` on create) for:

413, 416, 417, 419, 420, 422, 423, 427, 428, 429

Already-attributed DME tasks (412, 414, 415, 418, 421, 424) were left as-is.

## Explicit non-goals
- No attribution of `[GH …]` webhook noise tasks
- No sample/test tasks
- No repo-bound project model (#409 still separate from this workspace Projects slice)
- No fix for #391 (update-trigger availability footgun) in this PR

## How to re-check
```bash
export MUPOT_URL=https://mupot.mumega.com
export MUPOT_ADMIN_TOKEN=…   # org-admin workspace token; never commit
node scripts/project-attribution-mumega.mjs           # dry-run
node scripts/project-attribution-mumega.mjs --apply   # re-apply grants + attributions
```

Manifest: `scripts/project-attribution-mumega.manifest.json`

## Review asks
1. Confirm DME issue set (413–429) is the right mirror scope.
2. Confirm mumega hq `write` (not `admin`) is the intended grant.
3. Decide whether created mirrors should later gain real `github_issue_url` linkback (needs MCP/API support or dashboard edit).
