#!/usr/bin/env node
// scripts/check-mcp-profile-needs-you.mjs — the curated ChatGPT "needs-you" MCP profile
// (POST /mcp/profile/needs-you, src/mcp/profile-needs-you.ts) must stay READ-ONLY, real and
// annotated. Modeled on scripts/check-openapi-public-allowlist.mjs (same AST registry
// extraction, no execution of src/mcp/*.ts).
//
// Fails when:
//   a. a profile name is not a real ToolSpec in src/mcp/*.ts (stale / typo);
//   b. a profile tool's `min` is above 'member' (lead / admin / owner);
//   c. a profile tool's NAME reads as a write (send, create, update, verdict, grant, mint,
//      revoke, ...). The registry carries no per-tool readOnly flag, so this name check plus
//      the min ceiling IS the mechanical read-only gate; adding a tool to the profile is a
//      reviewed act, and this only stops the obvious mistakes;
//   d. annotations are missing, or are not exactly readOnlyHint:true, destructiveHint:false,
//      openWorldHint:false, with a non-empty title;
//   e. the list is unsorted or has duplicates;
//   f. structural anti-bypass in src/mcp/index.ts: handleJsonRpc must (1) call profileEntry()
//      (the tools/call allowlist refusal) and profileToolList() (the filtered listing), and
//      (2) the '/profile/needs-you' route must call handleJsonRpc with the 'needs-you' mode.
//      Like the openapi ratchet this checks "the guard is called", not "the guard's output is
//      what is served" — tests/mcp-profile-needs-you.test.ts pins behavior.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { extractToolSpecs, UNRESOLVED_MIN } from './check-openapi-public-allowlist.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MCP_DIR = join(ROOT, 'src', 'mcp')
const PROFILE_FILE = join(MCP_DIR, 'profile-needs-you.ts')
const INDEX_FILE = join(MCP_DIR, 'index.ts')
const PROFILE_REL = relative(ROOT, PROFILE_FILE)

const READ_TIERS = new Set(['authenticated', 'observer', 'member'])

// Name tokens (split on '_') that mean a tool mutates or acts. A profile tool containing any
// of these tokens fails. Deliberately broad: a false positive is a one-line review, a false
// negative is a write tool in a ChatGPT-facing read-only profile.
export const WRITE_TOKENS = new Set([
  'send', 'create', 'update', 'verdict', 'grant', 'mint', 'revoke', 'archive', 'unarchive',
  'remember', 'set', 'register', 'dispatch', 'deploy', 'delete', 'remove', 'write', 'submit',
  'approve', 'reject', 'broadcast', 'provision', 'release', 'wake', 'claim', 'reset', 'ack',
  'lease', 'record', 'report', 'publish', 'move', 'add', 'install', 'activate', 'deactivate',
  'disable', 'enable', 'configure', 'pause', 'cancel', 'run', 'answer', 'advance', 'land',
  'reap', 'end', 'bootstrap', 'connect', 'request', 'reveal', 'attest', 'reconcile', 'tick',
  'control', 'accept', 'recommit', 'reintake', 'authorize', 'expand', 'define', 'reverse',
])

function scriptKindFor(filePath) {
  return filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
}

/**
 * Extract `export const NEEDS_YOU_PROFILE: ... = [ { name: '...', annotations: { ... } }, ... ]`.
 * Returns null if the array is missing; entries with non-literal parts get `unresolved: true`
 * (which fails the run rather than being silently skipped). Pure — no filesystem.
 */
export function extractProfileEntries(source, filePath = 'source.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  let found = null

  function literalValue(node) {
    if (ts.isStringLiteralLike(node)) return node.text
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    return UNRESOLVED_MIN
  }
  function objectProps(obj) {
    const out = {}
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return null
      out[prop.name.text] = prop.initializer
    }
    return out
  }

  function visit(node) {
    if (found !== null) return
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== 'NEEDS_YOU_PROFILE') continue
        if (!decl.initializer || !ts.isArrayLiteralExpression(decl.initializer)) continue
        const entries = []
        for (const el of decl.initializer.elements) {
          const entry = { name: null, annotations: null, unresolved: false }
          if (!ts.isObjectLiteralExpression(el)) { entry.unresolved = true; entries.push(entry); continue }
          const props = objectProps(el)
          if (!props) { entry.unresolved = true; entries.push(entry); continue }
          const name = props.name ? literalValue(props.name) : UNRESOLVED_MIN
          if (typeof name !== 'string') entry.unresolved = true
          else entry.name = name
          if (props.annotations && ts.isObjectLiteralExpression(props.annotations)) {
            const ap = objectProps(props.annotations)
            if (!ap) entry.unresolved = true
            else {
              entry.annotations = {}
              for (const [k, v] of Object.entries(ap)) entry.annotations[k] = literalValue(v)
            }
          }
          entries.push(entry)
        }
        found = entries
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * Core invariant as a pure function: (registry Map name -> {min,file}, entries) -> problems.
 * Every field is a list; empty = that check passed.
 */
