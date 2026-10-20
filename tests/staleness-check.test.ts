// tests/staleness-check.test.ts — scripts/staleness-check.mjs, the mupot#443
// Part B staleness detector. Covers the pure decision logic (current / drift /
// unstamped / unreachable / error) with an injected fetch mock — no network
// calls, no dependency on any pot actually being live.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPot, checkAllPots, formatReport, runCheck, exitCodeFor, probeLegacyPot } from '../scripts/staleness-check.mjs'
import { deploymentPots, legacyPots, resolveUpdateTargets, validateManifest } from '../scripts/lib/pots-manifest.mjs'

const HEAD = 'a'.repeat(40)

function jsonFetch(body, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    json: async () => body,
  })
}

describe('checkPot', () => {
  it('reports "current" when the live commit exactly matches HEAD', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD, clean: true }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'current', head: HEAD, live: HEAD })
  })

  it('matches case-insensitively (git shas are case-insensitive)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD.toUpperCase(), {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD, clean: true }),
    })
    expect(r.status).toBe('current')
  })

  it('reports "unverified" when the commit matches but health says clean:false', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD, clean: false }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'unverified', head: HEAD, live: HEAD, clean: false })
  })

  it('reports "drift" when the live commit differs from HEAD — the exact #443 scenario', async () => {
    const staleSha = 'b'.repeat(40)
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: staleSha }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'drift', head: HEAD, live: staleSha })
  })

  it('reports "unstamped" when commit is null (the bug this closes)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: null }),
    })
    expect(r.status).toBe('unstamped')
  })

  it('reports "unstamped" when commit is missing from the response entirely', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega' }),
    })
    expect(r.status).toBe('unstamped')
  })

  it('reports "unreachable" with the http status on a non-2xx response', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({}, false, 503),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'unreachable', head: HEAD, http: 503 })
  })

  it('reports "error" when the fetch itself throws (network failure, DNS, timeout)', async () => {
    const r = await checkPot(
      { slug: 'mumega', health: 'https://x/health' },
      HEAD,
      { fetchImpl: async () => { throw new Error('boom') } },
    )
    expect(r.status).toBe('error')
    expect(r.error).toContain('boom')
  })

  // mupot#571 fix 3 — a 2xx HTTP response with a matching commit is NOT
  // enough on its own. Require app-level ok:true AND the expected tenant.
  it('reports "unhealthy" when the app-level ok flag is false, even though HTTP is 2xx and the commit matches', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: false, tenant: 'mumega', commit: HEAD }),
    })
    expect(r.status).toBe('unhealthy')
  })

  it('reports "unhealthy" when the ok field is missing entirely', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ tenant: 'mumega', commit: HEAD }),
    })
    expect(r.status).toBe('unhealthy')
  })

  it('reports "wrong_tenant" when a healthy-looking response names a DIFFERENT tenant, even with a matching commit — the exact misroute this closes', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'digid', commit: HEAD }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'wrong_tenant', head: HEAD, tenant: 'digid', expected: 'mumega' })
  })

  it('validates against an explicit pot.tenant field when the manifest entry carries one', () => {
    return checkPot({ slug: 'mumega-alias', tenant: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD, clean: true }),
    }).then((r) => expect(r.status).toBe('current'))
  })

  it('reports "wrong_tenant" before ever looking at "unstamped" — tenant identity is checked first', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'viamar' }),
    })
    expect(r.status).toBe('wrong_tenant')
  })
})

describe('checkAllPots', () => {
  it('checks every pot in the manifest and preserves per-pot results', async () => {
    const manifestPath = new URL('./fixtures/staleness-manifest.json', import.meta.url).pathname
    const results = await checkAllPots({
      manifestPath,
      head: HEAD,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          tenant: String(url).includes('drifted') ? 'drifted-pot' : 'current-pot',
          commit: String(url).includes('drifted') ? 'c'.repeat(40) : HEAD,
          clean: true,
        }),
      }),
    })
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.slug === 'current-pot')?.status).toBe('current')
    expect(results.find((r) => r.slug === 'drifted-pot')?.status).toBe('drift')
  })
})

