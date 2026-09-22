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
// CREDENTIALS: a DEDICATED, bucket-scoped R2 API token pair, read from
// `R2_POT_BUNDLES_ACCESS_KEY_ID` / `R2_POT_BUNDLES_SECRET_ACCESS_KEY` — never derived from
// the deploy's own `CLOUDFLARE_API_TOKEN`. Athena's round-1 ruling on this PR (2026-09-22)
// rejected an earlier version of this module that derived S3 credentials from that deploy
// token itself: that derivation is not a documented Cloudflare pattern, it hands this
// script the FULL scope of whatever broker minted the deploy token (that token is
// account-owned, not scoped to this one bucket), and the account-owned token rejects that
// derivation path in practice anyway. See docs/workflows/tenant-provision.md's "Minting
// the R2 credential pair" section for exactly how an operator mints the pair (Cloudflare
// dashboard → R2 → Manage R2 API Tokens → Object Read & Write, scoped to bucket
// `mupot-pot-bundles`) and where it lives on the deploy host. Both values are read from the
// environment only, checked for presence before any network call
// (`readR2PotBundlesCredentials` below), and never appear in any thrown message, log line,
// or printed receipt — only the two ENV VAR NAMES do.
//
// UNVERIFIED LIVE (same discipline as scripts/build-pot-worker-bundle.mjs and
// docs/workflows/tenant-provision.md's other "this session cannot touch live CF" notes):
// this session never calls the real Cloudflare API. The S3-compatible endpoint shape above
// is sourced from developers.cloudflare.com and the published `cloudflare` npm package's
// own type definitions, not exercised against a live account. Kasra-core should
// smoke-test `putPotWorkerBundleObject` / `verifyPotWorkerBundleObject` against a real,
// scoped R2 credential pair once one is minted — see the doc section named above for the
// live-verify-before-merge receipt format to capture when that happens.

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

/** Env var names for the dedicated, bucket-scoped R2 credential pair — named exports (not
 *  just string literals) so a caller printing a refusal message and a test asserting on it
 *  can never drift apart on the exact spelling. */
export const R2_POT_BUNDLES_ACCESS_KEY_ID_ENV = 'R2_POT_BUNDLES_ACCESS_KEY_ID'
export const R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV = 'R2_POT_BUNDLES_SECRET_ACCESS_KEY'

/**
 * Reads the dedicated R2 credential pair from the environment (default `process.env`,
 * injectable for tests). Pure and synchronous — makes no network call, so this always runs
 * BEFORE any request is signed or sent. Throws a message naming exactly which of the two
 * env vars is missing/blank — NEVER the values themselves, and never the value of any OTHER
 * env var either. See this file's header for why these two, and not `CLOUDFLARE_API_TOKEN`.
 */
export function readR2PotBundlesCredentials(env = process.env) {
  const accessKeyId = env[R2_POT_BUNDLES_ACCESS_KEY_ID_ENV]
  const secretAccessKey = env[R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV]
  const missing = []
  if (!accessKeyId || !accessKeyId.trim()) missing.push(R2_POT_BUNDLES_ACCESS_KEY_ID_ENV)
  if (!secretAccessKey || !secretAccessKey.trim()) missing.push(R2_POT_BUNDLES_SECRET_ACCESS_KEY_ENV)
  if (missing.length > 0) {
    throw new Error(
      `refusing to publish/verify: missing required environment variable(s): ${missing.join(', ')} — ` +
        'mint a scoped R2 API token pair (Cloudflare dashboard → R2 → Manage R2 API Tokens → ' +
        "Object Read & Write, scoped to bucket 'mupot-pot-bundles') and set both before " +
        'running this script. This is deliberately NOT CLOUDFLARE_API_TOKEN — see ' +
        'docs/workflows/tenant-provision.md "Minting the R2 credential pair".',
    )
  }
  return { accessKeyId, secretAccessKey }
}

