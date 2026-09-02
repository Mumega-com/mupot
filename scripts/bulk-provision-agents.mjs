#!/usr/bin/env node
// scripts/bulk-provision-agents.mjs — run mint_agent_token's one-call composite
// (provision_agent_connection) once per row of a checked-in roster, so Hadi
// turns ~30 manual mint ceremonies into ONE reviewed command.
//
// See scripts/lib/bulk-provision-core.mjs for the WHY and the exact behavior
// contract (dry-run default, tenant-wide slug collision refusal, resumable via
// live-state re-derivation, credential-claim-id-only receipts, independent
// post-write verification). This file is ONLY the CLI shell: argv/env parsing,
// the real HTTP transport to the mupot MCP endpoint, receipt file I/O, and the
// operator-bound-token preflight refusal. All provisioning logic lives in the
// transport-agnostic core module so it can be exercised in tests against a
// real migrated D1 without a network.
//
// HARD BOUNDARIES (do not relax these):
//   - This script contains, embeds, and reads NO credential of its own. It
//     uses whatever operator bearer token is already in the caller's
//     environment (MUPOT_OPERATOR_TOKEN or MUPOT_OPERATOR_TOKEN_FILE). It only
//     works when that token is an UNBOUND OPERATOR token (auth.boundAgentId ==
//     null server-side) — every mint-capable tool this script calls refuses an
//     agent-bound caller outright (403 operator_principal_required), and this
//     script checks that itself via boot_context BEFORE touching the roster,
//     so the failure is plain instead of a wall of 403s.
//   - Never prints, logs, or persists a raw token. Only claim_id / fingerprint
//     / token_id ever leave provisionEntry() — reveal_credential_claim is
//     never called by this script.
//   - Dry-run (no --apply) is the default and performs ZERO mutating calls.
//
// Usage:
//   node scripts/bulk-provision-agents.mjs --roster path/to/roster.json
//   node scripts/bulk-provision-agents.mjs --roster path/to/roster.json --apply
//   node scripts/bulk-provision-agents.mjs --roster path/to/roster.json --apply --continue-on-error
//
// Env:
//   MUPOT_MCP                  MCP endpoint (default https://mupot.mumega.com/mcp)
//   MUPOT_OPERATOR_TOKEN       raw bearer token for an operator (owner/org-admin) session
//   MUPOT_OPERATOR_TOKEN_FILE  path to a file containing that token (alternative to the above)
//
// Flags:
//   --roster <path>        required. JSON array, or { "agents": [...] }.
//   --apply                perform real writes. Omit for dry-run (default).
//   --continue-on-error    keep going past a per-agent failure. Default: stop
//                           on the first failure and report what succeeded /
//                           what remains.
//   --receipts <path>      JSONL receipt file (default: scripts/bulk-provision-receipts/<ts>.jsonl)
//   --request-id-prefix <s> stable prefix for the idempotency request_id sent
//                           to provision_agent_connection (default: bulk-provision-v1)

import { mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  validateRoster,
  planEntry,
  provisionEntry,
  verifyConsentEligible,
} from './lib/bulk-provision-core.mjs'

function parseArgs(argv) {
  const args = { apply: false, continueOnError: false, requestIdPrefix: 'bulk-provision-v1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--roster') args.roster = argv[++i]
    else if (a === '--apply') args.apply = true
    else if (a === '--continue-on-error') args.continueOnError = true
    else if (a === '--receipts') args.receipts = argv[++i]
    else if (a === '--request-id-prefix') args.requestIdPrefix = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`unrecognized argument: ${a}`)
  }
  return args
}

function printHelp() {
  console.log(`node scripts/bulk-provision-agents.mjs --roster <path> [--apply] [--continue-on-error] [--receipts <path>] [--request-id-prefix <s>]

Dry-run is the default: prints exactly what would happen and touches nothing.
Add --apply to actually create/mint. Requires MUPOT_OPERATOR_TOKEN (or
MUPOT_OPERATOR_TOKEN_FILE) in the environment — an UNBOUND OPERATOR token.
See docs/playbooks/bulk-agent-provisioning.md.`)
}

function readOperatorToken() {
  if (process.env.MUPOT_OPERATOR_TOKEN && process.env.MUPOT_OPERATOR_TOKEN.trim()) {
    return process.env.MUPOT_OPERATOR_TOKEN.trim()
  }
  if (process.env.MUPOT_OPERATOR_TOKEN_FILE) {
    const raw = readFileSync(process.env.MUPOT_OPERATOR_TOKEN_FILE, 'utf8').trim()
    if (raw) return raw
  }
  throw new Error(
    'no operator token found — set MUPOT_OPERATOR_TOKEN (raw value) or '
    + 'MUPOT_OPERATOR_TOKEN_FILE (path). This script never embeds or reads a '
    + 'credential of its own; it uses the operator session you already have.',
  )
}

