// plugins/seatlink/discover.mjs — seat discovery + inbox-stream failure policy for seatlink.
//
// Pure functions only (no herdr / mupot / filesystem calls here): the caller injects every input,
// so the join and the 401 policy are unit-testable from fixtures. See README.md for how the
// installed bridge wires these in.
//
// Seat identity rule (same as the bridge's own seatMap): the seat NAME is the herdr WORKSPACE
// LABEL (or herdr agent name), never anything a pane says about itself. Mupot identity is the
// peer row it joins to by slug; a seat that joins to zero or several peers is NOT guessed at.

/** A peer slug safe to join into a token path. */
export const PEER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Lowercase, `_` -> `-`, trim. `muvps_kasra` and `muvps-kasra` compare equal. */
export function normalizeSeatName(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/_/g, '-')
}

/** Candidate peer slugs for a seat name: the normalized name, plus the name without a `muvps-` host prefix. */
export function slugCandidates(seatName) {
  const n = normalizeSeatName(seatName)
  if (!n) return []
  const out = [n]
  if (n.startsWith('muvps-') && n.length > 'muvps-'.length) out.push(n.slice('muvps-'.length))
  return out
}

/** `herdr agent list` / `workspace list` print a {id,result:{...}} envelope (there is NO --json flag).
 *  Accepts the envelope or the bare result; returns [] for anything else. */
export function parseHerdrAgents(raw) {
  const j = typeof raw === 'string' ? safeParse(raw) : raw
  const agents = j?.result?.agents ?? j?.agents
  return Array.isArray(agents) ? agents : []
}

