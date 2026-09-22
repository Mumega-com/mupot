// tests/pot-bundle-r2.test.ts — scripts/lib/pot-bundle-r2.mjs, the shared core for
// scripts/publish-pot-bundle.mjs and scripts/verify-pot-bundle.mjs (mupot#1285/#1516
// enablement, docs/workflows/tenant-provision.md "CI publish output contract").
//
// Covers: digest/metadata-key/object-key construction, the dirty-tree/RELEASE_SHA-mismatch
// refusals (same discipline as scripts/deploy.mjs), the dedicated-R2-credential env-var
// refusal (Athena round-1 ruling, 2026-09-22 — NOT derived from CLOUDFLARE_API_TOKEN), and
// the PUT/GET round trip with `fetch` mocked (fake fetch, per this repo's established DI
// pattern — see tests/secret-env-cf.test.ts's `fetchImpl` parameter, mirrored here) — never
// against live R2.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  POT_WORKER_BUNDLE_SHA256_METADATA_KEY,
  POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT,
  R2_POT_BUNDLES_ACCESS_KEY_ID_ENV,
  R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV,
  bundleObjectKey,
  sha256HexOfUtf8Text,
  assertPublishPreconditions,
  r2ObjectUrl,
  readR2PotBundlesCredentials,
  putPotWorkerBundleObject,
  verifyPotWorkerBundleObject,
  buildVerifyReceipt,
  buildPublishReceipt,
  BundleShaConflictError,
  BundlePublishUnconfirmedError,
} from '../scripts/lib/pot-bundle-r2.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const fakeR2FetchPreload = fileURLToPath(new URL('./fixtures/fake-r2-fetch-preload.mjs', import.meta.url))

// The digest/metadata-key contract this whole module exists to satisfy is defined in
// src/pots/service.ts's loadPotWorkerBundle — this pins the ONE literal that must never
// silently drift between the two files, since nothing else (types, tests on the other
// side) would catch a rename here failing to match a rename there.
const potServiceSource = readFileSync(new URL('../src/pots/service.ts', import.meta.url), 'utf8')

describe('POT_WORKER_BUNDLE_SHA256_METADATA_KEY parity with src/pots/service.ts', () => {
  it('matches the literal loadPotWorkerBundle actually reads', () => {
    const m = /export const POT_WORKER_BUNDLE_SHA256_METADATA_KEY = '([^']+)'/.exec(potServiceSource)
    expect(m, 'src/pots/service.ts must still export this literal — update the regex above if it moved').not.toBeNull()
    expect(POT_WORKER_BUNDLE_SHA256_METADATA_KEY).toBe(m![1])
  })
})

describe('bundleObjectKey', () => {
  it('builds ${releaseSha}/worker.js exactly as loadPotWorkerBundle does', () => {
    const sha = 'a'.repeat(40)
    expect(bundleObjectKey(sha)).toBe(`${sha}/worker.js`)
  })
})

