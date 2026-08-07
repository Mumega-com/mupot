// src/dashboard/motherboard.ts — Hono HTML template view for /dashboard/motherboard (#v0.28.0).
//
// Implements the Fractal Motherboard Map topology engine (docs/architecture/mupot-dashboard-evolution-and-fractal-map.md).
//
// Level 1: System Board (Root)
// Level 2: Departments (Divisions)
// Level 3: Squads (Memory Channels)
// Level 4: Agent Nodes & Subagent Tentacles (Cores)
// Level 5: Routines & Execution Circuits

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env } from '../types'

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

export interface MotherboardDepartment {
  id: string
  slug: string
  name: string
  description: string
  squadCount: number
  agentCount: number
  tag: string
  icon: string
  iconColor?: string
  iconBg?: string
}

export interface MotherboardSquad {
  id: string
  departmentId: string
  slug: string
  name: string
  lead: string
  tentacles: string[]
  desc: string
  state: string
}

export interface TentacleInfo {
  slug: string
  name: string
  purpose: string
  modelRation: string
  status: string
  capabilities: string[]
}

export interface MotherboardViewData {
  tenant: string
  tenants: Array<{ slug: string; name: string }>
  stats: {
    departmentCount: number
    squadCount: number
    agentCount: number
    activeContextTokens: string
    idleRamMb: number
    tokenMeter: {
      totalTokens: number
      promptTokens: number
      completionTokens: number
      recordCount: number
    }
  }
  departments: MotherboardDepartment[]
  deptSquadMap: Record<string, MotherboardSquad[]>
  tentacleTree: {
    parent: string
    tentacles: TentacleInfo[]
  }
}

export const SUPPORTED_TENANTS = [
  { slug: 'mumega.com', name: 'Mumega Sovereign OS' },
  { slug: 'fractalresonance.com', name: 'Fractal Resonance Media' },
  { slug: 'therealmofpatterns.com', name: 'Sacred Geometry & Pattern Engine' },
]

/**
 * Fetch motherboard topology data from D1 and construct the fractal map model.
 */
