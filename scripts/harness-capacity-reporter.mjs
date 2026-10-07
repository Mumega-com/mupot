#!/usr/bin/env node
// scripts/harness-capacity-reporter.mjs — mupot#1765 (epic #1590). READ-ONLY, no deps.
//
// Runs a HARD ALLOWLIST of Orca read subcommands, reduces the output to COUNTS ONLY, and reports
// them via the mupot MCP tool `harness_capacity_report`. It never forwards terminal previews,
// titles, paths, branch names or any other text. The Orca CLI can also WRITE (terminal send,
// worker-stop, computer-use): anything not on the allowlist is refused before a process is spawned.
//
// Env:  MUPOT_TOKEN_FILE (required unless --dry-run)  path to a file holding the bearer token
//       MUPOT_MCP_URL    default https://mupot.mumega.com/mcp
//       ORCA_BIN         default ~/.orca-relay/bin/orca
// Flags: --dry-run  --host-key <slug> (default hadi-mac)  --max-agents <n>

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** The ONLY Orca invocations this script may run. Exact argv match; nothing else is spawned. */
export const ORCA_READ_ALLOWLIST = Object.freeze([
  Object.freeze(['status']),
  Object.freeze(['host', 'list']),
  Object.freeze(['terminal', 'list']),
  Object.freeze(['orchestration', 'worker-list']),
  Object.freeze(['worktree', 'ps']),
])

export const BUSY_RECENT_MS = 10 * 60 * 1000

export function assertAllowedOrcaCommand(argv) {
  const ok = ORCA_READ_ALLOWLIST.some((a) => a.length === argv.length && a.every((t, i) => t === argv[i]))
  if (!ok) throw new Error(`refused: orca subcommand not on read allowlist: ${JSON.stringify(argv.slice(0, 2))}`)
}

const nonNegInt = (n) => (Number.isInteger(n) && n >= 0 ? n : 0)
const arr = (v) => (Array.isArray(v) ? v : [])

/**
 * Reduce raw Orca outputs to numbers. Only boolean/number/enum-compared fields are read;
 * string fields (preview, title, paths, branch) are never copied into the result.
 */
export function summarize({ terminals, workers, worktrees }, now) {
  const terms = arr(terminals?.result?.terminals)
  const live = terms.filter((t) => t && t.connected === true && t.orphaned !== true)
  const wk = arr(workers?.result?.workers)
  const wts = arr(worktrees?.result?.worktrees)
  const workersActive = wk.filter((w) => w && (w.workerState === 'running' || w.workerState === 'starting')).length
  const releaseUnknown = wk.filter((w) => w && w.resource && w.resource.releaseState === 'unknown').length
  const counts = {
    live_terminals: live.length,
    agent_sessions: live.filter((t) => typeof t.agentIdentity === 'string' && t.agentIdentity.length > 0).length,
    busy_recent: live.filter((t) => typeof t.lastOutputAt === 'number' && now - t.lastOutputAt <= BUSY_RECENT_MS).length,
    orphaned_terminals: terms.filter((t) => t && t.orphaned === true).length,
    workers_active: workersActive,
    workers_release_unknown: releaseUnknown,
    worktrees_with_live: wts.filter((w) => w && nonNegInt(w.liveTerminalCount) > 0).length,
  }
  const summary = {
    terminals_total: terms.length,
    workers_total: wk.length,
    worktrees_total: wts.length,
  }
  return { counts, summary }
}

const HOST_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/

export function buildPayload({ hostKey, maxAgents, raw, now }) {
  if (!HOST_KEY_RE.test(hostKey)) throw new Error('invalid host key')
  const { counts, summary } = summarize(raw, now)
  return {
    harness: 'orca',
    host_key: hostKey,
    observed_at: now,
    ...counts,
    ...(maxAgents !== undefined ? { max_agents: maxAgents } : {}),
    summary,
  }
}

function parseJsonLoose(stdout) {
  // The relay may print a banner line before the JSON document.
  const i = stdout.indexOf('{')
  if (i < 0) throw new Error('no JSON in orca output')
  return JSON.parse(stdout.slice(i))
}

async function runOrca(bin, argv) {
  assertAllowedOrcaCommand(argv)
  const { stdout } = await execFileP(bin, [...argv, '--json'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  return parseJsonLoose(stdout)
}

function parseFlags(argv) {
  const f = { dryRun: false, hostKey: 'hadi-mac', maxAgents: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') f.dryRun = true
    else if (argv[i] === '--host-key') f.hostKey = argv[++i] ?? ''
    else if (argv[i] === '--max-agents') f.maxAgents = Number(argv[++i])
    else throw new Error(`unknown flag: ${argv[i]}`)
  }
  if (f.maxAgents !== undefined && !(Number.isInteger(f.maxAgents) && f.maxAgents >= 0)) throw new Error('invalid --max-agents')
  return f
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const bin = process.env.ORCA_BIN || join(homedir(), '.orca-relay', 'bin', 'orca')
  // status + host list are liveness gates: a failing runtime must not be reported as zero load.
  const status = await runOrca(bin, ['status'])
  if (status?.ok !== true) throw new Error('orca status not ok; refusing to report')
  await runOrca(bin, ['host', 'list'])
  const raw = {
    terminals: await runOrca(bin, ['terminal', 'list']),
    workers: await runOrca(bin, ['orchestration', 'worker-list']),
    worktrees: await runOrca(bin, ['worktree', 'ps']),
  }
  for (const k of Object.keys(raw)) if (raw[k]?.ok !== true) throw new Error(`orca ${k} not ok; refusing to report`)
  const payload = buildPayload({ hostKey: flags.hostKey, maxAgents: flags.maxAgents, raw, now: Date.now() })
  if (flags.dryRun) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const tokenFile = process.env.MUPOT_TOKEN_FILE
  if (!tokenFile) throw new Error('MUPOT_TOKEN_FILE is required (path to a file containing the bearer token)')
  const token = readFileSync(tokenFile, 'utf8').trim()
  const url = process.env.MUPOT_MCP_URL || 'https://mupot.mumega.com/mcp'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'harness_capacity_report', arguments: payload } }),
  })
  if (!res.ok) throw new Error(`mupot responded HTTP ${res.status}`)
  const body = await res.text()
  if (/"isError"\s*:\s*true|"error"\s*:\s*\{/.test(body)) throw new Error('mupot rejected the report')
  process.stdout.write(`reported live=${payload.live_terminals} agents=${payload.agent_sessions}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`harness-capacity-reporter: ${e instanceof Error ? e.message : 'failed'}\n`)
    process.exit(1)
  })
}