describe('formatReport', () => {
  it('renders a human-readable line per pot with the right marker for each status', () => {
    const out = formatReport(HEAD, [
      { slug: 'a', status: 'current', head: HEAD, live: HEAD },
      { slug: 'b', status: 'drift', head: HEAD, live: 'c'.repeat(40) },
      { slug: 'c', status: 'unstamped', head: HEAD },
      { slug: 'd', status: 'unreachable', head: HEAD, http: 500 },
      { slug: 'e', status: 'error', head: HEAD, error: 'timeout' },
      { slug: 'f', status: 'unhealthy', head: HEAD, ok: false },
      { slug: 'g', status: 'wrong_tenant', head: HEAD, tenant: 'digid', expected: 'mumega' },
      { slug: 'h', status: 'unverified', head: HEAD, live: HEAD, clean: false },
    ])
    expect(out).toContain(HEAD)
    expect(out).toContain('✓ current')
    expect(out).toContain('⚠ DRIFT')
    expect(out).toContain('✘ UNSTAMPED')
    expect(out).toContain('✘ UNREACHABLE (http 500)')
    expect(out).toContain('✘ ERROR (timeout)')
    expect(out).toContain('✘ UNHEALTHY (ok=false)')
    expect(out).toContain("✘ WRONG TENANT (got 'digid', expected 'mumega')")
    expect(out).toContain('✘ UNVERIFIED BUILD (clean=false)')
  })

  // mupot#571 fix 5 — the report header must never assert a ref it didn't
  // verify. Pre-fix, this was hardcoded to "main HEAD" unconditionally,
  // regardless of what ref a workflow_dispatch run actually built.
  describe('ref honesty (mupot#571 fix 5)', () => {
    it('does not assume "main" when no ref is supplied', () => {
      const out = formatReport(HEAD, [])
      expect(out).not.toMatch(/\bmain\b/i)
      expect(out).toContain(`HEAD ${HEAD}`)
    })

    it('reports the actual ref a workflow_dispatch run built against, not an assumed default', () => {
      const out = formatReport(HEAD, [], { ref: 'fix/some-other-branch' })
      expect(out).toContain(`ref 'fix/some-other-branch' @ ${HEAD}`)
      expect(out).not.toMatch(/main HEAD/)
    })

    it('reports "main" only when that IS the real supplied ref — never by default', () => {
      const out = formatReport(HEAD, [], { ref: 'main' })
      expect(out).toContain(`ref 'main' @ ${HEAD}`)
    })
  })
})

