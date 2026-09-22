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
} from '../scripts/lib/pot-bundle-r2.mjs'

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

describe('putPotWorkerBundleObject', () => {
  it('PUTs to the exact object key with the sha256 recorded as x-amz-meta-sha256, a conditional If-None-Match, and a SIGNED payload (never UNSIGNED-PAYLOAD)', async () => {
    const sha = 'f'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async (req: Request) => {
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
    expect(signingClient.sign).toHaveBeenCalledOnce()
  })

  it('throws (never swallows) a non-2xx PUT response', async () => {
    const sha = '1'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async () => new Response('access denied', { status: 403 }))
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
    ).rejects.toThrow(/R2 PUT.*failed.*403.*access denied/s)
  })

  it('scrubs <AWSAccessKeyId> from a PUT failure body before it reaches the thrown message', async () => {
    const sha = '9'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(
      async () =>
        new Response('<Error><AWSAccessKeyId>SUPERSECRETKEYID</AWSAccessKeyId><Code>InvalidAccessKeyId</Code></Error>', {
          status: 403,
        }),
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
    expect((thrown as Error).message).not.toContain('SUPERSECRETKEYID')
    expect((thrown as Error).message).toContain('REDACTED')
  })

  // Kasra-core round-2 finding (2026-09-22): a plain overwrite-by-key PUT could silently
  // replace an already-published RELEASE_SHA's bundle with DIFFERENT bytes (a stale local
  // tree, a non-reproducible build, two colonies racing the same commit). Conditional write
  // + a same-digest-vs-different-digest branch on 412 closes this.
  describe('conditional write (If-None-Match) on an already-published key', () => {
    const sha = '4'.repeat(40)
    const bodyText = 'export default { fetch() {} }'
    const digest = sha256HexOfUtf8Text(bodyText)

    it('treats a 412 with an IDENTICAL existing digest as a successful, idempotent re-publish', async () => {
      const signingClient = fakeSigningClient()
      let call = 0
      const fetchImpl = vi.fn(async (req: Request) => {
        call++
        if (call === 1) {
          expect(req.method).toBe('PUT')
          return new Response('', { status: 412 })
        }
        // The internal re-verify GET.
        expect(req.method).toBe('GET')
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
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('throws BundleShaConflictError (code: bundle_sha_conflict) on a 412 with a DIFFERENT existing digest — never silently overwrites', async () => {
      const signingClient = fakeSigningClient()
      const existingBody = 'a completely different bundle'
      const existingDigest = sha256HexOfUtf8Text(existingBody)
      let call = 0
      const fetchImpl = vi.fn(async (req: Request) => {
        call++
        if (call === 1) return new Response('', { status: 412 })
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
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).name).toBe('BundleShaConflictError')
      expect((thrown as { code?: string }).code).toBe('bundle_sha_conflict')
      expect((thrown as { existingSha256?: string }).existingSha256).toBe(existingDigest)
      expect((thrown as { attemptedSha256?: string }).attemptedSha256).toBe(digest)
    })

    it('throws BundleShaConflictError even when the existing object is unreadable (fails closed, never assumes match)', async () => {
      const signingClient = fakeSigningClient()
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call++
        if (call === 1) return new Response('', { status: 412 })
        return new Response('server error', { status: 500 })
      })
      await expect(
        putPotWorkerBundleObject({
          accountId: 'acct',
          bucket: 'mupot-pot-bundles',
          releaseSha: sha,
          bodyText,
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          signingClient,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'bundle_sha_conflict' })
    })
  })

  it('defaults to a real makeR2SigningClient (aws4fetch) when no signingClient is injected — the signed request still reaches fetchImpl with a real Authorization header', async () => {
    const sha = '2'.repeat(40)
    const fetchImpl = vi.fn(async (req: Request) => {
      expect(req.headers.get('Authorization')).toMatch(/^AWS4-HMAC-SHA256 /)
      return new Response('', { status: 200 })
    })
    await putPotWorkerBundleObject({
      accountId: 'acct',
      bucket: 'mupot-pot-bundles',
      releaseSha: sha,
      bodyText: 'x',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
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
    expect(result).toEqual({ ok: false, key: `${sha}/worker.js`, reason: `no object published at '${sha}/worker.js'` })
  })

  it('reports ok:false on a transport-level failure status', async () => {
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
    expect((result as { reason: string }).reason).toMatch(/R2 GET.*failed.*500.*server error/s)
  })

  it('scrubs <AWSAccessKeyId> from a GET failure body before it reaches the returned reason', async () => {
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(
      async () =>
        new Response('<Error><AWSAccessKeyId>SUPERSECRETKEYID</AWSAccessKeyId><Code>AccessDenied</Code></Error>', {
          status: 403,
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
    expect((result as { reason: string }).reason).not.toContain('SUPERSECRETKEYID')
    expect((result as { reason: string }).reason).toContain('REDACTED')
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
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
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

    it('failure: prints ONLY ok/reason — a reason string that happens to carry a sentinel still surfaces (this function trusts its caller\'s reason text; the library-level reason strings are separately tested to never carry an env value)', () => {
      const receipt = buildVerifyReceipt({ ok: false, key: 'abc/worker.js', reason: 'no object published' })
      expect(receipt).toEqual({ ok: false, reason: 'no object published' })
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
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
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
