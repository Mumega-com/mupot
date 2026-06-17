# Marketing Department — Multi-Channel Command Layer

Status: **architecture + sprint plan** · Author: Kasra · cross-vendor reviewed (Codex, 2026-06-17)
Extends: [console-department-microkernel.md](./console-department-microkernel.md)
Roadmap: productizes **v0.23** (digid marketing pilot) on the dept microkernel shipped 2026-06-17; feeds **v0.24** (pulses/board).

The Marketing department is **not "the SEO department."** It is a **governed, multi-channel command
layer** — SEO is one channel; outbound, email, paid, social, content, PR are others. This doc fixes
the architecture (kept deliberately boring per the cross-vendor review) and the build sprints.

---

## 0. What shipped already (the base)

The department-template microkernel is **live** (2026-06-17): the pulse spine (`metric_points`, #192),
the object-capability microkernel core (contract + ctx + registry + conformance harness, #196), and
the first real department — **Growth / Marketing & Sales** (#197): declarative manifest + a real-data
collector (the prospects funnel) + the `/departments/growth` view + a `*/15` cron. Activate it on a
pot → it seeds squads → reads that pot's funnel → emits honest metrics → the dashboard shows them.
This doc adds the **channel layer** on top of that department.

---

## 1. The thesis

The Marketing department turns marketing **goals → gated work → metrics → re-prioritization**, across
many **channels**. It is the **command layer**; the actual work is done by **MCP-skilled agents**
(MCPWP / GSC / ad-platform skills), never by the department itself. Per-pot adaptation is **config**
(domain, keywords, competitors, connector creds) — **zero per-tenant code**. The same Marketing
department activates on mumega (sovereign-agent SEO), viamar (moving-company SEO), digid (grants), etc.

---

## 2. The channel — a FLAT declarative descriptor, NOT a kernel

Cross-vendor review (Codex) was emphatic: **keep the channel layer boring.** A channel is a typed
**manifest fragment**, not a second microkernel:

```ts
interface ChannelDescriptor {
  key: string                       // 'seo' | 'outbound' | 'email' | 'paid' | 'social' | …
  name: string
  metricDescriptors: MetricDescriptor[]   // reuses the dept's MetricDescriptor (§4.1 of the microkernel doc)
  sourceAuthority: string[]               // which connector/source may emit this channel's metrics
  connectorRefs: ConnectorRef[]           // mcpwp | gsc | ghl | ads | … (declared, gated)
  workTypes: GatedWorkType[]              // comparison-page · answer-shape · audit · content · outreach …
  renderHints: ChannelRenderHint          // how the dashboard panels render
  configSchema: ZodSchema                 // the per-pot config shape (domain, keywords, competitors…)
}
```

**Hard rules (the boundary):**
- **NO channel-level** ctx-minting, registry, lifecycle, bus, audit, or capability resolver. If a
  channel needs its own ctx, the department kernel was recreated inside Growth too early.
- **pot → department = an authority boundary** (a real kernel). **department → channel = a
  *composition* boundary only.** Removing a channel drops its metrics / work-types / render entries
  and touches **no sibling channel** and introduces **no new trusted machinery.**
- **Channels never mint authority.** All authority flows through the department's **existing**
  ctx / Gate / `metric_points` path. A channel is data + work-type declarations.

---

## 3. The command/executor split + the leak-guards

| Owns | Who |
|---|---|
| goals, allowed work-types, the Gate, metrics, scoreboards, prioritization | the **department** (command) |
| execution — keyword research, content, audits, fixes, sends | **MCP-skilled agents** (their skills/connectors) |

**Four leak-guards (binding):**
1. **Agents never self-declare success** — they submit **receipts/evidence into a gated work record**;
   the human/Gate confirms. (The no-fake-green rule, applied to agent work.)
2. **Connectors never emit arbitrary metrics** — emits go through the department's ctx +
   `sourceAuthority` path (the same one the Growth collector uses).
3. **Per-tenant config is DATA, not prompt text with implicit authority** (no prompt-injectable
   authority; config is a validated blob).
4. **A channel proposes work; it never mutates a customer-facing asset without the Gate**
   (publish/fix/spend = human-authorized; arms never publish).

---

## 4. The real shared core (don't encode imaginary sameness)

The biggest risk is **freezing the abstraction before two real channel shapes exist.** Channels are
NOT uniform: **ads** has spend/budget/safety; **email** has consent/deliverability; **SEO** has
content/indexing lag; **PR** has attribution ambiguity. The genuinely shared core is **not**
"marketing channel" — it is:

> **gated work + source-scoped metrics + evidence receipts + prioritization.**

So `ChannelDescriptor` stays flat config. **A nested channel *kernel* is extracted only after THREE
real channels force the same lifecycle/capability/audit shape repeatedly** — not before.

---

## 5. The channels (the map — built on demand, not all at once)

| Channel | Metric (→ pulse/candle) | Executor skill | Status |
|---|---|---|---|
| **Outbound** | prospect funnel (leads→replies→conversion) | the prospects system | **exists** — extract as channel #1 |
| **SEO / AEO** | rankings · organic traffic · AI citations | MCPWP / GSC | first *new* channel (read-only first) |
| **Email** | open/click · conversions | GHL connector | later |
| **Paid** | `ad_spend` · CAC · ROAS | ad-platform connector | later (the candle's `ad_spend`) |
| **Social** | reach · engagement | social skill | later |
| **Content** | output · engagement | content agents → MCPWP | folds into SEO/outbound |
| **PR / earned** | citations · mentions (the #1 AEO driver) | **human** + tracking | dept *tracks*, human *does* |

---

## 6. Per-pot adaptation + the differentiators to bake in

Adaptation = **config**, the GoHighLevel-snapshot story but governed + agentic: a pot supplies
{domain, keyword/query clusters, competitors, brand voice, connector creds} and the same channels run
its flywheel. **The <20-min activation story is the product narrative** (market-trained by GHL).

Three differentiators no competitor ships together (build them in from the start):
1. **The governed Gate** as a first-class template primitive — "the agency approves before the
   campaign fires." (GHL has billing toggles, not a gate.)
2. **Multi-tenant + sovereign** namespacing per pot.
3. **AEO / brand-citation tracking** (steal from Profound) — track whether the pot appears in
   ChatGPT/Perplexity/AI-Overview answers, as a first-class SEO-channel metric.

---

## 7. Sprints (the build order — Codex-sequenced; do NOT start with SEO)

Each sprint: branch-only, diverse-gated (Opus + Codex), no merge/deploy without Hadi.

- **S1 — ChannelDescriptor + fixture channel.** Define the flat `ChannelDescriptor` type + a tiny
  **null/fixture channel** + a conformance test (the channel analog of the dept fixture, much
  smaller): a channel registers its metrics/work-types/render under the department **without** adding
  any authority machinery; removing it leaves siblings + dept tests green. **Proves the shape.**
- **S2 — Outbound channel (extraction).** Refactor the **existing prospects funnel** (already real
  data, real metrics, the conversion-honesty history) into the first **real** `ChannelDescriptor`.
  Proves extraction from concrete code with **no SEO/connector uncertainty.** The descriptor must
  survive outbound **without special-casing** before SEO is added.
- **S3 — SEO channel, read-only evidence.** SEO/AEO as the first **external-agent** channel:
  MCPWP/GSC **analysis → a gated work proposal** (audit findings, keyword gaps, comparison-page
  candidates). **Read-only** — agents produce evidence + proposals into the gated record; **no
  writes.** Metrics: `seo_issues`, `avg_position`, `organic_traffic`, `ai_citations`.
- **S4 — SEO gated writes.** The flywheel's hands: keyword→content→publish and audit→autofix, each a
  **gated** action (propose → `/approvals` → MCPWP write). Arms never publish un-gated.
- **S5+ — additional channels on demand** (email/paid/social), each as config + a connector. Extract
  a nested channel kernel **only if** three channels force the same shape (§4).

---

## 8. Invariants (gated on every channel PR)

1. **Flat channel** — no ctx/registry/lifecycle/audit at the channel layer (§2).
2. **Composition, not authority** — channels never mint; all authority via the dept ctx/Gate/metrics.
3. **Leak-guards** — receipts-not-self-declared-success · connector emits via sourceAuthority ·
   config-is-data · propose-not-mutate-without-Gate (§3).
4. **Honesty** — real data or honest empty/unavailable states; no fabricated metrics (the conversion
   catch); AEO/citation numbers only from real measurement.
5. **Diverse-gate** — Opus + Codex on every channel + the descriptor.
6. **No premature kernel** — flat config until 3 channels prove the same shape.

---

## 9. Roadmap alignment

- **v0.23 (digid operates live)** — `#42` marketing roster (Inbound/Outbound/Internet-Research) + the
  gated MCPWP content loop is **this, productized**: Outbound channel = the roster's outbound; the
  MCPWP content loop = the SEO channel's S4 gated writes; `#39` loops/approvals = the Gate path.
- **v0.24 (breathing organism)** — channel metrics are the **pulses**; the brain-as-prioritizer ranks
  the channels' gated work on the board.
- **v0.25 (true microkernel)** — the department/channel split is a step toward substrate-portable
  business functions.
- **Roadmap update needed:** the department-template microkernel (pulse + core + Growth) **shipped
  2026-06-17**, ahead of where the (2026-06-15) roadmap placed it — fold it in.
