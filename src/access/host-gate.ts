// mupot — host gate for the Access approve page. Runs as the FIRST statement of the Worker's fetch.
//
// The Cloudflare Access cookie (CF_Authorization) is scoped to the HOST. Anything else served on that
// host (an MCP endpoint, the preview proxy into agent-deployable Workers, the dashboard) would receive
// the human's Access JWT and could replay it. So the approval page lives on a DEDICATED hostname:
//   - on the dedicated approval host (ACCESS_CANONICAL_HOST, distinct from every colony host) only
//     /approve/* is served; every other path is a 404 here, before any other handler is reached;
//   - /approve/* on any other host is a 404, so the page never shares a host with other surfaces;
//   - flag off: the gate does nothing (the /approve mount itself answers 404 as before).
// A canonical host that is unset, malformed or equals a colony host is a config error: the page is
// never enabled (accessApproveStatus), and /approve/* is a 404 everywhere.
// Contract: docs/architecture/access-approve-page.md.
import type { Env } from '../types'
import { accessApproveEnabled, dedicatedApprovalHost } from './config'

const NOT_FOUND = (): Response =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })

export function isApprovePath(pathname: string): boolean {
  return pathname === '/approve' || pathname.startsWith('/approve/')
}

function safeDecode(p: string): string {
  try {
    return decodeURI(p)
  } catch {
    return p
  }
}

/** A Response to return immediately, or null to let the normal pipeline run. */
export function approvalHostGate(req: Request, env: Env): Response | null {
  if (!accessApproveEnabled(env)) return null
  const url = new URL(req.url)
  const approvalHost = dedicatedApprovalHost(env)
  const onApprovalHost = approvalHost !== null && url.host.toLowerCase() === approvalHost
  // The router decodes the path before matching, so a percent-encoded spelling (/%61pprove) counts as /approve too.
  const approve = isApprovePath(url.pathname) || isApprovePath(safeDecode(url.pathname))
  if (onApprovalHost) return approve ? null : NOT_FOUND()
  return approve ? NOT_FOUND() : null
}
