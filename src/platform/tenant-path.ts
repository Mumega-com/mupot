// mupot#1928 — path-routed tenants (`https://<root>/t/<slug>/...`).
//
// The apex Worker strips `/t/<slug>` before the tenant handler runs, so every root-relative URL the
// tenant emits (href, form action, fetch, Location, absolute links built from a request origin)
// would resolve against the colony root. This module is the ONE place that knows the prefix:
//
//  * `parseTenantPrefix`  — the only parser; accepts exactly `/t/<slug>` (no query, no `//`, no
//    scheme, no encoded slash), so a prefix can never be an open-redirect target.
//  * `tenantPath`         — prefix a root-relative path (throws on anything that is not one).
//  * `applyTenantPrefix`  — response choke point: Location header + HTML attributes + inline-script
//    navigation + a fetch/XHR/EventSource shim. Applied once, in the Worker entry.
//  * `requestBase`        — absolute base for emails / Stripe / OAuth redirect URIs.
//
// The prefix is resolved SERVER-SIDE from the matched route (index.ts) and carried in a header the
// apex sets after its own allow-list; it is re-validated by `parseTenantPrefix` on every read.

/** Internal header the apex sets for a dispatched path tenant (never trusted unvalidated). */
export const TENANT_PREFIX_HEADER = 'x-mupot-path-prefix'

const PATH_TENANT_RE = /^\/t\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(\/.*)?$/i

/** Apex path ` /t/{tenant}/{interface} ` e.g. `/t/gaf/mcp`. */
export function extractPathTenant(pathname: string): { slug: string; remainder: string } | null {
  const match = pathname.match(PATH_TENANT_RE)
  if (!match) return null
  const slug = match[1].toLowerCase()
  const rest = match[2]
  const remainder = rest && rest.length > 0 ? rest : '/'
  return { slug, remainder }
}

const PREFIX_RE = /^\/t\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Returns `/t/<slug>` (lower-cased) or null. The sole accepted shape. */
export function parseTenantPrefix(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return PREFIX_RE.test(v) ? v : null
}

/**
 * The validated prefix for a request, or null. The header is client-reachable on any direct
 * request, so it is honoured ONLY when it names THIS Worker's own tenant slug (server config):
 * a forged `/t/<other-pot>` can never aim a link at another tenant's isolate. A forged
 * `/t/<own-slug>` re-roots only onto this same tenant's legitimate apex address.
 */
export function tenantPrefixOf(request: Request, ownSlug: string): string | null {
  const prefix = parseTenantPrefix(request.headers.get(TENANT_PREFIX_HEADER))
  return prefix !== null && prefix === `/t/${ownSlug.toLowerCase()}` ? prefix : null
}

/** Drop a header that does not name this tenant, so no downstream reader can see a forged value. */
export function stripUntrustedPrefix(request: Request, ownSlug: string): Request {
  if (!request.headers.has(TENANT_PREFIX_HEADER) || tenantPrefixOf(request, ownSlug) !== null) return request
  const headers = new Headers(request.headers)
  headers.delete(TENANT_PREFIX_HEADER)
  return new Request(request, { headers })
}

/** True for `/x`, false for `//x`, `/\x`, schemes, relative paths and control characters. */
function isRootRelative(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false
  // eslint-disable-next-line no-control-regex -- reject CR/LF/NUL header-splitting characters
  return !/[\\\u0000-\u001f]/.test(path)
}

/** Prefix a root-relative path. Throws on anything else: callers must never feed user input here
 *  without validating it first (an absolute or protocol-relative value is not a tenant path). */
export function tenantPath(prefix: string | null, path: string): string {
  if (!isRootRelative(path)) throw new TypeError(`tenantPath: not a root-relative path: ${JSON.stringify(path)}`)
  return prefix === null ? path : `${prefix}${path}`
}

