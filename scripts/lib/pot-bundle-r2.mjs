// scripts/lib/pot-bundle-r2.mjs — shared core for scripts/publish-pot-bundle.mjs and
// scripts/verify-pot-bundle.mjs (mupot#1285/#1516 enablement — the R2-publish half of
// bundle option B, docs/workflows/tenant-provision.md "CI publish output contract").
//
// Every exported function here is pure or takes its network/crypto edges as parameters
// (fetchImpl, an injected R2 signing client) so the two CLI scripts can be unit-tested
// with a fake fetch — same DI shape as src/secret-env/cf-secrets.ts's putScriptSecrets
// (fetchImpl: typeof fetch = fetch).
//
// WHY THE S3-COMPATIBLE API, NOT THE PLAIN BEARER-TOKEN R2 REST API: the Cloudflare v4
// REST API's "Upload Object" endpoint (PUT /accounts/{id}/r2/buckets/{bucket}/objects/{key})
// takes only `jurisdiction` and `cf-r2-storage-class` — verified directly against the
// published `cloudflare` npm package's own `ObjectUploadParams` type
// (unpkg.com/cloudflare/resources/r2/buckets/objects.d.ts, 2026-09-22) — it has NO way to
// set custom metadata at upload time. Custom metadata (the exact contract
// `loadPotWorkerBundle`, src/pots/service.ts, reads back) is only settable via the Workers
// binding (not available to a Node script) or the S3-compatible API's `x-amz-meta-<key>`
// headers, which R2 maps 1:1 onto `R2Object.customMetadata[<key>]` with the prefix
// stripped — this is the same well-documented mapping the R2 docs describe for the
// Workers binding's own `customMetadata` option. So this module signs S3-compatible
// requests (via `aws4fetch`, Cloudflare's own recommended lightweight SigV4 client for
// R2 — https://developers.cloudflare.com/r2/examples/authenticate-r2-auth-tokens/)
// against `https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>`.
//
// CREDENTIAL DERIVATION: per https://developers.cloudflare.com/r2/api/tokens/, an S3
// Access Key ID is "the `id` of the API token" and the Secret Access Key is "the SHA-256
// hash of the API token `value`". A caller normally captures the `id` at token-creation
// time; this module instead resolves it from the token itself via the standard, minimal-
// permission `GET /user/tokens/verify` endpoint (works for any valid token, requires no
// extra scope) so the ONLY secret an operator has to hold is the same `CLOUDFLARE_API_TOKEN`
// wrangler itself already reads from the environment for `wrangler deploy` — no separate
// R2-specific Access Key ID / Secret Access Key pair to provision and rotate.
//
// UNVERIFIED LIVE (same discipline as scripts/build-pot-worker-bundle.mjs and
// docs/workflows/tenant-provision.md's other "this session cannot touch live CF" notes):
// this session never calls the real Cloudflare API. The endpoint shapes above are sourced
// from developers.cloudflare.com and the published `cloudflare` npm package's own type
// definitions, not exercised against a live account. Kasra-core should smoke-test
// `deriveR2S3Credentials` + `putPotWorkerBundleObject` against a real token once the
// `mupot-pot-bundles` bucket and a scoped token are available.

import { createHash } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import { isFullSha } from './release-sha.mjs'

/** Default bucket name (already created per this task's brief — see
 *  docs/workflows/tenant-provision.md). Overridable via POT_WORKER_BUNDLE_R2_BUCKET for a
 *  colony running its own bucket name, or in tests. */
export const POT_WORKER_BUNDLE_R2_BUCKET_DEFAULT = 'mupot-pot-bundles'

/** MUST match `POT_WORKER_BUNDLE_SHA256_METADATA_KEY` in src/pots/service.ts EXACTLY —
 *  that is the value `loadPotWorkerBundle` reads back off the R2 object's customMetadata.
 *  tests/pot-bundle-r2.test.ts asserts this literal has not drifted from the source file. */
export const POT_WORKER_BUNDLE_SHA256_METADATA_KEY = 'sha256'

/** `${releaseSha}/worker.js` — the exact object key shape `loadPotWorkerBundle` builds
 *  (`${env.RELEASE_SHA || 'unknown'}/worker.js`) and the doc's "CI publish output
 *  contract" names. */
export function bundleObjectKey(releaseSha) {
  return `${releaseSha}/worker.js`
}

/** sha256Hex(code) as computed by src/members/service.ts's sha256Hex and relied on by
 *  loadPotWorkerBundle: TextEncoder-UTF8-encode, SHA-256, lowercase hex. Node's
 *  `createHash('sha256').update(text, 'utf8')` hashes the identical UTF-8 byte sequence a
 *  browser/Workers `TextEncoder().encode(text)` would produce for any text that round-trips
 *  through UTF-8 cleanly (true for a JS bundle) — same digest, no WebCrypto needed here. */