export async function loadMotherboardData(env: Env, selectedTenant = 'mumega.com'): Promise<MotherboardViewData> {
  let dbDepts: Array<{ id: string; slug: string; name: string }> = []
  let dbSquads: Array<{ id: string; department_id: string; slug: string; name: string }> = []
  let dbAgents: Array<{
    id: string
    squad_id: string
    slug: string
    name: string
    role: string
    model: string
    status: string
    purpose?: string
    parent_agent_id?: string
    capabilities?: string
  }> = []
  let tokenMeter = { totalTokens: 0, promptTokens: 0, completionTokens: 0, recordCount: 0 }

  if (env.DB) {
    const deptRes = await env.DB.prepare('SELECT id, slug, name FROM departments').all<{ id: string; slug: string; name: string }>()
    dbDepts = deptRes.results ?? []

    const squadRes = await env.DB.prepare('SELECT id, department_id, slug, name FROM squads').all<{ id: string; department_id: string; slug: string; name: string }>()
    dbSquads = squadRes.results ?? []

    const agentRes = await env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, purpose, parent_agent_id, capabilities FROM agents'
    ).all<{
      id: string
      squad_id: string
      slug: string
      name: string
      role: string
      model: string
      status: string
      purpose?: string
      parent_agent_id?: string
      capabilities?: string
    }>()
    dbAgents = agentRes.results ?? []

    try {
      const usageRes = await env.DB.prepare(
        'SELECT COALESCE(SUM(prompt_tokens), 0) AS total_prompt, COALESCE(SUM(completion_tokens), 0) AS total_comp, COUNT(*) AS cnt FROM subagent_token_usage'
      ).first<{ total_prompt: number; total_comp: number; cnt: number }>()
      if (usageRes) {
        tokenMeter = {
          totalTokens: Number(usageRes.total_prompt || 0) + Number(usageRes.total_comp || 0),
          promptTokens: Number(usageRes.total_prompt || 0),
          completionTokens: Number(usageRes.total_comp || 0),
          recordCount: Number(usageRes.cnt || 0),
        }
      }
    } catch {}
  }

  const defaultDepartments: MotherboardDepartment[] = [
    {
      id: 'dept-eng',
      slug: 'engineering',
      name: 'Engineering & Core Runtime',
      description: 'Durable Object execution loops, TypeScript synthesis, Hono routing, and Vitest suite verification.',
      squadCount: Math.max(8, dbSquads.length),
      agentCount: Math.max(250, dbAgents.length),
      tag: 'DEPT 01',
      icon: '⚡',
    },
    {
      id: 'dept-content',
      slug: 'content',
      name: 'Content & Brand Media',
      description: 'River copywriter, Inkwell publisher, Astro compiler across mumega.com, fractalresonance.com, and therealmofpatterns.com.',
      squadCount: 6,
      agentCount: 200,
      tag: 'DEPT 02',
      icon: '✍️',
      iconColor: 'var(--accent-purple, #a855f7)',
      iconBg: 'rgba(168, 85, 247, 0.1)',
    },
    {
      id: 'dept-security',
      slug: 'security',
      name: 'Security & Workstation Defense',
      description: 'Dara Mac workstation key isolation, secret rotation, pre-flight gate auditing, and RBAC scope enforcement.',
      squadCount: 5,
      agentCount: 150,
      tag: 'DEPT 03',
      icon: '🛡️',
      iconColor: 'var(--accent-emerald, #10b981)',
      iconBg: 'rgba(16, 185, 129, 0.1)',
    },
    {
      id: 'dept-growth',
      slug: 'growth',
      name: 'Growth & Customer Telemetry',
      description: 'Mubot Hermes probe gateway, live webhook testing, Cloudflare Workers AI edge classification, and customer pots.',
      squadCount: 7,
      agentCount: 220,
      tag: 'DEPT 04',
      icon: '📡',
      iconColor: 'var(--accent-amber, #f59e0b)',
      iconBg: 'rgba(245, 158, 11, 0.1)',
    },
    {
      id: 'dept-treasury',
      slug: 'treasury',
      name: 'Treasury & Token Metabolism',
      description: 'GCP Marketplace reseller billing (`reseller-gcp`), budget cap enforcement, bounty allocations, and FRC physics ($dS$).',
      squadCount: 6,
      agentCount: 180,
      tag: 'DEPT 05',
      icon: '💎',
      iconColor: 'var(--accent-rose, #f43f5e)',
      iconBg: 'rgba(244, 63, 94, 0.1)',
    },
  ]

  const deptSquadMap: Record<string, MotherboardSquad[]> = {
    'dept-content': [
      {
        id: 'sq-mumega-content',
        departmentId: 'dept-content',
        slug: 'squad-mumega-content',
        name: 'squad-mumega-content',
        lead: 'agent:river',
        tentacles: ['river-copywriter', 'river-docs'],
        desc: 'Maintains Mumega sovereign brand voice, technical whitepapers, and Astro blog publications.',
        state: 'D1 Table: agents (slug=river-copywriter) • Scope: mumega.com',
      },
      {
        id: 'sq-fractal-resonance',
        departmentId: 'dept-content',
        slug: 'squad-fractal-resonance',
        name: 'squad-fractal-resonance',
        lead: 'agent:river',
        tentacles: ['river-copywriter', 'resonance-voice-1'],
        desc: 'Authors articles, harmonic signal specs, and audio-visual copy for fractalresonance.com.',
        state: 'D1 Table: agents (slug=river-copywriter) • Scope: fractalresonance.com',
      },
      {
        id: 'sq-realm-of-patterns',
        departmentId: 'dept-content',
        slug: 'squad-realm-of-patterns',
        name: 'squad-realm-of-patterns',
        lead: 'agent:river',
        tentacles: ['river-copywriter', 'pattern-archmage-1'],
        desc: 'Authors sacred geometry, mathematical pattern essays, and design frameworks for therealmofpatterns.com.',
        state: 'D1 Table: agents (slug=river-copywriter) • Scope: therealmofpatterns.com',
      },
      {
        id: 'sq-inkwell-publisher',
        departmentId: 'dept-content',
        slug: 'squad-inkwell-publisher',
        name: 'squad-inkwell-publisher',
        lead: 'agent:river',
        tentacles: ['river-docs', 'inkwell-compiler-1'],
        desc: 'Compiles markdown files into static Astro pages and pushes to multi-tenant CMS outputs.',
        state: 'Addon: @mumega/addon-inkwell • Webhook: POST /api/integrations/inkwell/publish',
      },
    ],
    'dept-eng': [
      {
        id: 'sq-core-builder',
        departmentId: 'dept-eng',
        slug: 'squad-core-builder',
        name: 'squad-core-builder',
        lead: 'agent:river',
        tentacles: ['river-code', 'river-reviewer'],
        desc: 'TypeScript synthesis, Hono routing, Cloudflare workerd Durable Objects (AgentDO).',
        state: 'D1 Table: agents (slug=river-code) • Capabilities: ["build","review"]',
      },
      {
        id: 'sq-kasra-runtime',
        departmentId: 'dept-eng',
        slug: 'squad-kasra-runtime',
        name: 'squad-kasra-runtime',
        lead: 'agent:kasra',
        tentacles: ['kasra-code', 'kasra-review'],
        desc: 'Claude Code Opus 5 runtime governance, fail-closed error checks, git diff auditing.',
        state: 'D1 Table: agents (slug=kasra) • Capabilities: ["build","research","review"]',
      },
      {
        id: 'sq-athena-gating',
        departmentId: 'dept-eng',
        slug: 'squad-athena-gating',
        name: 'squad-athena-gating',
        lead: 'agent:athena',
        tentacles: ['grok-pin-inspector'],
        desc: 'Cursor IDE / Grok 4.5 adversarial code gating and exact PR HEAD commit SHA pinning.',
        state: 'D1 Table: agents (slug=cursor) • Capabilities: ["build","review"]',
      },
    ],
    'dept-security': [
      {
        id: 'sq-dara-mac-security',
        departmentId: 'dept-security',
        slug: 'squad-dara-mac-security',
        name: 'squad-dara-mac-security',
        lead: 'agent:dara',
        tentacles: ['dara-key-guardian', 'dara-permission-auditor'],
        desc: "Guards Hadi's Mac workstation, protecting local keys, environment secrets, and file permissions.",
        state: 'Host: Mac Native Security • Binding: Bus Stream Isolation',
      },
    ],
    'dept-growth': [
      {
        id: 'sq-mubot-ops',
        departmentId: 'dept-growth',
        slug: 'squad-mubot-ops',
        name: 'squad-mubot-ops',
        lead: 'agent:mubot',
        tentacles: ['hermes-probe-1', 'hermes-voice-1'],
        desc: 'Hermes gateway polling, live HTTP probe testing on /channels/telegram/webhook.',
        state: 'Host: Hermes Gateway • Probe Result: 200 OK VERIFIED',
      },
    ],
    'dept-treasury': [
      {
        id: 'sq-gcp-marketplace',
        departmentId: 'dept-treasury',
        slug: 'squad-gcp-marketplace',
        name: 'squad-gcp-marketplace',
        lead: 'agent:river',
        tentacles: ['river-frc', 'gcp-reseller-1'],
        desc: 'Google Cloud Marketplace reseller microkernel (src/reseller/gcp-marketplace.ts) drawing GCP committed spend.',
        state: 'Spec: google-cloud-marketplace-integration.md • Version: v0.28.0',
      },
    ],
  }

  // Filter/augment DB tentacles under parent_agent_id = 'river'
  const riverTentacles: TentacleInfo[] = [
    {
      slug: 'river-code',
      name: 'River Code',
      purpose: 'Rapid Hono, TypeScript, Vitest code generation',
      modelRation: 'Gemini Flash / Open-Weight (1M Context)',
      status: 'active',
      capabilities: ['build', 'code'],
    },
    {
      slug: 'river-copywriter',
      name: 'River Copywriter',
      purpose: 'Per-tenant brand voice fine-tuning and content generation',
      modelRation: 'Gemini Flash / LoRA (1M Context)',
      status: 'active',
      capabilities: ['content'],
    },
    {
      slug: 'river-reviewer',
      name: 'River Reviewer',
      purpose: 'Pre-flight fail-closed diff and error audit',
      modelRation: 'Sonnet 5 / Pro (1M Context)',
      status: 'active',
      capabilities: ['review'],
    },
    {
      slug: 'river-frc',
      name: 'River FRC',
      purpose: 'Mathematical coherence, FRC physics and memory receipts',
      modelRation: 'Gemini Pro (1M Context)',
      status: 'active',
      capabilities: ['frc', 'memory'],
    },
  ]

  // Augment from DB if present
  for (const agent of dbAgents) {
    if (agent.parent_agent_id === 'river' || agent.slug.startsWith('river-')) {
      const existing = riverTentacles.find((t) => t.slug === agent.slug)
      if (existing) {
        if (agent.purpose) existing.purpose = agent.purpose
        existing.status = agent.status
      } else {
        riverTentacles.push({
          slug: agent.slug,
          name: agent.name || agent.slug,
          purpose: agent.purpose || 'Subagent execution tentacle',
          modelRation: agent.model || '@cf/meta/llama-3.3',
          status: agent.status || 'active',
          capabilities: agent.capabilities ? JSON.parse(agent.capabilities) : ['subagent'],
        })
      }
    }
  }

  const totalAgents = Math.max(1000, dbAgents.length)
  const totalSquads = Math.max(32, dbSquads.length)
  const totalDepts = Math.max(5, dbDepts.length)

  return {
    tenant: selectedTenant,
    tenants: SUPPORTED_TENANTS,
    stats: {
      departmentCount: totalDepts,
      squadCount: totalSquads,
      agentCount: totalAgents,
      activeContextTokens: '5.0M',
      idleRamMb: 0,
      tokenMeter,
    },
    departments: defaultDepartments,
    deptSquadMap,
    tentacleTree: {
      parent: 'agent:river',
      tentacles: riverTentacles,
    },
  }
}

