#!/usr/bin/env node
// plugins/seatlink/seatlink-discover.mjs — `--discover`: print the seat set seatlink would run.
//
//   node seatlink-discover.mjs --discover [--seats seats.json] [--token-dir ~/.fleet/agents] [--peers peers.json]
//
// Reads `herdr agent list` + `herdr workspace list` (JSON by default; herdr has no --json flag) and
// mupot `peers` (from --peers <file> holding the tool's JSON result, or MUPOT_TOKEN_FILE + MUPOT_API_URL
// for a live REST/MCP call). Read-only; prints JSON {seats, skipped}; never writes seats.json, never prints tokens.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSeatSet, parseHerdrAgents, parseHerdrWorkspaces, parsePeers } from './discover.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function livePeers() {
  const tokenFile = process.env.MUPOT_TOKEN_FILE
  if (!tokenFile) throw new Error('no --peers file and no MUPOT_TOKEN_FILE: cannot read mupot peers')
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  const base = (process.env.MUPOT_API_URL || 'https://mupot.mumega.com').replace(/\/$/, '')
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'peers', arguments: {} } }),
  })
  if (!res.ok) throw new Error(`peers: HTTP ${res.status}`)
  const body = await res.json()
  const text = body?.result?.content?.[0]?.text
  return parsePeers(typeof text === 'string' ? text : body?.result)
}

async function main() {
  if (!process.argv.includes('--discover')) {
    console.error('usage: seatlink-discover.mjs --discover [--seats seats.json] [--token-dir dir] [--peers peers.json]')
    process.exit(2)
  }
  const herdr = process.env.HERDR_BIN || 'herdr'
  const agents = parseHerdrAgents(execFileSync(herdr, ['agent', 'list'], { encoding: 'utf8' }))
  const workspaces = parseHerdrWorkspaces(execFileSync(herdr, ['workspace', 'list'], { encoding: 'utf8' }))
  const peersFile = arg('--peers', '')
  const peers = peersFile ? parsePeers(fs.readFileSync(peersFile, 'utf8')) : await livePeers()
  const seatsFile = arg('--seats', '')
  const overrides = seatsFile && fs.existsSync(seatsFile) ? (JSON.parse(fs.readFileSync(seatsFile, 'utf8')).seats ?? []) : []
  const tokenDir = arg('--token-dir', path.join(os.homedir(), '.fleet', 'agents'))
  const tokenFileFor = (slug) => {
    const f = path.join(tokenDir, `${slug}-agent-bound.token`)
    return fs.existsSync(f) ? f : null
  }
  const out = buildSeatSet({ herdrAgents: agents, herdrWorkspaces: workspaces, peers, overrides, tokenFileFor })
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error(`discover failed: ${e.message}`); process.exit(1) })