// ── mupot#2107 M1 — legacy pots are informational; deployment pots still gate ──
describe('legacy pots (mupot#2107 M1)', () => {
  const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname
  const H = 'cafe'.repeat(10)

  // current-pot is healthy and at HEAD unless `deployDrift`; legacy hosts follow `legacy`.
  function fetchFor({ deployDrift = false, legacy = 'down' }: { deployDrift?: boolean; legacy?: 'down' | 'up' | 'throws' } = {}) {
    return async (url: string) => {
      const u = String(url)
      if (u.includes('current.example')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, tenant: 'current-pot', commit: deployDrift ? 'b'.repeat(40) : H, clean: true }) }
      }
      if (u.includes('drifted.example')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, tenant: 'drifted-pot', commit: 'c'.repeat(40), clean: true }) }
      }
      if (legacy === 'throws') throw new Error('ECONNREFUSED')
      if (legacy === 'up') return { ok: true, status: 200, json: async () => ({ ok: true, tenant: 'whatever', commit: 'd'.repeat(40) }) }
      return { ok: false, status: 503, json: async () => ({}) }
    }
  }

  it('deployment drift still fails the run (exit 1) even when legacy pots are fine', async () => {
    const r = await runCheck({ manifestPath: fx('staleness-manifest-legacy.json'), requiredSlug: 'current-pot', head: H, fetchImpl: fetchFor({ deployDrift: true, legacy: 'up' }) })
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('  current-pot ⚠ DRIFT (live=bbbbbbbbbbbb)')
  })

  it('legacy pots unreachable (http 503) do NOT fail the run: exit 0, reported as informational', async () => {
    const r = await runCheck({ manifestPath: fx('staleness-manifest-legacy.json'), requiredSlug: 'current-pot', head: H, fetchImpl: fetchFor({ legacy: 'down' }) })
    expect(r.exitCode).toBe(0)
    expect(r.output.split('\n')).toEqual([
      `mupot staleness check — HEAD ${H}`,
      '',
      '  current-pot ✓ current',
      '',
      'legacy pots (frozen, informational only — not counted, see #2107)',
      '  old-a      unreachable (http 503)',
      '  old-b      unreachable (http 503)',
    ])
  })

  it('legacy fetch throwing does NOT fail the run and is reported with its error', async () => {
    const r = await runCheck({ manifestPath: fx('staleness-manifest-legacy.json'), requiredSlug: 'current-pot', head: H, fetchImpl: fetchFor({ legacy: 'throws' }) })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('  old-a      unreachable (ECONNREFUSED)')
  })

  it('a reachable legacy pot reports its live commit but never affects the exit code, even when it differs from HEAD', async () => {
    const r = await runCheck({ manifestPath: fx('staleness-manifest-legacy.json'), requiredSlug: 'current-pot', head: H, fetchImpl: fetchFor({ legacy: 'up' }) })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('  old-a      reachable — NOT verified (live=dddddddddddd, tenant=whatever), informational only')
    expect(r.legacy.map((l: { slug: string; status: string }) => `${l.slug}:${l.status}`)).toEqual(['old-a:reachable', 'old-b:reachable'])
  })

  it('legacy absent = old behaviour: exact old report, no legacy section, no legacy key in --json', async () => {
    const manifestPath = fx('staleness-manifest.json') // no `legacy` key
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, tenant: String(url).includes('drifted') ? 'drifted-pot' : 'current-pot', commit: String(url).includes('drifted') ? 'c'.repeat(40) : H, clean: true }),
    })
    const r = await runCheck({ manifestPath, requiredSlug: 'current-pot', head: H, fetchImpl })
    expect(r.exitCode).toBe(1)
    expect(r.output.split('\n')).toEqual([
      `mupot staleness check — HEAD ${H}`,
      '',
      '  current-pot ✓ current',
      '  drifted-pot ⚠ DRIFT (live=cccccccccccc)',
    ])
    const j = await runCheck({ manifestPath, requiredSlug: 'current-pot', head: H, json: true, fetchImpl })
    expect(Object.keys(JSON.parse(j.output))).toEqual(['head', 'ref', 'pots'])
  })

  it('a pot moved to legacy is never treated as a deployment: its drift does not fail the run and checkAllPots omits it', async () => {
    const manifestPath = fx('staleness-manifest-moved.json')
    const fetchImpl = fetchFor()
    const deployments = await checkAllPots({ manifestPath, head: H, fetchImpl })
    expect(deployments.map((d: { slug: string }) => d.slug)).toEqual(['current-pot'])
    const r = await runCheck({ manifestPath, requiredSlug: 'current-pot', head: H, fetchImpl })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('  drifted-pot reachable — NOT verified (live=cccccccccccc, tenant=drifted-pot), informational only')
    expect(r.output).not.toContain('DRIFT')
  })

  it('exitCodeFor takes deployment results only: one non-current => 1, all current => 0, empty => 1', () => {
    expect(exitCodeFor([{ status: 'current' }])).toBe(0)
    expect(exitCodeFor([{ status: 'current' }, { status: 'error' }])).toBe(1)
    expect(exitCodeFor([])).toBe(1) // nothing verified is never green
  })

  it('the real pots.manifest.json keeps only mumega as a deployment and freezes viamar + digid under legacy', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../pots.manifest.json', import.meta.url).pathname, 'utf8'))
    expect(deploymentPots(manifest).map((p: { slug: string }) => p.slug)).toEqual(['mumega'])
    expect(legacyPots(manifest).map((p: { slug: string; status: string }) => `${p.slug}:${p.status}`)).toEqual(['viamar:frozen', 'digid:frozen'])
    for (const p of legacyPots(manifest)) {
      expect(p.note).toContain('#2107')
      expect(p.health).toMatch(/^https:\/\//)
    }
  })
})

