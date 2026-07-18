import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSignedProjectEnvelope,
  exportProjectLinkPublicKey,
  generateProjectLinkKeyPair,
} from '../src/addons/project-link/envelope'
import { projectLinkApp } from '../src/addons/project-link/routes'
import { createProjectLink } from '../src/addons/project-link/service'
import { activateAddon, configureAddon, installAddon } from '../src/addons/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const NOW = '2026-07-18T22:30:00.000Z'

describe('project-link delivery route', () => {
  let harness: SqliteD1Harness
  let env: Env
  let sourceKeys: CryptoKeyPair
  let destinationKeys: CryptoKeyPair

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad', 'dept', 'squad', 'Squad');
      INSERT INTO projects (id, slug, name, status) VALUES ('project', 'project', 'Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project', 'squad', 'write');
    `)
    destinationKeys = await generateProjectLinkKeyPair()
    env = {
      DB: harness.db,
      TENANT_SLUG: 'dme',
      BUS: { send: async () => undefined },
      PROJECT_LINK_SIGNING_KEY: JSON.stringify(await crypto.subtle.exportKey('jwk', destinationKeys.privateKey)),
    } as unknown as Env
    const actor = { id: 'owner', role: 'owner' as const }
    const installed = await installAddon(env, actor, 'project-link')
    const configured = await configureAddon(env, actor, 'project-link')
    const activated = await activateAddon(env, actor, 'project-link')
    if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
    sourceKeys = await generateProjectLinkKeyPair()
    const created = await createProjectLink(env, {
      id: 'dme-link',
      local_project_id: 'project',
      local_squad_id: 'squad',
      local_agent_id: 'dme-agent',
      local_key_id: 'dme-key',
      remote_pot: 'mumega',
      remote_project_id: 'mumega-project',
      remote_link_id: 'mumega-link',
      remote_agent_id: 'codex-mac-mumcp',
      remote_key_id: 'mumega-key',
      remote_public_key: await exportProjectLinkPublicKey(sourceKeys.publicKey),
      remote_base_url: 'https://mumega.mupot.test',
      capabilities: ['project.task.write'],
      approved_evidence_origins: [],
      stale_after_seconds: 300,
    }, { id: 'owner', role: 'owner' }, NOW)
    if (!created.ok) throw new Error('fixture link creation failed')
  })

  afterEach(() => harness.close())

  async function signed() {
    return createSignedProjectEnvelope({
      source: { pot: 'mumega', project_id: 'mumega-project', agent_id: 'codex-mac-mumcp', key_id: 'mumega-key' },
      destination: { pot: 'dme', project_id: 'project' },
      correlation_id: 'flight-001',
      idempotency_key: 'delivery-001',
      requested_capability: 'project.task.write',
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      task: {
        source_task_id: 'task-001', flight_id: 'flight-001', request_id: null,
        title: 'Validate governed delivery', state: 'in_progress', priority: 'high', blocker_summary: null,
        success_predicate: 'The destination stores one task and one matching receipt.',
        progress_summary: 'The source completed its sanitized preflight.',
      },
      evidence: null,
    }, sourceKeys.privateKey)
  }

  it('accepts an unauthenticated but valid signed delivery and returns the same receipt on replay', async () => {
    const body = JSON.stringify(await signed())
    const request = () => new Request('https://dme.test/dme-link/deliver', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) }, body,
    })

    const first = await projectLinkApp.fetch(request(), env)
    const replay = await projectLinkApp.fetch(request(), env)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(200)
    const firstBody = await first.json() as { receipt: { shared_receipt_sha256: string } }
    const replayBody = await replay.json() as { receipt: { shared_receipt_sha256: string }; idempotent: boolean }
    expect(replayBody.idempotent).toBe(true)
    expect(replayBody.receipt.shared_receipt_sha256).toBe(firstBody.receipt.shared_receipt_sha256)
  })

  it('rejects malformed and oversized bodies before any database write', async () => {
    const malformed = await projectLinkApp.fetch(new Request('https://dme.test/dme-link/deliver', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    }), env)
    const oversized = await projectLinkApp.fetch(new Request('https://dme.test/dme-link/deliver', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '40000' }, body: '{}',
    }), env)

    expect(malformed.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })
})
