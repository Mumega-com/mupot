// Parity pin for the four zod call sites (mupot prune-zod). The imports were
// changed from `import { z } from 'zod'` to `import * as z from 'zod'` so the
// bundler drops zod's 64 unused locale modules. That must not change what any
// validator accepts, rejects, or reports. The inline snapshots below were
// captured against the ORIGINAL `{ z }` imports (origin/main abc8ad42) and
// must stay byte-identical after the import change.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { SsoConfigBody } from '../src/auth/sso-routes'
import { SyncBody } from '../src/channels/admin'
import { SeoChannelConfigSchema } from '../src/departments/channels/seo-channel'
import { WordpressChannelConfigSchema } from '../src/departments/channels/wordpress-channel'

type Schema = { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: unknown[] } } }

function verdict(schema: Schema, input: unknown): unknown {
  const r = schema.safeParse(input)
  return r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error?.issues }
}

const SEO_OK = { domain: 'a.com', keywordClusters: ['x'], competitors: [], executor: 'mcpwp' }

describe('zod validators: accept/reject/issue parity', () => {
  it('SyncBody (channels/admin discord sync)', () => {
    const cases: unknown[] = [
      {}, { squadId: 's', dryRun: true }, { squadId: 5 }, { dryRun: 'yes' }, { extra: 1 }, null, 'x', [],
    ]
    expect(cases.map((c) => verdict(SyncBody, c))).toMatchInlineSnapshot(`
      [
        {
          "data": {},
          "ok": true,
        },
        {
          "data": {
            "dryRun": true,
            "squadId": "s",
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "string",
              "message": "Invalid input: expected string, received number",
              "path": [
                "squadId",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "boolean",
              "message": "Invalid input: expected boolean, received string",
              "path": [
                "dryRun",
              ],
            },
          ],
          "ok": false,
        },
        {
          "data": {},
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received null",
              "path": [],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received string",
              "path": [],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received array",
              "path": [],
            },
          ],
          "ok": false,
        },
      ]
    `)
  })

  it('SsoConfigBody (sso config write, strict, default_role allowlist)', () => {
    const cases: unknown[] = [
      {},
      { enabled: true, allowed_domains: ['a.com'], default_role: 'member', enforce_sso: false, idp_provider: 'saml' },
      { default_role: 'observer' },
      { default_role: 'admin' },
      { default_role: 'owner' },
      { idp_provider: 'okta' },
      { allowed_domains: [1] },
      { enabled: 'true' },
      { unknown_key: 1 },
      null,
    ]
    expect(cases.map((c) => verdict(SsoConfigBody, c))).toMatchInlineSnapshot(`
      [
        {
          "data": {},
          "ok": true,
        },
        {
          "data": {
            "allowed_domains": [
              "a.com",
            ],
            "default_role": "member",
            "enabled": true,
            "enforce_sso": false,
            "idp_provider": "saml",
          },
          "ok": true,
        },
        {
          "data": {
            "default_role": "observer",
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "invalid_value",
              "message": "Invalid option: expected one of "observer"|"member"",
              "path": [
                "default_role",
              ],
              "values": [
                "observer",
                "member",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_value",
              "message": "Invalid option: expected one of "observer"|"member"",
              "path": [
                "default_role",
              ],
              "values": [
                "observer",
                "member",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_value",
              "message": "Invalid option: expected one of "google"|"saml"|"generic"",
              "path": [
                "idp_provider",
              ],
              "values": [
                "google",
                "saml",
                "generic",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "string",
              "message": "Invalid input: expected string, received number",
              "path": [
                "allowed_domains",
                0,
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "boolean",
              "message": "Invalid input: expected boolean, received string",
              "path": [
                "enabled",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "unrecognized_keys",
              "keys": [
                "unknown_key",
              ],
              "message": "Unrecognized key: "unknown_key"",
              "path": [],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received null",
              "path": [],
            },
          ],
          "ok": false,
        },
      ]
    `)
  })

  it('SeoChannelConfigSchema', () => {
    const cases: unknown[] = [
      SEO_OK,
      { ...SEO_OK, executor: 'inkwell-content' },
      { ...SEO_OK, domain: '' },
      { ...SEO_OK, executor: 'other' },
      { ...SEO_OK, keywordClusters: 'x' },
      { domain: 'a.com' },
      { ...SEO_OK, extra: 1 },
      undefined,
    ]
    expect(cases.map((c) => verdict(SeoChannelConfigSchema, c))).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "competitors": [],
            "domain": "a.com",
            "executor": "mcpwp",
            "keywordClusters": [
              "x",
            ],
          },
          "ok": true,
        },
        {
          "data": {
            "competitors": [],
            "domain": "a.com",
            "executor": "inkwell-content",
            "keywordClusters": [
              "x",
            ],
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "too_small",
              "inclusive": true,
              "message": "Too small: expected string to have >=1 characters",
              "minimum": 1,
              "origin": "string",
              "path": [
                "domain",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_value",
              "message": "Invalid option: expected one of "inkwell-content"|"mcpwp"",
              "path": [
                "executor",
              ],
              "values": [
                "inkwell-content",
                "mcpwp",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "array",
              "message": "Invalid input: expected array, received string",
              "path": [
                "keywordClusters",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "array",
              "message": "Invalid input: expected array, received undefined",
              "path": [
                "keywordClusters",
              ],
            },
            {
              "code": "invalid_type",
              "expected": "array",
              "message": "Invalid input: expected array, received undefined",
              "path": [
                "competitors",
              ],
            },
            {
              "code": "invalid_value",
              "message": "Invalid option: expected one of "inkwell-content"|"mcpwp"",
              "path": [
                "executor",
              ],
              "values": [
                "inkwell-content",
                "mcpwp",
              ],
            },
          ],
          "ok": false,
        },
        {
          "data": {
            "competitors": [],
            "domain": "a.com",
            "executor": "mcpwp",
            "keywordClusters": [
              "x",
            ],
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received undefined",
              "path": [],
            },
          ],
          "ok": false,
        },
      ]
    `)
  })

  it('WordpressChannelConfigSchema', () => {
    const cases: unknown[] = [{ domain: 'a.com' }, { domain: '' }, { domain: 3 }, {}, { domain: 'a', extra: 1 }, null]
    expect(cases.map((c) => verdict(WordpressChannelConfigSchema, c))).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "domain": "a.com",
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "too_small",
              "inclusive": true,
              "message": "Too small: expected string to have >=1 characters",
              "minimum": 1,
              "origin": "string",
              "path": [
                "domain",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "string",
              "message": "Invalid input: expected string, received number",
              "path": [
                "domain",
              ],
            },
          ],
          "ok": false,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "string",
              "message": "Invalid input: expected string, received undefined",
              "path": [
                "domain",
              ],
            },
          ],
          "ok": false,
        },
        {
          "data": {
            "domain": "a",
          },
          "ok": true,
        },
        {
          "issues": [
            {
              "code": "invalid_type",
              "expected": "object",
              "message": "Invalid input: expected object, received null",
              "path": [],
            },
          ],
          "ok": false,
        },
      ]
    `)
  })
})

describe('zod bundle shape', () => {
  it('no src file uses the locale-retaining `import { z } from "zod"` form', () => {
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && /from ['"]zod['"]/.test(readFileSync(p, 'utf8')) &&
          !/import \* as z from ['"]zod['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(join(__dirname, '..', 'src'))
    expect(offenders).toEqual([])
  })

  it('bundling a validator pulls in no zod locale modules other than en', () => {
    const r = buildSync({
      entryPoints: [join(__dirname, '..', 'src/departments/channels/wordpress-channel.ts')],
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral',
      mainFields: ['module', 'main'], conditions: ['import'], logLevel: 'silent',
    })
    // metafile.inputs lists every parsed module even when tree-shaken; bytesInOutput is what ships.
    const shipped: string[] = []
    for (const out of Object.values(r.metafile.outputs)) {
      for (const [k, v] of Object.entries(out.inputs)) {
        if (k.includes('zod/v4/locales/') && v.bytesInOutput > 0 && !k.endsWith('/en.js')) shipped.push(k)
      }
    }
    expect(shipped).toEqual([])
  })
})
