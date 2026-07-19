#!/usr/bin/env node
/**
 * Idempotent Mumega pot project-attribution applicator.
 *
 * Applies (or re-checks) the squad grants + task attributions described in
 * scripts/project-attribution-mumega.manifest.json against a live pot MCP.
 *
 * Auth: set MUPOT_URL + MUPOT_ADMIN_TOKEN (org-admin workspace token).
 * Never commit tokens. Dry-run is the default; pass --apply to mutate.
 *
 * Usage:
 *   node scripts/project-attribution-mumega.mjs
 *   node scripts/project-attribution-mumega.mjs --apply
 *   node scripts/project-attribution-mumega.mjs --apply --manifest path/to.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MANIFEST = path.join(__dirname, 'project-attribution-mumega.manifest.json')

function parseArgs(argv) {
  let apply = false
  let manifestPath = DEFAULT_MANIFEST
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--manifest') {
      const next = argv[i + 1]
      if (!next) throw new Error('--manifest requires a path')
      manifestPath = next
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { apply, manifestPath }
}

async function mcpCall(baseUrl, token, name, args) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mupot-project-attribution/v1',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${name}: ${JSON.stringify(body).slice(0, 400)}`)
  }
  if (body.error) {
    throw new Error(`${name} RPC error: ${JSON.stringify(body.error)}`)
  }
  return body.result?.structuredContent ?? body.result
}

function projectId(manifest, slugOrId) {
  if (manifest.projects[slugOrId]) return manifest.projects[slugOrId]
  return slugOrId
}

function squadId(manifest, slugOrId) {
  if (manifest.squads[slugOrId]) return manifest.squads[slugOrId]
  return slugOrId
}

async function main() {
  const { apply, manifestPath } = parseArgs(process.argv)
  const baseUrl = process.env.MUPOT_URL
  const token = process.env.MUPOT_ADMIN_TOKEN
  if (!baseUrl) throw new Error('MUPOT_URL is required')
  if (!token) throw new Error('MUPOT_ADMIN_TOKEN is required')

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schema !== 'mupot.project-attribution/v1') {
    throw new Error(`unsupported manifest schema: ${manifest.schema}`)
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    pot: baseUrl,
    grants: [],
    moves: [],
    attributions: [],
    creates: [],
  }

  for (const grant of manifest.squad_grants ?? []) {
    const args = {
      project_id: projectId(manifest, grant.project),
      squad_id: squadId(manifest, grant.squad),
      access_level: grant.access_level,
    }
    if (apply) {
      const out = await mcpCall(baseUrl, token, 'project_squad_set', args)
      report.grants.push({ ...args, result: 'applied', out })
    } else {
      report.grants.push({ ...args, result: 'would_apply' })
    }
  }

  for (const move of manifest.task_moves ?? []) {
    const args = {
      task_id: move.task_id,
      project_id: projectId(manifest, move.to_project),
    }
    if (apply) {
      const out = await mcpCall(baseUrl, token, 'task_update', args)
      report.moves.push({ ...args, title: move.title, result: 'applied', out })
    } else {
      report.moves.push({ ...args, title: move.title, result: 'would_apply' })
    }
  }

  for (const row of manifest.task_attributions_mupot_development ?? []) {
    const args = {
      task_id: row.task_id,
      project_id: projectId(manifest, 'mupot-development'),
    }
    if (apply) {
      const out = await mcpCall(baseUrl, token, 'task_update', args)
      report.attributions.push({ ...args, title: row.title, result: 'applied', out })
    } else {
      report.attributions.push({ ...args, title: row.title, result: 'would_apply' })
    }
  }

  // Creates are not re-run by default: they would duplicate. Only report plan.
  for (const row of manifest.task_creates_dme_integration ?? []) {
    report.creates.push({
      github_issue: row.github_issue,
      task_id: row.task_id ?? null,
      title: row.title,
      result: row.task_id ? 'already_created' : 'would_create',
      note: 'task_create is one-shot; re-apply skips creates when task_id is present',
    })
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
