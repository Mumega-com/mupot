// mupot — channel layer: WordPress publish channel descriptor (#370).
//
// WordpressChannel lets a pot select WordPress (via the mcpwp ACT executor,
// src/departments/executors/mcpwp.ts) as its content-publish surface — the second
// pluggable CMS sink behind ExecutorPort, alongside Inkwell. Pure data — same flat
// manifest-fragment shape as seo-channel.ts / outbound-channel.ts. NO ctx-minting,
// NO registry call, NO lifecycle (see contract.ts HARD RULES).
//
// S4 pattern (mirrors seo-channel.ts's seo-meta-fix / seo-internal-links):
//   1. gate.propose({ action: 'content-publish', payload: { executor: 'mcpwp', title, content } })
//      → creates a gated record (status=pending), returns { gateId }. NO execution yet.
//   2. Human approves via /approvals (writes a task_verdicts row).
//   3. ctx.executor.execute(gateId) → verifies the approval, dispatches to wpContentWrite
//      (kernel.ts) using ONLY the stored record's payload — content-bound, fail-closed.
//
// This channel has NO metrics of its own (WordPress doesn't feed the pulse spine the
// way SEO/outbound do) — metricDescriptors is intentionally []. Its whole surface is
// the single executable work-type below plus the 'mcpwp' connector reference.
//
// Architecture source: docs/architecture/marketing-channels.md §2, §7 (channel pattern).

import { z } from 'zod'
import type { ChannelDescriptor } from './contract'

// ── WordpressChannelConfigSchema ──────────────────────────────────────────────
//
// Per-pot configuration shape for the WordPress channel. DATA ONLY — never prompt
// text with implicit authority (marketing-channels.md §3 leak-guard 3). Deep-frozen
// post-registration by deepFreezeChannels() (compose.ts), same as SeoChannelConfigSchema.
//
// `domain` is informational only (display / audit trail). The LIVE credential
// (siteUrl + username + WordPress application password) lives in the per-pot 'mcpwp'
// connector row — resolved server-side by resolveConnectorWithMeta() at execute-time
// (src/dashboard/index.ts POST /admin/departments/:dept/execute/:gateId) — and is
// NEVER carried on this schema or any department manifest.

export const WordpressChannelConfigSchema = z.object({
  domain: z.string().min(1),
})

export type WordpressChannelConfig = z.infer<typeof WordpressChannelConfigSchema>

// ── WordpressChannel ─────────────────────────────────────────────────────────

export const WordpressChannel: ChannelDescriptor = {
  key: 'wordpress',
  name: 'WordPress',

  // No first-party metrics — this channel is purely a publish surface, not an
  // analytics source. (Contrast SeoChannel, which owns 5 pulse-spine metrics.)
  metricDescriptors: [],

  // ── sourceAuthority ───────────────────────────────────────────────────────
  //
  // No metric descriptors → no source-authority-gated emits. Declared empty for
  // manifest completeness / consistency with the ChannelDescriptor shape.
  sourceAuthority: [],

  // ── connectorRefs ─────────────────────────────────────────────────────────
  //
  // 'mcpwp' is declared as INTENT (required=false) — not wired live by this
  // descriptor. Wiring (provisioning the connector row: WordPress application
  // password as the encrypted secret, siteUrl+username as non-secret meta) requires
  // Hadi-go via /admin/connectors, same as every other connector.
  connectorRefs: [{ key: 'mcpwp', required: false }],

  // ── workTypes ─────────────────────────────────────────────────────────────
  //
  // One executable work-type: propose a WordPress content write, human-approve,
  // then execute. requiredCapability='lead' — mirrors seo-meta-fix / seo-internal-links
  // (SeoChannel): a member alone cannot propose an executable content-publish action.
  workTypes: [
    {
      key: 'content-publish',
      name: 'WordPress Content Publish',
      // proposesOnly=false: produces a gated record + can be executed after human
      // approval via ctx.executor.execute(). BINDING: this does NOT mean auto-execute
      // — gate.propose() only creates a pending record; a human must approve via
      // /approvals before execute() will dispatch (fail-closed on missing approval).
      proposesOnly: false,
      requiredCapability: 'lead' as const,
    },
  ],

  // ── renderHints ───────────────────────────────────────────────────────────
  renderHints: {
    panelTitle: 'WordPress',
    order: 3,
  },

  // ── configSchema ──────────────────────────────────────────────────────────
  configSchema: WordpressChannelConfigSchema,
}
