// tests/flight-journey-03-onboarding.test.ts — Verification of Journey 3: Multimodal Business Onboarding & Agent Repo Scaffolding.
//
// Invariants verified:
//   1. FLIGHT ONBOARD-REPO: Auto-scaffold external git repository agent workspace (agents/<slug>/ .mcp.json, config.json, MEMORY.md).
//   2. FLIGHT ONBOARD-SAAS: 1-Click Starter Squad Pack setup (Engineering Sprint, Content Studio, Ops) with starter tasks.
//   3. FLIGHT ONBOARD-MCP: 10-Second Desktop Connect Bundle generator for Cursor, Codex, Claude Code, and Hermes.
//   4. D1 Schema Migration: 0142_onboarding_squad_packs.sql tables workspace_onboarding_records & agent_workspaces.
//   5. MCP Tools Integration: onboard_agent_workspace, onboard_provision_pack, onboard_desktop_bundle.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { scaffoldAgentWorkspace } from '../src/onboarding/repo-scaffold'
import { provisionStarterWorkspace, STARTER_SQUAD_PACKS } from '../src/onboarding/squad-packs'
import { generateDesktopConnectBundle } from '../src/onboarding/desktop-connect'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('Journey 3: Multimodal Business Onboarding & Agent Repo Scaffolding', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const ADMIN_ID = 'm-admin'
  const SQUAD_CORE = 'squad-core'

  const adminAuth: AuthContext = {
    userId: ADMIN_ID,
    memberId: ADMIN_ID,
    email: 'admin@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: ADMIN_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    } as unknown as Env

    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('${ADMIN_ID}', 'admin@mumega.com', 'Admin User', 'active');

      -- Set starter/pro tier so squad pack provisioning has sufficient agent/squad/department allowance
      INSERT OR IGNORE INTO org_settings (key, value)
      VALUES ('billing_state', '{"tier":"pro","event_id":"seed","effective_at":"2026-08-28T00:00:00Z"}');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_CORE}', 'dept-1', 'core', 'Core Squad');
    `)
  })

  describe('1. FLIGHT ONBOARD-REPO: Automated Git Repo Sensing & Scaffolding', () => {
    it('generates .mcp.json, config.json, MEMORY.md and records workspace tracking', async () => {
      const scaffold = await scaffoldAgentWorkspace(env, adminAuth, {
        agentName: 'Codex Dev Worker',
        agentSlug: 'codex-dev-worker',
        repoUrl: 'https://github.com/CustomerOrg/app-backend.git',
        harness: 'codex-desktop',
        machine: 'hadi-mac-m3',
      })

      expect(scaffold.ok).toBe(true)
      expect(scaffold.agentSlug).toBe('codex-dev-worker')
      expect(scaffold.targetFolder).toBe('agents/codex-dev-worker')

      // Verify generated files
      expect(scaffold.files.mcpJson).toContain('https://mupot.mumega.com/mcp')
      expect(scaffold.files.configJson).toContain('https://github.com/CustomerOrg/app-backend.git')
      expect(scaffold.files.memoryMd).toContain('Codex Dev Worker')
      expect(scaffold.files.checkinPayload.harness).toBe('codex-desktop')

      // Verify D1 workspace registration
      const wsRow = await env.DB.prepare(
        `SELECT * FROM agent_workspaces WHERE id = ?1`,
      ).bind(scaffold.workspaceId).first<{ repo_url: string; harness: string }>()

      expect(wsRow?.repo_url).toBe('https://github.com/CustomerOrg/app-backend.git')
      expect(wsRow?.harness).toBe('codex-desktop')
    })
  })

  describe('2. FLIGHT ONBOARD-SAAS: 1-Click Starter Squad Packs', () => {
    it('provisions engineering sprint crew with starter tasks and records onboarding', async () => {
      const provision = await provisionStarterWorkspace(env, adminAuth, {
        companyName: 'Acme Software Labs',
        businessType: 'engineering',
        starterPackKey: 'engineering_sprint',
        modelPreference: 'claude-3-7-sonnet',
      })

      expect(provision.ok).toBe(true)
      expect(provision.companyName).toBe('Acme Software Labs')
      expect(provision.agents).toHaveLength(3) // Lead Architect, Fast Builder, Gate Reviewer
      expect(provision.firstTaskId).toBeTruthy()

      // Verify onboarding record in D1
      const rec = await env.DB.prepare(
        `SELECT * FROM workspace_onboarding_records WHERE tenant = ?1`,
      ).bind(TENANT).first<{ company_name: string; starter_pack: string }>()

      expect(rec?.company_name).toBe('Acme Software Labs')
      expect(rec?.starter_pack).toBe('engineering_sprint')

      // Verify starter task created
      const task = await env.DB.prepare(
        `SELECT title, status FROM tasks WHERE id = ?1`,
      ).bind(provision.firstTaskId).first<{ title: string; status: string }>()

      expect(task?.title).toContain('Verify sovereign pot deployment')
      expect(task?.status).toBe('open')
    })
  })

  describe('3. FLIGHT ONBOARD-MCP: 10-Second Desktop Connect Bundle', () => {
    it('generates copy-paste configs for Cursor, Codex, Claude Code, and Hermes', () => {
      const bundle = generateDesktopConnectBundle(env, {
        rawToken: 'mupot_secret_token_123',
      })

      expect(bundle.mcpEndpoint).toBe('https://mupot.mumega.com/mcp')
      expect(bundle.authType).toBe('workspace_token')

      // Cursor config
      expect(bundle.harnessConfigs.cursorMcpJson).toContain('https://mupot.mumega.com/mcp')
      expect(bundle.harnessConfigs.cursorMcpJson).toContain('mupot_secret_token_123')

      // Codex config
      expect(bundle.harnessConfigs.codexToml).toContain('[mcp_servers.mumega]')
      expect(bundle.harnessConfigs.codexToml).toContain('mupot_secret_token_123')

      // Claude Code config
      expect(bundle.harnessConfigs.claudeCodeJson).toContain('https://mupot.mumega.com/mcp')

      // Hermes config
      expect(bundle.harnessConfigs.hermesEnv).toContain('MUPOT_MCP_ENDPOINT')
      expect(bundle.harnessConfigs.hermesEnv).toContain('mupot_secret_token_123')

      // Raw curl command
      expect(bundle.harnessConfigs.curlCommand).toContain('curl -X POST')
    })
  })

  describe('4. MCP Tools Integration Suite', () => {
    it('executes onboard_agent_workspace, onboard_provision_pack, and onboard_desktop_bundle via MCP', async () => {
      // 1. onboard_desktop_bundle
      const bundleRes = await invokeTool(adminAuth, env, 'onboard_desktop_bundle', {
        raw_token: 'mupot_demo_key',
      })
      expect(bundleRes.ok).toBe(true)
      expect((bundleRes.result as any).mcpEndpoint).toBe('https://mupot.mumega.com/mcp')

      // 2. onboard_provision_pack
      const packRes = await invokeTool(adminAuth, env, 'onboard_provision_pack', {
        company_name: 'Starlight Media',
        starter_pack_key: 'content_studio',
      })
      expect(packRes.ok).toBe(true)
      expect((packRes.result as any).starterPack).toBe('content_studio')

      // 3. onboard_agent_workspace
      const wsRes = await invokeTool(adminAuth, env, 'onboard_agent_workspace', {
        agent_name: 'Media Producer',
        repo_url: 'https://github.com/Starlight/media-assets.git',
        machine: 'starlight-studio-mac',
      })
      expect(wsRes.ok).toBe(true)
      expect((wsRes.result as any).targetFolder).toBe('agents/media-producer')
    })
  })
})