describe('sha256HexOfUtf8Text', () => {
  it('matches a known sha256 hex digest', async () => {
    // sha256("hello world") — a widely-known test vector.
    expect(sha256HexOfUtf8Text('hello world')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('matches src/members/service.ts sha256Hex for the same input (cross-check via WebCrypto)', async () => {
    const text = 'const x = 1; // a fake worker bundle\n'
    const expected = sha256HexOfUtf8Text(text)
    const data = new TextEncoder().encode(text)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const bytes = new Uint8Array(digest)
    let s = ''
    for (const b of bytes) s += b.toString(16).padStart(2, '0')
    expect(expected).toBe(s)
  })

  it('is sensitive to a single-byte change (never a coincidental collision on realistic input)', () => {
    expect(sha256HexOfUtf8Text('a')).not.toBe(sha256HexOfUtf8Text('b'))
  })
})

describe('assertPublishPreconditions', () => {
  const headSha = 'c'.repeat(40)

  it('allows a clean tree with releaseSha === headSha', () => {
    expect(() => assertPublishPreconditions({ dirty: false, headSha, releaseSha: headSha })).not.toThrow()
  })

  it('refuses a dirty working tree even when releaseSha matches HEAD', () => {
    expect(() => assertPublishPreconditions({ dirty: true, headSha, releaseSha: headSha })).toThrow(
      /DIRTY working tree/,
    )
  })

  it('refuses when releaseSha is not a full 40-hex sha', () => {
    expect(() => assertPublishPreconditions({ dirty: false, headSha, releaseSha: 'main' })).toThrow(
      /not a full 40-hex commit sha/,
    )
  })

  it('refuses a -dirty-suffixed stamp (never a valid publish target)', () => {
    expect(() =>
      assertPublishPreconditions({ dirty: false, headSha, releaseSha: `${headSha}-dirty` }),
    ).toThrow(/not a full 40-hex commit sha/)
  })

  it('refuses when releaseSha is a full sha but does not match HEAD', () => {
    const otherSha = 'd'.repeat(40)
    expect(() => assertPublishPreconditions({ dirty: false, headSha, releaseSha: otherSha })).toThrow(
      /does not match HEAD/,
    )
  })
})

describe('r2ObjectUrl', () => {
  it('builds the account-id-hosted, bucket-first-path-segment S3-compatible URL', () => {
    const sha = 'e'.repeat(40)
    expect(r2ObjectUrl({ accountId: 'acct123', bucket: 'mupot-pot-bundles', key: bundleObjectKey(sha) })).toBe(
      `https://acct123.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`,
    )
  })
})

// Athena round-1 ruling (2026-09-22): NO derivation from CLOUDFLARE_API_TOKEN and no
// token-verification network call of any kind — a dedicated, bucket-scoped R2 credential
// pair read straight from the environment, refused by NAME (never by value), synchronously,
// before any network call.
describe('readR2PotBundlesCredentials', () => {
  it('reads both env vars when present', () => {
    const creds = readR2PotBundlesCredentials({
      [R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]: 'ak-123',
      [R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV]: 'sk-456',
    })
    expect(creds).toEqual({ accessKeyId: 'ak-123', secretAccessKey: 'sk-456' })
  })

  it('throws naming ONLY the missing var when the access key id is absent', () => {
    expect(() => readR2PotBundlesCredentials({ [R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV]: 'sk-456' })).toThrow(
      new RegExp(`missing required environment variable\\(s\\): ${R2_POT_BUNDLES_ACCESS_KEY_ID_ENV}(?!.*${R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV})`),
    )
  })

  it('throws naming ONLY the missing var when the secret access key is absent', () => {
    expect(() => readR2PotBundlesCredentials({ [R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]: 'ak-123' })).toThrow(
      new RegExp(`missing required environment variable\\(s\\): ${R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV} —`),
    )
  })

  it('throws naming BOTH vars when neither is set', () => {
    expect(() => readR2PotBundlesCredentials({})).toThrow(
      new RegExp(`${R2_POT_BUNDLES_ACCESS_KEY_ID_ENV}, ${R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV}`),
    )
  })

  it('treats a blank/whitespace-only value the same as absent', () => {
    expect(() =>
      readR2PotBundlesCredentials({
        [R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]: '   ',
        [R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV]: 'sk-456',
      }),
    ).toThrow(new RegExp(R2_POT_BUNDLES_ACCESS_KEY_ID_ENV))
  })

  it('never includes the credential VALUES in the thrown message, even when one is present', () => {
    let thrown: unknown
    try {
      readR2PotBundlesCredentials({ [R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]: 'super-secret-access-key-value' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).not.toContain('super-secret-access-key-value')
  })

  it('is synchronous — returns the credentials object directly, never a Promise (no network call is possible)', () => {
    const result = readR2PotBundlesCredentials({
      [R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]: 'ak',
      [R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV]: 'sk',
    })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ accessKeyId: 'ak', secretAccessKey: 'sk' })
  })

  it('never reads CLOUDFLARE_API_TOKEN as a fallback', () => {
    expect(() =>
      readR2PotBundlesCredentials({ CLOUDFLARE_API_TOKEN: 'some-deploy-token-value' }),
    ).toThrow(new RegExp(`${R2_POT_BUNDLES_ACCESS_KEY_ID_ENV}, ${R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV}`))
  })
})

const fakeSigningClient = () => ({
  // Mirrors aws4fetch's AwsClient.sign(request) -> Promise<Request> shape closely enough
  // to exercise this module's own logic without real SigV4 signing or credentials — the
  // REAL signer (aws4fetch) is a well-known, Cloudflare-recommended, independently-tested
  // library; what this module owns and must verify itself is the URL/headers/body it
  // hands to that signer, not SigV4 math.
  sign: vi.fn(async (req: Request) => req),
})

/** Every `putPotWorkerBundleObject` call now does a pre-PUT read FIRST (mupot#1524
 *  round-2 P2-1) — a fetchImpl mock that only handles a single PUT call must answer a
 *  leading GET (with 404, "nothing published yet") before its PUT-specific assertions, or
 *  the mock will see a GET where it expects a PUT and fail for the wrong reason. This
 *  helper builds that "first call is the not-yet-published pre-check" wrapper once. */
function withNotYetPublishedPreCheck(handlePut: (req: Request, call: number) => Promise<Response> | Response) {
  let call = 0
  return vi.fn(async (req: Request) => {
    call++
    if (call === 1) {
      expect(req.method).toBe('GET')
      return new Response('', { status: 404 })
    }
    return handlePut(req, call)
  })
}

describe('putPotWorkerBundleObject', () => {
  it('does a pre-PUT GET first; when nothing is published yet, PUTs to the exact object key with the sha256 recorded as x-amz-meta-sha256, a conditional If-None-Match, and a SIGNED payload (never UNSIGNED-PAYLOAD)', async () => {
    const sha = 'f'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = withNotYetPublishedPreCheck((req) => {
      expect(req.method).toBe('PUT')
      expect(req.url).toBe(`https://acct.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`)
      expect(req.headers.get(`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`)).toBe(
        sha256HexOfUtf8Text('console.log(1)'),
      )
      expect(req.headers.get('If-None-Match')).toBe('*')
      expect(req.headers.get('X-Amz-Content-Sha256')).toBe(sha256HexOfUtf8Text('console.log(1)'))
      expect(req.headers.get('X-Amz-Content-Sha256')).not.toBe('UNSIGNED-PAYLOAD')
      return new Response('', { status: 200 })
    })
    const receipt = await putPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      bodyText: 'console.log(1)',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(receipt).toEqual({
      key: `${sha}/worker.js`,
      sha256: sha256HexOfUtf8Text('console.log(1)'),
      size: Buffer.byteLength('console.log(1)', 'utf8'),
      bucket: 'mupot-pot-bundles',
      url: `https://<redacted-account>.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`,
      alreadyPublished: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(signingClient.sign).toHaveBeenCalledTimes(2)
  })

  it('throws (never swallows) a non-2xx PUT response', async () => {
    const sha = '1'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = withNotYetPublishedPreCheck(() => new Response('access denied', { status: 403 }))
    await expect(
      putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: sha,
        bodyText: 'x',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/R2 PUT.*failed.*403/s)
  })

  // mupot#1524 round-2 P1: the redaction fix this replaces (`redactS3ErrorBody`) scrubbed
  // ONE tag (<AWSAccessKeyId>) and passed the rest of the body through verbatim — a real S3
  // error body's other tags (<BucketName>, <Endpoint>, <HostId>, <RequestId>) can carry
  // CLOUDFLARE_ACCOUNT_ID and the bucket name straight into the thrown message. The fix is
  // an ALLOW-LIST (Athena's rule: a printed field must be NAMED to be printed) — only HTTP
  // status + the S3 <Code> element ever reach the message. See the dedicated
  // "PUT/GET failure allow-list" describe block below for the full sentinel-account/bucket
  // coverage of both the PUT and GET failure paths.
  it('never echoes the raw PUT failure body — only HTTP status + <Code> reach the thrown message', async () => {
    const sha = '9'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = withNotYetPublishedPreCheck(
      () =>
        new Response(
          '<Error><Code>InvalidAccessKeyId</Code><AWSAccessKeyId>SUPERSECRETKEYID</AWSAccessKeyId>' +
            '<BucketName>super-secret-bucket</BucketName><Endpoint>super-secret-bucket.acct123.r2.cloudflarestorage.com</Endpoint></Error>',
          { status: 403 },
        ),
    )
    let thrown: unknown
    try {
      await putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: sha,
        bodyText: 'x',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).not.toContain('SUPERSECRETKEYID')
    expect(message).not.toContain('super-secret-bucket')
    expect(message).not.toContain('acct123')
    expect(message).not.toContain('<BucketName>')
    expect(message).not.toContain('<Endpoint>')
    expect(message).toContain('InvalidAccessKeyId')
    expect(message).toContain('403')
  })

  // mupot#1529 round-1 P2(1): the allow-list's `<Code>` match was case-INSENSITIVE and
  // uncapped. An HTML error page from an intermediary in front of R2 (a CDN, a load
  // balancer returning a 502) is not R2's own S3 XML schema at all — it can carry a
  // lowercase `<code>` HTML tag with completely unrelated content, including a hostname.
  it('an HTML 502 body with a hostname inside a lowercase <code> tag never leaks it — case-sensitive match, HTTP <status> only', async () => {
    const sha = 'd'.repeat(40)
    const signingClient = fakeSigningClient()
    const hostname = 'internal-lb-07.acct123.r2.cloudflarestorage.com'
    const fetchImpl = withNotYetPublishedPreCheck(
      () =>
        new Response(
          `<html><body><h1>502 Bad Gateway</h1><p>host: <code>${hostname}</code></p></body></html>`,
          { status: 502 },
        ),
    )
    let thrown: unknown
    try {
      await putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: sha,
        bodyText: 'x',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).not.toContain(hostname)
    expect(message).not.toContain('acct123')
    expect(message).not.toContain('<code>')
    expect(message).toContain('502')
    // No S3 <Code> element exists in this body at all — the message must be HTTP <status>
    // alone, no parenthesized code of any kind.
    expect(message).not.toMatch(/\(\w+\)/)
  })

  // mupot#1529 round-1 P2(1): an uncapped match let a hostile/corrupted multi-megabyte
  // <Code> value roughly double the thrown message's size for zero diagnostic benefit.
  it('a 2 MB <Code> value is refused by the grammar check — never embedded in the thrown message', async () => {
    const sha = 'e'.repeat(40)
    const signingClient = fakeSigningClient()
    const hugeCode = 'A'.repeat(2 * 1024 * 1024)
    const fetchImpl = withNotYetPublishedPreCheck(() => new Response(`<Error><Code>${hugeCode}</Code></Error>`, { status: 500 }))
    let thrown: unknown
    try {
      await putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: sha,
        bodyText: 'x',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message.length).toBeLessThan(200) // nowhere near 2 MB
    expect(message).not.toContain(hugeCode)
    expect(message).toBe(`R2 PUT '${sha}/worker.js' failed: HTTP 500`)
  })

  // mupot#1524 round-2 P2-1: `If-None-Match: '*'` alone trusts the SERVER to enforce the
  // conditional write. This describe block covers the PRE-PUT read layer, which does not
  // depend on server enforcement at all.
  describe('pre-PUT digest check (P2-1) — a server that ignores If-None-Match must still be refused', () => {
    const sha = '4'.repeat(40)
    const bodyText = 'export default { fetch() {} }'
    const digest = sha256HexOfUtf8Text(bodyText)

    it('an IDENTICAL existing digest short-circuits to alreadyPublished with ZERO PUT calls (one fetch total)', async () => {
      const signingClient = fakeSigningClient()
      const fetchImpl = vi.fn(async (req: Request) => {
        expect(req.method).toBe('GET') // the pre-check — no PUT should ever be attempted.
        return new Response(bodyText, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: digest },
        })
      })
      const receipt = await putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: sha,
        bodyText,
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(receipt.alreadyPublished).toBe(true)
      expect(receipt.sha256).toBe(digest)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls.every((call) => (call[0] as Request).method !== 'PUT')).toBe(true)
    })

    it('a DIFFERENT existing digest throws BundleShaConflictError with ZERO PUT calls, even on a server that would have silently accepted an overwrite (If-None-Match ignored)', async () => {
      const signingClient = fakeSigningClient()
      const existingBody = 'a completely different bundle'
      const existingDigest = sha256HexOfUtf8Text(existingBody)
      const fetchImpl = vi.fn(async (req: Request) => {
        // A server that IGNORES If-None-Match would happily 200 a PUT here — the only
        // reason this test can prove "0 PUTs" is that the pre-check throws before any PUT
        // is ever attempted, never because the mock refuses a PUT itself.
        return new Response(existingBody, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: existingDigest },
        })
      })
      let thrown: unknown
      try {
        await putPotWorkerBundleObject({
          accountId: 'acct',
          bucket: 'mupot-pot-bundles',
          releaseSha: sha,
          bodyText,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          signingClient,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundleShaConflictError)
      expect((thrown as { code?: string }).code).toBe('bundle_sha_conflict')
      expect((thrown as { existingSha256?: string }).existingSha256).toBe(existingDigest)
      expect((thrown as { attemptedSha256?: string }).attemptedSha256).toBe(digest)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls.every((call) => (call[0] as Request).method !== 'PUT')).toBe(true)
    })
  })

  // mupot#1529 round-1 P1-2: the pre-PUT read previously failed OPEN on 5 of 6 possible
  // outcomes — only a clean `ok:true` read refused; 404/403/500/no-metadata/bad-metadata
  // ALL fell through to a real PUT attempt. Against a server that ignores `If-None-Match`
  // (silently accepts an overwrite), that PUT "succeeds" and CLOBBERS whatever was really
  // there. This six-row matrix drives every outcome `verifyPotWorkerBundleObject` can
  // return through `putPotWorkerBundleObject` and asserts: exactly the ABSENT (404) row
  // issues a PUT (a legitimate new publish — not a clobber, since nothing existed); every
  // other row issues ZERO PUTs (CLOBBERED=false), because either a real digest was
  // established from the actual bytes read (PRESENT — including the no-metadata/
  // bad-metadata rows, which the OLD `.ok`-only check treated as failures instead of proof
  // of existence) or the read was genuinely inconclusive (UNKNOWN — fails closed, never
  // treated as absent).
  describe('six-row pre-PUT classification matrix (P1-2) — a server that ignores If-None-Match must still show 0 PUTs on every non-absent row', () => {
    const sha = 'c'.repeat(40)
    const bodyText = 'export default { fetch() {} }'
    const digest = sha256HexOfUtf8Text(bodyText)
    const differentBody = 'a completely different bundle'
    const differentDigest = sha256HexOfUtf8Text(differentBody)
    const metaKey = `x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`

    type Row = {
      name: string
      getResponse: () => Response
      expectPut: boolean
      expect: (result: { ok: true; alreadyPublished: boolean } | { ok: false; error: unknown }) => void
    }

    const rows: Row[] = [
      {
        name: 'PRESENT, same digest, valid metadata → alreadyPublished, 0 PUTs',
        getResponse: () => new Response(bodyText, { status: 200, headers: { [metaKey]: digest } }),
        expectPut: false,
        expect: (r) => {
          if (!r.ok) throw new Error('expected success')
          expect(r.alreadyPublished).toBe(true)
        },
      },
      {
        name: 'PRESENT, DIFFERENT digest, valid metadata → BundleShaConflictError, 0 PUTs',
        getResponse: () => new Response(differentBody, { status: 200, headers: { [metaKey]: differentDigest } }),
        expectPut: false,
        expect: (r) => {
          if (r.ok) throw new Error('expected throw')
          expect(r.error).toBeInstanceOf(BundleShaConflictError)
        },
      },
      {
        name: 'PRESENT, DIFFERENT bytes, NO metadata at all → BundleShaConflictError from the REAL bytes digest, 0 PUTs',
        getResponse: () => new Response(differentBody, { status: 200 }),
        expectPut: false,
        expect: (r) => {
          if (r.ok) throw new Error('expected throw')
          expect(r.error).toBeInstanceOf(BundleShaConflictError)
          expect((r.error as { existingSha256?: string }).existingSha256).toBe(differentDigest)
        },
      },
      {
        name: 'PRESENT, DIFFERENT bytes, WRONG/self-inconsistent metadata → BundleShaConflictError from the REAL bytes digest, 0 PUTs',
        getResponse: () => new Response(differentBody, { status: 200, headers: { [metaKey]: 'deadbeef'.repeat(8) } }),
        expectPut: false,
        expect: (r) => {
          if (r.ok) throw new Error('expected throw')
          expect(r.error).toBeInstanceOf(BundleShaConflictError)
          expect((r.error as { existingSha256?: string }).existingSha256).toBe(differentDigest)
        },
      },
      {
        name: 'ABSENT (404) → proceeds to a real PUT (the ONLY row where a PUT happens)',
        getResponse: () => new Response('', { status: 404 }),
        expectPut: true,
        expect: (r) => {
          if (!r.ok) throw new Error('expected success')
          expect(r.alreadyPublished).toBe(false)
        },
      },
      {
        name: 'UNKNOWN (403) → BundlePublishUnconfirmedError, fails CLOSED, 0 PUTs',
        getResponse: () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
        expectPut: false,
        expect: (r) => {
          if (r.ok) throw new Error('expected throw')
          expect(r.error).toBeInstanceOf(BundlePublishUnconfirmedError)
        },
      },
    ]

    it.each(rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
      const signingClient = fakeSigningClient()
      // The fake IGNORES If-None-Match: any PUT it receives "succeeds" (200) — CLOBBERING
      // whatever the pre-check GET reported, if the code were ever to reach a PUT here.
      const fetchImpl = vi.fn(async (req: Request) => {
        if (req.method === 'PUT') return new Response('', { status: 200 })
        return row.getResponse()
      })
      let outcome: { ok: true; alreadyPublished: boolean } | { ok: false; error: unknown }
      try {
        const receipt = await putPotWorkerBundleObject({
          accountId: 'acct',
          bucket: 'mupot-pot-bundles',
          releaseSha: sha,
          bodyText,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          signingClient,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        })
        outcome = { ok: true, alreadyPublished: receipt.alreadyPublished }
      } catch (error) {
        outcome = { ok: false, error }
      }
      row.expect(outcome)
      const putCalls = fetchImpl.mock.calls.filter((call) => (call[0] as Request).method === 'PUT')
      expect(putCalls.length).toBe(row.expectPut ? 1 : 0)
    })
  })

  // Kasra-core round-2 finding (2026-09-22): a plain overwrite-by-key PUT could silently
  // replace an already-published RELEASE_SHA's bundle with DIFFERENT bytes (a stale local
  // tree, a non-reproducible build, two colonies racing the same commit). Conditional write
  // + a same-digest-vs-different-digest branch on 412 closes this — this is LAYER 2, only
  // reachable when the pre-PUT check (above) saw nothing published yet (404) but another
  // writer won the race between that read and this function's own PUT.
  describe('conditional write (If-None-Match) 412 race path — reached only after a 404 pre-check', () => {
    const raceSha = 'a'.repeat(40)
    const bodyText = 'export default { fetch() {} }'
    const digest = sha256HexOfUtf8Text(bodyText)

    it('treats a 412 with an IDENTICAL existing digest as a successful, idempotent re-publish', async () => {
      const signingClient = fakeSigningClient()
      let call = 0
      const fetchImpl = vi.fn(async (req: Request) => {
        call++
        if (call === 1) {
          expect(req.method).toBe('GET') // pre-check
          return new Response('', { status: 404 })
        }
        if (call === 2) {
          expect(req.method).toBe('PUT')
          return new Response('', { status: 412 })
        }
        // The internal re-verify GET after the 412.
        expect(req.method).toBe('GET')
        return new Response(bodyText, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: digest },
        })
      })
      const receipt = await putPotWorkerBundleObject({
        accountId: 'acct',
        bucket: 'mupot-pot-bundles',
        releaseSha: raceSha,
        bodyText,
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(receipt.alreadyPublished).toBe(true)
      expect(receipt.sha256).toBe(digest)
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('throws BundleShaConflictError (code: bundle_sha_conflict) on a 412 with a DIFFERENT existing digest — never silently overwrites', async () => {
      const signingClient = fakeSigningClient()
      const existingBody = 'a completely different bundle'
      const existingDigest = sha256HexOfUtf8Text(existingBody)
      let call = 0
      const fetchImpl = vi.fn(async (req: Request) => {
        call++
        if (call === 1) return new Response('', { status: 404 })
        if (call === 2) return new Response('', { status: 412 })
        return new Response(existingBody, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: existingDigest },
        })
      })
      let thrown: unknown
      try {
        await putPotWorkerBundleObject({
          accountId: 'acct',
          bucket: 'mupot-pot-bundles',
          releaseSha: raceSha,
          bodyText,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          signingClient,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundleShaConflictError)
      expect((thrown as Error).name).toBe('BundleShaConflictError')
      expect((thrown as { code?: string }).code).toBe('bundle_sha_conflict')
      expect((thrown as { existingSha256?: string }).existingSha256).toBe(existingDigest)
      expect((thrown as { attemptedSha256?: string }).attemptedSha256).toBe(digest)
    })

    // mupot#1524 round-2 P2-4: a 412 whose confirming GET FAILS is not a confirmed digest
    // conflict — it is an UNCONFIRMED outcome. The prior version of this test asserted
    // `code: 'bundle_sha_conflict'` here, which claimed a fact (the existing bytes differ)
    // that a 500 on the confirming GET never actually established.
    it('throws BundlePublishUnconfirmedError (code: bundle_publish_unconfirmed), NOT BundleShaConflictError, when the confirming GET after a 412 itself fails', async () => {
      const signingClient = fakeSigningClient()
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call++
        if (call === 1) return new Response('', { status: 404 })
        if (call === 2) return new Response('', { status: 412 })
        return new Response('server error', { status: 500 })
      })
      let thrown: unknown
      try {
        await putPotWorkerBundleObject({
          accountId: 'acct',
          bucket: 'mupot-pot-bundles',
          releaseSha: raceSha,
          bodyText,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          signingClient,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        })
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(BundlePublishUnconfirmedError)
      expect((thrown as { code?: string }).code).toBe('bundle_publish_unconfirmed')
      expect((thrown as { code?: string }).code).not.toBe('bundle_sha_conflict')
      // The GET's own status (500) must be discoverable from the thrown message — an
      // operator debugging this needs to know WHY the confirmation failed.
      expect((thrown as Error).message).toContain('500')
      expect((thrown as { getStatus?: number }).getStatus).toBe(500)
    })
  })

  it('defaults to a real makeR2SigningClient (aws4fetch) when no signingClient is injected — the signed request still reaches fetchImpl with a real Authorization header', async () => {
    const sha = '2'.repeat(40)
    const fetchImpl = withNotYetPublishedPreCheck((req) => {
      expect(req.headers.get('Authorization')).toMatch(/^AWS4-HMAC-SHA256 /)
      return new Response('', { status: 200 })
    })
    // The pre-check GET is ALSO real-signed — assert on it too via the first call.
    let firstReq: Request | null = null
    const wrapped = vi.fn(async (req: Request) => {
      if (!firstReq) firstReq = req
      return (fetchImpl as unknown as (req: Request) => Promise<Response>)(req)
    })
    await putPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      bodyText: 'x',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      fetchImpl: wrapped as unknown as typeof fetch,
    })
    expect(firstReq!.headers.get('Authorization')).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('verifyPotWorkerBundleObject', () => {
  const sha = '3'.repeat(40)
  const bodyText = 'export default { fetch() {} }'
  const goodDigest = sha256HexOfUtf8Text(bodyText)

  it('reports ok:true when the recorded digest matches the bytes read back', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async (req: Request) => {
      expect(req.method).toBe('GET')
      return new Response(bodyText, {
        status: 200,
        headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: goodDigest },
      })
    })
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({
      ok: true,
      key: `${sha}/worker.js`,
      status: 200,
      sha256: goodDigest,
      size: Buffer.byteLength(bodyText, 'utf8'),
      bucket: 'mupot-pot-bundles',
      url: `https://<redacted-account>.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`,
    })
  })

  it('reports ok:false on a digest mismatch — never a silent pass on a mere 200', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(
      async () =>
        new Response(bodyText, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: 'deadbeef'.repeat(8) },
        }),
    )
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/digest mismatch/)
  })

  it('reports ok:false when the object has no recorded metadata at all', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async () => new Response(bodyText, { status: 200 }))
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/carries no.*metadata/)
  })

  it('reports ok:false with a clear reason on a 404 (nothing published for this release yet)', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ ok: false, key: `${sha}/worker.js`, status: 404, reason: `no object published at '${sha}/worker.js'` })
  })

  it('reports ok:false on a transport-level failure status, with only HTTP status in the reason (no raw body)', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 }))
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect((result as { status?: number }).status).toBe(500)
    expect((result as { reason: string }).reason).toMatch(/R2 GET.*failed.*HTTP 500/s)
    expect((result as { reason: string }).reason).not.toContain('server error')
  })

  // mupot#1524 round-2 P1 — see the equivalent PUT-side test above for the full rationale:
  // an allow-list (HTTP status + S3 <Code> only), never a body passthrough with one tag
  // scrubbed. <BucketName>/<Endpoint>/<HostId>/<RequestId> must never reach `reason`.
  it('never echoes the raw GET failure body — only HTTP status + <Code> reach the returned reason', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '<Error><Code>AccessDenied</Code><AWSAccessKeyId>SUPERSECRETKEYID</AWSAccessKeyId>' +
            '<BucketName>super-secret-bucket</BucketName><Endpoint>super-secret-bucket.acct123.r2.cloudflarestorage.com</Endpoint>' +
            '<HostId>host-id-value</HostId><RequestId>req-id-value</RequestId></Error>',
          { status: 403 },
        ),
    )
    const result = await verifyPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    const reason = (result as { reason: string }).reason
    expect(reason).not.toContain('SUPERSECRETKEYID')
    expect(reason).not.toContain('super-secret-bucket')
    expect(reason).not.toContain('acct123')
    expect(reason).not.toContain('host-id-value')
    expect(reason).not.toContain('req-id-value')
    expect(reason).not.toContain('<BucketName>')
    expect(reason).not.toContain('<Endpoint>')
    expect(reason).toContain('AccessDenied')
    expect(reason).toContain('403')
  })
})

