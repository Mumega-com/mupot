#!/usr/bin/env node
// scripts/check-effectful-tools-dry-run.mjs — an MCP tool that takes a `dry_run` argument AND
// writes state must DEFAULT to the dry run. Calling it with no `dry_run` must plan, never act.
//
// WHY THIS EXISTS
//
// A real incident (router_tick, mupot#1780): an operator call that omitted `dry_run` assigned 24
// tasks and queued 24 messages that could not be recalled. The fix there made the tool default
// to a dry run; nothing stopped the next effectful tool with a `dry_run` arg from defaulting the
// other way. This ratchet makes "default is the dry run" a build property, not a habit.
//
// WHAT IT CHECKS (read from src/mcp/*.ts with the TypeScript compiler API; nothing is executed,
// and comments and string contents are NOT code, so prose cannot satisfy or trip a check):
//
//   For every `const toolXxx: ToolSpec = { ... }` whose inputSchema declares a `dry_run`
//   property, and whose annotation row in src/mcp/tool-annotations.ts is anything but a pure
//   read (RO / ROX — or the row is missing, which fails closed):
//     1. every use of `args.dry_run` inside the spec must be a comparison against the literal
//        `false` (`=== false`, `!== false`). A comparison against `true`, a truthiness test, a
//        `??` / `||` default, or passing the value along is a default the ratchet cannot prove
//        is the dry run, and fails. Comparisons against `undefined` / `null` and `typeof` are
//        shape validation, not defaults, and are ignored.
//     2. at least one such `false` comparison must exist (a tool that never reads the arg back
//        has no provable default).
//     3. the inputSchema property must not declare `default: false`.
//   And: a `dry_run` schema property that does not belong to any recognised ToolSpec
//   declaration (a factory-built tool, a spread) fails as UNATTRIBUTED rather than passing
//   unseen.
//
// ALLOW-LIST: a tool may be exempted ONLY by a named entry in ALLOW below WITH a justification.
// An entry whose tool no longer exists, or that would pass without the exemption, is itself an
// error, so the list cannot rot into permanent cover.
//
// SCOPE: MCP tools only. HTTP routes with a dry-run switch are separate surfaces.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MCP_DIR = join(ROOT, 'src', 'mcp')
const ANNOTATIONS_FILE = join(MCP_DIR, 'tool-annotations.ts')

// tool name -> why defaulting to the effectful path is acceptable. Intentionally empty: every
// effectful dry_run tool today (router_tick, seed_attach) defaults to the dry run.
export const ALLOW = new Map([])

const READ_ONLY_ROW_KINDS = new Set(['RO', 'ROX'])

function scriptKindFor(filePath) {
  return filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
}

function isToolSpecDecl(node) {
  return (
    ts.isVariableDeclaration(node) &&
    node.type && ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'ToolSpec' &&
    node.initializer && ts.isObjectLiteralExpression(node.initializer)
  )
}

function propName(prop) {
  if (!prop.name) return null
  if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) return prop.name.text
  return null
}

function directProp(obj, key) {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propName(prop) === key) return prop.initializer
  }
  return null
}

const isLit = (node, kind) => node.kind === kind
const isFalse = (n) => isLit(n, ts.SyntaxKind.FalseKeyword)
const isTrue = (n) => isLit(n, ts.SyntaxKind.TrueKeyword)
const isNullish = (n) =>
  n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined')

function skipParens(node) {
  let n = node
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent
  return n
}

/** Is this node a read of the caller's dry_run argument (`args.dry_run`, `args['dry_run']`)? */
function isDryRunRead(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'dry_run'
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'dry_run'
  }
  return false
}

/**
 * Classify one read of dry_run by how it is used.
 *   'default-dry'   compared against the literal false (=== / !==)
 *   'ignore'        shape validation: typeof, or compared against undefined/null
 *   'bad:<why>'     anything else
 */
function classifyUse(read) {
  const node = skipParens(read)
  const parent = node.parent
  if (parent && ts.isTypeOfExpression(parent)) return 'ignore'
  if (parent && ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind
    const other = parent.left === node ? parent.right : parent.left
    const cmp = [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ]
    if (cmp.includes(op)) {
      const o = skipParens(other)
      if (isFalse(o)) return 'default-dry'
      if (isTrue(o)) return 'bad:compared-to-true'
      if (isNullish(o)) return 'ignore'
      return 'bad:compared-to-other'
    }
    if (
      op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) return 'bad:defaulting-or-truthiness-operator'
  }
  return 'bad:other-use'
}

/**
 * Analyse one source file. Pure. Returns
 *   { tools: [{ name, schemaDefault, uses: string[] }], unattributed: number }
 * for every ToolSpec declaration that declares a dry_run schema property, plus a count of dry_run
 * schema properties that sit outside any ToolSpec declaration.
 */
