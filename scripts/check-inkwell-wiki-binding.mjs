#!/usr/bin/env node
// scripts/check-inkwell-wiki-binding.mjs — deploy-time check for the dedicated INKWELL_WIKI
// service binding. A Worker cannot read a binding's `props` from the caller side, so the
// tenant-match guarantee is enforced here, against the wrangler config about to be deployed.
//
// Asserts (Inkwell wiki scope contract, mumega-com#1649):
//   - INKWELL_WIKI props.wiki.tenant === [vars] TENANT_SLUG
//   - project_scope === "tenant"
//   - actions is a non-empty subset of {read, write}
//   - projects, if present, is a non-empty array of non-empty strings (optional narrowing)
//   - INKWELL_SVC (generic connector/dashboard binding) carries NO props: scoped authority
//     must never ride on the generic binding.
// An absent INKWELL_WIKI block passes (legacy: wiki falls back to INKWELL_SVC) unless --require.
//
// Usage: node scripts/check-inkwell-wiki-binding.mjs [wrangler.toml] [--require]

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ── minimal TOML subset parser (no TOML dependency in this repo) ──────────────
// Supports: comments, [table], [[array-of-tables]] (+ [a.b.c] sub-tables attaching to the
// last element), dotted keys, strings, numbers, booleans, arrays, inline tables, and
// multi-line arrays / inline tables.

function stripComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '\\' && q === '"') i++
      else if (ch === q) q = null
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

function depthDelta(s) {
  let d = 0
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\' && q === '"') i++
      else if (ch === q) q = null
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === '[' || ch === '{') d++
    else if (ch === ']' || ch === '}') d--
  }
  return d
}

function parseValue(src) {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  function value() {
    ws()
    const ch = src[i]
    if (ch === '"' || ch === "'") {
      const q = ch
      let out = ''
      i++
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === '\\') { out += src[i + 1]; i += 2 } else out += src[i++]
      }
      if (src[i] !== q) throw new Error('unterminated string')
      i++
      return out
    }
    if (ch === '[') {
      i++
      const arr = []
      for (;;) {
        ws()
        if (src[i] === ']') { i++; return arr }
        arr.push(value())
        ws()
        if (src[i] === ',') i++
        else if (src[i] !== ']') throw new Error('bad array')
      }
    }
    if (ch === '{') {
      i++
      const obj = {}
      for (;;) {
        ws()
        if (src[i] === '}') { i++; return obj }
        const path = key()
        ws()
        if (src[i] !== '=') throw new Error('bad inline table')
        i++
        setPath(obj, path, value())
        ws()
        if (src[i] === ',') i++
        else if (src[i] !== '}') throw new Error('bad inline table')
      }
    }
    const m = /^[^\s,\]}]+/.exec(src.slice(i))
    if (!m) throw new Error('bad value')
    i += m[0].length
    if (m[0] === 'true') return true
    if (m[0] === 'false') return false
    const n = Number(m[0])
    if (Number.isNaN(n)) throw new Error(`bad scalar ${m[0]}`)
    return n
  }
  function key() {
    const parts = []
    for (;;) {
      ws()
      if (src[i] === '"' || src[i] === "'") parts.push(value())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i))
        if (!m) throw new Error('bad key')
        parts.push(m[0])
        i += m[0].length
      }
      ws()
      if (src[i] === '.') i++
      else return parts
    }
  }
  const v = value()
  ws()
  if (i < src.length) throw new Error('trailing characters')
  return v
}

function setPath(obj, path, val) {
  let cur = obj
  for (const p of path.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p]
  }
  cur[path[path.length - 1]] = val
}

