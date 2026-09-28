#!/usr/bin/env node
// scripts/check-openapi-public-allowlist.mjs — the UNAUTHENTICATED GET /openapi.json must
// never disclose a tool above member capability, and must never disclose a tool that isn't
// in the committed allowlist.
//
// WHY THIS EXISTS (mupot#1596)
//
// openApiSpec() (src/mcp/index.ts) used to walk the ENTIRE `TOOLS` registry — all 144 tools
// — with no filter, and serve it at `GET /openapi.json` with no auth at all (built for the
// Custom GPT Actions facade, which needs unauthenticated discovery). Every tool still
// enforces its own server-side authz (spec.min, checked centrally in invokeTool before run()
// is ever entered), so this was disclosure rather than an access break — but the disclosed
// set included the ENTIRE admin surface by name and input schema: mint_agent_token
// ("minimum capability: admin"), grant_agent_capability, revoke_agent_token,
// revoke_agent_session, archive_row, unarchive_row, addon_archive, and more — a map an
// attacker did not have to earn.
//
// THE FIX has two independent layers (src/mcp/openapi-public-allowlist.ts's module header
// has the full design):
//   1. Runtime: publicToolSpecs() (src/mcp/index.ts) filters TOOLS to
//      { name in PUBLIC_TOOL_ALLOWLIST } AND { min in authenticated|observer|member }.
//   2. This ratchet, which fails the build if either layer can no longer be trusted:
//        a. an allowlisted name is not a real ToolSpec in the registry (stale/typo'd entry);
//        b. an allowlisted name's real `min` is above 'member' (lead/admin/owner) — the
//           allowlist itself would disclose an admin tool if the runtime min-check were ever
//           removed, so this is caught here too, not just at runtime;
//        c. PUBLIC_TOOL_ALLOWLIST is unsorted or has a duplicate (hygiene: a diff that isn't
//           a clean one-line insertion is a signal to look twice);
//        d. the `GET /openapi.json` route handler in src/mcp/index.ts stops calling
//           publicOpenApiSpec() — the only sanctioned way to reach TOOLS from that
//           unauthenticated route. This is the regression that would silently re-open the
//           disclosure even with a perfectly correct allowlist file sitting unused.
//
// SOURCE OF TRUTH FOR "what tools exist and at what capability" — this file does NOT import
// or execute src/mcp/*.ts (these are Workers modules, not portable to plain Node without a
// bundler). Instead, like scripts/check-mcp-tool-seam.mjs, it uses the TypeScript compiler
// API (already a devDependency, pure AST parsing, no execution) to read every
// `const toolXxx: ToolSpec = { name: '...', ..., min: '...', ... }` declaration across
// src/mcp/*.ts. `min` is only ever a string literal in this codebase (verified: every
// non-literal `min:` occurrence is a TYPE annotation, e.g. `min: Capability`, never a value)
// — a `min` computed from an identifier or expression is a shape this ratchet cannot see and
// is treated as UNRESOLVED, which fails the run rather than silently passing (see
// UNRESOLVED_MIN below).
//
// KNOWN GAP, DELIBERATELY LEFT OPEN: src/mcp/routines.ts's `lifecycle(name, operation):
// ToolSpec` factory builds 3 tools (routine_enable, routine_pause, routine_archive) from a
// returned object literal whose `name` property is a shorthand reference to the factory's
// OWN parameter, not a string literal — this extractor does not resolve call-site arguments,
// so these 3 are invisible to the registry built here (verified: 141 resolved vs 144 real
// TOOLS.length, 2026-09-28). This is SAFE, not silently unsafe: all 3 are hardcoded
// `min: 'admin'` inside the factory, so they could never legitimately join the public
// allowlist — and if someone typos one of their names into PUBLIC_TOOL_ALLOWLIST anyway, the
// "unknown tool in allowlist" check below still fires (registry has no such name), failing
// the build rather than silently passing. If a FUTURE factory generates a member-tier tool
// this way, the failure mode is the same fail-safe direction: this ratchet would reject a
// legitimate allowlist addition with "unknown tool" rather than silently permitting an
// unverified one — extend extractToolSpecs to resolve that factory's call sites when that
// day comes, rather than loosening this check.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MCP_DIR = join(ROOT, 'src', 'mcp')
const ALLOWLIST_FILE = join(MCP_DIR, 'openapi-public-allowlist.ts')
const INDEX_FILE = join(MCP_DIR, 'index.ts')
const ALLOWLIST_REL = relative(ROOT, ALLOWLIST_FILE)

const MEMBER_TIER_OR_BELOW = new Set(['authenticated', 'observer', 'member'])
export const UNRESOLVED_MIN = Symbol('unresolved-min')

function scriptKindFor(filePath) {
  return filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
}

