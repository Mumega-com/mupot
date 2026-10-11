// tests/seed-draft.test.ts — seed_draft (src/seeds/draft.ts + src/mcp/seed.ts). The drafter must
// produce text the REAL validator and the REAL seed_attach dry run accept unchanged, must never
// carry acceptance or authority, and must refuse (not repair) hostile text.

import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { draftSeed, emitSeedYaml } from '../src/seeds/draft'
import { validateSeed } from '../src/seeds/validate'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const repoDraft = (extra: Record<string, unknown> = {}) =>
  draftSeed({ source: { kind: 'repo', url: 'https://github.com/Example-Org/Widget-App.git' }, ...extra } as never)
const wpDraft = (extra: Record<string, unknown> = {}) =>
  draftSeed({ source: { kind: 'site', url: 'https://wp.example.com/some/page?x=1#f', platform: 'wordpress' }, ...extra } as never)

function parsed(yaml: string): Record<string, unknown> {
  return parseDocument(yaml, { schema: 'core' }).toJS() as Record<string, unknown> // as: test-only read of our own draft
}

describe('repo draft', () => {
  it('normalises the repo URL, validates, and asks for the narrowest things', async () => {
    const r = await repoDraft()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const seed = r.validation.seed
    expect(seed).toMatchObject({ schema: 'mupot.seed/v1', slug: 'widget-app', kind: 'repo', repo: 'https://github.com/Example-Org/Widget-App' })
    expect(seed.deploy).toBeUndefined()
    expect(seed.surfaces).toEqual([{ path: '**', mode: 'propose' }])
    expect(seed.wants?.seats).toEqual({ squad: 'widget-app', max: 1, capability: 'observer' })
    expect(seed.wants?.gates).toEqual([{ action: 'publish_change', gate: 'gate:owner' }])
    expect(seed.risk?.allow_direct).toBeUndefined()
    expect(r.warnings.join('\n')).toMatch(/owner is "unassigned"/)
    expect(r.warnings.join('\n')).toMatch(/no network fetch/)
  })
  it('folds scp-style and https spellings to https, keeping the original owner/repo case', async () => {
    for (const url of ['git@github.com:O/R.git', 'https://GitHub.com/O/R/tree/main/src', 'https://github.com/O/R.git.git/']) {
      const r = await draftSeed({ source: { kind: 'repo', url } })
      expect(r.ok && r.validation.seed.repo).toBe('https://github.com/O/R')
    }
    const other = await draftSeed({ source: { kind: 'repo', url: 'https://Git.Example.com/Team/Repo.git' } })
    expect(other.ok && other.validation.seed.repo).toBe('https://git.example.com/Team/Repo')
    expect((await draftSeed({ source: { kind: 'repo', url: 'https://github.com/only-owner' } })).ok).toBe(false)
    expect((await draftSeed({ source: { kind: 'repo', url: 'not a url' } })).ok).toBe(false)
  })
  it('refuses non-https schemes, a missing host and a non-default port; scp-style stays allowed', async () => {
    for (const url of ['http://github.com/o/r', 'file:///etc/passwd', 'javascript:alert(1)', 'ssh://git@github.com/o/r', 'git://github.com/o/r', 'https:///o/r', 'https://github.com:8443/o/r', 'ftp://example.com/o/r']) {
      const r = await draftSeed({ source: { kind: 'repo', url } })
      expect(r.ok, url).toBe(false)
      if (!r.ok) expect(r.error.code, url).toBe('invalid_source')
    }
    expect((await draftSeed({ source: { kind: 'repo', url: 'git@github.com:o/r.git' } })).ok).toBe(true)
    const viaHint = await repoDraft({ hints: { repo_url: 'http://github.com/o/r' } })
    expect(viaHint.ok).toBe(false)
  })
  it('strips credentials from an https repo URL and warns', async () => {
    const r = await draftSeed({ source: { kind: 'repo', url: 'https://someuser:somepass@github.com/o/r' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.validation.seed.repo).toBe('https://github.com/o/r')
    expect(r.seedYaml).not.toMatch(/someuser|somepass/)
    expect(r.warnings.join('\n')).toMatch(/credentials in source\.url were stripped/)
    const plain = await draftSeed({ source: { kind: 'repo', url: 'https://github.com/o/r' } })
    expect(plain.ok && plain.warnings.join('\n')).not.toMatch(/stripped/)
  })
  it('runs the derived default name through the same text checks and refuses lone surrogates', async () => {
    expect((await repoDraft({ project_name: 'ok\uD800name' })).ok).toBe(false)
    expect((await repoDraft({ hints: { owner: 'lone\uDC00' } })).ok).toBe(false)
    const long = await draftSeed({ source: { kind: 'repo', url: `https://github.com/o/${'r'.repeat(130)}` } })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error.code).toBe('invalid_args')
    expect((await repoDraft({ project_name: 'pair \u{1F600}' })).ok).toBe(true)
  })
  it('collapses unknown hints into one warning (10 keys + count) and warns on ignored hints', async () => {
    const hints: Record<string, unknown> = {}
    for (let i = 0; i < 15; i++) hints[`extra${i}`] = i
    hints.deploy_receipt = 'r'
    const r = await draftSeed({ source: { kind: 'repo', url: 'https://github.com/o/r', extra_source_key: 1 } as never, hints } as never)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const unknown = r.warnings.filter((w) => w.includes('hint(s) ignored'))
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatch(/^15 hint\(s\) ignored/)
    expect(unknown[0]).toMatch(/and 5 more/)
    expect((unknown[0].match(/"extra\d+"/g) ?? []).length).toBe(10)
    expect(r.warnings.join('\n')).toMatch(/"deploy_receipt" ignored/)
    expect(r.warnings.join('\n')).toMatch(/extra key\(s\) under source ignored: "extra_source_key"/)
    const wp = await wpDraft({ hints: { surface_paths: ['a/**'] } })
    expect(wp.ok && wp.warnings.join('\n')).toMatch(/"surface_paths" ignored for a WordPress site/)
  })
  it('validates hints.squad in the drafter as invalid_hint', async () => {
    const r = await repoDraft({ hints: { squad: 'Not A Slug' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ code: 'invalid_hint', path: 'hints.squad' })
    expect((await repoDraft({ hints: { squad: 'good-squad' } })).ok).toBe(true)
  })
  it('uses hints for deploy, owner, gate, surfaces, tool slots; ignores unknown keys with a warning', async () => {
    const r = await repoDraft({
      project_name: 'Widget App',
      hints: { owner: 'team-a', goal: 'Ship widgets.', deploy_via: 'wrangler', deploy_cmd: 'npm run deploy', gate: 'gate:team-a', surface_paths: ['src/**', 'docs/**'], tool_slots: [{ mcp: 'https://tools.example.com/mcp', cred_slot: 'TOOLS_API' }], branches: ['main'], bogus: 1 },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.validation.seed.deploy).toEqual({ via: 'wrangler', cmd: 'npm run deploy', receipt: 'change receipt recorded on the project', human_only: true })
    expect(r.validation.seed.surfaces).toEqual([{ path: 'src/**', mode: 'propose' }, { path: 'docs/**', mode: 'propose' }])
    expect(r.validation.requests.some((q) => q.kind === 'tool_credential')).toBe(true)
    const w = r.warnings.join('\n')
    expect(w).toMatch(/branches.*no field/)
    expect(w).toMatch(/1 hint\(s\) ignored.*"bogus"/)
  })
  it('deploy_cmd without deploy_via falls back to git-push-only with a warning', async () => {
    const r = await repoDraft({ hints: { deploy_cmd: 'make ship' } })
    expect(r.ok && r.validation.seed.deploy?.via).toBe('git-push-only')
    expect(r.ok && r.warnings.join('\n')).toMatch(/git-push-only/)
  })
})

describe('wordpress draft', () => {
  it('mirrors the plugin-deploy shape: wp-plugin human-only deploy, propose-only surfaces, one tool slot', async () => {
    const r = await wpDraft({ project_name: 'Example WP Site', hints: { owner: 'site-owner' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.validation.seed
    expect(s).toMatchObject({ kind: 'site/wordpress', live: 'https://wp.example.com', slug: 'example-wp-site' })
    expect(s.deploy).toMatchObject({ via: 'wp-plugin', human_only: true })
    expect(s.surfaces?.map((x) => [x.type, x.mode])).toEqual([['wp.page', 'propose'], ['wp.post', 'propose'], ['wp.media', 'propose']])
    expect(s.tools).toEqual([{ mcp: 'https://wp.example.com/wp-json/mcpwp/v1/mcp', cred_slot: 'WP_SITE_API' }])
    expect(r.warnings.join('\n')).toMatch(/MCPWP default endpoint; confirm before binding/)
    expect(r.warnings.join('\n')).not.toMatch(/conventional/)
    expect(s.signals?.health).toEqual(['https://wp.example.com'])
    expect(r.warnings.join('\n')).toMatch(/reduced to its origin/)
    // the credential stays a REQUEST a human binds
    expect(r.validation.requests.find((q) => q.kind === 'tool_credential')?.fields.cred_slot).toBe('WP_SITE_API')
  })
  it('refuses http and credentialled site URLs; static platform maps to app with a warning', async () => {
    expect((await draftSeed({ source: { kind: 'site', url: 'http://wp.example.com', platform: 'wordpress' } })).ok).toBe(false)
    expect((await draftSeed({ source: { kind: 'site', url: 'https://u:p@wp.example.com' } })).ok).toBe(false)
    const r = await draftSeed({ source: { kind: 'site', url: 'https://static.example.com', platform: 'static' } })
    expect(r.ok && r.validation.seed.kind).toBe('app')
    expect(r.ok && r.warnings.join('\n')).toMatch(/no static-site kind/)
  })
})

describe('round trip and the no-accept guarantee', () => {
  it('a broken (unquoted or injecting) emitter is caught by the round-trip check as draft_rejected', async () => {
    // Emits a VALID but different seed: an extra signals block the intended object never had.
    const injecting = (seed: Record<string, unknown>) => `${emitSeedYaml(seed)}signals:\n  health:\n    - "https://injected.example.com"\n`
    const r = await draftSeed({ source: { kind: 'repo', url: 'https://github.com/o/r' } }, { emit: injecting })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ code: 'draft_rejected', message: 'drafted text did not round-trip to the intended seed' })
    // The real emitter passes.
    expect((await draftSeed({ source: { kind: 'repo', url: 'https://github.com/o/r' } }, { emit: emitSeedYaml })).ok).toBe(true)
  })
  it('drafted text is the validator input unchanged and parses to the same digest as the draft reports', async () => {
    for (const r of [await repoDraft(), await wpDraft()]) {
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const again = await validateSeed(r.seedYaml)
      expect(again.ok && again.seedSha256).toBe(r.validation.seedSha256)
    }
  })
  it('never carries accept, grant, token or credential keys, and every request still needs a human', async () => {
    for (const r of [await repoDraft({ hints: { deploy_via: 'wrangler' } }), await wpDraft()]) {
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.seedYaml).not.toMatch(/accept|grant|token|secret|password|credential|bearer/i)
      expect(r.validation.requests.length).toBeGreaterThan(0)
      expect(r.validation.requests.every((q) => q.needs === 'human_accept')).toBe(true)
      expect(r.validation.seed.surfaces?.every((x) => x.mode === 'propose')).toBe(true)
      expect(r.validation.seed.risk?.allow_direct).toBeUndefined()
      expect(r.validation.seed.wants?.seats?.capability).toBe('observer')
      expect(r.validation.seed.deploy ? r.validation.seed.deploy.human_only : true).toBe(true)
    }
  })
  it('hints cannot request direct surfaces or allow_direct (unknown hints are ignored)', async () => {
    const r = await repoDraft({ hints: { surfaces: [{ path: 'x', mode: 'direct' }], allow_direct: ['x'], accept: ['gate:abc'], accept_token: 'x' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.seedYaml).not.toMatch(/direct|accept/)
  })
})

describe('hostile input', () => {
  const injections = [
    'x"\nowner: evil',
    'x\n  accept: [gate:1]',
    'x: {a: b}\nrisk:\n  class: low',
    '"; wants: {seats: {squad: s, max: 8}}',
    'a‮b',
    'a​b',
    'a\u0000b',
    'a b',
    'a\u0085b',
    '*alias',
    '&anchor x',
    '- item',
    '# comment',
    '{{template}}',
  ]
  it('a hostile name, goal, owner or gate is refused or emitted as one inert scalar, never a second field', async () => {
    for (const text of injections) {
      for (const where of ['project_name', 'goal', 'owner', 'gate', 'deploy_cmd', 'squad']) {
        const hints: Record<string, unknown> = where === 'project_name' ? {} : { [where === 'gate' ? 'gate' : where]: text }
        const r = await repoDraft(where === 'project_name' ? { project_name: text } : { hints })
        if (!r.ok) continue // refused: fine
        // accepted: the seed must be exactly the intended shape (owner stays one scalar, no extra wants)
        const doc = parsed(r.seedYaml)
        expect(Object.keys(doc).sort()).toEqual(['goal', 'kind', 'name', 'owner', 'repo', 'risk', 'schema', 'slug', 'surfaces', 'wants'].concat(where === 'deploy_cmd' ? ['deploy'] : []).sort())
        expect(r.validation.seed.wants?.seats?.max).toBe(1)
        expect(r.validation.seed.risk?.class).toBe('medium')
        expect(r.validation.seed.wants?.gates).toHaveLength(1)
      }
    }
  })
  it('control and invisible characters are refused with a message that does not echo them', async () => {
    for (const bad of ['a\u0000b', 'a‮b', 'a​b', 'a\nb', 'a b']) {
      const r = await repoDraft({ hints: { owner: bad } })
      if (!r.ok) {
        expect(r.error.message).not.toContain(bad)
        expect(r.error.code).toBe('invalid_args')
      } else {
        // a trailing/embedded newline-free scalar only; newline must never survive raw
        expect(r.seedYaml.split('\n').every((l) => !l.includes(' '))).toBe(true)
      }
    }
    expect((await repoDraft({ hints: { owner: 'a\nowner: evil' } })).ok).toBe(false)
  })
  it('over-long strings are refused', async () => {
    expect((await repoDraft({ project_name: 'n'.repeat(500) })).ok).toBe(false)
    expect((await repoDraft({ hints: { goal: 'g'.repeat(5000) } })).ok).toBe(false)
    expect((await repoDraft({ hints: { surface_paths: Array.from({ length: 60 }, (_, i) => `p${i}`) } })).ok).toBe(false)
  })
  it('quotes and backslashes in a goal survive as data', async () => {
    const goal = 'Say "hi" \\ and \'bye\': ok # not a comment'
    const r = await repoDraft({ hints: { goal } })
    expect(r.ok && r.validation.seed.goal).toBe(goal)
  })
  it('a secret-shaped hint is refused by the validator, not drafted', async () => {
    const r = await repoDraft({ hints: { deploy_cmd: `deploy --key ${'sk'}${'-'}${'abcdefghijklmnopqrstuvwxyz0123'}` } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('draft_rejected')
    const bad = await repoDraft({ hints: { tool_slots: [{ mcp: 'https://t.example.com/mcp', cred_slot: 'lowercase value' }] } })
    expect(bad.ok).toBe(false)
  })
  it('malformed args are refused', async () => {
    for (const input of [null, {}, { source: null }, { source: { kind: 'file', url: 'x' } }, { source: { kind: 'repo', url: 5 } }, { source: { kind: 'repo', url: 'https://github.com/o/r', platform: 'wordpress' } }, { source: { kind: 'site', url: 'https://a.example.com', platform: 'drupal' } }, { source: { kind: 'repo', url: 'https://github.com/o/r' }, hints: [] }, { source: { kind: 'repo', url: 'https://github.com/o/r' }, project_name: '   ' }]) {
      expect((await draftSeed(input as never)).ok).toBe(false)
    }
  })
})

// ── through the real tool seam ────────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
function makeEnv() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  const snapshot = () => JSON.stringify(
    (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((t) => [t.name, (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n]),
  )
  return { env: { DB: harness.db, TENANT_SLUG: TENANT } as Env, snapshot }
}
const grant = (capability: CapabilityGrant['capability']): CapabilityGrant => ({ member_id: 'n/a', scope_type: 'org', scope_id: null, capability }) as CapabilityGrant
const member: AuthContext = { userId: 'm1', email: 'm1@example.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'm1', capabilities: [grant('member')], boundAgentId: null }
const observer: AuthContext = { ...member, userId: 'o1', memberId: 'o1', capabilities: [grant('observer')] }
const agent: AuthContext = { ...member, userId: 'a1', memberId: null, boundAgentId: 'agent-1' }

describe('seed_draft tool', () => {
  const run = (env: Env, a: AuthContext, args: unknown) => invokeTool(a, env, 'seed_draft', args, 'https://pot.test')
  it('is registered with a member floor', () => {
    const spec = TOOLS.find((t) => t.name === 'seed_draft')
    expect(spec?.min).toBe('member')
    expect(spec?.shouldTouchPresence?.({})).toBe(false)
  })
  it('an observer is refused at the floor', async () => {
    const { env } = makeEnv()
    expect(await run(env, observer, { source: { kind: 'repo', url: 'https://github.com/o/r' } })).toMatchObject({ ok: false, status: 403 })
  })
  it('returns draft + keyed requests, writes nothing anywhere, and the text passes the seed_attach dry run unchanged', async () => {
    const { env, snapshot } = makeEnv()
    const before = snapshot()
    for (const a of [member, agent]) {
      const r = await run(env, a, { source: { kind: 'site', url: 'https://wp.example.com', platform: 'wordpress' }, hints: { owner: 'site-owner' } })
      expect(r.ok).toBe(true)
      const res = (r as unknown as { result: { seed_yaml: string; seed_sha: string; valid: boolean; requests: Array<{ key: string; needs: string; text: string }>; warnings: string[]; next: string } }).result
      expect(res.valid).toBe(true)
      expect(res.seed_yaml).toContain('mupot.seed/v1')
      expect(res.requests.length).toBeGreaterThan(0)
      expect(res.requests.every((q) => q.needs === 'human_accept' && q.key.includes(':'))).toBe(true)
      expect(res.next).toMatch(/seed_attach/)
      expect(JSON.stringify(res)).not.toMatch(/accept_token/)
      const dry = (await invokeTool(member, env, 'seed_attach', { seed: res.seed_yaml }, 'https://pot.test')) as unknown as { ok: boolean; result: { seed_sha256: string; requests: Array<{ key: string }> } }
      expect(dry.ok).toBe(true)
      expect(dry.result.seed_sha256).toBe(res.seed_sha)
      expect(dry.result.requests.map((q) => q.key)).toEqual(res.requests.map((q) => q.key))
    }
    expect(snapshot()).toBe(before)
  })
  it('a repo-shape draft goes through the real tool seam and the seed_attach dry run with matching keys and digest', async () => {
    const { env, snapshot } = makeEnv()
    const before = snapshot()
    const r = await run(env, member, { source: { kind: 'repo', url: 'git@github.com:Example-Org/Widget-App.git' }, hints: { owner: 'team-a' } })
    expect(r.ok).toBe(true)
    const res = (r as unknown as { result: { seed_yaml: string; seed_sha: string; requests: Array<{ key: string }>; next: string; warnings: string[] } }).result
    expect(res.seed_yaml).toContain('repo: "https://github.com/Example-Org/Widget-App"')
    expect(res.next).toBe('Review and edit the draft, then call seed_attach (dry run) with this seed; a human org admin then accepts. Nothing here was written or accepted.')
    expect(res.next).not.toMatch(/seed_attach_request|approve/)
    const dry = (await invokeTool(member, env, 'seed_attach', { seed: res.seed_yaml }, 'https://pot.test')) as unknown as { ok: boolean; result: { seed_sha256: string; requests: Array<{ key: string }> } }
    expect(dry.ok).toBe(true)
    expect(dry.result.seed_sha256).toBe(res.seed_sha)
    expect(dry.result.requests.map((q) => q.key)).toEqual(res.requests.map((q) => q.key))
    expect(snapshot()).toBe(before)
  })
  it('refusals are 400 invalid_draft with a path', async () => {
    const { env } = makeEnv()
    const r = await run(env, member, { source: { kind: 'repo', url: 'https://github.com/o/r' }, hints: { owner: 'a\nb' } })
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_draft' })
  })
})