describe('POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT', () => {
  it('is the bucket name this task provisioned', () => {
    expect(POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT).toBe('mupot-pot-bundles')
  })

  it('matches the bucket_name wrangler.example.toml documents for POT_WORKER_BUNDLE_BUCKET (one constant, no drift)', () => {
    const wranglerExample = readFileSync(new URL('../wrangler.example.toml', import.meta.url), 'utf8')
    const bindingBlockMatch =
      /binding = "POT_WORKER_BUNDLE_BUCKET"\s*\n\s*bucket_name = "([^"]+)"/.exec(wranglerExample)
    expect(bindingBlockMatch, 'wrangler.example.toml must still declare the POT_WORKER_BUNDLE_BUCKET r2_buckets binding').not.toBeNull()
    expect(POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT).toBe(bindingBlockMatch![1])
  })
})

// CodeQL js/clear-text-logging (high), 2026-09-22 — flagged scripts/verify-pot-bundle.mjs:70
// (`console.log(JSON.stringify(result))`), where `result.url` was built directly from
// `CLOUDFLARE_ACCOUNT_ID`. Covers both the redaction at the source (r2ObjectUrl's raw
// output never reaching a returned receipt) and the printed-receipt allow-list functions
// the two CLI scripts now use instead of ever printing a raw result/receipt object.
describe('CodeQL js/clear-text-logging fix — no process.env value ever reaches a receipt', () => {
  // Lowercase deliberately — a real Cloudflare account id is lowercase hex, and the WHATWG
  // URL parser lowercases the hostname regardless, which would otherwise make the "the REAL
  // request still carries it" assertion below fail on a case mismatch that has nothing to
  // do with the redaction this test is actually proving.
  const SENTINEL_ACCOUNT_ID = 'sentinel-account-id-9f8e7d6c5b4a'
  const SENTINEL_BUCKET = 'sentinel-bucket-3d2c1b0a'

  describe('redactedR2ObjectUrl (via putPotWorkerBundleObject / verifyPotWorkerBundleObject)', () => {
    it('putPotWorkerBundleObject never returns the real accountId in its url field', async () => {
      const sha = '5'.repeat(40)
      const signingClient = { sign: vi.fn(async (req: Request) => req) }
      // First call is the pre-PUT precheck (P2-1/P1-2) — 404 so it falls through to a real
      // PUT, which the second call answers with success. A bare 200-for-everything mock
      // would now (correctly) be classified as an already-PRESENT object and short-circuit
      // before ever reaching a PUT, which is not what this test is exercising.
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call++
        return new Response('', { status: call === 1 ? 404 : 200 })
      })
      const receipt = await putPotWorkerBundleObject({
        accountId: SENTINEL_ACCOUNT_ID,
        bucket: SENTINEL_BUCKET,
        releaseSha: sha,
        bodyText: 'x',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(receipt.url).not.toContain(SENTINEL_ACCOUNT_ID)
      expect(receipt.url).toContain('<redacted-account>')
      // The REAL fetch call must still go to the real, un-redacted endpoint — only the
      // RETURNED receipt is redacted, never the actual request.
      const signedReq = (signingClient.sign.mock.calls[0] as [Request])[0]
      expect(signedReq.url).toContain(SENTINEL_ACCOUNT_ID)
    })

    it('verifyPotWorkerBundleObject never returns the real accountId in its url field', async () => {
      const sha = '6'.repeat(40)
      const bodyText = 'export default {}'
      const digest = sha256HexOfUtf8Text(bodyText)
      const signingClient = { sign: vi.fn(async (req: Request) => req) }
      const fetchImpl = vi.fn(
        async () =>
          new Response(bodyText, {
            status: 200,
            headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: digest },
          }),
      )
      const result = await verifyPotWorkerBundleObject({
        accountId: SENTINEL_ACCOUNT_ID,
        bucket: SENTINEL_BUCKET,
        releaseSha: sha,
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        signingClient,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(result.ok).toBe(true)
      expect((result as { url: string }).url).not.toContain(SENTINEL_ACCOUNT_ID)
      const signedReq = (signingClient.sign.mock.calls[0] as [Request])[0]
      expect(signedReq.url).toContain(SENTINEL_ACCOUNT_ID)
    })
  })

  describe('buildVerifyReceipt (scripts/verify-pot-bundle.mjs\'s printed receipt)', () => {
    it('success: prints ONLY ok/key/sha256/size/timestamp — no bucket, no url, no account', () => {
      const fakeResult = {
        ok: true,
        key: 'abc/worker.js',
        sha256: 'deadbeef',
        size: 123,
        bucket: SENTINEL_BUCKET,
        url: `https://${SENTINEL_ACCOUNT_ID}.r2.cloudflarestorage.com/${SENTINEL_BUCKET}/abc/worker.js`,
      }
      const receipt = buildVerifyReceipt(fakeResult, { now: () => '2026-09-22T00:00:00.000Z' })
      expect(receipt).toEqual({ ok: true, key: 'abc/worker.js', sha256: 'deadbeef', size: 123, timestamp: '2026-09-22T00:00:00.000Z' })
      const printed = JSON.stringify(receipt)
      expect(printed).not.toContain(SENTINEL_ACCOUNT_ID)
      expect(printed).not.toContain(SENTINEL_BUCKET)
      expect(printed).not.toContain('bucket')
      expect(printed).not.toContain('url')
    })

    // mupot#1524 round-2 P1: this test previously cited "the library-level reason strings
    // are separately tested to never carry an env value" — no such test existed anywhere
    // in this file. `buildVerifyReceipt` DOES trust its caller's `reason` text verbatim
    // (it has no way to know whether a caller-supplied string is safe); what makes that
    // safe in practice is that EVERY `reason` `verifyPotWorkerBundleObject` itself can
    // produce is free of environment-derived values BY CONSTRUCTION — see the real,
    // executable coverage for that claim: the 'verifyPotWorkerBundleObject' describe
    // block's "never echoes the raw GET failure body" test (allow-list: HTTP status + S3
    // <Code> only) and the 404/missing-metadata/digest-mismatch tests there (key + digest
    // values only, no env-derived value ever entering `reason`).
    it('failure: prints ONLY ok/reason — trusts its caller\'s reason text verbatim (does not itself scrub it)', () => {
      const receipt = buildVerifyReceipt({ ok: false, key: 'abc/worker.js', reason: 'no object published' })
      expect(receipt).toEqual({ ok: false, reason: 'no object published' })
    })

    it('failure: a reason string a caller passes in with a sentinel DOES surface — proving this function itself does no filtering, so the guarantee lives entirely in what verifyPotWorkerBundleObject is allowed to put in reason', () => {
      const receipt = buildVerifyReceipt({ ok: false, key: 'abc/worker.js', reason: `contains ${SENTINEL_ACCOUNT_ID}` })
      expect(receipt.reason).toContain(SENTINEL_ACCOUNT_ID)
    })
  })

  describe('buildPublishReceipt (scripts/publish-pot-bundle.mjs\'s printed receipt)', () => {
    it('prints ONLY ok/key/sha256/size/already_published/timestamp — no bucket, no url, no account', () => {
      const fakeReceipt = {
        key: 'abc/worker.js',
        sha256: 'deadbeef',
        size: 123,
        bucket: SENTINEL_BUCKET,
        url: `https://${SENTINEL_ACCOUNT_ID}.r2.cloudflarestorage.com/${SENTINEL_BUCKET}/abc/worker.js`,
        alreadyPublished: false,
      }
      const receipt = buildPublishReceipt(fakeReceipt, { now: () => '2026-09-22T00:00:00.000Z' })
      expect(receipt).toEqual({
        ok: true,
        key: 'abc/worker.js',
        sha256: 'deadbeef',
        size: 123,
        already_published: false,
        timestamp: '2026-09-22T00:00:00.000Z',
      })
      const printed = JSON.stringify(receipt)
      expect(printed).not.toContain(SENTINEL_ACCOUNT_ID)
      expect(printed).not.toContain(SENTINEL_BUCKET)
      expect(printed).not.toContain('bucket')
      expect(printed).not.toContain('url')
    })
  })

  it('end-to-end: a full publish-shaped call with sentinel accountId/bucket never leaks either through the printed receipt', async () => {
    const sha = '7'.repeat(40)
    const signingClient = { sign: vi.fn(async (req: Request) => req) }
    // Same fix as the redaction test above: 404 on the pre-PUT precheck, 200 on the PUT.
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      return new Response('', { status: call === 1 ? 404 : 200 })
    })
    const receipt = await putPotWorkerBundleObject({
      accountId: SENTINEL_ACCOUNT_ID,
      bucket: SENTINEL_BUCKET,
      releaseSha: sha,
      bodyText: 'console.log("hi")',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const printedReceipt = JSON.stringify(buildPublishReceipt(receipt, { now: () => '2026-09-22T00:00:00.000Z' }))
    expect(printedReceipt).not.toContain(SENTINEL_ACCOUNT_ID)
    expect(printedReceipt).not.toContain(SENTINEL_BUCKET)
  })

  it('end-to-end: a full verify-shaped call with sentinel accountId/bucket never leaks either through the printed receipt', async () => {
    const sha = '8'.repeat(40)
    const bodyText = 'console.log("hi")'
    const digest = sha256HexOfUtf8Text(bodyText)
    const signingClient = { sign: vi.fn(async (req: Request) => req) }
    const fetchImpl = vi.fn(
      async () =>
        new Response(bodyText, {
          status: 200,
          headers: { [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: digest },
        }),
    )
    const result = await verifyPotWorkerBundleObject({
      accountId: SENTINEL_ACCOUNT_ID,
      bucket: SENTINEL_BUCKET,
      releaseSha: sha,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      signingClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const printedReceipt = JSON.stringify(buildVerifyReceipt(result, { now: () => '2026-09-22T00:00:00.000Z' }))
    expect(printedReceipt).not.toContain(SENTINEL_ACCOUNT_ID)
    expect(printedReceipt).not.toContain(SENTINEL_BUCKET)
  })
})

// mupot#1524 round-2 P1: the false test citation this replaces asserted the allow-list
// property only at the LIBRARY function boundary. These drive a real S3-shaped error body
// carrying sentinel account id + bucket THROUGH THE ACTUAL CLI PROCESSES an operator or CI
// would run — `node scripts/verify-pot-bundle.mjs` / `node scripts/publish-pot-bundle.mjs`
// — via a `node --import` preload (tests/fixtures/fake-r2-fetch-preload.mjs) that replaces
// `globalThis.fetch` before either script's module code runs. No real network call.
describe('real CLI process — sentinel account id/bucket never leak through stdout/stderr', () => {
  it('scripts/verify-pot-bundle.mjs: an AccessDenied error body never leaks CLOUDFLARE_ACCOUNT_ID or the bucket name', () => {
    const sha = 'b'.repeat(40)
    const sentinelAccountId = 'sentinel-cli-account-9f8e7d6c'
    const sentinelBucket = 'sentinel-cli-bucket-3d2c1b0a'
    const errorBody =
      '<Error><Code>AccessDenied</Code>' +
      `<BucketName>${sentinelBucket}</BucketName>` +
      `<Endpoint>${sentinelBucket}.${sentinelAccountId}.r2.cloudflarestorage.com</Endpoint>` +
      '<HostId>host-id-value</HostId><RequestId>req-id-value</RequestId></Error>'
    const result = spawnSync(process.execPath, ['--import', fakeR2FetchPreload, 'scripts/verify-pot-bundle.mjs', sha], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: sentinelAccountId,
        POT_WORKER_BUNDLE_R2_BUCKET: sentinelBucket,
        R2_POT_BUNDLES_ACCESS_KEY_ID: 'ak-test',
        R2_POT_BUNDLES_SECRET_ACCESS_KEY: 'sk-test',
        FAKE_R2_STATUS: '403',
        FAKE_R2_BODY: errorBody,
      },
    })
    const combined = `${result.stdout}\n${result.stderr}`
    expect(combined).not.toContain(sentinelAccountId)
    expect(combined).not.toContain(sentinelBucket)
    expect(combined).not.toContain('host-id-value')
    expect(combined).not.toContain('req-id-value')
    expect(combined).not.toContain('<BucketName>')
    expect(combined).not.toContain('<Endpoint>')
    expect(combined).toContain('AccessDenied')
    expect(combined).toContain('403')
    expect(result.status).toBe(1)
    const printedLines = result.stdout.trim().split('\n')
    const receipt = JSON.parse(printedLines[printedLines.length - 1])
    expect(receipt).toEqual({ ok: false, reason: expect.stringContaining('AccessDenied') })
  })

  // NOTE ON SCOPE: this test requires a CLEAN working tree (scripts/publish-pot-bundle.mjs
  // refuses to publish from a dirty tree — assertPublishPreconditions, same discipline as
  // scripts/deploy.mjs) and a real `wrangler deploy --dry-run` build
  // (scripts/build-pot-worker-bundle.mjs --config wrangler.example.toml), which this
  // sandbox DOES support (verified 2026-09-22: no network call, no auth beyond parsing
  // wrangler.example.toml). It runs correctly in CI (always a clean checkout) and locally
  // once this PR's own changes are committed.
  it('scripts/publish-pot-bundle.mjs: a PermanentRedirect error body never leaks CLOUDFLARE_ACCOUNT_ID or the bucket name', () => {
    const sentinelAccountId = 'sentinel-cli-account-1a2b3c4d'
    const sentinelBucket = 'sentinel-cli-bucket-5e6f7a8b'
    const errorBody =
      '<Error><Code>PermanentRedirect</Code>' +
      `<BucketName>${sentinelBucket}</BucketName>` +
      `<Endpoint>${sentinelBucket}.${sentinelAccountId}.r2.cloudflarestorage.com</Endpoint>` +
      '<HostId>host-id-value-2</HostId><RequestId>req-id-value-2</RequestId></Error>'
    const result = spawnSync(
      process.execPath,
      ['--import', fakeR2FetchPreload, 'scripts/publish-pot-bundle.mjs', '--config', 'wrangler.example.toml'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: sentinelAccountId,
          POT_WORKER_BUNDLE_R2_BUCKET: sentinelBucket,
          R2_POT_BUNDLES_ACCESS_KEY_ID: 'ak-test',
          R2_POT_BUNDLES_SECRET_ACCESS_KEY: 'sk-test',
          FAKE_R2_STATUS: '403',
          FAKE_R2_BODY: errorBody,
        },
      },
    )
    const combined = `${result.stdout}\n${result.stderr}`
    expect(combined).not.toContain(sentinelAccountId)
    expect(combined).not.toContain(sentinelBucket)
    expect(combined).not.toContain('host-id-value-2')
    expect(combined).not.toContain('req-id-value-2')
    expect(combined).not.toContain('<BucketName>')
    expect(combined).not.toContain('<Endpoint>')
    expect(combined).toContain('PermanentRedirect')
    expect(combined).toContain('403')
    expect(result.status).not.toBe(0)
  }, 60_000)
})

// mupot#1529 round-1 P1-2: the six-row matrix above proves the classification at the
// LIBRARY level (injected fetchImpl). This exercises the SAME pre-PUT layer through the
// REAL `scripts/publish-pot-bundle.mjs` CLI process, using the fixture's per-request
// scripting (FAKE_R2_SCRIPT_JSON) to answer the pre-check GET and the subsequent PUT
// differently — proving the wiring (the CLI script's own argv/env handling, not just the
// exported function) also gets this right.
//
// NOTE ON SCOPE: like every other real publish-pot-bundle.mjs spawn in this file, this
// needs a clean, committed tree and a real (network-free) wrangler dry-run build — see the
// other "NOTE ON SCOPE" comments in this file for why.
describe('real CLI process — pre-PUT classification (P1-2) through scripts/publish-pot-bundle.mjs', () => {
  it('GET-404-then-PUT-200: a genuinely new bundle publishes successfully (the one row that DOES PUT)', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', fakeR2FetchPreload, 'scripts/publish-pot-bundle.mjs', '--config', 'wrangler.example.toml'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          POT_WORKER_BUNDLE_R2_BUCKET: 'test-bucket',
          R2_POT_BUNDLES_ACCESS_KEY_ID: 'ak-test',
          R2_POT_BUNDLES_SECRET_ACCESS_KEY: 'sk-test',
          FAKE_R2_SCRIPT_JSON: JSON.stringify([
            { status: 404 }, // pre-check: nothing published yet
            { status: 200 }, // the PUT itself succeeds
          ]),
        },
      },
    )
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    const receipt = JSON.parse(result.stdout.trim().split('\n').pop()!)
    expect(receipt.ok).toBe(true)
    expect(receipt.already_published).toBe(false)
  }, 60_000)

  it('GET-200-different-bytes: refuses with BundleShaConflictError and makes NO second (PUT) request', () => {
    const differentBody = 'export default { fetch() { return new Response("old") } }'
    const differentDigest = sha256HexOfUtf8Text(differentBody)
    const result = spawnSync(
      process.execPath,
      ['--import', fakeR2FetchPreload, 'scripts/publish-pot-bundle.mjs', '--config', 'wrangler.example.toml'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
          POT_WORKER_BUNDLE_R2_BUCKET: 'test-bucket',
          R2_POT_BUNDLES_ACCESS_KEY_ID: 'ak-test',
          R2_POT_BUNDLES_SECRET_ACCESS_KEY: 'sk-test',
          // A SINGLE scripted step: if the code (incorrectly) made a second (PUT) request,
          // the script would repeat this same 200-different-bytes response for it too —
          // which would look like a successful overwrite. The assertion below on the
          // process's own behavior (refused, never "published") is what actually proves
          // no PUT was attempted, matching the library-level six-row matrix's stricter
          // fetchImpl-call-count assertion for the same row.
          FAKE_R2_SCRIPT_JSON: JSON.stringify([{ status: 200, body: differentBody }]),
        },
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('DIFFERENT digest')
    expect(result.stderr).toContain(differentDigest)
    // stdout DOES carry the (inherited) real wrangler build's own output — this only
    // asserts no SUCCESS RECEIPT (buildPublishReceipt's `{"ok":true,...}` JSON line) was
    // ever printed, never that stdout is empty.
    expect(result.stdout).not.toContain('"ok":true')
  }, 60_000)
})
