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

export type BoundedRead = { ok: true; text: string } | { ok: false; reason: 'declared_too_large' | 'stream_too_large' }

/** Read a request body as text, refusing past `max` bytes. Never buffers more than `max` + one chunk. */
export async function readBoundedText(req: Request, max: number = MCP_REQUEST_CAP_BYTES): Promise<BoundedRead> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: 'declared_too_large' }
  if (!req.body) return { ok: true, text: '' }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined) // best effort: stop the upstream, we are refusing anyway
      return { ok: false, reason: 'stream_too_large' }
    }
    chunks.push(value)
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