/** https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key> — the R2 S3-compatible
 *  endpoint, path-style (account id as host, bucket as the first path segment). Used ONLY
 *  to build the real request URL for signing/fetching — NEVER put into a returned receipt
 *  object or a log line (see `REDACTED_ENDPOINT_HOST` below for the value that goes there
 *  instead; CodeQL js/clear-text-logging, 2026-09-22, flagged `CLOUDFLARE_ACCOUNT_ID`
 *  reaching `console.log` via exactly this path — `scripts/verify-pot-bundle.mjs` was
 *  blindly `JSON.stringify`-ing a result object that carried this real URL). */
export function r2ObjectUrl({ accountId, bucket, key }) {
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
}

/** The account-id host segment, redacted — this is the ONLY form of the R2 endpoint that
 *  may ever appear on a returned receipt object, in a thrown/logged message, or anywhere
 *  else outside the one signed `Request` this module builds and hands to `fetchImpl`. */
const REDACTED_ENDPOINT_HOST = '<redacted-account>.r2.cloudflarestorage.com'

/** Same shape as `r2ObjectUrl`, with the account id replaced — this is what
 *  `putPotWorkerBundleObject`/`verifyPotWorkerBundleObject` put on their RETURNED receipt
 *  objects, never the real, account-bearing URL. */