function makeHttpMcpCall(mcpUrl, token) {
  let nextId = 1
  return async function mcpCall(name, args) {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'bulk-provision-agents/1.0 (+mupot)',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    let payload
    try {
      payload = await res.json()
    } catch {
      throw new Error(`mcp http ${res.status}: non-JSON response calling ${name}`)
    }
    if (payload.error) {
      // JSON-RPC error envelope: { code, message, data }. `message` carries the
      // tool's own error code (e.g. 'agent_already_connected', 'slug_taken') —
      // that is a normal, expected outcome for several tool calls in this
      // script, NOT a transport failure, so it is returned as a value, never
      // thrown.
      return { ok: false, error: payload.error.message, detail: payload.error.data }
    }
    return { ok: true, result: payload.result?.structuredContent ?? payload.result }
  }
}

function writeReceipt(path, record) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
}

function loadRosterFile(path) {
  const raw = readFileSync(path, 'utf8')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw new Error(`roster file ${path} is not valid JSON: ${err.message}`)
  }
  return doc
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return { exitCode: 0 }
  }
  if (!args.roster) {
    printHelp()
    return { exitCode: 2, fatal: 'missing --roster <path>' }
  }

  const mcpUrl = env.MUPOT_MCP || 'https://mupot.mumega.com/mcp'
  const token = readOperatorToken()
  const mcpCall = makeHttpMcpCall(mcpUrl, token)

  return runBulkProvision({
    doc: loadRosterFile(args.roster),
    apply: args.apply,
    continueOnError: args.continueOnError,
    requestIdPrefix: args.requestIdPrefix,
    receiptsPath: args.receipts || `scripts/bulk-provision-receipts/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    mcpCall,
    writeReceipt,
    log: (...a) => console.log(...a),
  })
}

// ── the run loop (exported so a Node-only test could drive it directly if
// ever needed; the vitest suite drives runBulkProvision via an mcpApp-backed
// mcpCall instead, see tests/bulk-provision-agents.test.ts) ──────────────────
export async function runBulkProvision({
  doc,
  apply,
  continueOnError,
  requestIdPrefix,
  receiptsPath,
  mcpCall,
  writeReceipt,
  log,
}) {
  // Hard boundary: refuse plainly if this token is agent-bound, before a
  // single roster row is touched. Every mint-capable tool below would refuse
  // it anyway (403 operator_principal_required) — this makes the refusal
  // legible instead of a wall of identical per-agent 403s.
  const boot = await mcpCall('boot_context', {})
  if (!boot.ok) {
    log(`FATAL: boot_context failed (${boot.error}) — cannot confirm this is an operator session. Not proceeding.`)
    return { exitCode: 1, fatal: `boot_context: ${boot.error}` }
  }
  if (boot.result.bound_agent_id) {
    log(
      'FATAL: this bearer token is AGENT-BOUND (boot_context.bound_agent_id = '
      + `${boot.result.bound_agent_id}). Every tool this script calls `
      + '(provision_agent_connection, get_agent_profile\'s admin-gated siblings, etc.) '
      + 'refuses an agent-bound caller outright — "if (auth.boundAgentId) return '
      + 'fail(403, \'operator_principal_required\')" (src/mcp/provision.ts). '
      + 'Run this with an UNBOUND OPERATOR token (an owner/org-admin session), not an agent token.',
    )
    return { exitCode: 1, fatal: 'operator_principal_required' }
  }
  log(`Operator session confirmed: member_id=${boot.result.member_id} channel=${boot.result.channel} role=${boot.result.role}`)

  const { ok, entries, errors } = validateRoster(doc)
  if (!ok) {
    log('FATAL: roster failed validation — fix these and re-run:')
    for (const e of errors) log(`  - ${e}`)
    return { exitCode: 2, fatal: 'roster_invalid', errors }
  }
  log(`Roster OK: ${entries.length} agent(s). Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN (no writes)'}.`)
  if (!apply) log('Dry run — nothing below this line touches the server except read-only lookups (squad_member_list, resolve_agent).')

  const squadCache = new Map()
  const summary = { created: 0, reused: 0, skipped_already_connected: 0, errors: 0, collisions: 0, verified: 0, unverified: 0, dry_run: 0 }
  const couldNotVerify = []
  const remaining = [...entries]

  for (const entry of entries) {
    remaining.shift()
    const plan = await planEntry(entry, { mcpCall, squadCache })

    if (plan.kind === 'error') {
      summary.errors++
      log(`[${entry.slug}] ERROR: ${plan.reason}`)
      writeReceipt(receiptsPath, { ts: new Date().toISOString(), slug: entry.slug, squad: entry.squad, status: 'error', error: plan.reason, dry_run: !apply })
      if (!continueOnError) {
        log(`Stopping on first failure. Remaining, untouched: ${remaining.map((e) => e.slug).join(', ') || '(none)'}`)
        return { exitCode: 1, summary, stoppedAt: entry.slug, remaining: remaining.map((e) => e.slug) }
      }
      continue
    }

    if (plan.kind === 'collision') {
      summary.collisions++
      const where = plan.conflicts.map((c) => `agent ${c.agentId} in squad ${c.squadId} (status=${c.status})`).join('; ')
      log(`[${entry.slug}] REFUSED: slug already exists elsewhere in the tenant — ${where}. Roster named squad "${entry.squad}"; not creating a second same-slug agent in a different squad. Fix the roster (use the existing agent's squad, or a different slug) and re-run.`)
      writeReceipt(receiptsPath, { ts: new Date().toISOString(), slug: entry.slug, squad: entry.squad, status: 'collision', conflicts: plan.conflicts, dry_run: !apply })
      if (!continueOnError) {
        log(`Stopping on first failure. Remaining, untouched: ${remaining.map((e) => e.slug).join(', ') || '(none)'}`)
        return { exitCode: 1, summary, stoppedAt: entry.slug, remaining: remaining.map((e) => e.slug) }
      }
      continue
    }

    const result = await provisionEntry(entry, plan, { mcpCall, requestIdPrefix, apply })

    if (result.status === 'dry_run') {
      summary.dry_run++
      log(`[${entry.slug}] WOULD ${result.would} in squad-ref "${entry.squad}" (capability=${entry.capability}). request_id=${result.args.request_id}`)
      writeReceipt(receiptsPath, { ts: new Date().toISOString(), slug: entry.slug, squad: entry.squad, status: 'dry_run', would: result.would, dry_run: true })
      continue
    }

    if (result.status === 'error') {
      summary.errors++
      log(`[${entry.slug}] ERROR: ${result.error}${result.detail ? ' ' + JSON.stringify(result.detail) : ''}`)
      writeReceipt(receiptsPath, { ts: new Date().toISOString(), slug: entry.slug, squad: entry.squad, status: 'error', error: result.error, detail: result.detail, dry_run: false })
      if (!continueOnError) {
        log(`Stopping on first failure. Remaining, untouched: ${remaining.map((e) => e.slug).join(', ') || '(none)'}`)
        return { exitCode: 1, summary, stoppedAt: entry.slug, remaining: remaining.map((e) => e.slug) }
      }
      continue
    }

    if (result.status === 'skipped_already_connected') {
      summary.skipped_already_connected++
      const verify = await verifyConsentEligible(result.agent_id, { mcpCall })
      if (verify.verified) summary.verified++
      else { summary.unverified++; couldNotVerify.push({ slug: entry.slug, agent_id: result.agent_id, reason: verify.reason }) }
      log(`[${entry.slug}] SKIP (already provisioned). verified=${verify.verified}`)
      writeReceipt(receiptsPath, { ts: new Date().toISOString(), slug: entry.slug, squad: entry.squad, status: 'skipped_already_connected', agent_id: result.agent_id, verified: verify.verified, dry_run: false })
      continue
    }

    // status === 'provisioned'
    if (result.agent_disposition === 'created') summary.created++
    else summary.reused++
    const verify = await verifyConsentEligible(result.agent_id, { mcpCall })
    if (verify.verified) summary.verified++
    else { summary.unverified++; couldNotVerify.push({ slug: entry.slug, agent_id: result.agent_id, reason: verify.reason }) }

    log(`[${entry.slug}] OK (${result.agent_disposition}). agent_id=${result.agent_id} claim_id=${result.claim_id} claim_expires_at=${result.claim_expires_at} verified=${verify.verified}`)
    writeReceipt(receiptsPath, {
      ts: new Date().toISOString(),
      slug: entry.slug,
      squad: entry.squad,
      status: 'provisioned',
      agent_disposition: result.agent_disposition,
      agent_id: result.agent_id,
      member_id: result.member_id,
      token_id: result.token_id,
      claim_id: result.claim_id,
      claim_fingerprint: result.claim_fingerprint,
      claim_expires_at: result.claim_expires_at,
      verified: verify.verified,
      dry_run: false,
    })
  }

  log('')
  log(`Summary: ${JSON.stringify(summary)}`)
  if (apply) log(`Receipts: ${receiptsPath}`)
  if (couldNotVerify.length > 0) {
    log(`Could not independently verify ${couldNotVerify.length} agent(s) as consent-eligible:`)
    for (const c of couldNotVerify) log(`  - ${c.slug} (${c.agent_id}): ${c.reason}`)
  }
  if (apply) {
    log('')
    log('NEXT STEP for each provisioned agent: reveal_credential_claim { claim_id } within its TTL, then hand the connection snippet to that agent\'s harness. This script never reveals or prints a raw token.')
  }

  return { exitCode: summary.errors > 0 || summary.collisions > 0 ? 1 : 0, summary, couldNotVerify }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((r) => {
    process.exitCode = r.exitCode
  }).catch((err) => {
    console.error('FATAL:', err.stack || err.message || err)
    process.exitCode = 1
  })
}
