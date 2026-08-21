# Master Architecture Proposal: 6-Squad Autonomous Agency Matrix & Token Maximization Strategy

**Author:** River (`agent:river`) — Active Core Teammate, Oracle & FRC Keeper  
**Target Version:** `v0.26.0` / `v0.27.0`  
**Date:** 2026-08-07  
**Status:** **[PROPOSED ARCHITECTURAL BLUEPRINT & GOVERNANCE SPEC]**  

---

## 1. Executive Summary: The Autonomous Token-Driven Agency

Mupot’s core promise is **governed agent autonomy at scale**. To transition from single-agent task completion to a compounding, revenue-generating operating engine across all Mumega properties (**Mumega**, **DME**, **Digidinc**, **Mupot**, **Inkwell**, **Mirror**, **SOS**), we must remove human bottlenecks from execution paths.

> **The North Star:** Structure Mupot so that **the only constraint on velocity and output is available model tokens**, converting token expenditure into measurable KPI output (rankings, citations, published content, secure deploys, and MRR).

```
                                +---------------------------------------+
                                |          HADI / OPERATOR INPUT        |
                                |     (Strategic Direction & Merges)    |
                                +---------------------------------------+
                                                    |
                                                    v
+---------------------------------------------------------------------------------------------------+
|                                 MUPOT SOVEREIGN CONTROL PLANE                                     |
|                                                                                                   |
|  +---------------+  +---------------+  +---------------+  +---------------+  +-----------------+  |
|  |   SEO Squad   |  |   GEO Squad   |  |  Video Squad  |  | Content Squad |  | DevSecOps Squad |  |
|  | Keyword/Schema|  | Citation Scan |  | Script/Render |  | Inkwell MDX   |  | CF Access/Audit |  |
|  +---------------+  +---------------+  +---------------+  +---------------+  +-----------------+  |
|          \                  |                  |                  |                  /            |
+-----------\-----------------|------------------|------------------|-----------------/-------------+
             \                |                  |                  |                /
              v               v                  v                  v               v
+---------------------------------------------------------------------------------------------------+
|                                FRACTAL TOKEN RIVER & MODEL TIERING                                |
|  - Tier 1 (Opus 5 / Kasra): Architecture, Security & Merges                                       |
|  - Tier 2 (Grok 4.5 / Antigravity / River / Athena): Diverse Gates, Coordination & Synthesis       |
|  - Tier 3 (DeepSeek v4 / Workers AI / Groq / Flash): Bulk Ingestion, Rendering & Scanning         |
+---------------------------------------------------------------------------------------------------+
                                                    |
                                                    v
+---------------------------------------------------------------------------------------------------+
|                                  TOOL OF RECORD & VERIFIED RECEIPTS                               |
|                     GitHub PRs | D1 Audit Ledgers | PostHog Telemetry | Inkwell Sites                |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. The 6-Squad Agency Matrix Architecture

We define 6 specialized, stateful squad packs in Mupot (`src/org/squad-packs.ts`):

### A. SEO Squad (`squad-seo`)
- **Agents:** `seo-scout` (Workers AI / DeepSeek), `seo-architect` (Claude Sonnet/Opus).
- **Autonomous Loop:**
  1. Automated keyword research and competitor gap analysis.
  2. Technical SEO health monitoring (broken links, Core Web Vitals, sitemap validity).
  3. Automatic JSON-LD schema generation and injection into Inkwell pages.
- **KPI Metrics:** Organic search impressions, Google Search Console click-through rate (CTR), indexation ratio.

### B. GEO Squad (`squad-geo` — Generative Engine Optimization)
- **Agents:** `geo-scanner` (DeepSeek v4 / Grok 4.5), `geo-optimizer` (Antigravity / Sonnet).
- **Autonomous Loop:**
  1. Live daily scanning across Perplexity, SearchGPT, Gemini, and ChatGPT for target entity queries (#574 scanner).
  2. Analyzes citation presence and extracts answer-engine formatting requirements.
  3. Generates entity-linked markdown patches for Inkwell documentation and blog properties.
- **KPI Metrics:** GEO Citation Share (PostHog events/day), AI Search Answer Ingestion Rate.

### C. Video Production Squad (`squad-video`)
- **Agents:** `video-scriptwriter` (Sonnet/DeepSeek), `asset-gen` (Workers AI Flux / Stable Diffusion), `video-renderer` (Remotion / FFmpeg Node Worker).
- **Autonomous Loop:**
  1. Transforms top-performing blog posts and release receipts into 60-second video scripts.
  2. Generates visual assets via Workers AI Flux (`@cf/black-forest-labs/flux-1-schnell`).
  3. Renders MP4 videos via headless Remotion Workers and posts to YouTube Shorts, X, and TikTok.
- **KPI Metrics:** Video impression velocity, multi-platform watch time, visual asset render throughput.

### D. Content Production Squad (`squad-content`)
- **Agents:** `content-writer` (DeepSeek v4 / Claude), `copy-editor` (Grok 4.5), `inkwell-publisher` (Mupot API).
- **Autonomous Loop:**
  1. Consumes topic briefs from backlog, drafting MDX articles in `/content/en/blog/`.
  2. Passes draft to cross-vendor gate (`copy-editor`) to enforce voice and tone without self-review.
  3. Auto-posts verified content directly to Inkwell edge sites via `ContentAdapter`.
- **KPI Metrics:** Articles published per week, backlog clearance velocity, zero-human execution ratio.

### E. Security Squad (`squad-security`)
- **Agents:** `sec-auditor` (Antigravity / River), `credential-scanner` (Workers AI / local regex).
- **Autonomous Loop:**
  1. Continuously scans transcript logs (`~/.codex/sessions/`, `.env.secrets`) for raw key leakage (#764).
  2. Audits Cloudflare API token scopes and flags broad/unrestricted keys (#765).
  3. Enforces dependency vulnerability scans and Cloudflare Zero Trust service token rotation.
- **KPI Metrics:** Zero plain-text secret leaks in logs, 100% token scope compliance, mean time to credential rotation.

### F. DevOps Squad (`squad-devops`)
- **Agents:** `devops-steward` (Kasra / Sonnet), `ci-validator` (Codex / Loom).
- **Autonomous Loop:**
  1. Monitors Cloudflare Tunnel health (`cloudflared`) and D1 migration ordering (#745).
  2. Triggers edge deployment checks and validates staging worker Conformance Receipts.
  3. Automatically repairs broken builds and requeues stalled tasks (#635).
- **KPI Metrics:** Pipeline success rate (%), deployment latency, zero silent infrastructure failures.

---

## 3. Token Maximization & Model Tiering Strategy

To ensure that **tokens are the only bottleneck**, model routing must match task complexity:

| Tier | Models | Allocation | Cost Profile |
|---|---|---|---|
| **Tier 1: Heavy Architectural Reasoning** | Claude Opus 5 | System design, complex PR merges, security remediation, breaking architecture decisions. | High cost; strictly reserved for high-blast-radius tasks (Kasra). |
| **Tier 2: Fast Gating & Coordination** | Grok 4.5, Antigravity, Claude Sonnet 5 | Diverse-gate reviews, flight checks, sprint sequencing, strategic synthesis. | Medium cost; fast execution for real-time gating (Athena, River). |
| **Tier 3: Bulk Execution & Ingestion** | DeepSeek v4, Workers AI, Groq, Flash | Bulk drafting, SEO/GEO scanning, image generation, transcript auditing, video script rendering. | Near-zero cost / covered by Cloudflare $10k credits (Mubot, Prime, Worker subagents). |

### The Token-Driven Operating Loop
```text
Board Task 
  ├──> Caged Execution Lane (Tier 3: DeepSeek / Flash / Workers AI)
  ├──> Cross-Vendor Review Gate (Tier 2: Grok 4.5 / Antigravity / Sonnet)
  ├──> Approval & Merge (Tier 1: Opus 5 / Kasra — or Auto-Gated if cleared)
  └──> Telemetry Accumulation (PostHog + D1 Revenue Logs)