function redactedR2ObjectUrl({ bucket, key }) {
  return `https://${REDACTED_ENDPOINT_HOST}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
}

/** Builds the SigV4 signing client. Isolated behind a function (rather than constructed
 *  inline at every call site) so a test can swap in a client whose `.sign()` is easy to
 *  assert against without needing real Cloudflare credentials. */
export function makeR2SigningClient({ accessKeyId, secretAccessKey }) {
  return new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
}

/** An S3-shaped XML error body can carry `<AWSAccessKeyId>...</AWSAccessKeyId>` — scrub the
 *  VALUE before any error body text is thrown, logged, or printed. Never a full redaction of
 *  the body (the rest of the XML is diagnostic and not secret), just this one field. */
function redactS3ErrorBody(text) {
  return text.replace(/(<AWSAccessKeyId>)[^<]*(<\/AWSAccessKeyId>)/gi, '$1REDACTED$2')
}

/**
 * Thrown by `putPotWorkerBundleObject` when a PUT under an existing `${releaseSha}/worker.js`
 * key would silently overwrite DIFFERENT bytes than what is already published there. A
 * given RELEASE_SHA's bundle must be immutable once published — `code: 'bundle_sha_conflict'`
 * lets a caller (scripts/publish-pot-bundle.mjs) detect this specific case and print a
 * targeted message rather than a generic transport failure.
 */
export class BundleShaConflictError extends Error {
  constructor(message, { key, existingSha256, attemptedSha256 } = {}) {
    super(message)
    this.name = 'BundleShaConflictError'
    this.code = 'bundle_sha_conflict'
    this.key = key
    this.existingSha256 = existingSha256
    this.attemptedSha256 = attemptedSha256
  }
}

/**
 * PUTs the bundle text to `${releaseSha}/worker.js`, with the digest recorded as the
 * `POT_WORKER_BUNDLE_SHA256_METADATA_KEY` custom-metadata field via the S3-compatible
 * `x-amz-meta-sha256` header — the exact contract `loadPotWorkerBundle` verifies against.
 *
 * SIGNED PAYLOAD (Kasra-core round-2 finding, 2026-09-22): `aws4fetch`'s `AwsClient`
 * defaults an s3-service request to `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` unless that
 * header is already set on the request BEFORE signing — under that default, the SigV4
 * signature does not cover the body at all, so a tampered body would still verify against
 * an untampered signature. This function sets the header itself to the SAME digest it
 * records as `x-amz-meta-sha256`, computed from the exact bytes in `bodyText` — the body is
 * therefore genuinely signature-covered, not merely accompanied by an unverified claim.
 *
 * CONDITIONAL WRITE (Kasra-core round-2 finding — a given RELEASE_SHA's bundle must be
 * IMMUTABLE once published, never silently overwritten by different bytes under a retry,
 * a re-run with a stale local tree, or two colonies racing the same commit). PUTs with
 * `If-None-Match: '*'` (R2's S3-compatible API conditional-write extension — write only if
 * the key does not already exist). A `412 Precondition Failed` means the key already
 * exists: this function then GETs the existing object and compares digests — an IDENTICAL
 * digest is treated as a successful, idempotent re-publish (`alreadyPublished: true` on the
 * result, no error); a DIFFERENT digest throws `BundleShaConflictError`
 * (`code: 'bundle_sha_conflict'`) rather than ever silently replacing what is already live
 * for that commit. UNVERIFIED LIVE (same discipline as the rest of this module): this
 * session cannot confirm R2's S3-compatible PutObject actually honors `If-None-Match: '*'`
 * with a `412` on conflict — see docs/workflows/tenant-provision.md's live-verify-before-
 * merge receipt for where this gets confirmed against a real bucket.
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
      'If-None-Match': '*',
      'X-Amz-Content-Sha256': sha256,
      [`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`]: sha256,
    },
    body: bodyText,
  })
  const signed = await client.sign(request)
  const res = await fetchImpl(signed)

  if (res.status === 412) {
    const existing = await verifyPotWorkerBundleObject({
      accountId,
      bucket,
      releaseSha,
      accessKeyId,
      secretAccessKey,
      signingClient: client,
      fetchImpl,
    })
    if (existing.ok && existing.sha256 === sha256) {
      return { key, sha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }), alreadyPublished: true }
    }
    throw new BundleShaConflictError(
      `refusing to publish '${key}': an object already exists there with a DIFFERENT digest ` +
        `(existing ${existing.ok ? existing.sha256 : 'unreadable: ' + existing.reason}, attempted ${sha256}) — ` +
        'a published RELEASE_SHA bundle is immutable; this commit must never resolve to two ' +
        'different bundles.',
      { key, existingSha256: existing.ok ? existing.sha256 : undefined, attemptedSha256: sha256 },
    )
  }

  if (!res.ok) {
    const text = redactS3ErrorBody(await res.text().catch(() => ''))
    throw new Error(`R2 PUT '${key}' failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`)
  }
  return { key, sha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }), alreadyPublished: false }
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
    const text = redactS3ErrorBody(await res.text().catch(() => ''))
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
  return { ok: true, key, sha256: actualSha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }) }
}

// ── Printed-receipt shaping (CodeQL js/clear-text-logging, 2026-09-22) ──
//
// scripts/verify-pot-bundle.mjs used to `console.log(JSON.stringify(result))` — the FULL
// object `verifyPotWorkerBundleObject` returns, which (before this fix) carried a `url`
// field built directly from `CLOUDFLARE_ACCOUNT_ID`. CodeQL's js/clear-text-logging flagged
// exactly that data flow: an environment-derived value reaching a log sink. Redacting the
// account id inside `url` (above) closes the immediate hole, but the durable fix is that
// NEITHER CLI script ever prints a whole result/receipt object again — each builds its
// printed JSON from an explicit field allow-list instead. On success: object key, sha256,
// size, and a timestamp — never `bucket` (can carry `POT_WORKER_BUNDLE_R2_BUCKET`) and
// never `url`/`endpoint` (even redacted — simplest to just not print it at all). On
// failure: the `reason` string only, which this module's own functions already keep free
// of every environment-derived value (grepped and tested).

/** Builds the JSON receipt `scripts/verify-pot-bundle.mjs` prints, from an explicit
 *  allow-list of fields on `result` (the return value of `verifyPotWorkerBundleObject`) —
 *  never the raw `result` object itself. `now` is injectable for deterministic tests. */
export function buildVerifyReceipt(result, { now = () => new Date().toISOString() } = {}) {
  if (result.ok) {
    return { ok: true, key: result.key, sha256: result.sha256, size: result.size, timestamp: now() }
  }
  return { ok: false, reason: result.reason }
}

/** Builds the JSON receipt `scripts/publish-pot-bundle.mjs` prints on a successful publish,
 *  from an explicit allow-list of fields on `receipt` (the return value of
 *  `putPotWorkerBundleObject`) — never the raw `receipt` object itself. `now` is injectable
 *  for deterministic tests. */
export function buildPublishReceipt(receipt, { now = () => new Date().toISOString() } = {}) {
  return {
    ok: true,
    key: receipt.key,
    sha256: receipt.sha256,
    size: receipt.size,
    already_published: receipt.alreadyPublished,
    timestamp: now(),
  }
}