describe('fail closed on a malformed manifest (mupot#2107 M1 round 2)', () => {
  const H = 'cafe'.repeat(10)
  const okPot = { slug: 'mumega', config: null, db: 'mupot', health: 'https://mumega.example/health' }
  const frozen = (slug: string) => ({ slug, status: 'frozen', note: 'see #2107', config: null, db: slug, health: `https://${slug}.example/health` })
  const dir = mkdtempSync(join(tmpdir(), 'staleness-manifest-'))
  let n = 0
  function manifestFile(body: unknown): string {
    const f = join(dir, `m${n++}.json`)
    writeFileSync(f, JSON.stringify(body))
    return f
  }
  // Every probe would answer healthy+current — so a green result could only come from skipping validation.
  const allGreen = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, tenant: 'mumega', commit: H, clean: true }) })
  const run = (body: unknown) => runCheck({ manifestPath: manifestFile(body), head: H, fetchImpl: allGreen })
  const lines = (out: string) => out.split('\n')
  const NO_POTS = '  ✘ manifest: no deployment pots — refusing to report green'

  it.each([
    ['`pots` key misspelled as `pot`', { pot: [okPot] }],
    ['`pots` is an object, not an array', { pots: {} }],
    ['`pots` is an empty array', { pots: [] }],
    ['`pots` missing entirely', { legacy: [frozen('viamar')] }],
  ])('%s => exit 1 with the exact refusal line', async (_name, body) => {
    const r = await run(body)
    expect(r.exitCode).toBe(1)
    expect(lines(r.output)).toEqual([`mupot staleness check — HEAD ${H}`, '', NO_POTS])
    expect(r.results).toEqual([])
  })

  it('mumega moved into legacy => exit 1: "deployment pots do not include \'mumega\'"', async () => {
    const r = await run({ pots: [{ ...okPot, slug: 'other', health: 'https://other.example/health' }], legacy: [frozen('mumega')] })
    expect(r.exitCode).toBe(1)
    expect(lines(r.output)).toEqual([
      `mupot staleness check — HEAD ${H}`,
      '',
      "  ✘ manifest: deployment pots do not include 'mumega' — refusing to report green",
    ])
  })

  it('--json carries manifest_errors and no pots on a refused manifest', async () => {
    const r = await runCheck({ manifestPath: manifestFile({ pots: [] }), head: H, json: true, fetchImpl: allGreen })
    expect(r.exitCode).toBe(1)
    expect(JSON.parse(r.output)).toEqual({ head: H, ref: null, manifest_errors: ['manifest: no deployment pots — refusing to report green'] })
  })

  it('a slug in BOTH pots and legacy => exit 1 with the exact overlap line', async () => {
    const r = await run({ pots: [okPot], legacy: [frozen('mumega')] })
    expect(r.exitCode).toBe(1)
    expect(lines(r.output)).toEqual([
      `mupot staleness check — HEAD ${H}`,
      '',
      "  ✘ manifest: slug 'mumega' is in both pots and legacy",
    ])
  })

  it('a legacy entry without status "frozen" => exit 1 with the exact line', async () => {
    const r = await run({ pots: [okPot], legacy: [{ ...frozen('viamar'), status: 'active' }] })
    expect(r.exitCode).toBe(1)
    expect(lines(r.output)).toContain('  ✘ manifest: legacy \'viamar\' must have status "frozen"')
  })

  it.each([
    ['null', null],
    ['no slug', { health: 'https://x.example/health', status: 'frozen' }],
    ['a string', 'viamar'],
  ])('a malformed legacy entry (%s) is a manifest error => exit 1, never an uncaught throw', async (_name, bad) => {
    const r = await run({ pots: [okPot], legacy: [bad] })
    expect(r.exitCode).toBe(1)
    expect(lines(r.output)).toEqual([
      `mupot staleness check — HEAD ${H}`,
      '',
      '  ✘ manifest: legacy[0] is malformed (no slug)',
    ])
  })

  it('probeLegacyPot itself never throws on a malformed entry', async () => {
    await expect(probeLegacyPot(null)).resolves.toEqual({ slug: '?', kind: 'legacy', status: 'unreachable', error: 'malformed legacy entry' })
    await expect(probeLegacyPot({ health: 'x' })).resolves.toMatchObject({ status: 'unreachable', error: 'malformed legacy entry' })
  })

  it('a valid mumega + frozen legacy manifest is still green (the guards do not over-fire)', async () => {
    const r = await run({ pots: [okPot], legacy: [frozen('viamar')] })
    expect(r.exitCode).toBe(0)
    expect(r.errors).toEqual([])
  })

  it('validateManifest returns no errors for the shipped manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../pots.manifest.json', import.meta.url).pathname, 'utf8'))
    expect(validateManifest(manifest)).toEqual([])
  })
})

