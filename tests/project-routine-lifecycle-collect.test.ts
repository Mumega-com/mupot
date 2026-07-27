import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

import {
  CollectorError,
  canonicalDigest,
  parseCollectorArgs,
  runProjectRoutineLifecycleCollector,
} from '../scripts/project-routine-lifecycle-collect.mjs'
import { checkBundle } from '../scripts/project-routine-lifecycle-receipt.mjs'

const COMMIT = 'a'.repeat(40)
const OWNER_TOKEN = 'owner-secret-never-write'
const AGENT_TOKEN = 'agent-secret-never-write'
const WRONG_TOKEN = 'wrong-secret-never-write'
const PRIVATE_JWK = JSON.stringify({
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'public-coordinate',
  d: 'private-coordinate-never-write',
})

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function visualPng(): Buffer {
  const width = 320
  const height = 200
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * 3))
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (1 + width * 3)
    for (let column = 0; column < width; column += 1) {
      const pixel = rowStart + 1 + column * 3
      rows[pixel] = column < width / 2 ? 24 : 220
      rows[pixel + 1] = row < height / 2 ? 120 : 48
      rows[pixel + 2] = 180
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const situation = {
  project: { id: 'project-main', name: 'Mupot development', status: 'active' },
  goals: [{ id: 'goal-1', title: 'Ship v0.25', status: 'active' }],
  tasks: [{ id: 'control-task', title: 'Routine control task', status: 'review' }],
  flights: [],
  evidence: [],
}

const digest = '2e0b6ef5b3b02a043975075301388f658dab4056666289763a78ad78bc12a884'

const envelope = {
  version: 'routine.run/v1',
  run_id: 'run-1',
  project_id: 'project-main',
  routine_revision: 1,
  objective: 'Create one governed task and leave a complete lifecycle receipt.',
  situation_digest: digest,
  mcp_endpoint: 'http://127.0.0.1:8787/mcp',
  proposal_schema: {
    version: 'routine.proposal/v1',
    action_kinds: ['create_task', 'dispatch_flight', 'request_review', 'ask_human', 'no_action'],
  },
}

const terminalRun = {
  id: 'run-1',
  project_id: 'project-main',
  routine_id: 'routine-1',
  status: 'succeeded',
  assigned_agent_id: 'agent-conformance',
  task_id: 'control-task',
  result_summary: 'task_created',
  cost_micro_usd: 1250,
}

const activity = [
  {
    id: 'activity-1',
    kind: 'routine_run_succeeded',
    project_id: 'project-main',
    correlation_id: 'run-1',
  },
]

const evidence = [
  {
    id: 'evidence-1',
    kind: 'routine_result',
    project_id: 'project-main',
    correlation_id: 'run-1',
  },
]

function config() {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    outputDir: '/tmp/project-routine-receipt',
    projectId: 'project-main',
    unauthorizedProjectId: 'project-other',
    squadId: 'squad-main',
    agentId: 'agent-conformance',
    unauthorizedAgentId: 'agent-conformance-other',
    ownerToken: OWNER_TOKEN,
    signingJwk: PRIVATE_JWK,
    expectedTenant: 'tenant-local',
    expectedVersion: '0.25.0',
    expectedCommit: COMMIT,
    scheduledTicks: 1,
    pollTimeoutMs: 2_000,
  }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const writes = new Map<string, unknown>()
  let proposalCalls = 0

  const api = {
    probeTarget: vi.fn(async () => ({
      ok: true,
      tenant: 'tenant-local',
      version: '0.25.0',
      commit: COMMIT,
    })),
    mintAgentToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
      agent_id: agentId,
      token: agentId === 'agent-conformance' ? AGENT_TOKEN : WRONG_TOKEN,
    })),
    attachSigned: vi.fn(async () => ({ ok: true, agent_id: 'agent-conformance' })),
    scheduledTick: vi.fn(async () => ({ ok: true })),
    consumeSignedInbox: vi.fn(async () => ({
      ok: true,
      consumed: true,
      messages: [{
        id: 'message-1',
        from_agent: 'routine-scheduler',
        to_agent: 'agent-conformance',
        request_id: 'routine-run:run-1:attempt:1',
        body: JSON.stringify(envelope),
      }],
    })),
    invokeAction: vi.fn(async ({
      token,
      tool,
      input,
    }: {
      token: string
      tool: string
      input: Record<string, unknown>
    }) => {
      if (tool === 'project_get') {
        return { ok: true, status: 200, result: { project: situation.project, situation } }
      }
      if (tool === 'routine_run_get') {
        return { ok: true, status: 200, result: { run: terminalRun } }
      }
      if (tool === 'needs_you_list') {
        return {
          ok: true,
          status: 200,
          result: {
            items: [{
              id: 'attention-1',
              source_type: 'task',
              source_id: 'control-task',
              project_id: 'project-main',
            }],
          },
        }
      }
      if (tool !== 'routine_proposal_submit') {
        throw new Error(`unexpected tool ${tool}`)
      }
      if (token === WRONG_TOKEN) {
        return { ok: false, status: 403, error: 'assigned_agent_mismatch' }
      }
      if (input.project_id === 'project-other') {
        return { ok: false, status: 404, error: 'project_mismatch' }
      }
      if (input.situation_digest !== digest) {
        return { ok: false, status: 409, error: 'situation_mismatch' }
      }
      proposalCalls += 1
      if (proposalCalls === 1) {
        return {
          ok: true,
          status: 200,
          result: {
            status: 'waiting',
            reason: 'review',
            run_id: 'run-1',
            action_key: 'project-routine-lifecycle-run-1',
            duplicate: false,
          },
        }
      }
      if (proposalCalls === 2) {
        return {
          ok: true,
          status: 200,
          result: {
            status: 'succeeded',
            run_id: 'run-1',
            action_key: 'project-routine-lifecycle-run-1',
            duplicate: false,
            result: { task_id: 'created-task-1' },
          },
        }
      }
      return {
        ok: true,
        status: 200,
        result: {
          status: 'succeeded',
          run_id: 'run-1',
          action_key: 'project-routine-lifecycle-run-1',
          duplicate: true,
          result: { task_id: 'created-task-1' },
        },
      }
    }),
    readRestRun: vi.fn(async () => ({ run: terminalRun })),
    readRestProject: vi.fn(async () => ({ project: situation.project, situation })),
    readRestActivity: vi.fn(async () => ({ events: activity })),
    readRestEvidence: vi.fn(async () => ({ evidence })),
    detachSigned: vi.fn(async () => ({ ok: true })),
  }

  const browser = {
    assertOwnerSession: vi.fn(async () => ({ ok: true, role: 'owner' })),
    createRoutine: vi.fn(async () => ({ routineId: 'routine-1', status: 'draft' })),
    enableRoutine: vi.fn(async () => ({ routineId: 'routine-1', status: 'enabled' })),
    captureRoutine: vi.fn(async ({ viewport }: { viewport: string }) => ({
      viewport,
      path: `/tmp/project-routine-receipt/screenshots/${viewport}-propose-mode.png`,
      bytes: viewport === 'desktop' ? 18_000 : 12_000,
    })),
    manualFire: vi.fn(async () => ({ accepted: true, routineId: 'routine-1' })),
    approveTask: vi.fn(async () => ({ taskId: 'control-task', verdict: 'approved' })),
    readRun: vi.fn(async () => terminalRun),
    readProjectSituation: vi.fn(async () => situation),
    readActivityEvidence: vi.fn(async () => ({ activity, evidence })),
    close: vi.fn(async () => undefined),
  }

  const deps = {
    api,
    browser,
    restartWorker: vi.fn(async () => ({ restarted: true })),
    waitForTarget: vi.fn(async () => ({
      ok: true,
      tenant: 'tenant-local',
      version: '0.25.0',
      commit: COMMIT,
    })),
    writeArtifact: vi.fn(async (relativePath: string, value: unknown) => {
      writes.set(relativePath, value)
    }),
    now: vi.fn(() => new Date('2026-07-26T18:00:00.000Z')),
    randomUUID: vi.fn(() => 'collector-id-1'),
    sleep: vi.fn(async () => undefined),
  }

  return {
    writes,
    api,
    browser,
    deps: {
      ...deps,
      ...overrides,
      api: { ...api, ...((overrides.api as object | undefined) ?? {}) },
      browser: { ...browser, ...((overrides.browser as object | undefined) ?? {}) },
    },
  }
}