/**
 * Extract every `const <name>: ToolSpec = { ... }` declaration in one file's source as
 * { name: <the 'name' property's string value>, min: <the 'min' property's string value, or
 * UNRESOLVED_MIN if it isn't a plain string literal> }. Only DIRECT (depth-1) properties of
 * the object literal are read — a nested `inputSchema.properties.name` or `.min` can never
 * be mistaken for the ToolSpec's own fields, because AST traversal here never descends past
 * matching an object literal's immediate PropertyAssignment list.
 *
 * Pure — no filesystem — so the self-tests can drive it with synthetic source.
 */
export function extractToolSpecs(source, filePath = 'source.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const out = []

  function isToolSpecType(typeNode) {
    return typeNode && ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) &&
      typeNode.typeName.text === 'ToolSpec'
  }

  function stringPropertyValue(obj, key) {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      if (!ts.isIdentifier(prop.name) || prop.name.text !== key) continue
      return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : UNRESOLVED_MIN
    }
    return UNRESOLVED_MIN
  }

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      isToolSpecType(node.type) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const obj = node.initializer
      const name = stringPropertyValue(obj, 'name')
      const min = stringPropertyValue(obj, 'min')
      out.push({
        declName: ts.isIdentifier(node.name) ? node.name.text : '<destructured>',
        name: name === UNRESOLVED_MIN ? null : name,
        min,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Extract a top-level `export const <exportedName>: ... = [ 'a', 'b', ... ]` string array —
 * used for PUBLIC_TOOL_ALLOWLIST. Returns null if not found or if any element isn't a plain
 * string literal (unresolved — fails the run rather than silently reading a partial list).
 * Pure — no filesystem.
 */
export function extractStringArrayExport(source, exportedName, filePath = 'source.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  let found = null

  function visit(node) {
    if (found !== null) return
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== exportedName) continue
        if (!decl.initializer || !ts.isArrayLiteralExpression(decl.initializer)) continue
        const values = []
        for (const el of decl.initializer.elements) {
          if (!ts.isStringLiteralLike(el)) {
            found = { ok: false }
            return
          }
          values.push(el.text)
        }
        found = { ok: true, values }
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * Does src/mcp/index.ts's `GET /openapi.json` route handler call `publicOpenApiSpec(`? This
 * is the structural anti-bypass check: a perfectly correct allowlist is worthless if the
 * route stops using it. Walks the AST for `mcpActionsApp.get('/openapi.json', <arrow>)` and
 * checks the arrow body for a call whose callee identifier is `publicOpenApiSpec`.
 * Pure — no filesystem.
 */
export function publicRouteUsesGuardedSpec(source, filePath = 'index.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  let routeFound = false
  let callsGuarded = false

  function isTargetRouteCall(node) {
    if (!ts.isCallExpression(node)) return false
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return false
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'mcpActionsApp') return false
    const [pathArg] = node.arguments
    return pathArg && ts.isStringLiteralLike(pathArg) && pathArg.text === '/openapi.json'
  }

  function bodyCallsPublicOpenApiSpec(node) {
    let calls = false
    function inner(n) {
      if (calls) return
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'publicOpenApiSpec') {
        calls = true
        return
      }
      ts.forEachChild(n, inner)
    }
    inner(node)
    return calls
  }

  function visit(node) {
    if (isTargetRouteCall(node)) {
      routeFound = true
      const [, handler] = node.arguments
      if (handler) callsGuarded = bodyCallsPublicOpenApiSpec(handler)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { routeFound, callsGuarded }
}

/**
 * The core invariant, as a pure function: given the REAL {name -> {min, file}} registry and
 * the COMMITTED allowlist (array of names), what's wrong? Never touches the filesystem, so
 * the self-tests can mutate a registry Map directly to prove "adding an admin tool to the
 * allowlist must make it fail" without needing a throwaway repo on disk.
 *
 * Returns { unknown, tooHigh, unsorted, duplicates } — each a list (empty = that check
 * passed). `tooHigh` entries are { name, min, file }.
 */
export function validatePublicAllowlist(registry, allowlist) {
  const unknown = allowlist.filter((name) => !registry.has(name))
  const tooHigh = allowlist
    .filter((name) => registry.has(name))
    .map((name) => ({ name, min: registry.get(name).min, file: registry.get(name).file }))
    .filter(({ min }) => !MEMBER_TIER_OR_BELOW.has(min))
  const sorted = [...allowlist].sort()
  const unsorted = !allowlist.every((name, i) => name === sorted[i])
  const duplicates = [...new Set(allowlist.filter((name, i) => allowlist.indexOf(name) !== i))]
  return { unknown, tooHigh, unsorted, duplicates }
}

function listMcpFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  let failed = false

  // ── 1. Build the real {name -> min} registry from every ToolSpec declaration in src/mcp/*.ts ──
  const registry = new Map()
  const unresolved = []
  for (const file of listMcpFiles(MCP_DIR)) {
    const rel = relative(ROOT, file)
    const specs = extractToolSpecs(readFileSync(file, 'utf8'), file)
    for (const spec of specs) {
      if (spec.name === null || spec.min === UNRESOLVED_MIN) {
        unresolved.push({ file: rel, declName: spec.declName })
        continue
      }
      registry.set(spec.name, { min: spec.min, file: rel })
    }
  }

  if (unresolved.length > 0) {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — a ToolSpec declaration has a non-literal `name` or `min`')
    console.error("(this checker only understands plain string literals, per the file's own header):\n")
    for (const u of unresolved) console.error(`  ${u.file}: ${u.declName}`)
    console.error('')
  }

  console.log(`openapi-public-allowlist: ${registry.size} ToolSpec declaration(s) resolved across src/mcp/*.ts.`)

  // ── 2. Read the committed allowlist ──
  const allowlistSource = readFileSync(ALLOWLIST_FILE, 'utf8')
  const allowlistResult = extractStringArrayExport(allowlistSource, 'PUBLIC_TOOL_ALLOWLIST', ALLOWLIST_FILE)
  if (!allowlistResult || !allowlistResult.ok) {
    console.error(`\nCANNOT VERIFY THE RATCHET — could not parse PUBLIC_TOOL_ALLOWLIST as a plain string`)
    console.error(`array from ${ALLOWLIST_REL}.\n`)
    process.exit(1)
  }
  const allowlist = allowlistResult.values
  console.log(`openapi-public-allowlist: ${allowlist.length} tool(s) in the committed allowlist.`)

  // ── 3. The core invariant (pure function — see validatePublicAllowlist for what each
  //      field means and for the self-tests that mutate it directly) ──
  const { unknown, tooHigh, unsorted, duplicates } = validatePublicAllowlist(registry, allowlist)

  if (unknown.length > 0) {
    failed = true
    console.error(`\nUNKNOWN TOOL IN ALLOWLIST — ${ALLOWLIST_REL} names a tool that is not a real ToolSpec`)
    console.error('in src/mcp/*.ts (renamed, removed, or a typo):\n')
    for (const name of unknown) console.error(`  ${name}`)
    console.error('')
  }

  if (tooHigh.length > 0) {
    failed = true
    console.error('\nADMIN-TIER TOOL IN THE PUBLIC ALLOWLIST — this is the exact defect mupot#1596 fixes.')
    console.error(`GET /openapi.json is UNAUTHENTICATED; a tool above 'member' capability must never`)
    console.error(`be reachable from it. Remove these from ${ALLOWLIST_REL}:\n`)
    for (const { name, min, file } of tooHigh) console.error(`  ${name} (min:'${min}', declared in ${file})`)
    console.error('')
  }

  if (unsorted) {
    failed = true
    console.error(`\n${ALLOWLIST_REL}: PUBLIC_TOOL_ALLOWLIST is not sorted. Keep it sorted so a diff`)
    console.error('adding one tool is a clean one-line insertion, not a signal to look twice at.\n')
  }
  if (duplicates.length > 0) {
    failed = true
    console.error(`\n${ALLOWLIST_REL}: PUBLIC_TOOL_ALLOWLIST has duplicate entries: ${duplicates.join(', ')}\n`)
  }

  // ── 3d. Structural anti-bypass: the route must still call publicOpenApiSpec() ──
  const indexSource = readFileSync(INDEX_FILE, 'utf8')
  const { routeFound, callsGuarded } = publicRouteUsesGuardedSpec(indexSource, INDEX_FILE)
  if (!routeFound) {
    failed = true
    console.error("\nCANNOT VERIFY THE RATCHET — mcpActionsApp.get('/openapi.json', ...) was not found in")
    console.error(`${relative(ROOT, INDEX_FILE)}. If this route moved or was renamed, update this ratchet`)
    console.error('to look in the new location — do not delete this check.\n')
  } else if (!callsGuarded) {
    failed = true
    console.error("\nDISCLOSURE REGRESSION — the GET /openapi.json route handler no longer calls")
    console.error('publicOpenApiSpec(). This route is UNAUTHENTICATED: serving anything other than the')
    console.error('allowlist-filtered spec here (e.g. calling openApiSpec(origin, TOOLS, ...) directly)')
    console.error('re-opens the exact disclosure mupot#1596 closed, even with a perfectly correct')
    console.error(`allowlist sitting unused in ${ALLOWLIST_REL}.\n`)
  }

  const publicCount = allowlist.length - unknown.length - tooHigh.length
  console.log(
    `openapi-public-allowlist: ${publicCount} tool(s) would be served publicly ` +
    `(${registry.size} total in the registry).`,
  )

  if (failed) process.exit(1)
}