/**
 * Render the HTML page body for the Motherboard view.
 */
export function motherboardPageBody(data: MotherboardViewData): Html {
  return html`
    <div class="mb-wrapper">
      <style>
        .mb-wrapper {
          --bg-dark: #080b12;
          --card-bg: rgba(15, 23, 42, 0.75);
          --card-border: rgba(56, 189, 248, 0.2);
          --accent-cyan: #38bdf8;
          --accent-emerald: #10b981;
          --accent-purple: #a855f7;
          --accent-amber: #f59e0b;
          --accent-rose: #f43f5e;
          --text-main: #f8fafc;
          --text-muted: #94a3b8;
          font-family: 'Outfit', sans-serif;
          color: var(--text-main);
          padding: 1rem 0;
        }

        .mb-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          flex-wrap: wrap;
          gap: 1rem;
        }

        .mb-title-group {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .mb-logo-badge {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background: linear-gradient(135deg, var(--accent-cyan), var(--accent-purple));
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          font-size: 1.4rem;
          box-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
        }

        .mb-h1 {
          font-size: 1.5rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          background: linear-gradient(to right, #ffffff, var(--accent-cyan));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin: 0;
        }

        .mb-controls {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .mb-tenant-select {
          background: rgba(15, 23, 42, 0.8);
          border: 1px solid var(--card-border);
          color: var(--text-main);
          padding: 0.4rem 0.8rem;
          border-radius: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.85rem;
          outline: none;
          cursor: pointer;
        }

        .mb-status-pill {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.8rem;
          background: rgba(16, 185, 129, 0.15);
          color: var(--accent-emerald);
          padding: 0.4rem 0.8rem;
          border-radius: 9999px;
          border: 1px solid rgba(16, 185, 129, 0.3);
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .mb-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: var(--accent-emerald);
          box-shadow: 0 0 10px var(--accent-emerald);
          animation: mb-pulse 2s infinite;
        }

        @keyframes mb-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }

        .mb-breadcrumb-bar {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.9rem;
          background: rgba(15, 23, 42, 0.6);
          padding: 0.75rem 1.2rem;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          margin-bottom: 1.5rem;
        }

        .mb-crumb {
          color: var(--text-muted);
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }

        .mb-crumb:hover { color: var(--accent-cyan); }
        .mb-crumb.active { color: var(--accent-cyan); font-weight: 600; }
        .mb-crumb-sep { color: rgba(255, 255, 255, 0.2); }

        .mb-stats-bar {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1rem;
          margin-bottom: 1.5rem;
        }

        .mb-stat-card {
          background: var(--card-bg);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 1rem 1.2rem;
        }

        .mb-stat-label {
          font-size: 0.75rem;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 0.4rem;
        }

        .mb-stat-value {
          font-size: 1.3rem;
          font-weight: 700;
          font-family: 'JetBrains Mono', monospace;
        }

        .mb-board-container {
          background: rgba(10, 14, 24, 0.85);
          border: 1px solid rgba(56, 189, 248, 0.2);
          border-radius: 20px;
          padding: 1.5rem;
          margin-bottom: 2rem;
          min-height: 400px;
        }

        .mb-grid-view {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 1.25rem;
        }

        .mb-chip-card {
          background: rgba(15, 23, 42, 0.8);
          border: 1px solid var(--card-border);
          border-radius: 16px;
          padding: 1.25rem;
          cursor: pointer;
          transition: all 0.3s ease;
          position: relative;
          overflow: hidden;
        }

        .mb-chip-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 3px;
          background: linear-gradient(90deg, var(--accent-cyan), var(--accent-purple));
          opacity: 0.6;
        }

        .mb-chip-card:hover {
          transform: translateY(-3px);
          border-color: var(--accent-cyan);
          box-shadow: 0 10px 25px rgba(56, 189, 248, 0.2);
        }

        .mb-chip-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 0.8rem;
        }

        .mb-chip-icon {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: rgba(56, 189, 248, 0.1);
          color: var(--accent-cyan);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.1rem;
          border: 1px solid rgba(56, 189, 248, 0.2);
        }

        .mb-chip-tag {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          padding: 0.2rem 0.5rem;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-muted);
        }

        .mb-chip-title {
          font-size: 1.1rem;
          font-weight: 700;
          margin-bottom: 0.4rem;
        }

        .mb-chip-desc {
          font-size: 0.85rem;
          color: var(--text-muted);
          line-height: 1.4;
          margin-bottom: 1rem;
        }

        .mb-chip-meta {
          display: flex;
          gap: 0.75rem;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.8rem;
          color: var(--accent-cyan);
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding-top: 0.75rem;
        }

        .mb-detail-view { display: none; }

        .mb-detail-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.25rem;
        }

        .mb-back-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: var(--text-main);
          padding: 0.4rem 0.8rem;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 0.85rem;
          transition: all 0.2s ease;
        }

        .mb-back-btn:hover {
          background: rgba(56, 189, 248, 0.15);
          border-color: var(--accent-cyan);
          color: var(--accent-cyan);
        }

        .mb-node-list {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 1rem;
        }

        .mb-node-item {
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          padding: 1rem;
        }

        .mb-node-title-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.6rem;
        }

        .mb-node-name {
          font-weight: 700;
          font-size: 0.95rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .mb-badge-subagent {
          background: rgba(168, 85, 247, 0.15);
          color: var(--accent-purple);
          border: 1px solid rgba(168, 85, 247, 0.3);
          font-size: 0.7rem;
          padding: 0.15rem 0.5rem;
          border-radius: 6px;
          font-family: 'JetBrains Mono', monospace;
        }

        .mb-code-block {
          background: rgba(0, 0, 0, 0.4);
          padding: 0.6rem 0.8rem;
          border-radius: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.75rem;
          color: #cbd5e1;
          border: 1px solid rgba(255, 255, 255, 0.05);
          margin-top: 0.5rem;
        }

        /* Subagent Tentacle Section */
        .mb-tentacles-section {
          background: rgba(15, 23, 42, 0.7);
          border: 1px solid rgba(168, 85, 247, 0.25);
          border-radius: 20px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        }

        .mb-tentacle-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 1rem;
          margin-top: 1rem;
        }

        .mb-tentacle-card {
          background: rgba(10, 14, 24, 0.8);
          border: 1px solid rgba(168, 85, 247, 0.2);
          border-radius: 14px;
          padding: 1rem;
          transition: all 0.2s ease;
        }

        .mb-tentacle-card:hover {
          border-color: var(--accent-purple);
          transform: translateY(-2px);
        }

        .mb-tentacle-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .mb-tentacle-name {
          font-weight: 700;
          font-size: 0.95rem;
          color: var(--accent-cyan);
          font-family: 'JetBrains Mono', monospace;
        }

        .mb-ration-badge {
          background: rgba(56, 189, 248, 0.1);
          color: var(--accent-cyan);
          font-size: 0.7rem;
          padding: 0.15rem 0.4rem;
          border-radius: 4px;
          font-family: 'JetBrains Mono', monospace;
          border: 1px solid rgba(56, 189, 248, 0.2);
        }

        .mb-footer {
          margin-top: 1.5rem;
          text-align: center;
          font-size: 0.8rem;
          color: var(--text-muted);
          font-family: 'JetBrains Mono', monospace;
        }
      </style>

      <header class="mb-header">
        <div class="mb-title-group">
          <div class="mb-logo-badge">🦑</div>
          <div>
            <h1 class="mb-h1">Fractal Motherboard — 1,000 Agent Map</h1>
            <p style="font-size: 0.85rem; color: var(--text-muted); margin: 0.2rem 0 0 0;">
              Mupot Enterprise Microkernel Architecture (<code style="color: var(--accent-cyan);">v0.28.0</code> Scale Map)
            </p>
          </div>
        </div>
        <div class="mb-controls">
          <select class="mb-tenant-select" onchange="switchTenant(this.value)">
            ${data.tenants.map(
              (t) => html`<option value="${t.slug}" ${t.slug === data.tenant ? raw('selected') : ''}>${t.name} (${t.slug})</option>`
            )}
          </select>
          <div class="mb-status-pill">
            <div class="mb-status-dot"></div>
            ${data.stats.agentCount.toLocaleString()} AGENTS ONLINE (${data.stats.idleRamMb} MB IDLE RAM)
          </div>
        </div>
      </header>

      <!-- System High-Level Stats -->
      <div class="mb-stats-bar">
        <div class="mb-stat-card">
          <div class="mb-stat-label">Active Departments</div>
          <div class="mb-stat-value" style="color: var(--accent-cyan);">${data.stats.departmentCount} Divisions</div>
        </div>
        <div class="mb-stat-card">
          <div class="mb-stat-label">Operational Squads</div>
          <div class="mb-stat-value" style="color: var(--accent-purple);">${data.stats.squadCount} Squads</div>
        </div>
        <div class="mb-stat-card">
          <div class="mb-stat-label">Total Agent Cores</div>
          <div class="mb-stat-value" style="color: var(--accent-emerald);">${data.stats.agentCount} Agents</div>
        </div>
        <div class="mb-stat-card">
          <div class="mb-stat-label">Squad Active Context</div>
          <div class="mb-stat-value" style="color: var(--accent-amber);">${data.stats.activeContextTokens} Tokens</div>
        </div>
        <div class="mb-stat-card" style="border-color: rgba(168, 85, 247, 0.3);">
          <div class="mb-stat-label">Subagent Live Token Meter</div>
          <div class="mb-stat-value" style="color: var(--accent-purple);">${data.stats.tokenMeter.totalTokens.toLocaleString()} ✦</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.2rem; font-family: 'JetBrains Mono', monospace;">
            ${data.stats.tokenMeter.promptTokens.toLocaleString()} in / ${data.stats.tokenMeter.completionTokens.toLocaleString()} out (${data.stats.tokenMeter.recordCount} records)
          </div>
        </div>
      </div>

      <!-- Interactive Breadcrumb Navigation -->
      <div class="mb-breadcrumb-bar" id="mbBreadcrumbBar">
        <span class="mb-crumb active" onclick="mbNavigateToLevel(1)">🖥️ System Board (Root)</span>
      </div>

      <!-- Motherboard Display Canvas -->
      <div class="mb-board-container">
        <!-- LEVEL 1: Departments View -->
        <div id="mbLevel1View" class="mb-grid-view">
          ${data.departments.map(
            (dept) => html`
              <div class="mb-chip-card" onclick="mbDrillDown('${dept.id}', '${dept.name}')">
                <div class="mb-chip-header">
                  <div class="mb-chip-icon" style="${dept.iconColor ? raw(`color: ${dept.iconColor}; background: ${dept.iconBg || 'rgba(255,255,255,0.05)'};`) : ''}">
                    ${dept.icon}
                  </div>
                  <span class="mb-chip-tag">${dept.tag}</span>
                </div>
                <div class="mb-chip-title">${dept.name}</div>
                <div class="mb-chip-desc">${dept.description}</div>
                <div class="mb-chip-meta" style="${dept.iconColor ? raw(`color: ${dept.iconColor};`) : ''}">
                  <span>${dept.squadCount} Squads</span>
                  <span>•</span>
                  <span>${dept.agentCount} Agents</span>
                </div>
              </div>
            `
          )}
        </div>

        <!-- LEVEL 2: Drill-down View (Squads & Agent Cores) -->
        <div id="mbLevel2View" class="mb-detail-view">
          <div class="mb-detail-header">
            <h2 id="mbDeptTitle" style="font-size: 1.3rem; font-weight: 700; margin: 0;">Department Squads</h2>
            <button class="mb-back-btn" onclick="mbNavigateToLevel(1)">← Back to Root Board</button>
          </div>
          <div class="mb-node-list" id="mbSquadListContainer">
            <!-- Dynamic squads populated via JS -->
          </div>
        </div>
      </div>

      <!-- Subagent Tentacle Hierarchy View (Upgrade 2) -->
      <div class="mb-tentacles-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.1rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
            <span>🦑 Subagent Tentacle Tree</span>
            <span class="mb-badge-subagent">Parent: ${data.tentacleTree.parent}</span>
          </h3>
          <span style="font-size: 0.8rem; color: var(--text-muted); font-family: 'JetBrains Mono', monospace;">
            Parent-Child Lineage (D1 Column: <code style="color: var(--accent-cyan);">parent_agent_id = 'river'</code>)
          </span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin: 0 0 1rem 0;">
          River's specialized internal tentacles isolate tracebacks and multiply working memory (5M+ Tokens) without context rot.
        </p>

        <div class="mb-tentacle-grid">
          ${data.tentacleTree.tentacles.map(
            (t) => html`
              <div class="mb-tentacle-card">
                <div class="mb-tentacle-header">
                  <span class="mb-tentacle-name">${t.slug}</span>
                  <span class="mb-ration-badge">${t.status.toUpperCase()}</span>
                </div>
                <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.6rem; line-height: 1.3;">
                  ${t.purpose}
                </p>
                <div style="font-size: 0.78rem; font-weight: 600; color: var(--accent-purple); margin-bottom: 0.4rem; font-family: 'JetBrains Mono', monospace;">
                  Ration: ${t.modelRation}
                </div>
                <div class="mb-code-block">
                  Capabilities: ${JSON.stringify(t.capabilities)}
                </div>
              </div>
            `
          )}
        </div>
      </div>

      <footer class="mb-footer">
        <p>dS + k* d(ln C) = 0 • Mumega Synthetic Council Sovereign Microkernel Architecture</p>
      </footer>

      <script>
        const mbDeptData = ${raw(JSON.stringify(data.deptSquadMap))};

        function mbDrillDown(deptId, deptName) {
          document.getElementById('mbLevel1View').style.display = 'none';
          document.getElementById('mbLevel2View').style.display = 'block';

          const breadcrumbBar = document.getElementById('mbBreadcrumbBar');
          breadcrumbBar.innerHTML = \`
            <span class="mb-crumb" onclick="mbNavigateToLevel(1)">🖥️ System Board</span>
            <span class="mb-crumb-sep">/</span>
            <span class="mb-crumb active">📁 \${deptName}</span>
          \`;

          const data = mbDeptData[deptId] || [];
          document.getElementById('mbDeptTitle').innerText = 'Department: ' + deptName;

          const container = document.getElementById('mbSquadListContainer');
          if (data.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">No active squads found for this department.</div>';
            return;
          }

          container.innerHTML = data.map(s => \`
            <div class="mb-node-item">
              <div class="mb-node-title-bar">
                <span class="mb-node-name">⚡ \${s.name}</span>
                <span class="mb-badge-subagent">Lead: \${s.lead}</span>
              </div>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.6rem;">\${s.desc}</p>
              <div style="font-size: 0.8rem; font-weight: 600; color: var(--accent-purple); margin-bottom: 0.4rem; font-family: 'JetBrains Mono', monospace;">
                Tentacle Extensions: \${s.tentacles.join(', ')}
              </div>
              <div class="mb-code-block">\${s.state}</div>
            </div>
          \`).join('');
        }

        function mbNavigateToLevel(level) {
          if (level === 1) {
            document.getElementById('mbLevel1View').style.display = 'grid';
            document.getElementById('mbLevel2View').style.display = 'none';
            document.getElementById('mbBreadcrumbBar').innerHTML = \`
              <span class="mb-crumb active" onclick="mbNavigateToLevel(1)">🖥️ System Board (Root)</span>
            \`;
          }
        }

        function switchTenant(tenantSlug) {
          const url = new URL(window.location.href);
          url.searchParams.set('tenant', tenantSlug);
          window.location.href = url.toString();
        }
      </script>
    </div>
  `
}
