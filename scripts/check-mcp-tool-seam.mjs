#!/usr/bin/env node
// scripts/check-mcp-tool-seam.mjs — a test that exercises an MCP tool must enter through
// invokeTool, never call a ToolSpec's run() directly.
//
// WHY THIS EXISTS
//
// mupot#1289 round 1: a self lane was added inside update_agent's run() while `min: 'admin'`
// stayed on the tool. spec.min is enforced centrally in invokeTool (src/mcp/index.ts), BEFORE
// run() is ever entered — it is the chokepoint every real caller (JSON-RPC tools/call, the
// mcpApp HTTP surface) is forced through. All 9 new tests called `toolUpdateAgent.run(...)`
// directly, which skips that chokepoint entirely: 72/72 green, the feature unreachable in
// production for exactly the population it targeted. Caught only by an adversarial A/B that
// went through invokeTool instead. Same class as #684 (schema doubles) and the reason
// check-test-schema-source.mjs exists: a test that looks strong while proving nothing about
// the path production callers actually take.
//
// THE RULE
//
//   A test that calls `.run(` on an MCP tool object must reach it through invokeTool
//   (`src/mcp/index.ts`), not by calling the ToolSpec's run() method directly.
//
// WHAT COUNTS AS "an MCP tool object" — this is the part a naive `grep '\.run('` gets wrong.
// `.run(` also appears on D1 statements (`db.prepare(...).run()`), Cloudflare Workflows
// (`workflow.run(...)`), and elsewhere with nothing to do with MCP tools. So this scans
// imports and simple data flow instead of grepping blindly:
//
//   1. Anything imported (as a VALUE) from a module path under src/mcp/ is a seam value —
//      `TOOLS`, `PROVISION_TOOLS`, a directly-imported tool constant, etc.
//   2. Anything imported (as a TYPE) named like `ToolSpec` from src/mcp/ taints any variable
//      or parameter explicitly annotated with that type — this is how
//      `async function isGuarded(tool: ToolSpec, env: Env)` gets caught even though `tool`
//      itself was never imported.
//   3. Taint propagates through simple assignment, `.find()`/`.filter()` chains, array
//      literals (including spreads), and `for (const x of SEAM_VALUE)` loops — this is how
//      `const toolSend = TOOLS.find(t => t.name === 'send')!` and
//      `for (const tool of PROVISION_TOOLS) { tool.run(...) }` are both caught even though
//      `toolSend` / `tool` are local variables, not imports.
//
// A call `<expr>.run(` is a violation exactly when the root identifier of `<expr>` — walking
// through property/element access, calls, `!`, `as`, and parens — is in the tainted set.
//
// ON THE BASELINE — same contract as test-schema-source.mjs, and for the same reason: a hard
// gate cannot land with pre-existing offenders in the tree (provision-tools.test.ts's
// registry sweep is one — it legitimately needs `tool.run()` with empty args to prove EVERY
// registered tool is guarded, a property that can't be expressed by naming tools one at a
// time). So there is a baseline, and it is honest about what it is:
//
//   - it can only SHRINK. Removing a file is a normal PR; adding one fails the check.
//   - the count is PRINTED on every run, so it cannot quietly grow.
//   - a baselined file that has since stopped violating is ALSO an error, so the list cannot
//     rot into a permanent exemption for files that no longer need it.
//
// ESCAPE HATCH: a `// seam-exempt: <reason>` comment on the same line as the `.run(` call, or
// on the line directly above it, exempts that one call — and every exemption is printed
// (file:line + reason) on every run, so a reviewer sees the full list without hunting for it.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'mcp-tool-seam-baseline.json')

// ONE violating class today (direct `.run()` on a tool reached other than via invokeTool),
// kept as an array — like test-schema-source's CLASSES — so a second class (a different
// bypass shape) can be added later with the same shrink-only, independently-compared
// contract, rather than needing a rewrite.
const CLASSES = ['files']
const baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const baselines = Object.fromEntries(
  CLASSES.map((c) => [c, new Set(baselineFile[c] ?? [])]),
)

