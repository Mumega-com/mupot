// The Agents SDK must NOT live in the main Worker. Importing it raised non-idle startup CPU on every cold
// isolate (measured ~62 ms -> ~255 ms median) for a feature that is off, so the ProjectOffice class and the
// `agents` dependency live in their own Worker (workers/project-office/). These are raw-text guards over the
// files that would re-introduce it, in the same spirit as the repo's other ratchets.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full)
  }
  return out
}

// A real import/export/dynamic-import of the SDK or of the office Worker's code (comments mentioning them are fine).
const IMPORTS_THE_SDK = /^\s*(?:import|export)\b[^;'"]*\bfrom\s*['"](?:agents(?:\/[^'"]*)?|[^'"]*workers\/project-office[^'"]*|[^'"]*\/project-office)['"]|^\s*import\s*['"]agents|\bimport\(\s*['"]agents/m

describe('the main Worker stays free of the Agents SDK', () => {
  it('root package.json does not depend on `agents`', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('agents')
  })

  it('the root lockfile does not resolve `agents`', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, unknown> }
    expect(Object.keys(lock.packages)).not.toContain('node_modules/agents')
  })

  it('nothing under src/ imports `agents` or the office class', () => {
    const offenders = walk(join(ROOT, 'src')).filter((f) => IMPORTS_THE_SDK.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
  })

  it('src/index.ts exports no office class', () => {
    expect(read('src/index.ts')).not.toMatch(/ProjectOffice\b/)
  })
})

describe('new pots do not get the office until Phase 1', () => {
  const active = (text: string): string => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

  it('wrangler.example.toml has no live office binding, class, migration or script_name', () => {
    const live = active(read('wrangler.example.toml'))
    expect(live).not.toMatch(/PROJECT_OFFICE/)
    expect(live).not.toMatch(/ProjectOffice/)
    expect(live).not.toMatch(/script_name/)
  })

  it('the documented binding stays commented out, pointing at the separate Worker', () => {
    const text = read('wrangler.example.toml')
    expect(text).toMatch(/^# \[\[durable_objects\.bindings\]\]\n# name = "PROJECT_OFFICE_DO"\n# class_name = "ProjectOffice"\n# script_name = "mupot-project-office"$/m)
  })

  it('scripts/setup.sh does not mention the office at all', () => {
    expect(read('scripts/setup.sh')).not.toMatch(/project.office|PROJECT_OFFICE|ProjectOffice/i)
  })

  it('the office Worker carries its own migration, tag v1', () => {
    const toml = read('workers/project-office/wrangler.example.toml')
    expect(toml).toMatch(/\[\[migrations\]\]\ntag = "v1"\nnew_sqlite_classes = \["ProjectOffice"\]/)
    expect(toml).toMatch(/name = "mupot-project-office"/)
  })
})
