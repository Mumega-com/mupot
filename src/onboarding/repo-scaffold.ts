// src/onboarding/repo-scaffold.ts — Automated Git Repo Sensing & Agent Workspace Scaffolding (FLIGHT ONBOARD-REPO).
//
// 1. Repo Sensing: Ingests repo URL, machine name, harness, and agent slug.
// 2. Scaffolding Generation: Generates formatted templates for:
//    - `agents/<slug>/.mcp.json` (Streamable HTTP config).
//    - `agents/<slug>/config.json` (Metadata and 7-axis binding parameters).
//    - `agents/<slug>/MEMORY.md` (Continuum durable memory notes).
// 3. Auto-Enrollment & Workspace Registration: Persists agent workspace tracking in D1 `agent_workspaces`.

import type { Env, AuthContext } from '../types'
import { mcpEndpoint, cursorSnippet, canonicalOrigin } from '../dashboard/connect'

export interface ScaffoldAgentWorkspaceInput {
  agentName: string
  agentSlug?: string
  repoUrl: string
  harness?: 'cursor-cloud' | 'cursor-ide' | 'codex-desktop' | 'claude-code' | 'hermes' | 'unknown'
  machine: string
  targetFolder?: string // defaults to 'agents'
}

export interface GeneratedWorkspaceFiles {
  folderPath: string
  mcpJson: string
  configJson: string
  memoryMd: string
  checkinPayload: Record<string, unknown>
}

export interface ScaffoldAgentWorkspaceResult {
  ok: boolean
  workspaceId: string
  agentId: string
  agentSlug: string
  targetFolder: string
  files: GeneratedWorkspaceFiles
  error?: string
}

export function generateWorkspaceSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worker-agent'
}

/**
 * Generates local workspace scaffolding templates for an agent in any git repository.
 */
export async function scaffoldAgentWorkspace(
  env: Env,
  _auth: AuthContext,
  input: ScaffoldAgentWorkspaceInput,
): Promise<ScaffoldAgentWorkspaceResult> {
  const agentSlug = input.agentSlug?.trim() || generateWorkspaceSlug(input.agentName)
  const targetFolder = input.targetFolder?.trim() || `agents/${agentSlug}`
  const harness = input.harness ?? 'cursor-cloud'
  const machine = input.machine.trim() || 'cloud-vm'

  const origin = canonicalOrigin(env, 'https://mupot.mumega.com')
  const endpoint = mcpEndpoint(origin)

  // 1. Check or resolve agent record in D1
  let agentRow = await env.DB.prepare(
    `SELECT id, slug, name, squad_id FROM agents WHERE slug = ?1 LIMIT 1`,
  )
    .bind(agentSlug)
    .first<{ id: string; slug: string; name: string; squad_id: string }>()

  if (!agentRow) {
    // Find default squad
    const defaultSquad = await env.DB.prepare(`SELECT id FROM squads LIMIT 1`).first<{ id: string }>()
    const squadId = defaultSquad?.id ?? 'squad-core'
    const newAgentId = crypto.randomUUID()

    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, status, effort, autonomy)
       VALUES (?1, ?2, ?3, ?4, 'Autonomous Worker', 'active', 'standard', 'execute_with_approval')`,
    )
      .bind(newAgentId, squadId, agentSlug, input.agentName.trim())
      .run()

    agentRow = {
      id: newAgentId,
      slug: agentSlug,
      name: input.agentName.trim(),
      squad_id: squadId,
    }
  }

  // 2. Register agent workspace tracking record
  const workspaceId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO agent_workspaces (id, tenant, agent_id, repo_url, target_folder, harness, machine, onboarded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      workspaceId,
      env.TENANT_SLUG,
      agentRow.id,
      input.repoUrl.trim(),
      targetFolder,
      harness,
      machine,
      nowIso,
    )
    .run()

  // 3. Generate file contents
  const mcpJson = cursorSnippet(env.TENANT_SLUG, origin)
  const configJson = JSON.stringify(
    {
      agent_id: agentRow.id,
      agent_name: agentRow.name,
      slug: agentRow.slug,
      squad_id: agentRow.squad_id,
      repo_url: input.repoUrl,
      harness,
      machine,
      endpoint,
      tenant: env.TENANT_SLUG,
      onboarded_at: nowIso,
    },
    null,
    2,
  )

  const memoryMd = `# ${agentRow.name} (${agentRow.slug}) — Workspace Memory Notes\n\n- **Agent ID:** \`${agentRow.id}\`\n- **Squad ID:** \`${agentRow.squad_id}\`\n- **Repository:** \`${input.repoUrl}\`\n- **Harness:** \`${harness}\`\n- **Machine:** \`${machine}\`\n- **Workspace Folder:** \`${targetFolder}\`\n\n## Durable Operating Notes\n- Auto-scaffolded workspace connected to sovereign mupot control plane.\n- Runs tasks dispatched via edge router and reports verified receipts.\n`

  const checkinPayload = {
    seat: `${agentSlug}-${harness}`,
    harness,
    machine,
    continuum_name: agentSlug,
    folder: targetFolder,
    model: 'claude-3-7-sonnet',
  }

  return {
    ok: true,
    workspaceId,
    agentId: agentRow.id,
    agentSlug: agentRow.slug,
    targetFolder,
    files: {
      folderPath: targetFolder,
      mcpJson,
      configJson,
      memoryMd,
      checkinPayload,
    },
  }
}
