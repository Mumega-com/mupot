// src/mcp/request-cap.ts — the bounded request-body reader for POST /mcp and POST /mcp/actions/:tool (mupot#2315).
//
// WHY 400 KiB: the wiki body cap is MAX_BODY_BYTES = 64 KiB of UTF-8 (src/pages/port.ts). It travels inside a JSON
// string inside a JSON-RPC envelope. Worst case for a conforming client: every body byte written as a \uXXXX escape
// (6 wire bytes per body byte; ASCII-only escaping), so 64 KiB * 6 = 384 KiB. The rest of the envelope (jsonrpc, id,
// method, params.name, project_id, slug, title, summary <=500 chars, tags, links, expected_*; each escaped too) is
// bounded well under 16 KiB. 384 KiB + 16 KiB = 400 KiB = 409600 bytes. The cap stays a HARD bound: it is enforced on
// the declared Content-Length before any read AND on the bytes actually streamed (a chunked or lying request has no
// trustworthy Content-Length), so memory per request never exceeds MCP_REQUEST_CAP_BYTES.
// The sibling /mcp/profile/needs-you route is read-only, shares none of this, and keeps its own 64 KiB cap.
import { MAX_BODY_BYTES } from '../pages/port'

export const MCP_ENVELOPE_ALLOWANCE_BYTES = 16 * 1024
export const MCP_ESCAPE_FACTOR = 6
export const MCP_REQUEST_CAP_BYTES = MAX_BODY_BYTES * MCP_ESCAPE_FACTOR + MCP_ENVELOPE_ALLOWANCE_BYTES

/** The pre-auth / default cap: what every request had before #2315, and what every tool except project_wiki_upsert keeps. */
export const MCP_BASE_REQUEST_CAP_BYTES = 64 * 1024

export type BoundedRead = { ok: true; text: string } | { ok: false; reason: 'declared_too_large' | 'stream_too_large' | 'read_error' }

/** Read a request body as text, refusing past `max` bytes. Never buffers more than `max` + one chunk. */
export async function readBoundedText(req: Request, baseMax: number = MCP_REQUEST_CAP_BYTES, escalate?: () => Promise<number>): Promise<BoundedRead> {
  // `escalate` is consulted at most once, and only when the request actually exceeds `baseMax` (declared or streamed):
  // it resolves the caller's auth and returns the (higher) cap that caller earned. A request that fits baseMax never pays for it.
  let max = baseMax
  let escalated = false
  const raise = async (): Promise<void> => {
    if (escalated || !escalate) return
    escalated = true
    max = Math.max(baseMax, await escalate())
  }
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) await raise()
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'declared_too_large' }
  if (!req.body) return { ok: true, text: '' }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) await raise()
      if (total > max) {
        await reader.cancel().catch(() => undefined) // best effort: stop the upstream, we are refusing anyway
        return { ok: false, reason: 'stream_too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'read_error' } // a broken/aborted client stream is the caller's JSON 400, never a plain 500
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const ch of chunks) { merged.set(ch, off); off += ch.byteLength }
  return { ok: true, text: new TextDecoder().decode(merged) }
}

/** What a 413 tells the caller: what was too large, the limit, and the next step. */
export function payloadTooLargeDetail(route: string): Record<string, unknown> {
  return {
    what: `the HTTP request body for ${route}`,
    limit_bytes: MCP_REQUEST_CAP_BYTES,
    next_step: `Send a smaller request (limit ${MCP_REQUEST_CAP_BYTES} bytes including the JSON envelope). For project_wiki_upsert keep body <= ${MAX_BODY_BYTES} UTF-8 bytes and avoid \\uXXXX-escaping ASCII; if the page is larger, split it across linked pages.`,
  }
}

/** After parsing: only project_wiki_upsert may use the raised cap. Every other tool keeps the pre-#2315 64 KiB request bound. */
export function oversizeForTool(bodyBytes: number, canonicalToolName: unknown): boolean {
  return bodyBytes > MCP_BASE_REQUEST_CAP_BYTES && canonicalToolName !== 'project_wiki_upsert'
}

export function toolTooLargeDetail(tool: unknown): Record<string, unknown> {
  return {
    what: `the request body for tool ${typeof tool === 'string' ? tool : 'unknown'}`,
    limit_bytes: MCP_BASE_REQUEST_CAP_BYTES,
    next_step: `Only project_wiki_upsert accepts more than ${MCP_BASE_REQUEST_CAP_BYTES} bytes. Send less: store long text as several smaller calls, or as a split wiki page via project_wiki_upsert.`,
  }
}