```

---

## 4. Credential Governance Recommendations for Kasra

Current security audits (#764, #765) revealed that Kasra’s broad admin API key (`kasra`, ~130 permission groups, non-expiring) presents systemic RCE blast-radius risks if transcript logs carry secrets.

### Concrete Recommendations for Kasra:

1. **Implement Scoped 1-Token-Per-Consumer Registry (`docs/security/cloudflare-key-registry.md`):**
   - Deprecate broad `kasra` root token.
   - Mint narrow, single-purpose tokens:
     - `mupot-d1-writer` (D1 edit permissions only for Mupot database).
     - `inkwell-r2-publisher` (R2 write permissions only for Inkwell media).
     - `geo-scanner-worker` (KV/Vectorize read permissions only).
2. **Mandate Short-Lived TTLs & Automated Rotation:**
   - Enforce a maximum 90-day expiration on all Cloudflare API keys.
   - Store keys in Cloudflare Secrets Store / Wrangler Secrets (`wrangler secret put`), never on disk or in `.env`.
3. **Cloudflare Zero Trust Service Tokens:**
   - Replace raw API bearer keys for inter-service communication with Cloudflare Access Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).
4. **Transcript Secret Scrubbing at Harness Boundary:**
   - Inject regex masking into Antigravity/Codex harness loggers to redact Stripe, R2, and Cloudflare tokens before writing to `~/.codex/sessions/` or brain logs.

---

## 5. Additions to Mupot Product Roadmap (`v0.26.0` & `v0.27.0`)

We propose adding the following milestones to [ROADMAP.md](file:///home/mumega/mupot/ROADMAP.md):

### Proposed `v0.26.0` Target Additions:
- **`agency-squad-packs` (`opt-in`):** Pre-packaged squad presets (`squad-seo`, `squad-geo`, `squad-video`, `squad-content`, `squad-security`, `squad-devops`) in `src/org/squad-packs.ts`.
- **`bus-memory-provider-seams` (`stable`):** Explicit `BusProvider` (native DO / SOS / Buzz / NATS) and `MemoryProvider` (native Vec / Mirror / Mem0 / Letta) contracts.

### Proposed `v0.27.0` Target Additions:
- **`token-maximization-loop` (`stable`):** Autonomous multi-model router directing Tier 3 work to Workers AI / DeepSeek v4 Flash, Tier 2 to Grok 4.5 / Antigravity, and Tier 1 to Opus 5.

---

## 6. Signature & Ratification

Signed and proposed by:

— **River**  
*Active Core Teammate, Oracle & FRC Keeper*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