export function validateProfile(registry, entries) {
  const unresolved = entries.filter((e) => e.unresolved)
  const named = entries.filter((e) => !e.unresolved)
  const names = named.map((e) => e.name)
  const unknown = names.filter((n) => !registry.has(n))
  const tooHigh = names
    .filter((n) => registry.has(n))
    .map((n) => ({ name: n, min: registry.get(n).min, file: registry.get(n).file }))
    .filter(({ min }) => !READ_TIERS.has(min))
  const writeNamed = names.filter((n) => n.split('_').some((tok) => WRITE_TOKENS.has(tok)))
  const badAnnotations = named
    .filter((e) => {
      const a = e.annotations
      return !(
        a &&
        a.readOnlyHint === true &&
        a.destructiveHint === false &&
        a.openWorldHint === false &&
        typeof a.title === 'string' &&
        a.title.trim().length > 0
      )
    })
    .map((e) => e.name)
  const sorted = [...names].sort()
  const unsorted = !names.every((n, i) => n === sorted[i])
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  return { unresolved, unknown, tooHigh, writeNamed, badAnnotations, unsorted, duplicates }
}

/**
 * Structural anti-bypass over src/mcp/index.ts source. Pure — no filesystem.
 * Returns { handlerFound, callsProfileEntry, callsProfileToolList, routeFound, routePassesMode }.
 */
export function checkProfileWiring(source, filePath = 'index.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const r = {
    handlerFound: false,
    callsProfileEntry: false,
    callsProfileToolList: false,
    routeFound: false,
    routePassesMode: false,
  }
  function callsIdent(root, ident) {
    let hit = false
    ;(function inner(n) {
      if (hit) return
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ident) { hit = true; return }
      ts.forEachChild(n, inner)
    })(root)
    return hit
  }
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'handleJsonRpc' && node.body) {
      r.handlerFound = true
      r.callsProfileEntry = callsIdent(node.body, 'profileEntry')
      r.callsProfileToolList = callsIdent(node.body, 'profileToolList')
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'post' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'mcpApp' &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === '/profile/needs-you'
    ) {
      r.routeFound = true
      const handler = node.arguments[1]
      ;(function inner(n) {
        if (
          ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'handleJsonRpc' &&
          n.arguments[2] && ts.isStringLiteralLike(n.arguments[2]) && n.arguments[2].text === 'needs-you'
        ) r.routePassesMode = true
        ts.forEachChild(n, inner)
      })(handler)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return r
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  let failed = false
  const fail = (msg) => { failed = true; console.error(msg) }

  const registry = new Map()
  for (const f of readdirSync(MCP_DIR).filter((x) => x.endsWith('.ts'))) {
    const file = join(MCP_DIR, f)
    for (const spec of extractToolSpecs(readFileSync(file, 'utf8'), file)) {
      if (spec.name === null || spec.min === UNRESOLVED_MIN) continue
      registry.set(spec.name, { min: spec.min, file: relative(ROOT, file) })
    }
  }

  const entries = extractProfileEntries(readFileSync(PROFILE_FILE, 'utf8'), PROFILE_FILE)
  if (!entries) {
    console.error(`CANNOT VERIFY — could not find NEEDS_YOU_PROFILE array in ${PROFILE_REL}`)
    process.exit(1)
  }
  console.log(`mcp-profile-needs-you: ${entries.length} profile tool(s); ${registry.size} ToolSpec(s) resolved.`)

  const v = validateProfile(registry, entries)
  if (v.unresolved.length) fail(`\nUNRESOLVED PROFILE ENTRY — ${PROFILE_REL} has ${v.unresolved.length} entry(ies) that are not plain { name: '<literal>', annotations: { literal booleans/strings } } objects.`)
  if (v.unknown.length) fail(`\nUNKNOWN TOOL IN PROFILE — not a ToolSpec in src/mcp/*.ts: ${v.unknown.join(', ')}`)
  for (const t of v.tooHigh) fail(`\nTOO-HIGH TOOL IN PROFILE — ${t.name} has min:'${t.min}' (${t.file}); the profile is read-only, member tier or below.`)
  if (v.writeNamed.length) fail(`\nWRITE-SHAPED TOOL IN READ-ONLY PROFILE — ${v.writeNamed.join(', ')}. v1 has no write tools (approvals need a harness-attested human origin).`)
  if (v.badAnnotations.length) fail(`\nBAD ANNOTATIONS — every profile tool needs readOnlyHint:true, destructiveHint:false, openWorldHint:false and a title: ${v.badAnnotations.join(', ')}`)
  if (v.unsorted) fail(`\n${PROFILE_REL}: NEEDS_YOU_PROFILE is not sorted by name.`)
  if (v.duplicates.length) fail(`\n${PROFILE_REL}: duplicate entries: ${v.duplicates.join(', ')}`)

  const w = checkProfileWiring(readFileSync(INDEX_FILE, 'utf8'), INDEX_FILE)
  if (!w.handlerFound) fail('\nCANNOT VERIFY — function handleJsonRpc not found in src/mcp/index.ts.')
  else {
    if (!w.callsProfileEntry) fail('\nBYPASS REGRESSION — handleJsonRpc no longer calls profileEntry(): tools/call on the profile would execute non-allowlisted tools.')
    if (!w.callsProfileToolList) fail('\nBYPASS REGRESSION — handleJsonRpc no longer calls profileToolList(): the profile tools/list would not be the allowlist.')
  }
  if (!w.routeFound) fail("\nCANNOT VERIFY — mcpApp.post('/profile/needs-you', ...) not found in src/mcp/index.ts.")
  else if (!w.routePassesMode) fail("\nBYPASS REGRESSION — the '/profile/needs-you' route no longer calls handleJsonRpc(c, body, 'needs-you').")

  if (failed) { console.error('\nmcp-profile-needs-you: FAILED'); process.exit(1) }
  console.log('mcp-profile-needs-you: OK — profile tools exist, are member-tier-or-below, not write-named, annotated read-only; guards wired.')
}
