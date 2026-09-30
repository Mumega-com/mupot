// Ratchet: every key the worker's `Env` interface declares (and every env.X the
// source reads) must be in ENV_REVIEWED_BINDING_NAMES, so secret_env_request can
// never be used to squat / overwrite a binding the worker itself owns.
// Adding an Env key without touching src/secret-env/env-reviewed-names.ts FAILS here.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ENV_REVIEWED_BINDING_NAMES, RESERVED_BINDING_PREFIXES } from '../src/secret-env/env-reviewed-names'
import { isValidBindingName } from '../src/secret-env/names'

const ROOT = join(__dirname, '..')

function envInterfaceKeys(source: string): string[] {
  const file = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true)
  const keys: string[] = []
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Env') {
      for (const member of node.members) {
        if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) keys.push(member.name.text)
      }
    }
  })
  return keys
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('secret-env reserved names ratchet', () => {
  it('parser finds the Env interface (sanity — guards the ratchet against going vacuous)', () => {
    const keys = envInterfaceKeys(readFileSync(join(ROOT, 'src/types.ts'), 'utf8'))
    expect(keys.length).toBeGreaterThan(50)
    expect(keys).toContain('DB')
  })

  it('every Env-declared key is reviewed and refused as a binding name', () => {
    const keys = envInterfaceKeys(readFileSync(join(ROOT, 'src/types.ts'), 'utf8'))
    const unreviewed = keys.filter((key) => !ENV_REVIEWED_BINDING_NAMES.has(key))
    expect(unreviewed, `Env keys not in ENV_REVIEWED_BINDING_NAMES: ${unreviewed.join(', ')}`).toEqual([])
    for (const key of keys) expect(isValidBindingName(key), key).toBe(false)
  })

  it('every env.X the source reads is reviewed (covers optional secrets absent from the interface)', () => {
    const missing = new Set<string>()
    const re = /\b(?:env|c\.env)\.([A-Z][A-Z0-9_]{2,})\b/g
    for (const file of walk(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(re)) {
        const name = m[1]!
        if (!ENV_REVIEWED_BINDING_NAMES.has(name) && !name.endsWith('_')) missing.add(name)
      }
    }
    // Constants that merely look like env reads (module-level consts named env.*) — none expected.
    expect([...missing].sort()).toEqual([])
  })

  it('every UPPER_SNAKE field of every *Env / *Secrets interface in src is reviewed (typed-accessor reads)', () => {
    // Reads such as discordSecrets(env).DISCORD_PUBLIC_KEY never match env.X; their names
    // live as fields of a narrow `DiscordSecrets`-style interface instead.
    const missing = new Set<string>()
    for (const file of walk(join(ROOT, 'src'))) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && /(Env|Secrets)$/.test(node.name.text)) {
          for (const member of node.members) {
            if (member.name && ts.isIdentifier(member.name) && /^[A-Z][A-Z0-9_]+$/.test(member.name.text)) {
              if (!ENV_REVIEWED_BINDING_NAMES.has(member.name.text)) missing.add(`${member.name.text} (${node.name.text})`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    expect([...missing].sort()).toEqual([])
  })

  it('every name read through accessor(env).X or (env as T).X is reviewed', () => {
    const missing = new Set<string>()
    const patterns = [
      /\b\w*(?:Secrets|Env)\(\s*(?:c\.)?env\s*\)\.([A-Z][A-Z0-9_]+)/g,
      /\(\s*(?:c\.)?env as [^)]*\)\.([A-Z][A-Z0-9_]+)/g,
    ]
    for (const file of walk(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const re of patterns) for (const m of text.matchAll(re)) {
        if (!ENV_REVIEWED_BINDING_NAMES.has(m[1]!)) missing.add(m[1]!)
      }
    }
    expect([...missing].sort()).toEqual([])
  })

  it('every template-literal name prefix (`NAME_${x}`) in src is a reserved prefix', () => {
    const uncovered = new Set<string>()
    for (const file of walk(join(ROOT, 'src'))) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isTemplateExpression(node) && /^[A-Z][A-Z0-9_]*_$/.test(node.head.text)) {
          if (!RESERVED_BINDING_PREFIXES.includes(node.head.text)) uncovered.add(node.head.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    expect([...uncovered].sort()).toEqual([])
  })

  it('the reviewed list is sorted and duplicate-free (stable diffs)', () => {
    const list = [...ENV_REVIEWED_BINDING_NAMES]
    expect(list).toEqual([...list].sort())
  })
})