describe('project routine lifecycle collector', () => {
  it('fails closed when the CLI target, lifecycle hooks, or environment-only credentials are absent', () => {
    expect(() => parseCollectorArgs([], {})).toThrowError(/--base-url/)

    const argv = [
      '--base-url', 'http://127.0.0.1:8787',
      '--out-dir', '/tmp/receipt',
      '--project-id', 'project-main',
      '--unauthorized-project-id', 'project-other',
      '--squad-id', 'squad-main',
      '--agent-id', 'agent-conformance',
      '--unauthorized-agent-id', 'agent-other',
      '--hooks-module', './local-hooks.mjs',
      '--expected-version', '0.25.0',
      '--expected-commit', COMMIT,
    ]

    expect(() => parseCollectorArgs(argv, {})).toThrowError(/MUPOT_ROUTINE_OWNER_TOKEN/)
    expect(() => parseCollectorArgs(
      [...argv, '--owner-token', OWNER_TOKEN],
      {
        MUPOT_ROUTINE_OWNER_TOKEN: OWNER_TOKEN,
        MUPOT_CONFORMANCE_PRIVATE_JWK: PRIVATE_JWK,
      },
    )).toThrowError(/credentials.*command line/i)
  })

  it('fails closed when required executable callbacks are not supplied', async () => {
    const { deps } = dependencies()
    await expect(runProjectRoutineLifecycleCollector(config(), {
      ...deps,
      restartWorker: undefined,
    })).rejects.toThrowError(/restartWorker/)
  })

  it('canonicalizes Situation objects before hashing', async () => {
    await expect(canonicalDigest({
      b: 2,
      a: { z: 3, y: [2, 1] },
    })).resolves.toBe('7102b0a307e9e238b6005e3311bbdf788a51b58ac1eebac438326f8ac30a1055')
  })

  it('collects the governed lifecycle, restart, and normalized parity without persisting credentials', async () => {
    const { deps, writes, api, browser } = dependencies()
    const result = await runProjectRoutineLifecycleCollector(config(), deps)

    expect(result).toMatchObject({
      ok: true,
      collector_id: 'collector-id-1',
      routine_id: 'routine-1',
      run_id: 'run-1',
      terminal_status: 'succeeded',
      target: { version: '0.25.0', commit: COMMIT },
    })
    expect(api.mintAgentToken).toHaveBeenCalledTimes(2)
    expect(api.scheduledTick).toHaveBeenCalledTimes(1)
    expect(browser.captureRoutine).toHaveBeenCalledWith(expect.objectContaining({ viewport: 'desktop' }))
    expect(browser.captureRoutine).toHaveBeenCalledWith(expect.objectContaining({ viewport: 'mobile' }))
    expect(browser.approveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'control-task' }))
    expect(deps.restartWorker).toHaveBeenCalledTimes(1)
    expect(deps.waitForTarget).toHaveBeenCalledTimes(1)
    expect(api.detachSigned).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)

    expect(writes.get('artifacts/restart-parity.json')).toMatchObject({
      artifact_type: 'mupot-project-routine-observation/v1',
      step: 'restart_parity',
      data: {
        parity: {
          run: { rest_mcp_dashboard: true, after_restart: true },
          situation: { rest_mcp_dashboard: true, digest_verified: true, after_restart: true },
          activity: { rest_dashboard: true },
          evidence: { rest_dashboard: true },
        },
      },
    })
    expect(writes.get('artifacts/runtime-proposal.json')).toMatchObject({
      data: {
        access_rejections: {
          assigned_agent_rejected: true,
          project_scope_rejected: true,
        },
      },
    })
    expect(writes.get('artifacts/needs-you-approval.json')).toMatchObject({
      data: {
        approval: {
          needs_you_visible: true,
          verdict: 'approved',
          action_exactly_once: true,
          duplicate_replay: true,
        },
      },
    })

    const serialized = JSON.stringify([...writes.entries()])
    for (const secret of [OWNER_TOKEN, AGENT_TOKEN, WRONG_TOKEN, 'private-coordinate-never-write']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('emits a complete bundle accepted by the existing lifecycle receipt checker', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'mupot-routine-clean-repo-'))
    const version = '0.25.0'
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'mupot-receipt-fixture', version })}\n`)
    writeFileSync(
      join(repoRoot, 'src', 'version.ts'),
      `export const MUPOT_PUBLIC_API_VERSION = '${version}' as const\n`,
    )
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['config', 'user.name', 'Mupot Collector Test'], { cwd: repoRoot })
    execFileSync('git', ['config', 'user.email', 'collector-test@mupot.invalid'], { cwd: repoRoot })
    execFileSync('git', ['add', 'package.json', 'src/version.ts'], { cwd: repoRoot })
    execFileSync('git', ['commit', '-qm', 'receipt fixture'], { cwd: repoRoot })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const outputDir = mkdtempSync(join(tmpdir(), 'mupot-routine-collector-checker-'))
    const currentConfig = {
      ...config(),
      outputDir,
      expectedCommit: head,
      expectedVersion: version,
    }
    const currentHealth = {
      ok: true,
      tenant: 'tenant-local',
      version,
      commit: head,
    }
    const fixture = dependencies({
      api: {
        probeTarget: vi.fn(async () => currentHealth),
      },
      browser: {
        captureRoutine: vi.fn(async ({ viewport }: { viewport: string }) => {
          const path = join(outputDir, 'screenshots', `${viewport}-propose-mode.png`)
          mkdirSync(dirname(path), { recursive: true })
          const png = visualPng()
          writeFileSync(path, png)
          return { viewport, path, bytes: png.byteLength }
        }),
      },
      waitForTarget: vi.fn(async () => currentHealth),
      writeArtifact: vi.fn(async (relativePath: string, value: unknown) => {
        const path = join(outputDir, relativePath)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
      }),
    })

    const result = await runProjectRoutineLifecycleCollector(currentConfig, fixture.deps)
    const checked = checkBundle({
      outDir: outputDir,
      pot: 'tenant-local',
      baseUrl: currentConfig.baseUrl,
      projectId: currentConfig.projectId,
      routineId: result.routine_id,
      routineRunId: result.run_id,
      expectedCommit: head,
      expectedVersion: version,
      repoRoot,
    })

    expect(checked.status, JSON.stringify(
      checked.checks.filter((check: { ok: boolean }) => !check.ok),
      null,
      2,
    )).toBe('pass')
    const needsYou = JSON.parse(readFileSync(join(outputDir, 'needs-you-approval.json'), 'utf8'))
    expect(needsYou.evidence).toMatchObject({
      external_action_gated: true,
      external_action_executed: false,
      external_action_approved: false,
    })
  })

  it('rejects a routine envelope whose Situation digest does not match the project read', async () => {
    const mismatched = {
      ...envelope,
      situation_digest: '0'.repeat(64),
    }
    const { deps, api, browser } = dependencies({
      api: {
        consumeSignedInbox: vi.fn(async () => ({
          ok: true,
          consumed: true,
          messages: [{ body: JSON.stringify(mismatched) }],
        })),
      },
    })

    await expect(runProjectRoutineLifecycleCollector(config(), deps))
      .rejects.toThrowError(/Situation digest mismatch/)
    expect(api.detachSigned).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('rejects a replay that does not prove duplicate execution', async () => {
    const base = dependencies()
    const originalInvokeAction = base.api.invokeAction.getMockImplementation()
    if (!originalInvokeAction) throw new Error('fixture invokeAction implementation missing')
    const invokeAction = vi.fn()
    invokeAction.mockImplementation(async (request) => {
      const response = await originalInvokeAction(request)
      if (
        request.tool === 'routine_proposal_submit'
        && request.token === AGENT_TOKEN
        && response.ok
        && response.result?.status === 'succeeded'
      ) {
        return { ...response, result: { ...response.result, duplicate: false } }
      }
      return response
    })

    await expect(runProjectRoutineLifecycleCollector(config(), {
      ...base.deps,
      api: { ...base.api, invokeAction },
    })).rejects.toThrowError(/duplicate replay/)
  })

  it('rejects parity drift after the Worker restart', async () => {
    const base = dependencies()
    const readRestRun = vi.fn()
      .mockResolvedValueOnce({ run: terminalRun })
      .mockResolvedValueOnce({ run: { ...terminalRun, status: 'running' } })

    await expect(runProjectRoutineLifecycleCollector(config(), {
      ...base.deps,
      api: { ...base.api, readRestRun },
    })).rejects.toThrowError(/restart.*run parity/i)
  })
})

describe('collector CLI', () => {
  it('imports --hooks-module dependencies and executes the collector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-routine-collector-cli-'))
    const hooksPath = join(dir, 'collector-hooks.mjs')
    const outputDir = join(dir, 'receipt')
    const marker = join(dir, 'restart-called.txt')
    writeFileSync(hooksPath, `
      import { mkdir, writeFile } from 'node:fs/promises'
      import { dirname, join } from 'node:path'

      export async function createCollectorDependencies(config) {
        let proposals = 0
        const situation = {}
        const run = {
          id: 'run-cli', project_id: config.projectId, routine_id: 'routine-cli',
          status: 'succeeded', assigned_agent_id: config.agentId,
          task_id: 'task-cli', result_summary: 'task_created', cost_micro_usd: 7
        }
        const health = {
          ok: true, tenant: config.expectedTenant,
          version: config.expectedVersion, commit: config.expectedCommit
        }
        return {
          api: {
            probeTarget: async () => health,
            mintAgentToken: async ({ agentId }) => ({
              agent_id: agentId,
              token: agentId === config.agentId ? 'assigned-cli-secret' : 'wrong-cli-secret'
            }),
            attachSigned: async () => ({ ok: true }),
            scheduledTick: async () => ({ ok: true }),
            consumeSignedInbox: async () => ({
              ok: true, consumed: true,
              messages: [{
                request_id: 'routine-run:run-cli:attempt:1',
                body: JSON.stringify({
                  version: 'routine.run/v1', run_id: 'run-cli',
                  project_id: config.projectId, routine_revision: 1,
                  objective: 'CLI lifecycle', situation_digest: '${'f'.repeat(64)}',
                  mcp_endpoint: config.baseUrl + '/mcp', proposal_schema: {}
                })
              }]
            }),
            invokeAction: async ({ token, tool, input }) => {
              if (tool === 'routine_run_get') return { ok: true, result: { run } }
              if (tool === 'project_get') return {
                ok: true, result: { project: { id: config.projectId, status: 'active' }, situation }
              }
              if (tool === 'needs_you_list') return {
                ok: true, result: { items: [{ id: 'need-cli', source_type: 'task', source_id: 'task-cli' }] }
              }
              if (token === 'wrong-cli-secret') return {
                ok: false, status: 403, error: 'assigned_agent_mismatch'
              }
              if (input.project_id === config.unauthorizedProjectId) return {
                ok: false, status: 400, error: 'project_mismatch'
              }
              if (input.situation_digest !== '${'f'.repeat(64)}') return {
                ok: false, status: 400, error: 'situation_mismatch'
              }
              proposals += 1
              if (proposals === 1) return {
                ok: true, result: {
                  status: 'waiting', reason: 'review', duplicate: false,
                  run_id: 'run-cli', action_key: 'project-routine-lifecycle-run-cli'
                }
              }
              return {
                ok: true, result: {
                  status: 'succeeded', duplicate: proposals > 2,
                  run_id: 'run-cli', action_key: 'project-routine-lifecycle-run-cli',
                  result: { task_id: 'created-cli' }
                }
              }
            },
            readRestRun: async () => ({ run }),
            readRestProject: async () => ({
              project: { id: config.projectId, status: 'active' }, situation
            }),
            readRestActivity: async () => ({ rows: [{ id: 'activity-cli' }] }),
            readRestEvidence: async () => ({ rows: [{ id: 'evidence-cli' }] }),
            detachSigned: async () => ({ ok: true })
          },
          browser: {
            assertOwnerSession: async () => ({ ok: true, role: 'owner' }),
            createRoutine: async () => ({ routineId: 'routine-cli', status: 'draft' }),
            enableRoutine: async () => ({ routineId: 'routine-cli', status: 'enabled' }),
            captureRoutine: async ({ viewport }) => ({
              viewport, path: join(config.outputDir, 'screenshots', viewport + '-propose-mode.png'), bytes: 10
            }),
            manualFire: async () => ({ accepted: true }),
            approveTask: async () => ({ taskId: 'task-cli', verdict: 'approved' }),
            readRun: async () => run,
            readProjectSituation: async () => situation,
            readActivityEvidence: async () => ({
              activity: [{ id: 'activity-cli' }], evidence: [{ id: 'evidence-cli' }]
            }),
            close: async () => undefined
          },
          restartWorker: async () => {
            await writeFile(process.env.CLI_RESTART_MARKER, 'called')
            return { restarted: true }
          },
          waitForTarget: async () => health,
          writeArtifact: async (relativePath, value) => {
            const path = join(config.outputDir, relativePath)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, JSON.stringify(value))
          },
          now: () => new Date('2026-07-26T18:00:00.000Z'),
          randomUUID: () => 'collector-cli',
          sleep: async () => undefined
        }
      }
    `)

    const result = spawnSync(process.execPath, [
      resolve('scripts/project-routine-lifecycle-collect.mjs'),
      '--base-url', 'http://127.0.0.1:8787',
      '--out-dir', outputDir,
      '--project-id', 'project-main',
      '--unauthorized-project-id', 'project-other',
      '--squad-id', 'squad-main',
      '--agent-id', 'agent-conformance',
      '--unauthorized-agent-id', 'agent-other',
      '--hooks-module', hooksPath,
      '--expected-tenant', 'tenant-local',
      '--expected-version', '0.25.0',
      '--expected-commit', COMMIT,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MUPOT_ROUTINE_OWNER_TOKEN: OWNER_TOKEN,
        MUPOT_CONFORMANCE_PRIVATE_JWK: PRIVATE_JWK,
        CLI_RESTART_MARKER: marker,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      collector_id: 'collector-cli',
      routine_id: 'routine-cli',
      run_id: 'run-cli',
    })
    expect(readFileSync(marker, 'utf8')).toBe('called')
  })
})

describe('CollectorError', () => {
  it('does not include secret-bearing detail in its public message', () => {
    const error = new CollectorError('target rejected request', { token: OWNER_TOKEN })
    expect(error.message).toBe('target rejected request')
    expect(JSON.stringify(error.safeDetail)).not.toContain(OWNER_TOKEN)
  })

  it('redacts unexpected dependency failures before surfacing diagnostics', async () => {
    const fixture = dependencies()
    fixture.deps.api.probeTarget = async () => {
      throw new Error(`transport failed for ${OWNER_TOKEN}`)
    }

    await expect(runProjectRoutineLifecycleCollector(config(), fixture.deps))
      .rejects.toMatchObject({
        name: 'CollectorError',
        message: 'collector execution failed',
        safeDetail: {
          name: 'Error',
          reason: '[redacted]',
        },
      })
  })
})
