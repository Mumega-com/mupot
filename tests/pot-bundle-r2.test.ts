// tests/pot-bundle-r2.test.ts — scripts/lib/pot-bundle-r2.mjs, the shared core for
// scripts/publish-pot-bundle.mjs and scripts/verify-pot-bundle.mjs (mupot#1285/#1516
// enablement, docs/workflows/tenant-provision.md "CI publish output contract").
//
// Covers: digest/metadata-key/object-key construction, the dirty-tree/RELEASE_SHA-mismatch
// refusals (same discipline as scripts/deploy.mjs), and the R2 credential-derivation +
// PUT/GET round trip with `fetch` mocked (fake fetch, per this repo's established DI
// pattern — see tests/secret-env-cf.test.ts's `fetchImpl` parameter, mirrored here) — never
// against live R2.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  POT_WORKER_BUNDLE_SHA256_METADATA_KEY,
  POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT,
  bundleObjectKey,
  sha256HexOfUtf8Text,
  assertPublishPreconditions,
  r2ObjectUrl,
  deriveR2S3Credentials,
  putPotWorkerBundleObject,
  verifyPotWorkerBundleObject,
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

describe('deriveR2S3Credentials', () => {
  it('derives accessKeyId from /user/tokens/verify result.id and secretAccessKey from sha256(token)', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer my-token')
      return new Response(JSON.stringify({ success: true, result: { id: 'tok-id-123', status: 'active' } }), {
        status: 200,
      })
    })
    const creds = await deriveR2S3Credentials({ apiToken: 'my-token', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(creds.accessKeyId).toBe('tok-id-123')
    expect(creds.secretAccessKey).toBe(sha256HexOfUtf8Text('my-token'))
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('never logs or returns the raw token itself', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, result: { id: 'tok-id', status: 'active' } }), { status: 200 }),
    )
    const creds = await deriveR2S3Credentials({ apiToken: 'super-secret-value', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(JSON.stringify(creds)).not.toContain('super-secret-value')
  })

  it('throws with a descriptive error on an invalid/expired token', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }), {
        status: 401,
      }),
    )
    await expect(
      deriveR2S3Credentials({ apiToken: 'bad-token', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/verification failed.*401.*code:1000.*Invalid API Token/s)
  })

  it('throws on a non-JSON error body rather than crashing on .json()', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    await expect(
      deriveR2S3Credentials({ apiToken: 'x', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/verification failed.*502/s)
  })

  it('refuses a blank apiToken before ever calling fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(deriveR2S3Credentials({ apiToken: '  ', fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      /apiToken is required/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
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
  it('PUTs to the exact object key with the sha256 recorded as x-amz-meta-sha256', async () => {
    const sha = 'f'.repeat(40)
    const signingClient = fakeSigningClient()
    const fetchImpl = vi.fn(async (req: Request) => {
      expect(req.method).toBe('PUT')
      expect(req.url).toBe(`https://acct.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`)
      expect(req.headers.get(`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`)).toBe(
        sha256HexOfUtf8Text('console.log(1)'),
      )
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
      url: `https://acct.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`,
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
      url: `https://acct.r2.cloudflarestorage.com/mupot-pot-bundles/${sha}/worker.js`,
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
})

describe('POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT', () => {
  it('is the bucket name this task provisioned', () => {
    expect(POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT).toBe('mupot-pot-bundles')
  })
})
