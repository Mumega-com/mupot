// plugins/seatlink/discover.mjs — seat discovery + inbox-stream failure policy for seatlink.
//
// Pure functions only (no herdr / mupot / filesystem calls here): the caller injects every input,
// so the join and the 401 policy are unit-testable from fixtures. See README.md for how the
// installed bridge wires these in.
//
// Seat identity rule (same as the bridge's own seatMap): the seat NAME is the herdr WORKSPACE
// LABEL (or herdr agent name), never anything a pane says about itself. Mupot identity is the
// peer row it joins to by slug; a seat that joins to zero or several peers is NOT guessed at.

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
    if (seen.has(name)) continue // two panes in one workspace: one seat per label
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
    const tokenFile = tokenFileFor ? tokenFileFor(peer.slug) : null
    if (!tokenFile) { skipped.push({ herdr: name, mupot_agent_id: peer.id, reason: 'no_token_file' }); continue }
    seats.push({ herdr: name, mupot_agent_id: peer.id, mupot_token_file: tokenFile, source: 'discover' })
  }

  // An override for a seat herdr does not currently list is kept: seats.json stays authoritative
  // for hand-declared seats (e.g. a pane that is not up yet).
  for (const [name, ov] of overrideByName) {
    if (!seen.has(name)) seats.push({ ...ov, source: 'override' })
  }
  return { seats, skipped }
}

/** HTTP statuses that mean "this credential will not work until a human fixes it". Retrying is noise. */
export const TERMINAL_AUTH_STATUSES = new Set([401, 403])

/**
 * Decide what a failed inbox-stream open means.
 * Returns { action: 'stop', line } for 401/403 (one loud line, never retry),
 * or { action: 'retry' } for everything else (network error, 5xx, 429 ...).
 */
export function classifyStreamFailure(seat, status) {
  if (TERMINAL_AUTH_STATUSES.has(status)) {
    return {
      action: 'stop',
      line: `SEAT DEAF: ${seat} inbox stream refused with HTTP ${status} (token rejected). `
        + 'NOT retrying; this seat receives no mail until its token is re-minted and seatlink is restarted.',
    }
  }
  return { action: 'retry' }
}

/**
 * Run one seat's stream loop under the policy. `openOnce()` performs one connect+consume cycle and
 * returns normally when the stream ends, or throws an Error carrying `.status` for an HTTP refusal.
 * Returns { stopped: true, status } after a terminal auth failure; otherwise loops forever (or until
 * `shouldContinue()` is false, used by tests). Backoff doubles from 1s to a 30s cap on retryable errors.
 */
export async function runSeatStream({ seat, openOnce, log, sleep, shouldContinue = () => true }) {
  let backoff = 1000
  while (shouldContinue()) {
    try {
      await openOnce()
      backoff = 1000
    } catch (e) {
      const status = typeof e?.status === 'number' ? e.status : null
      const verdict = classifyStreamFailure(seat, status)
      if (verdict.action === 'stop') {
        log(verdict.line)
        return { stopped: true, status }
      }
      log(`SSE ${seat}: ${e?.message ?? e}, retry ${backoff}ms`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
  return { stopped: false, status: null }
}