export function parseHerdrWorkspaces(raw) {
  const j = typeof raw === 'string' ? safeParse(raw) : raw
  const ws = j?.result?.workspaces ?? j?.workspaces
  return Array.isArray(ws) ? ws : []
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

/** mupot `peers` tool result ({peers:[{id,slug,...}]}); tolerant of an MCP structuredContent wrapper. */
export function parsePeers(raw) {
  const j = typeof raw === 'string' ? safeParse(raw) : raw
  const peers = j?.peers ?? j?.result?.peers ?? j?.structuredContent?.peers
  return Array.isArray(peers) ? peers.filter((p) => p && typeof p.id === 'string' && typeof p.slug === 'string') : []
}

/**
 * Build the seat set.
 *   herdrAgents      parsed `herdr agent list` agents
 *   herdrWorkspaces  parsed `herdr workspace list` workspaces (label lookup)
 *   peers            parsed mupot peers
 *   overrides        optional seats.json `seats` array: an entry with the same `herdr` name WINS wholesale
 *   tokenFileFor     (peerSlug) => path | null  (injected; the caller checks the filesystem)
 * Returns { seats, skipped }. Every herdr seat ends in exactly one of the two lists, with a reason.
 */
export function buildSeatSet({ herdrAgents, herdrWorkspaces = [], peers, overrides = [], tokenFileFor }) {
  const labelByWs = new Map(herdrWorkspaces.map((w) => [w.workspace_id, w.label]))
  const overrideByName = new Map((overrides ?? []).filter((o) => o?.herdr).map((o) => [o.herdr, o]))
  const bySlug = new Map()
  for (const p of peers) {
    const k = normalizeSeatName(p.slug)
    bySlug.set(k, [...(bySlug.get(k) ?? []), p])
  }

  const seats = []
  const skipped = []
  const seen = new Set()

  for (const a of herdrAgents) {
    const name = labelByWs.get(a.workspace_id) || a.name || null
    if (!name) { skipped.push({ herdr: null, pane_id: a.pane_id ?? null, reason: 'no_label' }); continue }
    // Two panes sharing a label: one seat per label, but never a silent drop.
    if (seen.has(name)) { skipped.push({ herdr: name, pane_id: a.pane_id ?? null, reason: 'duplicate_label' }); continue }
    seen.add(name)

    const ov = overrideByName.get(name)
    if (ov) { seats.push({ ...ov, source: 'override' }); continue }

    let matches = []
    for (const slug of slugCandidates(name)) {
      matches = bySlug.get(slug) ?? []
      if (matches.length) break
    }
    if (matches.length === 0) { skipped.push({ herdr: name, reason: 'no_peer_match' }); continue }
    if (matches.length > 1) { skipped.push({ herdr: name, reason: 'ambiguous_peer_match' }); continue }
    const peer = matches[0]
    // The slug is joined into a filesystem path by the caller: refuse anything but a plain slug.
    if (!PEER_SLUG_RE.test(peer.slug)) { skipped.push({ herdr: name, mupot_agent_id: peer.id, reason: 'invalid_peer_slug' }); continue }
    const tokenFile = tokenFileFor ? tokenFileFor(peer.slug) : null
    if (!tokenFile) { skipped.push({ herdr: name, mupot_agent_id: peer.id, reason: 'no_token_file' }); continue }
    seats.push({ herdr: name, mupot_agent_id: peer.id, mupot_token_file: tokenFile, source: 'discover' })
  }

  // Two herdr seats claiming ONE mupot agent id would double-inject (the bridge keys cursors and pane
  // injection by label): neither is trusted, both are skipped.
  const claims = new Map()
  for (const s of seats) if (s.source === 'discover') claims.set(s.mupot_agent_id, (claims.get(s.mupot_agent_id) ?? 0) + 1)
  const deduped = []
  for (const s of seats) {
    if (s.source === 'discover' && claims.get(s.mupot_agent_id) > 1) {
      skipped.push({ herdr: s.herdr, mupot_agent_id: s.mupot_agent_id, reason: 'duplicate_peer_claim' })
    } else deduped.push(s)
  }
  seats.length = 0
  seats.push(...deduped)

  // An override for a seat herdr does not currently list is kept: seats.json stays authoritative
  // for hand-declared seats (e.g. a pane that is not up yet).
  for (const [name, ov] of overrideByName) {
    if (!seen.has(name)) seats.push({ ...ov, source: 'override' })
  }
  return { seats, skipped }
}

/** Long backoff for refusals a human may fix (token file rewritten) or an outage: 5 minutes. */
export const LONG_BACKOFF_MS = 300000

/**
 * Decide what a failed inbox-stream open means.
 *   stop     401, or 403 whose body says `not_agent_bound` (the credential can never work as-is)
 *   backoff  any other 403 (policy/WAF/transient) or 5xx: wait LONG_BACKOFF_MS, re-read the token
 *   retry    network error, 429, anything else: 1s -> 30s doubling
 */
export function classifyStreamFailure(seat, status, body = '') {
  const terminal403 = status === 403 && /not_agent_bound/.test(String(body ?? ''))
  if (status === 401 || terminal403) {
    return {
      action: 'stop',
      line: `SEAT DEAF: ${seat} inbox stream refused with HTTP ${status} (token rejected). `
        + 'NOT retrying; this seat receives no mail until its token is re-minted and seatlink is restarted.',
    }
  }
  if (status === 403 || (typeof status === 'number' && status >= 500)) return { action: 'backoff' }
  return { action: 'retry' }
}

/**
 * Run one seat's stream loop under the policy. `openOnce(token)` performs one connect+consume cycle and
 * returns normally when the stream ends, or throws an Error carrying `.status` (and optionally `.body`)
 * for an HTTP refusal. `readToken()` is called at the top of EVERY cycle so a re-minted token file is
 * picked up without a restart. Returns { stopped: true, status } after a terminal failure; otherwise
 * loops forever (or until `shouldContinue()` is false, used by tests).
 */
export async function runSeatStream({ seat, openOnce, readToken = () => undefined, log, sleep, shouldContinue = () => true }) {
  let backoff = 1000
  while (shouldContinue()) {
    try {
      await openOnce(readToken())
      backoff = 1000
      await sleep(1000) // a normal stream end must not hot-loop
    } catch (e) {
      const status = typeof e?.status === 'number' ? e.status : null
      const verdict = classifyStreamFailure(seat, status, e?.body)
      if (verdict.action === 'stop') {
        log(verdict.line)
        return { stopped: true, status }
      }
      if (verdict.action === 'backoff') {
        log(`SSE ${seat}: ${e?.message ?? e}, HTTP ${status}, backing off ${LONG_BACKOFF_MS}ms (token re-read next cycle)`)
        await sleep(LONG_BACKOFF_MS)
        continue
      }
      log(`SSE ${seat}: ${e?.message ?? e}, retry ${backoff}ms`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
  return { stopped: false, status: null }
}