function splitKey(s) {
  // keys only need simple dotted bare/quoted parts here
  return s.trim().split('.').map((p) => p.trim().replace(/^["']|["']$/g, ''))
}

export function parseToml(text) {
  const root = {}
  let cur = root
  const lines = text.split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    let line = stripComment(lines[n]).trim()
    if (!line) continue
    if (line.startsWith('[')) {
      const arr = line.startsWith('[[')
      const name = line.replace(/^\[\[?/, '').replace(/\]\]?$/, '')
      const path = splitKey(name)
      let t = root
      for (let k = 0; k < path.length; k++) {
        const p = path[k]
        const last = k === path.length - 1
        if (last && arr) {
          if (!Array.isArray(t[p])) t[p] = []
          const el = {}
          t[p].push(el)
          t = el
        } else {
          if (Array.isArray(t[p])) t = t[p][t[p].length - 1]
          else {
            if (typeof t[p] !== 'object' || t[p] === null) t[p] = {}
            t = t[p]
          }
        }
      }
      cur = t
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) throw new Error(`line ${n + 1}: expected key = value`)
    let rhs = line.slice(eq + 1)
    while (depthDelta(rhs) > 0 && n + 1 < lines.length) rhs += ` ${stripComment(lines[++n]).trim()}`
    try {
      setPath(cur, splitKey(line.slice(0, eq)), parseValue(rhs.trim()))
    } catch (e) {
      throw new Error(`line ${n + 1}: ${e.message}`)
    }
  }
  return root
}

// ── the check ────────────────────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set(['read', 'write'])

/** @returns {{ errors: string[], configured: boolean }} */
export function checkWikiBinding(toml) {
  const errors = []
  let cfg
  try {
    cfg = parseToml(toml)
  } catch (e) {
    return { errors: [`wrangler config does not parse: ${e.message}`], configured: false }
  }
  const services = Array.isArray(cfg.services) ? cfg.services : []
  const svc = services.find((s) => s && s.binding === 'INKWELL_SVC')
  if (svc && svc.props !== undefined) {
    errors.push('INKWELL_SVC must not carry props: scoped wiki authority belongs only on INKWELL_WIKI')
  }
  const wikis = services.filter((s) => s && s.binding === 'INKWELL_WIKI')
  if (wikis.length === 0) return { errors, configured: false }
  if (wikis.length > 1) errors.push('INKWELL_WIKI declared more than once')
  const wiki = wikis[0]
  const slug = cfg.vars && typeof cfg.vars.TENANT_SLUG === 'string' ? cfg.vars.TENANT_SLUG : ''
  if (!slug) errors.push('[vars] TENANT_SLUG missing: cannot verify the wiki tenant')
  const p = wiki.props && typeof wiki.props === 'object' ? wiki.props.wiki : undefined
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('INKWELL_WIKI props.wiki missing')
    return { errors, configured: true }
  }
  if (typeof p.tenant !== 'string' || p.tenant === '') errors.push('props.wiki.tenant must be a non-empty string')
  else if (slug && p.tenant !== slug) errors.push(`props.wiki.tenant "${p.tenant}" must equal TENANT_SLUG "${slug}"`)
  if (p.project_scope !== 'tenant') errors.push('props.wiki.project_scope must be "tenant"')
  if (!Array.isArray(p.actions) || p.actions.length === 0) errors.push('props.wiki.actions must be a non-empty array')
  else if (!p.actions.every((a) => typeof a === 'string' && ALLOWED_ACTIONS.has(a))) {
    errors.push('props.wiki.actions must be a subset of ["read","write"]')
  }
  if (p.projects !== undefined) {
    if (!Array.isArray(p.projects) || p.projects.length === 0
      || !p.projects.every((x) => typeof x === 'string' && x.trim() !== '' && x !== '*')) {
      errors.push('props.wiki.projects, if present, must be a non-empty array of exact project ids (no wildcard)')
    }
  }
  return { errors, configured: true }
}

function main() {
  const args = process.argv.slice(2)
  const require = args.includes('--require')
  const file = args.find((a) => !a.startsWith('--')) ?? 'wrangler.toml'
  const { errors, configured } = checkWikiBinding(readFileSync(file, 'utf8'))
  if (!configured && require) errors.push('INKWELL_WIKI binding not configured (--require)')
  if (errors.length) {
    for (const e of errors) console.error(`check-inkwell-wiki-binding: ${e}`)
    process.exit(1)
  }
  console.log(`check-inkwell-wiki-binding: ok (${configured ? 'scoped binding valid' : 'INKWELL_WIKI absent, legacy INKWELL_SVC path'})`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
