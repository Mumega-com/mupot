// src/onboarding/squad-packs.ts — 1-Click Starter Squad Packs & Business Provisioning (FLIGHT ONBOARD-SAAS).
//
// Pre-built Starter Squad Packs for 1-click business setup:
// 1. 'engineering_sprint': Software Engineering Crew (Lead Architect, Fast Builder, Gate Reviewer).
// 2. 'content_studio': Marketing & SEO Content Studio (Lore/Content Author, SEO Optimizer, Media Producer).
// 3. 'business_ops': Business Operations & Support (Triage Agent, Analytics Monitor, Operator Assistant).

import type { Env, AuthContext } from '../types'
import { createAgent } from '../org/service'
import { createTask } from '../tasks/service'

export interface StarterPackDefinition {
  key: string
  name: string
  businessType: 'engineering' | 'growth_agency' | 'operations' | 'ecommerce' | 'custom'
  departmentSlug: string
  departmentName: string
  squadSlug: string
  squadName: string
  charter: string
  agents: Array<{
    slug: string
    name: string
    role: string
    okr: string
    kpiTarget: string
  }>
  starterTaskTitle: string
  starterTaskDoneWhen: string
}

export const STARTER_SQUAD_PACKS: Record<string, StarterPackDefinition> = {
  engineering_sprint: {
    key: 'engineering_sprint',
    name: 'Engineering Sprint Team',
    businessType: 'engineering',
    departmentSlug: 'dept-engineering',
    departmentName: 'Engineering',
    squadSlug: 'squad-eng',
    squadName: 'Engineering Sprint Squad',
    charter: 'Build, test, review, and ship production features and patches with verified CI evidence.',
    agents: [
      {
        slug: 'eng-lead',
        name: 'Lead Architect',
        role: 'Architect & Coordinator',
        okr: 'Coordinate technical sprint priorities and review system architecture',
        kpiTarget: '10 reviewed PRs / week',
      },
      {
        slug: 'eng-builder',
        name: 'Fast Builder',
        role: 'Full-Stack Developer',
        okr: 'Implement features and test suites in isolated worktrees',
        kpiTarget: '15 passing commits / week',
      },
      {
        slug: 'eng-gate',
        name: 'Gate Reviewer',
        role: 'Security & Quality Gate',
        okr: 'Verify CI checks and enforce cryptographic receipt contracts',
        kpiTarget: '0 unverified merges',
      },
    ],
    starterTaskTitle: 'Verify sovereign pot deployment and run starter test suite',
    starterTaskDoneWhen: 'All health checks pass and first PR is verified',
  },
  content_studio: {
    key: 'content_studio',
    name: 'Marketing & SEO Content Studio',
    businessType: 'growth_agency',
    departmentSlug: 'dept-growth',
    departmentName: 'Growth & Marketing',
    squadSlug: 'squad-growth',
    squadName: 'Content Studio Squad',
    charter: 'Produce high-converting blog content, technical case studies, and search-optimized media.',
    agents: [
      {
        slug: 'content-writer',
        name: 'Content Author',
        role: 'Lead Copywriter',
        okr: 'Draft authoritative technical guides and customer case studies',
        kpiTarget: '4 published articles / month',
      },
      {
        slug: 'seo-optimizer',
        name: 'SEO Specialist',
        role: 'Search Optimization',
        okr: 'Audit keyword rankings and optimize on-page schema markup',
        kpiTarget: '100% Core Web Vitals pass rate',
      },
    ],
    starterTaskTitle: 'Draft initial product launch announcement and SEO meta tags',
    starterTaskDoneWhen: 'Draft reviewed and approved by operator at /approvals',
  },
  business_ops: {
    key: 'business_ops',
    name: 'Business Operations & Support',
    businessType: 'operations',
    departmentSlug: 'dept-ops',
    departmentName: 'Operations',
    squadSlug: 'squad-ops',
    squadName: 'Operations Squad',
    charter: 'Triage customer inquiries, monitor fleet telemetry, and coordinate daily business routines.',
    agents: [
      {
        slug: 'ops-triage',
        name: 'Triage Assistant',
        role: 'Inbox & Request Triage',
        okr: 'Sort inbound requests and route high-priority items to operators',
        kpiTarget: '<5m triage latency',
      },
      {
        slug: 'ops-monitor',
        name: 'Telemetry Watcher',
        role: 'System Health Monitor',
        okr: 'Monitor spend caps and heartbeat liveness across the fleet',
        kpiTarget: '0 unalerted stalls',
      },
    ],
    starterTaskTitle: 'Configure daily operator digest and health sweep routine',
    starterTaskDoneWhen: 'Daily report successfully sent to admin inbox',
  },
}