/**
 * MECHANICAL NON-GROWTH PIN. Enforced by comparing against the baseline on the MERGE TARGET,
 * not against a number committed next to the list it constrains — a PR cannot grow the list
 * because the thing it is measured against is not in the PR. See
 * scripts/check-test-schema-source.mjs for the full rationale; this is the identical
 * mechanism, unchanged.
 */
function baselineSizeOnTarget() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'

  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: ROOT, stdio: 'ignore',
    })
  } catch {
    return { state: 'unreadable' }
  }

  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/mcp-tool-seam-baseline.json`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    return {
      state: 'compared',
      sizes: Object.fromEntries(
        CLASSES.map((c) => [c, Array.isArray(parsed[c]) ? parsed[c].length : null]),
      ),
    }
  } catch {
    return { state: 'bootstrap' }
  }
}

/**
 * Files that exist on the merge target, or null if it cannot be read. A baselined file that
 * is not on the target was introduced by THIS PR, and therefore is not pre-existing debt —
 * closes the seeding-window bypass (see check-test-schema-source.mjs mutation M2, the exact
 * same hole in the exact same shape of ratchet).
 */
function targetFileSet() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'tests/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(raw.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) out.push(full)
  }
  return out
}

// A module specifier reaches into the MCP seam surface: '../src/mcp', '../src/mcp/index',
// '../../src/mcp/provision', etc. Deliberately NOT 'src/mcpwp' or similar — requires the
// path segment to be exactly `mcp` followed by `/` or end of string.
const SEAM_MODULE = /(^|\/)src\/mcp(\/|$)/

const SEAM_EXEMPT_RE = /\/\/\s*seam-exempt:\s*(.+?)\s*$/

function scriptKindFor(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/** Unwrap parens / `!` / `as X` wrappers that don't change what's being referenced. */
function unwrap(expr) {
  while (
    expr && (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr))
  ) {
    expr = expr.expression
  }
  return expr
}

/** The leftmost identifier of a property/element/call access chain, or null. */
function rootIdentifierOf(expr) {
  expr = unwrap(expr)
  if (!expr) return null
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return rootIdentifierOf(expr.expression)
  if (ts.isElementAccessExpression(expr)) return rootIdentifierOf(expr.expression)
  if (ts.isCallExpression(expr)) return rootIdentifierOf(expr.expression)
  if (ts.isSpreadElement(expr)) return rootIdentifierOf(expr.expression)
  return null
}

/** Does this initializer expression flow from a tainted identifier? Array literals (incl.
 * spreads) are tainted if ANY element's root identifier is tainted, so
 * `[...PROVISION_TOOLS, extra]` taints the whole array even though `extra` is local. */
function initializerIsTainted(expr, tainted) {
  const e = unwrap(expr)
  if (!e) return false
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.some((el) => {
      const inner = ts.isSpreadElement(el) ? el.expression : el
      const root = rootIdentifierOf(inner)
      return root !== null && tainted.has(root)
    })
  }
  const root = rootIdentifierOf(e)
  return root !== null && tainted.has(root)
}

/** Does a type annotation reference one of the tainted type names anywhere inside it —
 * covers `ToolSpec`, `ToolSpec[]`, `Array<ToolSpec>`, `ReadonlyArray<ToolSpec>`. */
function typeAnnotationReferencesTainted(typeNode, typeNames) {
  let found = false
  function visit(n) {
    if (found) return
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && typeNames.has(n.typeName.text)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(typeNode)
  return found
}

/**
 * Scan one file's source for seam-bypass violations.
 *
 * Returns { violations: [{ line, snippet }], exemptions: [{ line, reason }] }, both 1-based
 * lines. Pure — does no I/O, exported for the self-tests to drive directly with synthetic
 * source rather than through the filesystem/git-scaffold pins.
 */
export function scanSource(filePath, source) {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const lines = source.split('\n')

  const seamValueNames = new Set()
  const seamTypeNames = new Set()

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!SEAM_MODULE.test(stmt.moduleSpecifier.text)) continue
    const clause = stmt.importClause
    if (!clause) continue
    const typeOnlyImport = clause.isTypeOnly === true
    if (clause.name) {
      (typeOnlyImport ? seamTypeNames : seamValueNames).add(clause.name.text)
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        (typeOnlyImport ? seamTypeNames : seamValueNames).add(clause.namedBindings.name.text)
      } else if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const isElementTypeOnly = typeOnlyImport || el.isTypeOnly === true
          const target = isElementTypeOnly ? seamTypeNames : seamValueNames
          target.add(el.name.text)
        }
      }
    }
  }

  if (seamValueNames.size === 0 && seamTypeNames.size === 0) {
    return { violations: [], exemptions: [] }
  }

  // Fixed-point taint propagation: variable declarations (by initializer or by a type
  // annotation naming a seam type), function/arrow parameters (by type annotation), and
  // for-of loop bindings (by the iterated expression). A handful of passes is plenty for
  // test-file-sized ASTs — propagation chains here run at most 2-3 hops deep in practice.
  const tainted = new Set(seamValueNames)
  let changed = true
  let guard = 0
  while (changed && guard < 8) {
    changed = false
    guard += 1
    ;(function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const name = node.name.text
        if (!tainted.has(name)) {
          if (node.type && typeAnnotationReferencesTainted(node.type, seamTypeNames)) {
            tainted.add(name)
            changed = true
          } else if (node.initializer && initializerIsTainted(node.initializer, tainted)) {
            tainted.add(name)
            changed = true
          }
        }
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const name = node.name.text
        if (!tainted.has(name) && node.type && typeAnnotationReferencesTainted(node.type, seamTypeNames)) {
          tainted.add(name)
          changed = true
        }
      }
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) {
          if (ts.isIdentifier(decl.name) && !tainted.has(decl.name.text)) {
            if (initializerIsTainted(node.expression, tainted)) {
              tainted.add(decl.name.text)
              changed = true
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    })(sf)
  }

  function exemptionFor(node) {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line // 0-based
    const sameLine = lines[line] ?? ''
    const aboveLine = line > 0 ? lines[line - 1] ?? '' : ''
    const same = sameLine.match(SEAM_EXEMPT_RE)
    if (same) return same[1]
    const above = aboveLine.match(SEAM_EXEMPT_RE)
    if (above) return above[1]
    return null
  }

  const violations = []
  const exemptions = []

  ;(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'run'
    ) {
      const root = rootIdentifierOf(node.expression.expression)
      if (root !== null && tainted.has(root)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const reason = exemptionFor(node)
        if (reason) {
          exemptions.push({ line, reason })
        } else {
          violations.push({ line, snippet: (lines[line - 1] ?? '').trim() })
        }
      }
    }
    ts.forEachChild(node, visit)
  })(sf)

  return { violations, exemptions }
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  const offenders = { files: [] }
  const violating = { files: new Set() }
  const allExemptions = []

  for (const file of walk(TESTS_DIR)) {
    const rel = relative(ROOT, file)
    const { violations, exemptions } = scanSource(file, readFileSync(file, 'utf8'))
    for (const ex of exemptions) allExemptions.push({ file: rel, ...ex })
    if (violations.length === 0) continue
    violating.files.add(rel)
    if (!baselines.files.has(rel)) offenders.files.push({ file: rel, violations })
  }

  const staleBaseline = Object.fromEntries(
    CLASSES.map((c) => [c, [...baselines[c]].filter((rel) => !violating[c].has(rel)).sort()]),
  )

  const target = baselineSizeOnTarget()
  for (const c of CLASSES) {
    const remaining = baselines[c].size - staleBaseline[c].length
    const note =
      target.state === 'compared' && target.sizes[c] !== null ? `, target ${target.sizes[c]}`
      : target.state === 'compared' ? ', target none (new class, seeding)'
      : target.state === 'bootstrap' ? ', target none (bootstrap)'
      : ''
    console.log(
      `mcp-tool-seam [${c}]: ${remaining} file(s) calling a tool's .run() directly ` +
      `(baseline ${baselines[c].size}${note}).`,
    )
  }

  console.log(`mcp-tool-seam: ${allExemptions.length} seam-exempt call(s) in the tree.`)
  for (const ex of allExemptions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${ex.file}:${ex.line} — ${ex.reason}`)
  }

  let failed = false

  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.')
    console.error('Failing rather than passing: a ratchet that disengages when it cannot read')
    console.error('git is exactly the silent-exemption defect it exists to prevent.\n')
  } else if (target.state === 'compared') {
    for (const c of CLASSES) {
      if (target.sizes[c] !== null && baselines[c].size > target.sizes[c]) {
        failed = true
        console.error(`\nBASELINE [${c}] GREW: ${target.sizes[c]} -> ${baselines[c].size}. It may only shrink.`)
        console.error('Appending a file here is not a fix. Route the test through invokeTool')
        console.error('(src/mcp/index.ts) and remove its entry instead.\n')
      }
    }
  }

  for (const c of CLASSES) {
    if (offenders[c].length === 0) continue
    failed = true
    console.error(`\nNEW VIOLATION [${c}] — a test may not call a tool's .run() directly; go through`)
    console.error('invokeTool(auth, env, toolName, args, ctx) from src/mcp/index.ts instead:\n')
    for (const { file, violations } of offenders[c]) {
      for (const v of violations) console.error(`  ${file}:${v.line}  ${v.snippet}`)
    }
    console.error('')
    console.error('spec.min is enforced centrally in invokeTool, BEFORE run() is entered. A test')
    console.error("that calls .run() directly skips that chokepoint, so a lane can be dead in")
    console.error('production behind spec.min while every test calling .run() stays green (mupot#1289).')
    console.error('If invokeTool genuinely cannot be used here, add a same-line or line-above comment')
    console.error('`// seam-exempt: <reason>` — it will be printed on every run, not hidden.')
    console.error('The baseline is a ratchet: it may shrink, never grow.\n')
  }

  const onTarget = targetFileSet()
  if (onTarget !== null) {
    for (const c of CLASSES) {
      const smuggled = [...baselines[c]].filter((rel) => !onTarget.has(rel)).sort()
      if (smuggled.length === 0) continue
      failed = true
      console.error(`\nBASELINED FILE IS NEW [${c}] — these are not on the merge target, so they`)
      console.error('are not pre-existing debt and cannot be baselined:\n')
      for (const f of smuggled) console.error(`  ${f}`)
      console.error('\nA baseline records debt that already existed. Route the new test through')
      console.error('invokeTool instead.\n')
    }
  }

  for (const c of CLASSES) {
    if (staleBaseline[c].length === 0) continue
    failed = true
    console.error(`\nSTALE BASELINE [${c}] — these files no longer violate and must be removed from`)
    console.error(`${relative(ROOT, BASELINE_PATH)}:\n`)
    for (const f of staleBaseline[c]) console.error(`  ${f}`)
    console.error('\nLeaving a fixed file in the baseline turns a ratchet into an exemption.\n')
  }

  // WHAT THIS DOES NOT CATCH — stated rather than implied, same honesty note as
  // check-test-schema-source.mjs. This is a syntactic scan, not a type checker: it does not
  // resolve module boundaries beyond string-matching the specifier, does not follow a value
  // through a function call's return (`const t = getTool(); t.run(...)` is invisible unless
  // `t` is separately typed as a seam type), and does not follow destructuring patterns
  // (`for (const { tool } of x)`). It also only recognizes the `.run()` bypass shape, not
  // every conceivable way to reach a tool handler outside invokeTool. It catches the shape
  // #1289 actually shipped, and the shapes reachable by the same simple propagation. A
  // determined author can still evade it. The RATCHET — comparing the committed list against
  // the merge target's list — is what makes deliberate growth impossible regardless.

  process.exit(failed ? 1 : 0)
}