describe('mupot-update target resolution (mupot#2107 M1)', () => {
  const manifest = {
    pots: [{ slug: 'mumega', db: 'mupot' }],
    legacy: [{ slug: 'viamar', status: 'frozen' }, { slug: 'digid', status: 'frozen' }],
  }

  it('a slug in both pots and legacy is refused for --all and by name (neither list wins)', () => {
    const both = { pots: [{ slug: 'mumega', db: 'mupot' }], legacy: [{ slug: 'mumega', status: 'frozen' }] }
    const msg = "manifest: slug 'mumega' is in both pots and legacy"
    expect(resolveUpdateTargets(both, '--all')).toEqual({ targets: [], skippedLegacy: ['mumega'], error: msg })
    expect(resolveUpdateTargets(both, 'mumega')).toEqual({ targets: [], skippedLegacy: ['mumega'], error: msg })
  })

  it('an unfrozen legacy entry is refused', () => {
    const r = resolveUpdateTargets({ pots: manifest.pots, legacy: [{ slug: 'viamar', status: 'active' }] }, '--all')
    expect(r.targets).toEqual([])
    expect(r.error).toBe('manifest: legacy \'viamar\' must have status "frozen"')
  })

  it('a malformed legacy entry is refused, not thrown on', () => {
    const r = resolveUpdateTargets({ pots: manifest.pots, legacy: [null] }, '--all')
    expect(r.targets).toEqual([])
    expect(r.error).toBe('manifest: legacy[0] is malformed (no slug)')
  })

  it('--all selects deployment entries only and names legacy as skipped', () => {
    const r = resolveUpdateTargets(manifest, '--all')
    expect(r.targets.map((t: { slug: string }) => t.slug)).toEqual(['mumega'])
    expect(r.skippedLegacy).toEqual(['viamar', 'digid'])
    expect(r.error).toBeNull()
  })

  it('naming a legacy slug is refused with a frozen-legacy error and no targets', () => {
    const r = resolveUpdateTargets(manifest, 'viamar')
    expect(r.targets).toEqual([])
    expect(r.error).toBe("'viamar' is a frozen legacy pot (#2107) — mupot-update does not deploy legacy pots.")
  })

  it('an unknown slug lists only deployment slugs as known', () => {
    expect(resolveUpdateTargets(manifest, 'nope').error).toBe("unknown pot 'nope'. Known: mumega")
  })

  it('no legacy key = old behaviour with an empty skipped list', () => {
    const r = resolveUpdateTargets({ pots: manifest.pots }, '--all')
    expect(r.targets).toHaveLength(1)
    expect(r.skippedLegacy).toEqual([])
  })
})