export interface ProvisionWorkspaceInput {
  companyName: string
  businessType?: 'engineering' | 'growth_agency' | 'operations' | 'ecommerce' | 'custom'
  starterPackKey: string
  modelPreference?: string
}

export interface ProvisionWorkspaceResult {
  ok: boolean
  companyName: string
  starterPack: string
  departmentId: string
  squadId: string
  agents: Array<{ id: string; slug: string; name: string }>
  firstTaskId?: string
  error?: string
}

/**
 * 1-Click Provisioning of a complete business workspace with pre-packaged squads & starter tasks.
 */
export async function provisionStarterWorkspace(
  env: Env,
  _auth: AuthContext,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionWorkspaceResult> {
  const pack = STARTER_SQUAD_PACKS[input.starterPackKey] || STARTER_SQUAD_PACKS.engineering_sprint
  const businessType = input.businessType || pack.businessType
  const modelPref = input.modelPreference || 'claude-3-7-sonnet'
  const nowIso = new Date().toISOString()

  // 1. Create Department
  let departmentId = ''
  const existingDept = await env.DB.prepare(`SELECT id FROM departments WHERE slug = ?1`).bind(pack.departmentSlug).first<{ id: string }>()
  if (existingDept) {
    departmentId = existingDept.id
  } else {
    const deptId = crypto.randomUUID()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO departments (id, slug, name, kind, created_at) VALUES (?, ?, ?, 'work', ?)`,
    )
      .bind(deptId, pack.departmentSlug, pack.departmentName, now)
      .run()
    departmentId = deptId
  }

  // 2. Create Squad
  let squadId = ''
  const existingSquad = await env.DB.prepare(`SELECT id FROM squads WHERE slug = ?1`).bind(pack.squadSlug).first<{ id: string }>()
  if (existingSquad) {
    squadId = existingSquad.id
  } else {
    const sId = crypto.randomUUID()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO squads (id, department_id, slug, name, charter, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(sId, departmentId, pack.squadSlug, pack.squadName, pack.charter, now)
      .run()
    squadId = sId
  }

  // 3. Create Agents
  const createdAgents: Array<{ id: string; slug: string; name: string }> = []
  for (const a of pack.agents) {
    const agentRes = await createAgent(env, squadId, {
      slug: a.slug,
      name: a.name,
      role: a.role,
      okr: a.okr,
      kpi_target: a.kpiTarget,
      model: modelPref,
      effort: 'standard',
      autonomy: 'execute_with_approval',
    })
    if (agentRes.ok) {
      createdAgents.push({ id: agentRes.value.id, slug: agentRes.value.slug, name: agentRes.value.name })
    }
  }

  // 4. Create First Starter Task on Squad
  let firstTaskId: string | undefined
  try {
    const task = await createTask(env, {
      squad_id: squadId,
      title: pack.starterTaskTitle,
      body: `Welcome to ${input.companyName}! This is your starter task to verify your agent crew. [owner: @operator, ttl: 7d]`,
      done_when: pack.starterTaskDoneWhen,
      priority: 'P1',
      status: 'open',
    }, { allowDeferredPredicate: true })
    firstTaskId = task.id
  } catch (err) {
    console.error('starter task creation error:', err)
  }

  // 5. Record Onboarding Milestones
  await env.DB.prepare(
    `INSERT INTO workspace_onboarding_records
       (tenant, company_name, business_type, starter_pack, model_preference, first_task_id, completed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (tenant) DO UPDATE SET
       company_name = excluded.company_name,
       business_type = excluded.business_type,
       starter_pack = excluded.starter_pack,
       first_task_id = excluded.first_task_id,
       completed_at = excluded.completed_at`,
  )
    .bind(
      env.TENANT_SLUG,
      input.companyName.trim(),
      businessType,
      pack.key,
      modelPref,
      firstTaskId ?? null,
      nowIso,
    )
    .run()

  return {
    ok: true,
    companyName: input.companyName,
    starterPack: pack.key,
    departmentId,
    squadId,
    agents: createdAgents,
    firstTaskId,
  }
}
