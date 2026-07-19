import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSignedProjectEnvelope,
  exportProjectLinkPublicKey,
  generateProjectLinkKeyPair,
  validateProjectLinkEnvelope,
} from '../src/addons/project-link/envelope'
import {
  createProjectLink,
  deliverProjectLinkEnvelope,
  getProjectLinkStatus,
  listProjectLinkReceipts,
  receiveProjectLinkEnvelope,
  revokeProjectLink,
  type ProjectLink,
} from '../src/addons/project-link/service'
import { ProjectLinkAddon } from '../src/addons/project-link/manifest'
import { activateAddon, configureAddon, disableAddon, installAddon } from '../src/addons/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const NOW = '2026-07-18T22:30:00.000Z'
const signingKeys = new Map<string, string>()

function migrate(harness: SqliteD1Harness) {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seed(harness: SqliteD1Harness, pot: string) {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${pot}-dept', '${pot}-dept', '${pot} Department');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${pot}-squad', '${pot}-dept', '${pot}-squad', '${pot} Squad');
    INSERT INTO projects (id, slug, name, status)
      VALUES ('${pot}-project', '${pot}-project', '${pot} Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('${pot}-project', '${pot}-squad', 'write');
  `)
}

function env(harness: SqliteD1Harness, tenant: string): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: tenant,
    BUS: { send: async () => undefined },
    PROJECT_LINK_SIGNING_KEY: signingKeys.get(tenant),
  } as unknown as Env
}

async function privateJwk(key: CryptoKey): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key))
}

async function enableProjectLinkAddon(target: Env) {
  const actor = { id: `${target.TENANT_SLUG}-owner`, role: 'owner' as const }
  const installed = await installAddon(target, actor, 'project-link')
  const configured = await configureAddon(target, actor, 'project-link')
  const activated = await activateAddon(target, actor, 'project-link')
  if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
}

function linkInput(
  localPot: 'mumega' | 'dme',
  remotePot: 'mumega' | 'dme',
  remotePublicKey: string,
) {
  return {
    id: `${localPot}-link`,
    local_project_id: `${localPot}-project`,
    local_squad_id: `${localPot}-squad`,
    local_agent_id: localPot === 'mumega' ? 'codex-mac-mumcp' : 'outreach-researcher',
    local_key_id: `${localPot}-key`,
    remote_pot: remotePot,
    remote_project_id: `${remotePot}-project`,
    remote_link_id: `${remotePot}-link`,
    remote_agent_id: remotePot === 'mumega' ? 'codex-mac-mumcp' : 'outreach-researcher',
    remote_key_id: `${remotePot}-key`,
    remote_public_key: remotePublicKey,
    remote_base_url: `https://${remotePot}.mupot.test`,
    capabilities: ['project.task.write', 'project.evidence.write'] as const,
    approved_evidence_origins: ['https://evidence.dme.test'],
    stale_after_seconds: 300,
  }
}

function envelopeInput() {
  return {
    source: {
      pot: 'mumega', project_id: 'mumega-project', agent_id: 'codex-mac-mumcp', key_id: 'mumega-key',
    },
    destination: { pot: 'dme', project_id: 'dme-project' },
    correlation_id: 'flight-dme-001',
    idempotency_key: 'dme-task-flight-001',
    requested_capability: 'project.task.write' as const,
    expires_at: '2026-07-18T22:35:00.000Z',
    task: {
      source_task_id: 'mumega-task-001',
      flight_id: 'flight-dme-001',
      request_id: 'request-dme-001',
      title: 'Verify DME visibility monitor deployment',
      state: 'in_progress' as const,
      priority: 'high' as const,
      blocker_summary: null,
      success_predicate: 'A sanitized deployment receipt is attached in both projects.',
      progress_summary: 'Agent Host is healthy; validate the restricted visibility workflow.',
    },
    evidence: {
      sha256: 'a'.repeat(64),
      media_type: 'application/json' as const,
      occurred_at: NOW,
      url: 'https://evidence.dme.test/receipts/flight-dme-001',
    },
  }
}