/** Does `path` already live under `prefix` (so it must not be prefixed twice)? */
const ANY_PREFIXED_RE = /^\/t\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:[/?#]|$)/i
function alreadyPrefixed(path: string, _prefix: string): boolean {
  // Any valid /t/<slug> start is already an addressed path: never stack a second prefix on it.
  return ANY_PREFIXED_RE.test(path)
}

/** Truly global paths that must NOT gain the tenant prefix. Empty by design: even OAuth and
 *  well-known documents are per-tenant behind a path door. Kept as an explicit allowlist so a
 *  future global path is a reviewed addition. */
export const TENANT_GLOBAL_PATHS: readonly string[] = []

function isGlobalPath(path: string): boolean {
  return TENANT_GLOBAL_PATHS.some((g) => path === g || path.startsWith(`${g}/`))
}

/** Rewrite one emitted URL value. Non-root-relative and already-prefixed values pass through. */
export function prefixUrlValue(value: string, prefix: string): string {
  if (!isRootRelative(value) || alreadyPrefixed(value, prefix) || isGlobalPath(value)) return value
  return `${prefix}${value}`
}

/** Rewrite a Location header. Absolute / protocol-relative targets are left to the caller's policy. */
export function prefixLocation(location: string, prefix: string): string {
  return prefixUrlValue(location, prefix)
}

// `href="/x"`, `action='/x'`, and the backslash-escaped form `href=\"/x\"` that appears when
// markup sits inside a JS string in an inline script. The attribute must be preceded by
// whitespace, so `data-href=` and `xhref=` are NOT matched. `srcset`/`xlink:href` are not rewritten
// (the dashboard emits neither; add here if that changes).
const ATTR_RE = /(\s(?:href|src|action|formaction)\s*=\s*)(\\?)(["'])(\/(?!\/)[^"'\\]*)/gi
// `location.href = '/x'`, `window.location = "/x"`, `location.assign('/x')`, `location.replace('/x')`.
const NAV_ASSIGN_RE = /(\blocation(?:\.href)?\s*=\s*)(["'`])(\/(?!\/)[^"'`\\]*)/g
const NAV_CALL_RE = /(\blocation\.(?:assign|replace)\(\s*)(["'`])(\/(?!\/)[^"'`\\]*)/g
// `fetch('/x')`, `new EventSource('/x')`, `xhr.open('POST', '/x')`, `sendBeacon('/x')` (literal first URL).
const CALL_RE = /(\b(?:fetch|EventSource|sendBeacon)\(\s*)(["'`])(\/(?!\/)[^"'`\\]*)/g
const XHR_RE = /(\.open\(\s*["'][A-Za-z]+["']\s*,\s*)(["'`])(\/(?!\/)[^"'`\\]*)/g
// `location.origin + '/x'`
const ORIGIN_JOIN_RE = /(\blocation\.origin\s*\+\s*)(["'`])(\/(?!\/)[^"'`\\]*)/g
// <meta http-equiv="refresh" content="0;url=/x">
const META_REFRESH_RE = /(\burl\s*=\s*)(\/(?!\/)[^"'\s>]*)/gi

/** Client shim: root-relative fetch / XHR / EventSource / sendBeacon / window.open follow the
 *  prefix too, covering URLs held in variables that no static rewrite can see. The prefix is
 *  embedded as a JSON string literal of the validated `/t/<slug>` shape (no escaping hazard). */
function clientShim(prefix: string): string {
  const p = JSON.stringify(prefix)
  return `<script>(function(){var P=${p};window.__MUPOT_BASE=P;` +
    `function f(u){return typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf('\\\\')<0&&u!==P&&u.indexOf(P+'/')!==0&&u.indexOf(P+'?')!==0?P+u:u}` +
    `var F=window.fetch;if(F)window.fetch=function(i,o){return F.call(this,typeof i==='string'?f(i):i,o)};` +
    `var X=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;if(X)XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=f(String(u));return X.apply(this,a)};` +
    `var E=window.EventSource;if(E){window.EventSource=function(u,c){return new E(f(String(u)),c)};window.EventSource.prototype=E.prototype}` +
    `var B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(navigator,f(String(u)),d)};` +
    `var O=window.open;if(O)window.open=function(u){var a=[].slice.call(arguments);if(typeof u==='string')a[0]=f(u);return O.apply(window,a)};` +
    `})();</script>`
}

const JS_SCRIPT_TYPE_RE = /^(?:|text\/javascript|application\/javascript|module)$/i

function rewriteJs(js: string, prefix: string): string {
  const navFix = (_m: string, lead: string, q: string, path: string): string => `${lead}${q}${prefixUrlValue(path, prefix)}`
  return js
    .replace(ATTR_RE, (_m, lead: string, esc: string, q: string, path: string) => `${lead}${esc}${q}${prefixUrlValue(path, prefix)}`)
    .replace(NAV_ASSIGN_RE, navFix).replace(NAV_CALL_RE, navFix).replace(CALL_RE, navFix).replace(XHR_RE, navFix).replace(ORIGIN_JOIN_RE, navFix)
}

function rewriteTag(tag: string, prefix: string): string {
  let out = tag.replace(ATTR_RE, (_m, lead: string, esc: string, q: string, path: string) =>
    `${lead}${esc}${q}${prefixUrlValue(path, prefix)}`)
  if (/^<meta\b/i.test(tag) && /\bhttp-equiv\s*=\s*["']?refresh/i.test(tag)) {
    out = out.replace(META_REFRESH_RE, (_m, lead: string, path: string) => `${lead}${prefixUrlValue(path, prefix)}`)
  }
  return out
}

// One pass over the markup: <pre>/<code>/<textarea> bodies are left alone; <script> bodies get the
// JS rules (JSON/other types are skipped); every other TAG gets attribute rewriting; text content
// between tags is never touched.
const SEGMENT_RE = /(<(pre|code|textarea)\b[^>]*>[\s\S]*?<\/\2\s*>)|(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)|(<[a-zA-Z][^<>]*>)/gi

/** Rewrite an HTML document for a prefixed tenant. Pure string transform on the emitted markup. */
export function rewriteHtmlForPrefix(html: string, prefix: string, injectShim = true): string {
  const out = html.replace(SEGMENT_RE, (...m: string[]) => {
    if (m[1] !== undefined) return m[1]
    if (m[3] !== undefined) {
      const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(m[4] ?? '')?.[1] ?? ''
      const open = rewriteTag(m[3], prefix)
      return `${open}${JS_SCRIPT_TYPE_RE.test(type) ? rewriteJs(m[5], prefix) : m[5]}${m[6]}`
    }
    return rewriteTag(m[7], prefix)
  })
  // Fragments (no document structure) get no shim: the host page owns the document.
  if (!injectShim || !/<!doctype|<html\b|<head\b/i.test(out)) return out
  const shim = clientShim(prefix)
  const tag = /<head(?:\s[^>]*)?>/i.exec(out)
  if (tag !== null) return out.slice(0, tag.index + tag[0].length) + shim + out.slice(tag.index + tag[0].length)
  const html1 = /<html(?:\s[^>]*)?>/i.exec(out)
  if (html1 !== null) return out.slice(0, html1.index + html1[0].length) + shim + out.slice(html1.index + html1[0].length)
  return shim + out
}

/** The response choke point for a prefixed tenant. HTML bodies are rewritten (streams such as
 *  SSE, JSON and binaries are untouched); a root-relative Location gains the prefix. */
export async function applyTenantPrefix(response: Response, prefix: string): Promise<Response> {
  if (response.status === 101) return response
  const location = response.headers.get('location')
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  const isHtml = type.includes('text/html')
  if (location === null && !isHtml) return response
  const headers = new Headers(response.headers)
  // Cache belt-and-braces: the body/Location depends on the prefix header.
  headers.append('vary', TENANT_PREFIX_HEADER)
  if (location !== null) headers.set('location', prefixLocation(location, prefix))
  if (!isHtml || response.body === null) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  // A page with its own CSP would block an un-nonced inline shim; its attributes are still rewritten.
  const body = rewriteHtmlForPrefix(await response.text(), prefix, !response.headers.has('content-security-policy'))
  headers.delete('content-length')
  headers.delete('etag')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Absolute base URL for links that leave the response (emails, Stripe return URLs, OAuth redirect
 * URIs). Unprefixed tenant: the request origin, as before. Prefixed tenant: the operator-pinned
 * PUBLIC_ORIGIN host (the request host of a dispatched tenant is the internal `<slug>.<root>`
 * dispatch address, not a URL a human can open) plus the validated prefix.
 */
export function requestBase(env: { PUBLIC_ORIGIN?: string; TENANT_SLUG?: string }, request: Request): string {
  const reqOrigin = new URL(request.url).origin
  const prefix = tenantPrefixOf(request, env.TENANT_SLUG || 'mumega')
  if (prefix === null) return reqOrigin
  const pinned = env.PUBLIC_ORIGIN?.trim()
  const base = pinned ? pinnedBase(pinned) : null
  if (base !== null) {
    // The operator-pinned base wins when it carries no path (the home tenant reached through its
    // /t/<home> alias keeps the ROOT URLs, e.g. the registered OAuth /auth/callback) or the same
    // prefix (a path-routed pot). A pinned base naming a different prefix is misconfiguration.
    const pinnedPrefix = base.slice(new URL(base).origin.length)
    if (pinnedPrefix === '' || pinnedPrefix === prefix) return base
    return `${new URL(base).origin}${prefix}`
  }
  return `${reqOrigin}${prefix}`
}

/** Operator-pinned PUBLIC_ORIGIN as a base URL: origin plus its validated `/t/<slug>` path, if any. */
export function pinnedBase(pinned: string): string | null {
  let u: URL
  try {
    u = new URL(pinned)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const path = u.pathname.replace(/\/+$/, '')
  const prefix = parseTenantPrefix(path)
  return prefix === null ? u.origin : `${u.origin}${prefix}`
}

/**
 * Which prefix (if any) re-roots the response to this ORIGINAL (pre-rewrite) request. A `/t/<slug>`
 * path always wins over any header, and only the Worker's own home slug is stamped here; any other
 * slug is dispatched and re-rooted by the tenant Worker itself. Otherwise only the validated
 * apex-stamped header counts.
 */
export function responsePrefixFor(original: Request, homeSlug: string): string | null {
  const path = extractPathTenant(new URL(original.url).pathname)
  if (path !== null) return path.slug === homeSlug.toLowerCase() ? `/t/${path.slug}` : null
  return tenantPrefixOf(original, homeSlug)
}