export function sha256HexOfUtf8Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Refuse to publish from a dirty tree or when `releaseSha` does not exactly match the
 * current HEAD — the same discipline `scripts/deploy.mjs` applies before it will stamp a
 * build, for the same reason: a bundle published under a commit sha it wasn't actually
 * built from is a lie the next `loadPotWorkerBundle` digest check cannot catch (the digest
 * only proves the BYTES weren't corrupted in transit, not that they came from the commit
 * the object's own key claims). Throws with a descriptive message; never silently degrades.
 */
export function assertPublishPreconditions({ dirty, headSha, releaseSha }) {
  if (dirty) {
    throw new Error(
      'refusing to publish from a DIRTY working tree — the built bundle would not correspond ' +
        'to any single commit, so the object key (which claims to BE that commit) would be a ' +
        'lie. Commit or stash first.',
    )
  }
  if (!isFullSha(releaseSha)) {
    throw new Error(
      `refusing to publish: '${releaseSha}' is not a full 40-hex commit sha (got a short sha, ` +
        "a branch name, a '-dirty'-suffixed stamp, or nothing resolvable).",
    )
  }
  if (releaseSha !== headSha) {
    throw new Error(
      `refusing to publish: RELEASE_SHA (${releaseSha}) does not match HEAD (${headSha}) — ` +
        'the bundle must be built from the exact commit it is published under.',
    )
  }
}

/** https://developers.cloudflare.com/r2/api/tokens/ — Access Key ID is the API token's own
 *  `id`, resolved via the minimal-permission `GET /user/tokens/verify` (works for any valid
 *  token); Secret Access Key is the SHA-256 hash of the token's raw value. Never logs or
 *  returns the raw `apiToken` itself. */
export async function deriveR2S3Credentials({ apiToken, fetchImpl = fetch }) {
  if (!apiToken || !apiToken.trim()) {
    throw new Error('deriveR2S3Credentials: apiToken is required (read CLOUDFLARE_API_TOKEN from the environment)')
  }
  const res = await fetchImpl('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    // non-JSON error body — body stays null, handled below
  }
  if (!res.ok || !body?.success || !body?.result?.id) {
    const errCode = body?.errors?.[0]?.code
    const errMessage = body?.errors?.[0]?.message
    throw new Error(
      `CLOUDFLARE_API_TOKEN verification failed (GET /user/tokens/verify): HTTP ${res.status}` +
        (errCode ? ` code:${errCode}` : '') +
        (errMessage ? ` — ${errMessage}` : ''),
    )
  }
  return {
    accessKeyId: body.result.id,
    secretAccessKey: sha256HexOfUtf8Text(apiToken),
  }
}

/** https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key> — the R2 S3-compatible
 *  endpoint, path-style (account id as host, bucket as the first path segment). */
export function r2ObjectUrl({ accountId, bucket, key }) {
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
}

/** Builds the SigV4 signing client. Isolated behind a function (rather than constructed
 *  inline at every call site) so a test can swap in a client whose `.sign()` is easy to
 *  assert against without needing real Cloudflare credentials. */
export function makeR2SigningClient({ accessKeyId, secretAccessKey }) {
  return new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
}

/**
 * PUTs the bundle text to `${releaseSha}/worker.js`, with the digest recorded as the
 * `POT_WORKER_BUNDLE_SHA256_METADATA_KEY` custom-metadata field via the S3-compatible
 * `x-amz-meta-sha256` header — the exact contract `loadPotWorkerBundle` verifies against.
 * PUT-by-key is naturally idempotent: re-running for the same commit re-uploads (and
 * re-signs) the same bytes and the same digest, overwriting the object in place — there is
 * no separate "already published" branch to keep in sync with the digest check.
 *
 * `signingClient` defaults to a real `makeR2SigningClient` instance; `fetchImpl` defaults
 * to the global `fetch` used to actually send the already-signed request. Both are
 * injectable so a test never needs real Cloudflare credentials or a network call.
 */
export async function putPotWorkerBundleObject({
  accountId,
  bucket,
  releaseSha,
  bodyText,
  accessKeyId,
  secretAccessKey,
  signingClient,
  fetchImpl = fetch,
}) {
  const key = bundleObjectKey(releaseSha)
  const url = r2ObjectUrl({ accountId, bucket, key })
  const sha256 = sha256HexOfUtf8Text(bodyText)
  const client = signingClient ?? makeR2SigningClient({ accessKeyId, secretAccessKey })
  const request = new Request(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: sha256,
    },
    body: bodyText,
  })
  const signed = await client.sign(request)
  const res = await fetchImpl(signed)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`R2 PUT '${key}' failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`)
  }
  return { key, sha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url }
}

/**
 * GETs the object back and re-verifies its digest against the recorded
 * `x-amz-meta-sha256` metadata — the operator receipt `scripts/verify-pot-bundle.mjs`
 * prints. Mirrors `loadPotWorkerBundle`'s own trust rule (src/pots/service.ts): missing
 * metadata or a mismatch is reported as a failure, never silently treated as "fine because
 * the GET returned 200" (a 200 only proves the bytes were readable, not that they are the
 * bytes CI actually built).
 */
export async function verifyPotWorkerBundleObject({
  accountId,
  bucket,
  releaseSha,
  accessKeyId,
  secretAccessKey,
  signingClient,
  fetchImpl = fetch,
}) {
  const key = bundleObjectKey(releaseSha)
  const url = r2ObjectUrl({ accountId, bucket, key })
  const client = signingClient ?? makeR2SigningClient({ accessKeyId, secretAccessKey })
  const request = new Request(url, { method: 'GET' })
  const signed = await client.sign(request)
  const res = await fetchImpl(signed)
  if (res.status === 404) {
    return { ok: false, key, reason: `no object published at '${key}'` }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, key, reason: `R2 GET '${key}' failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}` }
  }
  const recordedSha256 = res.headers.get(`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`)
  const bodyText = await res.text()
  const actualSha256 = sha256HexOfUtf8Text(bodyText)
  if (!recordedSha256) {
    return {
      ok: false,
      key,
      reason: `object exists but carries no 'x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}' metadata`,
      actualSha256,
    }
  }
  if (recordedSha256 !== actualSha256) {
    return {
      ok: false,
      key,
      reason: `digest mismatch: recorded ${recordedSha256}, computed ${actualSha256} from the bytes read back`,
      recordedSha256,
      actualSha256,
    }
  }
  return { ok: true, key, sha256: actualSha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url }
}