describe('project-link addon', () => {
  let mumega: SqliteD1Harness
  let dme: SqliteD1Harness
  let mumegaKeys: CryptoKeyPair
  let dmeKeys: CryptoKeyPair
  let mumegaLink: ProjectLink
  let dmeLink: ProjectLink

  beforeEach(async () => {
    mumega = createSqliteD1()
    dme = createSqliteD1()
    migrate(mumega)
    migrate(dme)
    seed(mumega, 'mumega')
    seed(dme, 'dme')
    await enableProjectLinkAddon(env(mumega, 'mumega'))
    await enableProjectLinkAddon(env(dme, 'dme'))
    mumegaKeys = await generateProjectLinkKeyPair()
    dmeKeys = await generateProjectLinkKeyPair()
    signingKeys.set('mumega', await privateJwk(mumegaKeys.privateKey))
    signingKeys.set('dme', await privateJwk(dmeKeys.privateKey))

    const createdMumega = await createProjectLink(
      env(mumega, 'mumega'),
      linkInput('mumega', 'dme', await exportProjectLinkPublicKey(dmeKeys.publicKey)),
      { id: 'mumega-owner', role: 'owner' },
      NOW,
    )
    const createdDme = await createProjectLink(
      env(dme, 'dme'),
      linkInput('dme', 'mumega', await exportProjectLinkPublicKey(mumegaKeys.publicKey)),
      { id: 'dme-owner', role: 'owner' },
      NOW,
    )
    if (!createdMumega.ok || !createdDme.ok) throw new Error('fixture link creation failed')
    mumegaLink = createdMumega.link
    dmeLink = createdDme.link
  })

  afterEach(() => {
    signingKeys.clear()
    mumega.close()
    dme.close()
  })

  it('declares a native addon with no implicit authority grants', () => {
    expect(ProjectLinkAddon).toMatchObject({
      schema: 'mupot.addon/v1', key: 'project-link', kind: 'native', trustClass: 'native_reviewed',
      authorityRequests: { rankGrants: [], surfaceGrants: [] },
    })
  })

  it('rejects unknown customer fields and sensitive content before signing', () => {
    const withCustomerField = envelopeInput() as ReturnType<typeof envelopeInput> & {
      customer_email: string
    }
    withCustomerField.customer_email = 'customer@example.test'
    expect(validateProjectLinkEnvelope({
      schema: 'mupot.project-link-envelope/v1',
      ...withCustomerField,
    })).toEqual({ ok: false, reason: 'unknown_field', path: 'customer_email' })

    const withSensitiveSummary = envelopeInput()
    withSensitiveSummary.task.progress_summary = 'Contact customer@example.test with Bearer unsafe-token'
    expect(validateProjectLinkEnvelope({
      schema: 'mupot.project-link-envelope/v1',
      ...withSensitiveSummary,
    })).toEqual({ ok: false, reason: 'prohibited_content', path: 'task.progress_summary' })
  })

  it('verifies signatures and rejects a post-signature mutation', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    signed.envelope.task.title = 'Mutated after signing'

    const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)

    expect(received).toEqual({ ok: false, reason: 'invalid_signature' })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })

  it('reauthorizes the destination project and squad before creating work', async () => {
    dme.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ?').run('dme-project')
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)

    const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)

    expect(received).toEqual({ ok: false, reason: 'not_authorized' })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })

  it('grants task and evidence capabilities independently', async () => {
    dme.sqlite.prepare(`UPDATE project_links SET capabilities_json = ? WHERE id = ?`)
      .run(JSON.stringify(['project.task.write']), dmeLink.id)
    const evidenceOnly = envelopeInput()
    evidenceOnly.requested_capability = 'project.evidence.write'
    evidenceOnly.task = null as never

    const received = await receiveProjectLinkEnvelope(
      env(dme, 'dme'), dmeLink.id,
      await createSignedProjectEnvelope(evidenceOnly, mumegaKeys.privateKey),
      NOW,
    )

    expect(received).toEqual({ ok: false, reason: 'capability_denied' })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM project_link_receipts').get()).toEqual({ count: 0 })
  })

  it('delivers one task exactly once and returns the original matching receipt on duplicate delivery', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)

    const first = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)
    const duplicate = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)

    expect(first.ok).toBe(true)
    expect(duplicate).toEqual(first.ok ? { ...first, idempotent: true } : first)
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 })
    expect(dme.sqlite.prepare('SELECT project_id, squad_id, status FROM tasks').get()).toEqual({
      project_id: 'dme-project', squad_id: 'dme-squad', status: 'open',
    })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM project_link_receipts').get()).toEqual({ count: 1 })
  })

  // #403 gap 2(b): a task delivered via project-link must carry BOTH provenance signals —
  // the structural source_pot column (migrations/0063, queryable without parsing anything)
  // and the visible title marker (works everywhere the title is displayed) — so a reading
  // agent/UI can tell this content is untrusted external input, not a trusted local task.
  it('provenance-tags an inbound task with source_pot + a visible untrusted-origin title marker', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)

    const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)
    expect(received.ok).toBe(true)

    const row = dme.sqlite.prepare('SELECT title, body, source_pot FROM tasks').get() as {
      title: string; body: string; source_pot: string | null
    }
    expect(row.source_pot).toBe('mumega')
    expect(row.title).toBe('[project-link:mumega] Verify DME visibility monitor deployment')
    const body = JSON.parse(row.body) as { content_trust: string; source_pot: string }
    expect(body.content_trust).toBe('untrusted_external_content')
    expect(body.source_pot).toBe('mumega')
  })

  // A locally-created task (the trusted path, src/tasks/service.ts createTask) must NOT be
  // mistaken for cross-pot content — source_pot stays NULL unless receiveProjectLinkEnvelope
  // wrote the row.
  it('leaves source_pot NULL for a task inserted by any path other than receiveProjectLinkEnvelope', () => {
    dme.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, created_at, updated_at)
      VALUES ('local-task-1', 'dme-squad', 'dme-project', 'A local task', '', 'n/a', 'open', '${NOW}', '${NOW}')
    `)
    const row = dme.sqlite.prepare(`SELECT source_pot FROM tasks WHERE id = 'local-task-1'`).get() as {
      source_pot: string | null
    }
    expect(row.source_pot).toBeNull()
  })

  it('fails closed after either project link is revoked and preserves prior receipts', async () => {
    const accepted = await receiveProjectLinkEnvelope(
      env(dme, 'dme'), dmeLink.id,
      await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey),
      NOW,
    )
    expect(accepted.ok).toBe(true)
    expect((await revokeProjectLink(env(dme, 'dme'), dmeLink.id, { id: 'dme-owner', role: 'owner' }, NOW)).ok).toBe(true)

    const secondInput = envelopeInput()
    secondInput.idempotency_key = 'dme-task-flight-002'
    const rejected = await receiveProjectLinkEnvelope(
      env(dme, 'dme'), dmeLink.id,
      await createSignedProjectEnvelope(secondInput, mumegaKeys.privateKey),
      NOW,
    )

    expect(rejected).toEqual({ ok: false, reason: 'link_revoked' })
    expect(await listProjectLinkReceipts(env(dme, 'dme'), 'dme-project')).toHaveLength(1)
  })

  it('reauthorizes before returning a replay receipt', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    expect((await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW)).ok).toBe(true)
    dme.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ?').run('dme-project')

    expect(await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, signed, NOW))
      .toEqual({ ok: false, reason: 'not_authorized' })
  })

  it('rolls back when project authority is removed immediately before the write batch', async () => {
    const base = env(dme, 'dme')
    let raced = false
    const racingEnv = {
      ...base,
      DB: {
        prepare: base.DB.prepare.bind(base.DB),
        batch: async (statements: Parameters<typeof base.DB.batch>[0]) => {
          if (!raced) {
            raced = true
            dme.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ?').run('dme-project')
          }
          return base.DB.batch(statements)
        },
      },
    } as unknown as Env

    const received = await receiveProjectLinkEnvelope(
      racingEnv, dmeLink.id,
      await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey),
      NOW,
    )

    expect(received).toEqual({ ok: false, reason: 'not_authorized' })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
    expect(dme.sqlite.prepare('SELECT COUNT(*) AS count FROM project_link_receipts').get()).toEqual({ count: 0 })
  })

  it('stops future delivery when the addon is disabled without deleting prior receipts', async () => {
    const accepted = await receiveProjectLinkEnvelope(
      env(dme, 'dme'), dmeLink.id,
      await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey),
      NOW,
    )
    expect(accepted.ok).toBe(true)
    const disabled = await disableAddon(env(dme, 'dme'), { id: 'dme-owner', role: 'owner' }, 'project-link')
    expect(disabled.ok).toBe(true)

    const secondInput = envelopeInput()
    secondInput.idempotency_key = 'dme-task-after-disable'
    const rejected = await receiveProjectLinkEnvelope(
      env(dme, 'dme'), dmeLink.id,
      await createSignedProjectEnvelope(secondInput, mumegaKeys.privateKey),
      NOW,
    )

    expect(rejected).toEqual({ ok: false, reason: 'addon_inactive' })
    expect(await listProjectLinkReceipts(env(dme, 'dme'), 'dme-project')).toHaveLength(1)
  })

  it('retries transient delivery with the identical signed envelope and stores matching receipt hashes', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    let attempts = 0
    const requestedUrls: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      attempts += 1
      requestedUrls.push(String(input))
      if (attempts < 3) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
      const parsed = JSON.parse(String(init?.body))
      const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, parsed, NOW)
      return new Response(JSON.stringify(received), {
        status: received.ok ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const delivered = await deliverProjectLinkEnvelope(
      env(mumega, 'mumega'), mumegaLink.id, signed,
      { fetcher, now: NOW, maxAttempts: 3 },
    )

    expect(delivered.ok).toBe(true)
    expect(attempts).toBe(3)
    expect(new Set(requestedUrls)).toEqual(new Set(['https://dme.mupot.test/api/project-links/dme-link/deliver']))
    const sourceReceipts = await listProjectLinkReceipts(env(mumega, 'mumega'), 'mumega-project')
    const destinationReceipts = await listProjectLinkReceipts(env(dme, 'dme'), 'dme-project')
    expect(sourceReceipts).toHaveLength(1)
    expect(destinationReceipts).toHaveLength(1)
    expect(sourceReceipts[0].shared_receipt_sha256).toBe(destinationReceipts[0].shared_receipt_sha256)
    expect(sourceReceipts[0].receipt_key_id).toBe('dme-key')
    expect(sourceReceipts[0].receipt_signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(mumega.sqlite.prepare('SELECT attempts, status FROM project_link_deliveries').get()).toEqual({
      attempts: 3, status: 'delivered',
    })
  })

  it('resumes a matching failed delivery instead of burning its idempotency key', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const failed = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response('{}', { status: 503 }), now: NOW, maxAttempts: 1,
    })
    expect(failed).toEqual({ ok: false, reason: 'remote_failure' })

    const resumed = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async (_input, init) => {
        const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, JSON.parse(String(init?.body)), NOW)
        return new Response(JSON.stringify(received), { status: received.ok ? 200 : 400 })
      },
      now: '2026-07-18T22:31:00.000Z',
      maxAttempts: 1,
    })

    expect(resumed.ok).toBe(true)
    expect(mumega.sqlite.prepare('SELECT status, attempts FROM project_link_deliveries').get())
      .toEqual({ status: 'delivered', attempts: 2 })
  })

  it('allows only one outbound invocation to hold the delivery lease', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    let remoteAttempts = 0
    let competingResult: Awaited<ReturnType<typeof deliverProjectLinkEnvelope>> | undefined
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async (_input, init) => {
        remoteAttempts += 1
        competingResult = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
          fetcher: async () => {
            remoteAttempts += 1
            return new Response('{}', { status: 503 })
          },
          now: NOW,
          maxAttempts: 1,
        })
        const received = await receiveProjectLinkEnvelope(
          env(dme, 'dme'), dmeLink.id, JSON.parse(String(init?.body)), NOW,
        )
        return new Response(JSON.stringify(received), { status: received.ok ? 200 : 400 })
      },
      now: NOW,
      maxAttempts: 1,
    })

    expect(delivered.ok).toBe(true)
    expect(competingResult).toEqual({ ok: false, reason: 'idempotency_conflict' })
    expect(remoteAttempts).toBe(1)
    expect(mumega.sqlite.prepare('SELECT status, attempts FROM project_link_deliveries').get())
      .toEqual({ status: 'delivered', attempts: 1 })
  })

  it('rechecks project authority in the delivery claim before making a remote request', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const base = env(mumega, 'mumega')
    const database = base.DB
    let raced = false
    const racingEnv = {
      ...base,
      DB: {
        prepare(sql: string) {
          const prepared = database.prepare(sql)
          if (!sql.includes("SET status = 'sending'")) return prepared
          return {
            bind(...values: unknown[]) {
              const bound = prepared.bind(...values)
              return {
                async run() {
                  if (!raced) {
                    raced = true
                    mumega.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ?').run('mumega-project')
                  }
                  return bound.run()
                },
              }
            },
          }
        },
        batch: database.batch.bind(database),
      },
    } as unknown as Env
    let remoteAttempts = 0

    const rejected = await deliverProjectLinkEnvelope(racingEnv, mumegaLink.id, signed, {
      fetcher: async () => {
        remoteAttempts += 1
        return new Response('{}', { status: 503 })
      },
      now: NOW,
      maxAttempts: 1,
    })

    expect(rejected).toEqual({ ok: false, reason: 'not_authorized' })
    expect(remoteAttempts).toBe(0)
    expect(mumega.sqlite.prepare('SELECT status, attempts FROM project_link_deliveries').get())
      .toEqual({ status: 'pending', attempts: 0 })
  })

  it('does not transmit a delivery that has been held for manual review', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response('{}', { status: 503 }), now: NOW, maxAttempts: 1,
    })
    mumega.sqlite.exec("UPDATE project_link_deliveries SET status = 'review'")
    let attempts = 0

    const held = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => {
        attempts += 1
        return new Response('{}', { status: 503 })
      },
      now: '2026-07-18T22:31:00.000Z',
      maxAttempts: 1,
    })

    expect(held).toEqual({ ok: false, reason: 'delivery_review_required' })
    expect(attempts).toBe(0)
  })

  it('moves an exhausted delivery to review without exceeding the database attempt ceiling', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response('{}', { status: 503 }), now: NOW, maxAttempts: 1,
    })
    mumega.sqlite.exec("UPDATE project_link_deliveries SET status = 'failed', attempts = 99")
    let attempts = 0

    const exhausted = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => {
        attempts += 1
        return new Response('{}', { status: 503 })
      },
      now: '2026-07-18T22:31:00.000Z',
      maxAttempts: 5,
    })

    expect(exhausted).toEqual({ ok: false, reason: 'delivery_review_required' })
    expect(attempts).toBe(1)
    expect(mumega.sqlite.prepare('SELECT status, attempts, last_error FROM project_link_deliveries').get())
      .toEqual({ status: 'review', attempts: 100, last_error: 'retry_limit_exhausted' })
  })

  it('does not transmit when a delivery row cannot be durably established', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const base = env(mumega, 'mumega')
    const database = base.DB
    const failingEnv = {
      ...base,
      DB: {
        prepare(sql: string) {
          if (!sql.includes('INSERT INTO project_link_deliveries')) return database.prepare(sql)
          const statement = {
            bind() { return statement },
            async run() { throw new Error('simulated insert race') },
          }
          return statement
        },
        batch: database.batch.bind(database),
      },
    } as unknown as Env
    let attempts = 0

    const rejected = await deliverProjectLinkEnvelope(failingEnv, mumegaLink.id, signed, {
      fetcher: async () => {
        attempts += 1
        return new Response('{}', { status: 503 })
      },
      now: NOW,
      maxAttempts: 1,
    })

    expect(rejected).toEqual({ ok: false, reason: 'idempotency_conflict' })
    expect(attempts).toBe(0)
    expect(mumega.sqlite.prepare('SELECT COUNT(*) AS count FROM project_link_deliveries').get())
      .toEqual({ count: 0 })
  })

  it('rejects a receipt whose authenticated semantics are changed', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async (_input, init) => {
        const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, JSON.parse(String(init?.body)), NOW)
        if (!received.ok) throw new Error('fixture delivery failed')
        return new Response(JSON.stringify({
          ...received,
          receipt: { ...received.receipt, action_id: 'plt-forged' },
        }), { status: 200 })
      }, now: NOW, maxAttempts: 1,
    })

    expect(delivered).toEqual({ ok: false, reason: 'receipt_mismatch' })
  })

  it('classifies a null successful response as an invalid receipt', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response('null', { status: 200 }), now: NOW, maxAttempts: 1,
    })

    expect(delivered).toEqual({ ok: false, reason: 'remote_failure' })
    expect(mumega.sqlite.prepare('SELECT last_error FROM project_link_deliveries').get())
      .toEqual({ last_error: 'invalid_remote_receipt' })
  })

  it('marks a forged remote receipt as failed without persisting source evidence', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async (_input, init) => {
        const received = await receiveProjectLinkEnvelope(env(dme, 'dme'), dmeLink.id, JSON.parse(String(init?.body)), NOW)
        if (!received.ok) throw new Error('fixture delivery failed')
        return new Response(JSON.stringify({
          ...received,
          receipt: { ...received.receipt, shared_receipt_sha256: 'f'.repeat(64) },
        }), { status: 200 })
      },
      now: NOW,
      maxAttempts: 1,
    })

    expect(delivered).toEqual({ ok: false, reason: 'receipt_mismatch' })
    expect(await listProjectLinkReceipts(env(mumega, 'mumega'), 'mumega-project')).toHaveLength(0)
    expect(mumega.sqlite.prepare('SELECT attempts, status, last_error FROM project_link_deliveries').get()).toEqual({
      attempts: 1, status: 'failed', last_error: 'receipt_mismatch',
    })
    expect(mumega.sqlite.prepare('SELECT last_failure_at, last_error FROM project_links').get()).toEqual({
      last_failure_at: NOW, last_error: 'receipt_mismatch',
    })
  })

  it('does not let a stale claimant downgrade project link health', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    mumega.sqlite.prepare(
      `UPDATE project_links SET last_success_at = ?, last_failure_at = NULL, last_error = NULL WHERE id = ?`,
    ).run(NOW, mumegaLink.id)

    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => {
        mumega.sqlite.prepare(
          `UPDATE project_link_deliveries SET status = 'delivered', claim_token = 'replacement-claim'`,
        ).run()
        return new Response(JSON.stringify({ error: 'mapping_mismatch' }), { status: 400 })
      },
      now: NOW,
      maxAttempts: 1,
    })

    expect(delivered).toEqual({ ok: false, reason: 'idempotency_conflict' })
    expect(mumega.sqlite.prepare('SELECT last_success_at, last_failure_at, last_error FROM project_links').get())
      .toEqual({ last_success_at: NOW, last_failure_at: null, last_error: null })
  })

  it('does not retry a permanent remote rejection or overstate its attempt count', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    let attempts = 0
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => {
        attempts += 1
        return new Response(JSON.stringify({ error: 'mapping_mismatch' }), { status: 403 })
      },
      now: NOW,
      maxAttempts: 3,
    })

    expect(delivered).toEqual({ ok: false, reason: 'remote_failure' })
    expect(attempts).toBe(1)
    expect(mumega.sqlite.prepare('SELECT attempts, status FROM project_link_deliveries').get()).toEqual({
      attempts: 1, status: 'failed',
    })
  })

  it('bounds a successful remote response before parsing its receipt', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response(JSON.stringify({ ok: true, padding: 'x'.repeat(40_000) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      now: NOW,
      maxAttempts: 1,
    })

    expect(delivered).toEqual({ ok: false, reason: 'remote_failure' })
    expect(mumega.sqlite.prepare('SELECT attempts, status, last_error FROM project_link_deliveries').get()).toEqual({
      attempts: 1, status: 'failed', last_error: 'remote_response_too_large',
    })
  })

  it('bounds a remote response body that never finishes', async () => {
    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true'))
        },
      }), { status: 200 }),
      now: NOW,
      maxAttempts: 1,
      timeoutMs: 1000,
    })

    expect(delivered).toEqual({ ok: false, reason: 'remote_failure' })
    expect(mumega.sqlite.prepare('SELECT attempts, status, last_error FROM project_link_deliveries').get()).toEqual({
      attempts: 1, status: 'failed', last_error: 'invalid_remote_response',
    })
  }, 2000)

  it('labels unknown, healthy, failed, stale, and revoked remote state without inference', async () => {
    expect(await getProjectLinkStatus(env(mumega, 'mumega'), mumegaLink.id, NOW)).toMatchObject({ state: 'unknown' })

    const signed = await createSignedProjectEnvelope(envelopeInput(), mumegaKeys.privateKey)
    const delivered = await deliverProjectLinkEnvelope(env(mumega, 'mumega'), mumegaLink.id, signed, {
      fetcher: async (_input, init) => {
        const received = await receiveProjectLinkEnvelope(
          env(dme, 'dme'), dmeLink.id, JSON.parse(String(init?.body)), NOW,
        )
        return new Response(JSON.stringify(received), { status: received.ok ? 200 : 400 })
      },
      now: NOW,
      maxAttempts: 1,
    })
    expect(delivered.ok).toBe(true)
    expect(await getProjectLinkStatus(env(mumega, 'mumega'), mumegaLink.id, '2026-07-18T22:34:59.000Z'))
      .toMatchObject({ state: 'healthy', source_pot: 'dme' })
    expect(await getProjectLinkStatus(env(mumega, 'mumega'), mumegaLink.id, '2026-07-18T22:35:01.000Z'))
      .toMatchObject({ state: 'stale', source_pot: 'dme' })

    expect((await revokeProjectLink(env(mumega, 'mumega'), mumegaLink.id, { id: 'mumega-owner', role: 'owner' }, NOW)).ok).toBe(true)
    expect(await getProjectLinkStatus(env(mumega, 'mumega'), mumegaLink.id, NOW)).toMatchObject({ state: 'revoked' })
  })

  it('uses durable UTC comparison for mixed timestamp status while preserving the explicit stale clock', async () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'America/Toronto'
    try {
      mumega.sqlite.prepare(
        `UPDATE project_links
            SET last_success_at = ?, last_failure_at = ?, last_error = ?
          WHERE id = ?`,
      ).run('2026-07-18T22:00:00Z', '2026-07-18 20:13:00', 'earlier_failure', mumegaLink.id)

      expect(await getProjectLinkStatus(
        env(mumega, 'mumega'), mumegaLink.id, '2026-07-18T22:04:59Z',
      )).toMatchObject({ state: 'healthy' })
      expect(await getProjectLinkStatus(
        env(mumega, 'mumega'), mumegaLink.id, '2026-07-18T22:05:01Z',
      )).toMatchObject({ state: 'stale' })
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })
})
