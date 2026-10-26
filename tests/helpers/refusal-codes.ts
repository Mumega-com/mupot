// Scans src/ for HTTP/MCP refusal codes: `fail(4xx, 'code'` (MCP) and `{ error: 'code' ... }, 4xx` (REST).
// Used by tests/policy-refusal-guard.test.ts. Heuristic by design: a false positive costs one allowlist or
// registry line; a false negative is a refusal nobody registered, which is the thing the guard exists to stop.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_FILES = new Set(['schema-chain.generated.ts', 'bundle.generated.ts', 'build-info.ts'])
const MCP_RE = /\bfail\(\s*[45]\d\d\s*,\s*['"]([a-z][a-z0-9_]*)['"]/g
const REST_RE = /\berror:\s*['"]([a-z][a-z0-9_]*)['"]((?:(?!\berror:)[^;]){0,300}?)\}\s*,\s*(?:[45]\d\d)\b/g

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !SKIP_FILES.has(name)) out.push(p)
  }
}

/** code -> files where it is refused. */
export function scanRefusalCodes(srcDir: string): Map<string, Set<string>> {
  const files: string[] = []
  walk(srcDir, files)
  const found = new Map<string, Set<string>>()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const re of [MCP_RE, REST_RE]) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        const code = m[1]
        if (!code) continue
        let set = found.get(code)
        if (!set) { set = new Set(); found.set(code, set) }
        set.add(relative(srcDir, f))
      }
    }
  }
  return found
}