export function analyzeToolSource(source, filePath = 'source.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const tools = []
  let attributedSchemaProps = 0
  let allSchemaProps = 0

  function schemaDryRunProp(spec) {
    const schema = directProp(spec, 'inputSchema')
    if (!schema || !ts.isObjectLiteralExpression(schema)) return null
    const props = directProp(schema, 'properties')
    if (!props || !ts.isObjectLiteralExpression(props)) return null
    for (const p of props.properties) {
      if (ts.isPropertyAssignment(p) && propName(p) === 'dry_run') return p
    }
    return null
  }

  function visit(node) {
    if (isToolSpecDecl(node)) {
      const spec = node.initializer
      const nameInit = directProp(spec, 'name')
      const name = nameInit && ts.isStringLiteralLike(nameInit) ? nameInit.text : null
      const dryProp = schemaDryRunProp(spec)
      if (dryProp) {
        attributedSchemaProps++
        let schemaDefault = null
        if (ts.isObjectLiteralExpression(dryProp.initializer)) {
          const d = directProp(dryProp.initializer, 'default')
          if (d) schemaDefault = isFalse(d) ? false : isTrue(d) ? true : 'other'
        }
        const uses = []
        const scan = (n) => {
          if (isDryRunRead(n)) uses.push(classifyUse(n))
          ts.forEachChild(n, scan)
        }
        scan(spec)
        tools.push({ name, schemaDefault, uses })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Count every `dry_run:` property assignment that is a child of a `properties` object, to catch
  // schemas the declaration walk above did not attribute to a ToolSpec.
  function countAll(node) {
    if (
      ts.isPropertyAssignment(node) && propName(node) === 'dry_run' &&
      node.parent && ts.isObjectLiteralExpression(node.parent) &&
      node.parent.parent && ts.isPropertyAssignment(node.parent.parent) &&
      propName(node.parent.parent) === 'properties'
    ) allSchemaProps++
    ts.forEachChild(node, countAll)
  }
  countAll(sf)

  return { tools, unattributed: Math.max(0, allSchemaProps - attributedSchemaProps) }
}

/**
 * Parse the annotation table: tool name -> row constructor kind (RO, ROX, ADD, ADDX, MUT, MUTX, or
 * 'row' for a raw row(...) call). Pure.
 */
export function parseAnnotationKinds(source, filePath = 'tool-annotations.ts') {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const kinds = new Map()
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === 'TOOL_ANNOTATION_ROWS' && node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue
        const name = propName(p)
        if (!name) continue
        const init = p.initializer
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) kinds.set(name, init.expression.text)
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return kinds
}

/**
 * Core invariant: (analysis results, annotation kinds, allow-list) -> problems. Pure.
 * Every field is a list; all empty means the check passed.
 */
export function validate(analyses, kinds, allow = ALLOW) {
  const problems = []
  const seen = new Set()
  for (const a of analyses) {
    for (const t of a.tools) {
      seen.add(t.name)
      const label = `${a.file}:${t.name ?? '<unnamed>'}`
      if (t.name === null) { problems.push(`${label}: tool name is not a string literal`); continue }
      const kind = kinds.get(t.name)
      if (kind === undefined) {
        problems.push(`${label}: no annotation row in tool-annotations.ts, cannot tell whether it writes`)
        continue
      }
      if (READ_ONLY_ROW_KINDS.has(kind)) {
        if (allow.has(t.name)) problems.push(`${label}: allow-listed but read-only; remove the allow entry`)
        continue
      }
      const issues = []
      if (t.schemaDefault === false) issues.push('inputSchema declares default:false for dry_run')
      for (const u of t.uses) if (u.startsWith('bad:')) issues.push(`dry_run read as ${u.slice(4)}`)
      if (!t.uses.includes('default-dry')) issues.push('no comparison of dry_run against false: the default cannot be proven')
      const unique = [...new Set(issues)]
      if (allow.has(t.name)) {
        if (unique.length === 0) problems.push(`${label}: allow-listed but already compliant; remove the allow entry`)
      } else {
        for (const i of unique) problems.push(`${label}: effectful tool (${kind}) defaults to acting: ${i}`)
      }
    }
    if (a.unattributed > 0) {
      problems.push(`${a.file}: ${a.unattributed} dry_run schema property(ies) not attached to a recognised ToolSpec declaration`)
    }
  }
  for (const name of allow.keys()) {
    if (!seen.has(name)) problems.push(`allow-list entry "${name}" matches no tool with a dry_run argument; remove it`)
  }
  return problems
}

function listMcpFiles() {
  return readdirSync(MCP_DIR).filter((f) => f.endsWith('.ts')).sort().map((f) => join(MCP_DIR, f))
}

function main() {
  const kinds = parseAnnotationKinds(readFileSync(ANNOTATIONS_FILE, 'utf8'))
  const analyses = listMcpFiles().map((file) => ({
    file: relative(ROOT, file),
    ...analyzeToolSource(readFileSync(file, 'utf8'), file),
  }))
  const problems = validate(analyses, kinds)
  const found = analyses.flatMap((a) => a.tools.map((t) => t.name)).filter(Boolean)
  console.log(`effectful-tools-dry-run: ${found.length} tool(s) declare dry_run: ${found.join(', ') || '(none)'}`)
  if (problems.length > 0) {
    for (const p of problems) console.error(`  FAIL ${p}`)
    console.error('\neffectful-tools-dry-run: FAILED')
    process.exit(1)
  }
  console.log('effectful-tools-dry-run: ok')
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()
