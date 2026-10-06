// mupot#1667: POST /mcp tools/call turns a 4xx tool refusal (authz/business) into HTTP 200 +
// result.isError (the real status/error/detail ride in result.structuredContent), while 5xx and
// protocol errors stay JSON-RPC errors with their HTTP status. Tests written before that change assert
// "<status> + error.message + error.data" on the Response. `mcpRequest` is mcpApp.request with that
// envelope translated back, so every existing assertion still checks the SAME status / error / detail.
import { mcpApp } from '../../src/mcp'

export interface ToolOutcome {
  status: number
  error: string | null
  detail: unknown
  isToolRefusal: boolean
}

interface RefusalBody {
  status?: unknown
  error?: unknown
  detail?: unknown
}

interface RpcEnvelope {
  id?: unknown
  result?: { isError?: unknown; structuredContent?: RefusalBody }
  error?: { message?: unknown; data?: unknown }
}

/** Status/error/detail of a tools/call Response, whichever envelope carried it. */
export async function callToolOutcome(res: Response): Promise<ToolOutcome> {
  const body = (await res.clone().json().catch(() => null)) as RpcEnvelope | null
  const sc = body?.result?.isError === true ? body.result.structuredContent : undefined
  if (sc && typeof sc.status === 'number') {
    return { status: sc.status, error: typeof sc.error === 'string' ? sc.error : null, detail: sc.detail, isToolRefusal: true }
  }
  const error = typeof body?.error?.message === 'string' ? body.error.message : null
  // unknown_tool / invalid_args / invalid_request are JSON-RPC -32602 errors at HTTP 200 now; their
  // pre-#1667 HTTP status was 400, which is what the legacy assertions pin.
  const status = res.status === 200 && error !== null && PROTOCOL_400.has(error) ? 400 : res.status
  return { status, error, detail: body?.error?.data, isToolRefusal: false }
}

const PROTOCOL_400 = new Set(['unknown_tool', 'invalid_args', 'invalid_request'])

/** Rebuild the pre-#1667 shape (HTTP status + JSON-RPC error{message,data}) for an isError result. */
export async function asLegacyRefusal(res: Response): Promise<Response> {
  const out = await callToolOutcome(res)
  if (!out.isToolRefusal && out.status === res.status) return res
  const env = (await res.clone().json()) as RpcEnvelope
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: env.id ?? null, error: { code: -32000, message: out.error, data: out.detail } }),
    { status: out.status, headers: { 'content-type': 'application/json' } },
  )
}

/** Drop-in for mcpApp.request(url, init, env, ...) with refusals presented in the legacy shape. */
export async function mcpRequest(...args: Parameters<typeof mcpApp.request>): Promise<Response> {
  return asLegacyRefusal(await mcpApp.request(...args))
}
