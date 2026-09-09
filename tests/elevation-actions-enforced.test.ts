// tests/elevation-actions-enforced.test.ts
//
// An authorization vocabulary is a FALSE-AUTHORITY SURFACE until every key has
// a consumer.
//
// Six of the eight ELEVATION_ACTIONS shipped with zero enforcement branches.
// Measured on the pre-fix branch: request action:project_lifecycle on a squad,
// have a human approve it, and hasElevatedAction returns granted:true — the
// grant is real, live, scope-matched, and renders on the dashboard with a
// countdown and an effect badge. Then project_create returns 403 need:'admin'.
// The operator believes they granted something. They granted nothing.
//
// That is worse than an unimplemented feature: an approval screen that makes a
// promise the system never keeps teaches the operator to trust the screen.
//
// So `enforced` is a declared property of each action, and this file holds it to
// the source in BOTH directions:
//
//   enforced: true  with no consumer  -> the false-authority bug above
//   enforced: false with a consumer   -> the action silently became real
//                                        without becoming requestable, so the
//                                        enforcement branch is dead code
//
// Both are failures, and the second is the one a well-meaning wiring commit
// causes when it forgets the flag.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ELEVATION_ACTIONS,
  ALL_ELEVATION_ACTION_KEYS,
  REQUESTABLE_ELEVATION_ACTION_KEYS,
} from '../src/auth/elevation-actions'

const SRC_DIR = join(__dirname, '..', 'src')
const DEFINITION_FILE = join('auth', 'elevation-actions.ts')
/** hasElevatedAction is DECLARED here, so its own parameter list (`action:
 *  string`) matches the call-site pattern. Excluded as a caller; it is the
 *  callee. */
const ELEVATION_IMPL_FILE = join('auth', 'elevation.ts')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('schema-chain')) out.push(full)
  }
  return out
}

/** Source with comments removed. A first version of this file searched raw text,
 *  and an adversarial pass drove a mutation straight through it: flip an action to
 *  enforced:true, add `// TODO: someday wire 'action:deploy' here` anywhere in
 *  src/, and the action became requestable and approvable while authorizing
 *  nothing — the exact false-authority bug this file exists to prevent, waved
 *  through by a comment. Enforcement is code; comments are not evidence of it. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** Every `hasElevatedAction(...)` call site in src/, with the action argument as
 *  written. mupot passes it positionally: (env, auth, action, scopeType, scopeId). */
function elevationCallSites(): Array<{ file: string; actionArg: string }> {
  const out: Array<{ file: string; actionArg: string }> = []
  for (const file of tsFiles(SRC_DIR)) {
    const rel = file.slice(file.indexOf('src/') + 4)
    if (rel === DEFINITION_FILE || rel === ELEVATION_IMPL_FILE) continue
    const code = codeOf(file)
    const re = /hasElevatedAction\s*\(\s*[^,]+,\s*[^,]+,\s*([^,]+),/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) out.push({ file: rel, actionArg: m[1].trim() })
  }
  return out
}

/** Files that ENFORCE this action — i.e. pass it to hasElevatedAction. Not files
 *  that merely mention it. The dashboard renders keys generically via
 *  ELEVATION_ACTIONS[...] and never names one, so it correctly never counts. */
function consumersOf(action: string): string[] {
  return elevationCallSites()
    .filter((c) => c.actionArg === `'${action}'` || c.actionArg === `"${action}"`)
    .map((c) => c.file)
}

describe('every elevation action is enforced exactly as it is declared', () => {
  it('the walker actually reads source (anti-vacuity)', () => {
    // A zero-file walk would make every case below trivially true.
    expect(tsFiles(SRC_DIR).length).toBeGreaterThan(50)
    // And the definition file must be excluded, or every action self-matches.
    expect(consumersOf('action:mint_token')).not.toContain(DEFINITION_FILE)
  })

  it.each(ALL_ELEVATION_ACTION_KEYS)('%s — enforced flag matches reality', (action) => {
    const declared = ELEVATION_ACTIONS[action].enforced
    const consumers = consumersOf(action)
    if (declared) {
      expect(
        consumers,
        `${action} is declared enforced but no file consults it — approving it would authorize nothing`,
      ).not.toEqual([])
    } else {
      expect(
        consumers,
        `${action} has consumers ${JSON.stringify(consumers)} but is declared unenforced, so it cannot be requested — that enforcement branch is dead code`,
      ).toEqual([])
    }
  })

  it('every hasElevatedAction call site names its action as a STRING LITERAL', () => {
    // The scan above is only complete if the action argument is always readable
    // statically. A call site passing a constant, a variable, or a template
    // would enforce an action while contributing no literal — so the action
    // could stay declared unenforced (and unrequestable) with live enforcement
    // behind it, which is dead code, or be silently enforced under a key nobody
    // audited. Rather than try to resolve such an expression, refuse it: this is
    // a small, closed set of call sites and keeping them literal costs nothing.
    const sites = elevationCallSites()
    expect(sites.length, 'no call sites found — the scan is blind').toBeGreaterThan(0)
    const nonLiteral = sites.filter((c) => !/^'[^']+'$|^"[^"]+"$/.test(c.actionArg))
    expect(nonLiteral, 'non-literal action argument defeats the enforcement scan').toEqual([])
  })

  it('only enforced actions are requestable', () => {
    const expected = ALL_ELEVATION_ACTION_KEYS.filter((k) => ELEVATION_ACTIONS[k].enforced)
    expect([...REQUESTABLE_ELEVATION_ACTION_KEYS].sort()).toEqual([...expected].sort())
  })

  it('at least one action is requestable — an empty vocabulary would pass everything above', () => {
    expect(REQUESTABLE_ELEVATION_ACTION_KEYS.length).toBeGreaterThan(0)
  })

  it('the goal actions a squad lead needs are both enforced', () => {
    // The two Hadi named: "make their own agents and project, nothing outside".
    // mint_token issues the agent's credential; project_lifecycle creates the
    // squad/project. If either regresses to unenforced, that scenario silently
    // stops working while every other test here still passes.
    expect(ELEVATION_ACTIONS['action:mint_token'].enforced).toBe(true)
    expect(ELEVATION_ACTIONS['action:project_lifecycle'].enforced).toBe(true)
  })
})
