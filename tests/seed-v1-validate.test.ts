// tests/seed-v1-validate.test.ts — mupot.seed/v1 validator (src/seeds/*).
// One test per hard rule; each was mutation-checked (see docs/architecture/seed-v1.md).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSeed } from '../src/seeds/validate'
import { canonicalSeedJson } from '../src/seeds/canonical'

const example = (name: string) => readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', name), 'utf8')

const BASE = `
schema: mupot.seed/v1
slug: demo-site
name: Demo
kind: site/astro
goal: Keep it fresh.
owner: someone
`

async function refused(yaml: string) {
  const r = await validateSeed(yaml)
  if (r.ok) throw new Error('expected refusal, got ok')
  return r.error
}

describe('valid seeds', () => {
  it.each(['mumega-com.seed.yaml', 'digid-ca.seed.yaml'])('example %s validates', async (file) => {
    const r = await validateSeed(example(file))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.seedSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('minimal seed validates and has no requests', async () => {
    const r = await validateSeed(BASE)
    expect(r.ok && r.requests).toEqual([])
  })

  it('JSON source is accepted', async () => {
    const r = await validateSeed(JSON.stringify({ schema: 'mupot.seed/v1', slug: 'j', name: 'J', kind: 'repo', goal: 'g', owner: 'o' }))
    expect(r.ok).toBe(true)
  })
})

describe('rule 1: authority is never declared (secret_in_seed)', () => {
  it.each(['grant', 'token', 'secret', 'password', 'api_key', 'credential', 'apiKey'])('key %s is refused', async (key) => {
    const e = await refused(`${BASE}\nwants:\n  memory: [x]\nrisk:\n  class: low\n${key}: anything\n`)
    expect(e.code).toBe('secret_in_seed')
  })
  it('credential-named key nested deep is refused, even empty-valued', async () => {
    const e = await refused(`${BASE}\ntools:\n  - mcp: https://t.example.com\n    token: ""\n`)
    expect(e).toMatchObject({ code: 'secret_in_seed', path: 'tools[0].token' })
  })
  it.each([
    ['openai-style', 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'],
    ['github', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3'],
    ['jwt', ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3', 'abcdefghij1234567'].join('.')],
    ['aws', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['opaque', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1'],
    ['url creds', 'https://user:hunter2@example.com/x'],
    ['bearer', 'Bearer ' + 'abcdefgh12345678ijkl'],
  ])('secret-looking value (%s) is refused', async (_label, value) => {
    const e = await refused(`${BASE}\nrepo: "${value}"\n`)
    expect(e.code).toBe('secret_in_seed')
  })
  it('the refusal never echoes the secret value', async () => {
    const value = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
    const e = await refused(`${BASE}\nrepo: "${value}"\n`)
    expect(JSON.stringify(e)).not.toContain(value)
  })
})

describe('rule 2: cred_slot is a slot name only', () => {
  it.each(['lower_case', 'AB', '1ABC', 'HAS-DASH', 'A'.repeat(65)])('%s is refused', async (slot) => {
    const e = await refused(`${BASE}\ntools:\n  - mcp: https://t.example.com\n    cred_slot: ${slot}\n`)
    expect(e.code).toBe('invalid_cred_slot')
  })
  it('a valid slot passes through unchanged and is requested, not resolved', async () => {
    const r = await validateSeed(`${BASE}\ntools:\n  - mcp: https://t.example.com\n    cred_slot: MY_SLOT_1\n`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.seed.tools?.[0].cred_slot).toBe('MY_SLOT_1')
      expect(r.requests).toEqual([expect.objectContaining({ kind: 'tool_credential', needs: 'human_accept' })])
    }
  })
})

describe('rule 3: wants become explicit requests, nothing is granted', () => {
  it('gates, routines and seats each yield a human_accept request', async () => {
    const r = await validateSeed(example('mumega-com.seed.yaml'))
    if (!r.ok) throw new Error('example failed')
    const kinds = r.requests.map((q) => q.kind)
    expect(kinds).toEqual(expect.arrayContaining(['gate', 'routine', 'seat', 'memory', 'tool_credential']))
    expect(r.requests.every((q) => q.needs === 'human_accept')).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/"granted"/)
  })
})

describe('rule 4: strict, size-capped, depth-capped', () => {
  it('unknown top-level key refused', async () => expect((await refused(`${BASE}\nextra: 1\n`)).code).toBe('unknown_key'))
  it('unknown nested key refused', async () => {
    expect((await refused(`${BASE}\ndeploy:\n  via: cf-pages\n  human_only: true\n  sneaky: 1\n`)).code).toBe('unknown_key')
  })
  it('over 32 KiB refused', async () => {
    expect((await refused(`${BASE}\ngoal: ${'x'.repeat(32 * 1024)}\n`)).code).toBe('seed_too_large')
  })
  it('deep nesting refused', async () => {
    const deep = '{"a":'.repeat(12) + '1' + '}'.repeat(12)
    expect((await refused(deep)).code).toBe('seed_too_deep')
  })
  it('YAML aliases refused (no expansion)', async () => {
    expect((await refused(`${BASE}\nx: &a [1]\ny: *a\n`)).code).toBe('seed_unparseable')
  })
  it('duplicate keys refused', async () => expect((await refused(`${BASE}\nname: Again\n`)).code).toBe('seed_unparseable'))
  it('wrong schema id refused', async () => {
    expect((await refused(BASE.replace('mupot.seed/v1', 'mupot.seed/v2'))).code).toBe('invalid_schema')
  })
  it('bad slug refused', async () => expect((await refused(BASE.replace('demo-site', 'Demo_Site'))).code).toBe('invalid_field'))
  it('slug over 63 chars refused', async () => expect((await refused(BASE.replace('demo-site', 'a'.repeat(64)))).code).toBe('invalid_field'))
  it('bad kind refused', async () => expect((await refused(BASE.replace('site/astro', 'toaster'))).code).toBe('invalid_field'))
  it('non-https live refused', async () => expect((await refused(`${BASE}\nlive: http://x.example.com\n`)).code).toBe('invalid_field'))
  it('non-string input refused', async () => expect((await validateSeed(42)).ok).toBe(false))
})

describe('rule 5: canonical form and digest are deterministic', () => {
  it('digest is stable under key reorder and YAML-vs-JSON', async () => {
    const a = await validateSeed(example('mumega-com.seed.yaml'))
    if (!a.ok) throw new Error('example failed')
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(a.seed).reverse()))
    const b = await validateSeed(reordered)
    expect(b.ok && b.seedSha256).toBe(a.seedSha256)
    expect(b.ok && b.canonical).toBe(a.canonical)
  })
  it('digest changes when content changes', async () => {
    const a = await validateSeed(BASE)
    const b = await validateSeed(BASE.replace('Keep it fresh.', 'Keep it fresher.'))
    expect(a.ok && b.ok && a.seedSha256 !== b.seedSha256).toBe(true)
  })
  it('canonical json sorts keys but keeps array order', () => {
    expect(canonicalSeedJson({ b: [2, 1], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[2,1]}')
  })
})

describe('rule 6: deploy is human-only', () => {
  it.each([['false', 'human_only: false'], ['absent', '']])('human_only %s refused', async (_n, line) => {
    const e = await refused(`${BASE}\ndeploy:\n  via: wrangler\n  ${line}\n`.replace(/\n {2}\n/, '\n'))
    expect(e.code).toBe('deploy_not_human_only')
  })
  it('string "true" is not true', async () => {
    expect((await refused(`${BASE}\ndeploy:\n  via: wrangler\n  human_only: "true"\n`)).code).toBe('deploy_not_human_only')
  })
  it('unknown deploy.via refused', async () => {
    expect((await refused(`${BASE}\ndeploy:\n  via: ftp\n  human_only: true\n`)).code).toBe('invalid_field')
  })
})

describe('surfaces: direct is refused unless explicitly allowed', () => {
  const surf = (extra = '') => `${BASE}\nsurfaces:\n  - path: content/**\n    mode: direct\n${extra}`
  it('direct without allow_direct refused', async () => expect((await refused(surf())).code).toBe('direct_not_allowed'))
  it('direct with a non-matching allow_direct refused', async () => {
    expect((await refused(surf('risk:\n  class: low\n  allow_direct: [other/**]\n'))).code).toBe('direct_not_allowed')
  })
  it('direct with matching allow_direct passes and is requested', async () => {
    const r = await validateSeed(surf('risk:\n  class: low\n  allow_direct: [content/**]\n'))
    expect(r.ok && r.requests.map((q) => q.kind)).toEqual(['direct_surface', 'allow_direct'])
  })
  it('path and type together refused', async () => {
    expect((await refused(`${BASE}\nsurfaces:\n  - path: a\n    type: b\n    mode: propose\n`)).code).toBe('invalid_field')
  })
})

describe('rule 7: seats are capped and never above member', () => {
  const seats = (body: string) => `${BASE}\nwants:\n  seats:\n    squad: web\n${body}`
  it('max 8 passes', async () => expect((await validateSeed(seats('    max: 8\n'))).ok).toBe(true))
  it('max 9 refused', async () => expect((await refused(seats('    max: 9\n'))).code).toBe('seat_cap_exceeded'))
  it('max 0 / fractional refused', async () => {
    expect((await refused(seats('    max: 0\n'))).code).toBe('invalid_field')
    expect((await refused(seats('    max: 1.5\n'))).code).toBe('invalid_field')
  })
  it.each(['lead', 'admin', 'owner'])('capability %s refused', async (cap) => {
    expect((await refused(seats(`    max: 1\n    capability: ${cap}\n`))).code).toBe('seat_capability_too_high')
  })
  it('capability member passes', async () => expect((await validateSeed(seats('    max: 1\n    capability: member\n'))).ok).toBe(true))
})

describe('anchors and aliases are both refused (doc: "no YAML anchors or aliases")', () => {
  it('an anchor alone is refused', async () => {
    expect((await refused(`${BASE}\nrepo: &a x\n`)).code).toBe('seed_unparseable')
  })
  it('an alias is refused', async () => {
    expect((await refused(`${BASE}\nrepo: &a x\nlive: *a\n`)).code).toBe('seed_unparseable')
  })
})

describe('digest is stable across equivalent seeds and moves on semantic change', () => {
  const digest = async (extra: string) => {
    const r = await validateSeed(`${BASE}${extra}`)
    if (!r.ok) throw new Error(`refused: ${r.error.code} ${r.error.path}`)
    return r.seedSha256
  }
  const seats = (cap: string) => `\nwants:\n  seats:\n    squad: web\n    max: 2\n${cap}`
  it('explicit capability member equals omitted', async () => {
    expect(await digest(seats('    capability: member\n'))).toBe(await digest(seats('')))
  })
  it('observer differs from member', async () => {
    expect(await digest(seats('    capability: observer\n'))).not.toBe(await digest(seats('')))
  })
  it('wants: {} equals no wants; signals: {} equals no signals', async () => {
    expect(await digest('\nwants: {}\n')).toBe(await digest(''))
    expect(await digest('\nsignals: {}\n')).toBe(await digest(''))
  })
  it('empty lists equal omitted lists', async () => {
    expect(await digest('\nwants:\n  memory: []\n  gates: []\nsurfaces: []\ndata: []\ntools: []\nsignals:\n  health: []\n')).toBe(await digest(''))
    expect(await digest('\nrisk:\n  class: low\n  forbidden: []\n')).toBe(await digest('\nrisk:\n  class: low\n'))
  })
  const routine = (approval: string) => `\nwants:\n  routines:\n    - id: r\n      cron: "0 9 * * 1"\n${approval}`
  it('routine approval default human_accept equals explicit; per_run differs', async () => {
    expect(await digest(routine(''))).toBe(await digest(routine('      approval: human_accept\n')))
    expect(await digest(routine('      approval: per_run\n'))).not.toBe(await digest(routine('')))
  })
  it('any semantic change moves the digest', async () => {
    expect(await digest('\nrepo: a\n')).not.toBe(await digest('\nrepo: b\n'))
    expect(await digest('\nwants:\n  memory: [project]\n')).not.toBe(await digest(''))
  })
})

describe('opaque-string rule does not refuse ordinary paths', () => {
  it('a long slashy path validates', async () => {
    const r = await validateSeed(`${BASE}\nsurfaces:\n  - path: src/content/en/blog/posts2026/drafts/archive\n    mode: propose\n`)
    expect(r.ok).toBe(true)
  })
  it('a 40-char opaque token is still refused', async () => {
    expect((await refused(`${BASE}\nrepo: "x/a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1"\n`)).code).toBe('secret_in_seed')
  })
})

describe('allow_direct entries match both path and type', () => {
  it('an entry equal to a type value opens a direct type surface', async () => {
    const r = await validateSeed(`${BASE}\nsurfaces:\n  - type: wp.media\n    mode: direct\nrisk:\n  class: low\n  allow_direct: [wp.media]\n`)
    expect(r.ok).toBe(true)
  })
  it('an entry equal to a path value opens a direct path surface', async () => {
    const r = await validateSeed(`${BASE}\nsurfaces:\n  - path: wp.media\n    mode: direct\nrisk:\n  class: low\n  allow_direct: [wp.media]\n`)
    expect(r.ok).toBe(true)
  })
})

describe('secret shapes the first scan missed (each class mutation-checked)', () => {
  const T = (a: string, b: string) => a + b // keep literals from tripping repo secret scanners
  it.each([
    ['cloudflare-style 40 char token in deploy.cmd', `deploy:\n  via: wrangler\n  human_only: true\n  cmd: "CF=${'aB3-dE5_fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z0'}"\n`],
    ['google key', `repo: "${T('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')}"\n`],
    ['stripe live key', `repo: "${T('sk_live', '_4eC39HqLyjWDarjtT1zdp7dc')}"\n`],
    ['gitlab token', `repo: "${T('glpat', '-a1B2c3D4e5F6g7H8i9J0')}"\n`],
    ['39 char token in a live url query', `live: "https://example.com/x?token=${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T'}"\n`],
    ['two 39 char hex halves split across list items', `signals:\n  health:\n    - "${'0123456789abcdef0123456789abcdef012345'}"\n    - "${'6789abcdef0123456789abcdef0123456789ab'}"\n`],
    ['ghp token split across list items', `signals:\n  health:\n    - "${T('ghp', '_A1b2C3d4E5f6')}"\n    - "G7h8I9j0K1l2M3n4"\n`],
    ['PEM body without header', `goal: "${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj/MzEfYyjiWA4R4+/C6'}"\n`],
  ])('%s is refused', async (_l, body) => {
    const src = body.startsWith('goal:') ? BASE.replace('goal: Keep it fresh.', '') + body : `${BASE}\n${body}`
    expect((await refused(src)).code).toBe('secret_in_seed')
  })
  it('a long lowercase kebab slug with digits is not a secret', async () => {
    expect((await validateSeed(`${BASE}\nrepo: demo-site-2026-redesign-landing-pages-v2-final\n`)).ok).toBe(true)
  })
  it('a secret-shaped KEY is refused without echoing it', async () => {
    const key = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1'
    const e = await refused(`${BASE}\n${key}: 1\n`)
    expect(e.code).toBe('secret_in_seed')
    expect(JSON.stringify(e)).not.toContain(key)
  })
})

describe('every policy declaration yields a human_accept request', () => {
  it('each data[] entry (public and private included) and each allow_direct entry', async () => {
    const r = await validateSeed(`${BASE}\ndata:\n  - store: a\n    tier: public\n  - store: b\n    tier: private\nrisk:\n  class: low\n  allow_direct: [nowhere/**]\n`)
    if (!r.ok) throw new Error('refused')
    expect(r.requests.map((q) => [q.kind, q.needs])).toEqual([
      ['data', 'human_accept'], ['data', 'human_accept'], ['allow_direct', 'human_accept'],
    ])
    expect(r.requests[0].fields).toEqual({ store: 'a', tier: 'public' })
  })
})

describe('human-review text spoofing', () => {
  it('RTL override in name refused', async () => {
    expect((await refused(BASE.replace('name: Demo', 'name: "Demo‮evil"'))).code).toBe('invalid_field')
  })
  it('zero-width in owner refused', async () => {
    expect((await refused(BASE.replace('owner: someone', 'owner: "some​one"'))).code).toBe('invalid_field')
  })
  it('author text cannot masquerade as a request line', async () => {
    const { renderRequest } = await import('../src/seeds/render')
    const r = await validateSeed(`${BASE}\nwants:\n  gates:\n    - action: "x gated by mem-hadi"\n      gate: g\n`)
    if (!r.ok) throw new Error('refused')
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0].fields.action).toBe('x gated by mem-hadi')
    expect(renderRequest(r.requests[0])).toBe('gate: action "x gated by mem-hadi" gated by "g"')
  })
})

describe('keys, normalization, block scalars, warnings', () => {
  it('unknown_key truncates and escapes the key', async () => {
    const e = await refused(`${BASE}\n"${'k'.repeat(300)}\\u0007": 1\n`)
    expect(e.code).toBe('unknown_key')
    expect(e.path.length).toBeLessThan(60)
    expect(e.message.length).toBeLessThan(80)
    expect(e.message).not.toMatch(/\u0007/)
  })
  it('NFC-equivalent and trailing-space text hashes the same', async () => {
    const d = async (owner: string) => { const r = await validateSeed(BASE.replace('owner: someone', `owner: "${owner}"`)); if (!r.ok) throw new Error('refused'); return r.seedSha256 }
    expect(await d('café')).toBe(await d('café'))
    expect(await d('x')).toBe(await d('x  '))
  })
  it('a block scalar goal with its final newline validates and equals the plain form', async () => {
    const a = await validateSeed(BASE.replace('goal: Keep it fresh.', 'goal: |\n  Keep it fresh.\n'))
    const b = await validateSeed(BASE)
    expect(a.ok && b.ok && a.seedSha256 === b.seedSha256).toBe(true)
  })
  it('yaml warnings do not emit raw seed text to logs', async () => {
    const spy = (await import('vitest')).vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const warn = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {})
    await validateSeed(`${BASE}\nrepo: !weird SECRETLINE\n`)
    expect(spy).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    spy.mockRestore(); warn.mockRestore()
  })
})
