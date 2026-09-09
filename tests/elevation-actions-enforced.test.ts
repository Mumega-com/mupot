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

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('schema-chain')) out.push(full)
  }
  return out
}

/** Files that reference this action key OUTSIDE its own definition file. The
 *  dashboard renders every key generically via ELEVATION_ACTIONS[...] and so
 *  never names one literally — a literal occurrence elsewhere is a consumer. */
function consumersOf(action: string): string[] {
  const hits: string[] = []
  for (const file of tsFiles(SRC_DIR)) {
    const rel = file.slice(file.indexOf('src/') + 4)
    if (rel === DEFINITION_FILE) continue
    if (readFileSync(file, 'utf8').includes(`'${action}'`)) hits.push(rel)
  }
  return hits
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
