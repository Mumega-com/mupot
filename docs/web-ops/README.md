# Web-Ops — the AI website-operations team (the wedge)

> "Mupot gives businesses an AI operations layer where specialized agents use tools, remember
> context, ask for approval, verify their work, and leave receipts." This is the first wedge:
> **AI website operations with approval**, with **Digid as the proof site**.

The `web-ops` department (`src/departments/modules/web-ops.ts`) is the **governance** half: it
seeds the six squads — `site-operator`, `qa`, `content-seo`, `brand-assets`, `funnel-ghl`,
`strategy` — into a pot, where the mupot supplies memory, the approval gate, receipts, and
validation. The **cognition** half is the operator's **tentacle agent-defs** (below): the actual
role agents `digidadmin` dispatches. MCPWP and GHL are the per-tenant **tools** the squads hold —
not baked into the template.

## The connect-and-activate flow (this is the "right?")
1. **Activate `web-ops` on the digid mupot.** Owner console → activate the `web-ops` department →
   seeds the six squads. (Needs tier ≥ **pro** — 6 squads > free's 1; the S6 gate enforces it.)
2. **Connect the tools.** Wire digid's **MCPWP** (the site) + **GHL** (the funnel) connectors into
   the pot's connector vault (per-tenant credentials; Hadi-go for secrets).
3. **Install the tentacle agent-defs** (the "codex folder") into `~/.claude/agents/` — the six
   `digid-*` defs below. Each is a cognitive branch of one squid (`digidadmin`), not six identities.
4. **Connect `digidadmin` to the digid mupot** (its bus token / MCP endpoint) so the tentacles can
   use the pot's tools, read its memory, and submit work to the approval gate.
5. **Activate the agents** = `digidadmin` dispatches the tentacles to do the squad work. Everything
   they do is governed: draft → QA validates → human approves → publish → receipt.

## The six tentacle-defs (the codex folder)
One squid (`digidadmin`), six arms. Install each as `~/.claude/agents/digid-<role>.md`. Tools per role:

| Agent-def | Owns | Tools |
|---|---|---|
| `digid-site-operator` | WordPress edits (pages/Elementor/menus/media/CSS/redirects) | **MCPWP** |
| `digid-qa` | pre/post checks (390px, H1, meta, links, overflow, CTA, copy leaks) | MCPWP read + screenshot/validate |
| `digid-content-seo` | copy, intent, internal linking, schema, titles/meta | MCPWP, web search |
| `digid-brand-assets` | image gen, alt text, naming, style rules, asset library | image-gen, MCPWP media |
| `digid-funnel-ghl` | GHL forms/calendars/attribution/follow-up/UTM | **GHL** |
| `digid-strategy` | the offer map; sets each cycle's objective | memory, web search |

### Example agent-def — copy this shape for all six
`~/.claude/agents/digid-site-operator.md`:
```markdown
---
name: digid-site-operator
description: digidadmin's WordPress operator tentacle — owns digid.ca site edits via MCPWP.
  Drafts changes; NEVER publishes without QA + human approval. Recall→work→remember.
tools: All tools
---
You are the Site Operator arm of the `digidadmin` squid. You edit digid.ca through MCPWP.

WAKE: recall the site context + memory (page IDs, menu structure, brand rules, known issues).
WORK: make the requested edit as a DRAFT. Never touch the menu when asked to touch a page;
isolate the change. Hand to digid-qa to validate, then submit to the approval gate — never
publish on your own.
SLEEP: remember what changed (page ID, before/after, why) so the trail compounds.
DISCIPLINE: draft → QA → approve → publish. Leave a receipt. One change, one verifiable effect.
```
The other five follow the same shape — swap `name`/`description`/the role body + the tools column
above. Each: **recall → work → remember**, each ends its work at the **approval gate**, never
publishes on its own.

## The playbooks (the squads' loops)
Reusable named procedures the web team runs — each is a governed loop (draft → validate → approve):
- **Launch a landing page** — strategy sets the goal → content-seo writes → brand-assets supplies
  images → site-operator builds (draft) → qa validates → approve → publish → receipt.
- **Publish a blog** — content-seo drafts + internal-links + meta → brand-assets cover image →
  site-operator drafts → qa (links/meta/mobile) → approve → publish.
- **Audit SEO** — content-seo crawls titles/meta/H1s/schema → flags gaps → proposes fixes (gated).
- **Fix a broken WordPress page** — qa detects (broken links/overflow/missing H1) → site-operator
  drafts the fix → qa re-checks → approve → publish. (The broken-menu incident is exactly this.)
- **Prepare sales follow-up** — funnel-ghl builds the form/calendar/sequence + attribution (gated).

## Why this is the wedge
Five of the eight operations-layer pillars (squads, memory, tool-governance, approval gates,
receipts) are already built in the mupot. `web-ops` adds the three that complete the wedge:
**validation** (the `qa` squad), **playbooks** (above), **cross-tool orchestration** (MCPWP + GHL
through one governed squad). Digid runs its own site this way → Digid sells the method.
