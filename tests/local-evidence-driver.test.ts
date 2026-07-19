import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..')
const TMP_ROOT = join(REPO_ROOT, 'tmp')
const DRIVER = join(REPO_ROOT, 'scripts', 'ci-local-evidence.sh')

interface DriverFixture {
  root: string
  bin: string
  server: string
  log: string
  evidence: string
  smoke: string
  runtime: string
}

const fixtureRoots: string[] = []
const serverProcesses: ChildProcess[] = []

afterEach(() => {
  for (const child of serverProcesses.splice(0)) child.kill('SIGTERM')
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeFixture(): DriverFixture {
  mkdirSync(TMP_ROOT, { recursive: true })
  const root = mkdtempSync(join(TMP_ROOT, 'local-evidence-driver-'))
  fixtureRoots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const server = join(root, 'health-server.mjs')
  const log = join(root, 'invocations.log')
  writeFileSync(server, `
import { createServer } from 'node:http'

const port = Number(process.argv[2])
const delay = Number(process.argv[3] || 0)
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, path: request.url }))
})
setTimeout(() => server.listen(port, '127.0.0.1'), delay)
process.on('SIGTERM', () => {
  try {
    server.close(() => process.exit(0))
  } catch {
    process.exit(0)
  }
})
`)
  const fakeNpx = join(bin, 'npx')
  writeFileSync(fakeNpx, `#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "\${FAKE_INVOCATION_LOG}"
if [[ "$*" == *"wrangler --version"* ]]; then
  exit 0
fi
if [[ "$*" == *"wrangler dev"* ]]; then
  port=""
  previous=""
  for argument in "$@"; do
    if [ "\${previous}" = "--port" ]; then port="\${argument}"; break; fi
    previous="\${argument}"
  done
  if [ "\${FAKE_DEV_MODE:-serve}" = "exit" ]; then
    sleep 1
    exit 23
  fi
  exec "\${REAL_NODE}" "\${FAKE_SERVER_PATH}" "\${port}" 0
fi
exit 0
`)
  chmodSync(fakeNpx, 0o755)
  const fakeNpm = join(bin, 'npm')
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "\${FAKE_INVOCATION_LOG}"
if [[ "$*" == *"smoke:local"* ]]; then
  case "\${MUPOT_SMOKE_ARTIFACTS}" in
    "\${TEST_ARTIFACT_ROOT}"/*) ;;
    *) echo "unexpected smoke artifacts path: \${MUPOT_SMOKE_ARTIFACTS}" >&2; exit 97 ;;
  esac
  mkdir -p "\${MUPOT_SMOKE_ARTIFACTS}"
  if [ "\${FAKE_SMOKE_FAIL:-0}" = "1" ]; then
    printf '{"ok":false}\n' > "\${MUPOT_SMOKE_ARTIFACTS}/failure-first.json"
    exit 9
  fi
  printf '{"ok":true,"run":"success"}\n' > "\${MUPOT_SMOKE_ARTIFACTS}/report.json"
  exit 0
fi
if [[ "$*" == *"conformance:runtime:local"* ]]; then
  case "\${MUPOT_CONFORMANCE_ARTIFACTS}" in
    "\${TEST_ARTIFACT_ROOT}"/*) ;;
    *) echo "unexpected runtime artifacts path: \${MUPOT_CONFORMANCE_ARTIFACTS}" >&2; exit 98 ;;
  esac
  mkdir -p "\${MUPOT_CONFORMANCE_ARTIFACTS}"
  printf '{"ok":true,"run":"success"}\n' > "\${MUPOT_CONFORMANCE_ARTIFACTS}/report.json"
  exit 0
fi
exit 99
`)
  chmodSync(fakeNpm, 0o755)
  return {
    root,
    bin,
    server,
    log,
    evidence: join(root, 'local-evidence'),
    smoke: join(root, 'local-smoke'),
    runtime: join(root, 'local-runtime-conformance'),
  }
}

async function unusedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function startServer(fixture: DriverFixture, port: number, delayMs = 0): ChildProcess {
  const child = spawn(process.execPath, [fixture.server, String(port), String(delayMs)], { stdio: 'ignore' })
  serverProcesses.push(child)
  return child
}

async function waitForEndpoint(url: string, served: boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const reachable = await fetch(url, { signal: AbortSignal.timeout(100) })
      .then(() => true)
      .catch(() => false)
    if (reachable === served) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`endpoint did not become ${served ? 'reachable' : 'free'}: ${url}`)
}

function runDriver(
  fixture: DriverFixture,
  port: number,
  overrides: Record<string, string> = {},
) {
  return spawnSync('bash', [DRIVER], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      REAL_NODE: process.execPath,
      FAKE_SERVER_PATH: fixture.server,
      FAKE_INVOCATION_LOG: fixture.log,
      TEST_ARTIFACT_ROOT: fixture.root,
      MUPOT_LOCAL_PORT: String(port),
      MUPOT_LOCAL_URL: `http://127.0.0.1:${port}`,
      MUPOT_LOCAL_EVIDENCE_DIR: fixture.evidence,
      MUPOT_SMOKE_ARTIFACTS: fixture.smoke,
      MUPOT_CONFORMANCE_ARTIFACTS: fixture.runtime,
      ...overrides,
    },
  })
}

function invocations(fixture: DriverFixture): string {
  return existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : ''
}

describe('local evidence driver ownership and artifact isolation', () => {
  it('refuses a preoccupied endpoint before migrations or Wrangler startup', async () => {
    const fixture = makeFixture()
    const port = await unusedPort()
    startServer(fixture, port)
    await waitForEndpoint(`http://127.0.0.1:${port}/health`, true)

    const result = runDriver(fixture, port)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('already served')
    expect(invocations(fixture)).not.toMatch(/wrangler (?:d1|dev)/)
  }, 25_000)

  it('rejects impostor health when the spawned Wrangler process has exited', async () => {
    const fixture = makeFixture()
    const port = await unusedPort()
    startServer(fixture, port, 1_500)

    const result = runDriver(fixture, port, { FAKE_DEV_MODE: 'exit' })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('spawned Wrangler process is not alive after health became ready')
    expect(invocations(fixture)).not.toContain('npm run')
  }, 25_000)

  it('clears failed browser artifacts before a successful repeated run', async () => {
    const fixture = makeFixture()
    const port = await unusedPort()

    const failed = runDriver(fixture, port, { FAKE_SMOKE_FAIL: '1' })
    expect(failed.status).not.toBe(0)
    expect(readdirSync(fixture.smoke)).toContain('failure-first.json')
    await waitForEndpoint(`http://127.0.0.1:${port}/health`, false)

    const passed = runDriver(fixture, port)
    expect(passed.status).toBe(0)
    expect(readdirSync(fixture.smoke).sort()).toEqual(['.mupot-local-evidence-artifacts', 'report.json'])
    expect(readdirSync(fixture.runtime).sort()).toEqual(['.mupot-local-evidence-artifacts', 'report.json'])
    expect(readFileSync(join(fixture.smoke, 'report.json'), 'utf8')).toContain('"run":"success"')
    expect(readdirSync(fixture.smoke).some((name) => name.startsWith('failure-'))).toBe(false)
    expect(readdirSync(fixture.runtime).some((name) => name.startsWith('failure-'))).toBe(false)
  }, 35_000)
})
