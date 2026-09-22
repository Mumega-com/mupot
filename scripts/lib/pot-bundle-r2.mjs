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

/**
 * A remote S3-compatible error body is untrusted, environment-adjacent text: a standard
 * body carries `<BucketName>`, `<Endpoint>`, `<HostId>`, and `<RequestId>` elements, and
 * R2's `<Endpoint>` in particular is exactly `<bucket>.<account-id>.r2.cloudflarestorage.com`
 * — the account id and bucket name, straight from the request this module just signed.
 *
 * mupot#1524 round-2 P1 finding: the earlier `redactS3ErrorBody` scrubbed ONE tag
 * (`<AWSAccessKeyId>`) and passed the remaining ~500 chars of the body through verbatim —
 * CodeQL's js/clear-text-logging rule was green only because its dataflow analysis cannot
 * trace env → signed request → REMOTE response → log; a real error body still laundered
 * `CLOUDFLARE_ACCOUNT_ID` and the bucket name into a thrown message or printed reason.
 *
 * Athena's rule applies here: a printed field must be NAMED to be printed, never merely
 * redacted after the fact. So this function is an ALLOW-LIST, not a scrubber — it returns
 * only the HTTP status and the S3 `<Code>` element (e.g. `AccessDenied`,
 * `InvalidAccessKeyId`), which are the two facts an operator actually needs to diagnose a
 * failure without ever touching `<BucketName>`/`<Endpoint>`/`<HostId>`/`<RequestId>` or any
 * other tag in the body — those are read by nothing here, so there is nothing to redact.
 */
// Real S3/R2 error codes are PascalCase ASCII identifiers ("AccessDenied",
// "InvalidAccessKeyId", "PermanentRedirect", "NoSuchKey") — this is the value grammar, not
// an arbitrary string. mupot#1529 round-1 P2(1): the case-INSENSITIVE `<Code>` match
// matched an unrelated `<code>` element in an HTML error page (a 502 from a CDN/load
// balancer in front of R2, not R2's own XML error schema) — printing whatever a random
// intermediary chose to put there, which can include a hostname. An uncapped match also let
// a hostile/corrupted 2 MB `<Code>` value double the thrown message's size for no benefit.
const S3_ERROR_CODE_GRAMMAR_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/

function summarizeS3Error(status, bodyText) {
  if (typeof bodyText !== 'string') return `HTTP ${status}`
  // Case-SENSITIVE: only the real S3 XML element `<Code>`, never an HTML `<code>` tag.
  const match = bodyText.match(/<Code>([^<]*)<\/Code>/)
  const code = match ? match[1].trim() : null
  if (code && S3_ERROR_CODE_GRAMMAR_RE.test(code)) {
    return `HTTP ${status} (${code})`
  }
  return `HTTP ${status}`
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
 * Thrown by `putPotWorkerBundleObject` when a `412 Precondition Failed` (the object
 * already exists) is followed by a confirming GET that itself fails — 404 (deleted
 * between the PUT and the confirm-GET), a transport error, or an object present but
 * missing/unreadable digest metadata. `bundle_sha_conflict` claims a KNOWN, DIFFERENT
 * digest; none of these cases establish that. Reporting them as `bundle_sha_conflict`
 * (mupot#1524 round-2 P2-4) tells the caller a fact ("the existing bytes differ") that
 * was never actually confirmed. `code: 'bundle_publish_unconfirmed'` names what is
 * actually true instead: this publish attempt's outcome (idempotent success, or a real
 * conflict) could not be established either way.
 */
export class BundlePublishUnconfirmedError extends Error {
  constructor(message, { key, getStatus, reason } = {}) {
    super(message)
    this.name = 'BundlePublishUnconfirmedError'
    this.code = 'bundle_publish_unconfirmed'
    this.key = key
    this.getStatus = getStatus
    this.reason = reason
  }
}

/** An object with IDENTICAL bytes already sits at the key but its `sha256` metadata is
 *  missing or does not match its own bytes — the state a dashboard/`wrangler r2 object put`
 *  upload leaves behind. Nothing here can repair it (a published key is immutable and a
 *  PUT would 412), and `verifyPotWorkerBundleObject` / the pot loader WILL refuse it, so
 *  `alreadyPublished: true` would be a claim about a state never established. Refuse with
 *  zero PUTs and name the recovery procedure (mupot#1529 round-2 P1). */
function unverifiedIdenticalObjectError(key, readResult) {
  return new BundlePublishUnconfirmedError(
    `refusing to report '${key}' as already published: an object with IDENTICAL bytes exists ` +
      'there but its sha256 metadata is missing or does not match its own bytes, so verify ' +
      `(and the pot loader) will refuse it (${readResult.reason ?? 'no reason given'}). Zero ` +
      'PUTs were made — a published key is immutable. Recover per ' +
      'docs/workflows/tenant-provision.md "Recovering from a digest mismatch" (delete the ' +
      'object with `wrangler r2 object delete --remote`, then republish).',
    { key, getStatus: readResult.status, reason: readResult.reason },
  )
}

/**
 * Classifies a `verifyPotWorkerBundleObject` result into what it actually PROVES about
 * whether the object exists, rather than trusting `.ok` alone (mupot#1529 round-1 P1-2).
 * `.ok` is false for FOUR different reasons — a 404, a transport error, missing metadata,
 * or a mismatch between the object's OWN recorded metadata and its OWN bytes — and only
 * the first of those actually means "nothing is there". The other three are still a `200`
 * response with real, readable bytes: proof of existence regardless of what the object's
 * metadata claims. Before this fix, the pre-PUT read (and the post-412 confirming read)
 * checked `.ok` alone, so a 200-with-no-metadata or 200-with-self-inconsistent-metadata
 * object (reachable in practice — the Cloudflare dashboard and `wrangler r2 object put`
 * both write objects with NO custom metadata at all) fell through to a PUT attempt and, on
 * a server that ignores `If-None-Match`, silently clobbered it.
 *
 *  - `'present'`: the GET returned `200` — bytes were read. `actualSha256` is the digest of
 *    those REAL bytes, computed by `verifyPotWorkerBundleObject` directly from the response
 *    body regardless of what its recorded metadata says or whether it matched — this is the
 *    ONLY value that may ever be compared against an attempted publish's own digest.
 *  - `'absent'`: a `404` — nothing published at this key yet. Safe to proceed to a PUT.
 *  - `'unknown'`: anything else (`403`, `500`, or any other non-200/404 status). Existence
 *    could not be established either way — MUST fail closed. Never treated as `'absent'`,
 *    which would let a PUT proceed and possibly clobber something real that simply
 *    couldn't be read back at the moment of the check.
 */
function classifyExistingObject(result) {
  if (result.status === 200) {
    // `verified` is whether the object's OWN recorded metadata agrees with its bytes — the
    // exact predicate `verifyPotWorkerBundleObject` (and the pot loader) will apply later.
    // A present object whose bytes match but whose metadata is missing/wrong is NOT
    // "already published" (mupot#1529 round-2 P1: two CLIs in one PR disagreed about the
    // same object — publish said already_published:true, verify exited 1).
    return { state: 'present', verified: result.ok === true, actualSha256: result.ok ? result.sha256 : result.actualSha256 }
  }
  if (result.status === 404) {
    return { state: 'absent' }
  }
  return { state: 'unknown' }
}

/** Process exit codes `scripts/publish-pot-bundle.mjs` uses to let `scripts/deploy.mjs`
 *  (which only sees the child's exit code, not the thrown error object, across the
 *  `spawnSync` boundary) tell a genuine digest conflict apart from every other failure —
 *  so its own post-deploy message can name the real recovery procedure
 *  (docs/workflows/tenant-provision.md "Recovering from a digest mismatch") instead of a
 *  generic "re-run publish" that would only refuse again (mupot#1524 round-2 P2-3). Named
 *  exports (not inline literals) so the two scripts can never drift on the numbers. */
export const BUNDLE_SHA_CONFLICT_EXIT_CODE = 2
export const BUNDLE_PUBLISH_UNCONFIRMED_EXIT_CODE = 3

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
 * CONDITIONAL WRITE, TWO LAYERS (Kasra-core round-2 finding, sharpened by mupot#1524
 * round-2 P2-1 — a given RELEASE_SHA's bundle must be IMMUTABLE once published, never
 * silently overwritten by different bytes under a retry, a re-run with a stale local tree,
 * or two colonies racing the same commit):
 *
 *   1. PRE-PUT READ (first layer, P2-1): before ANY write attempt, this function GETs the
 *      object back and compares digests. Identical bytes short-circuits to an idempotent
 *      `alreadyPublished: true` result with ZERO PUT calls; different bytes throws
 *      `BundleShaConflictError` with ZERO PUT calls. `If-None-Match: '*'` alone trusts the
 *      SERVER to enforce the conditional write correctly — a server that silently ignores
 *      the header would let a PUT of different bytes clobber an already-published bundle
 *      with no visible error at all. Reading first removes that trust requirement for the
 *      overwhelmingly common case (the object already exists and this call can see it).
 *   2. `If-None-Match: '*'` (second layer): still sent on every PUT, for the race the
 *      pre-check cannot see — two callers passing the pre-check concurrently, both
 *      observing "does not exist yet". A `412 Precondition Failed` here means another
 *      writer won that race between this function's own read and its write: the SAME
 *      re-GET-and-compare logic runs again, with the SAME identical-vs-different branching
 *      (see `BundlePublishUnconfirmedError` below for what happens when THAT confirming
 *      GET itself cannot be trusted). UNVERIFIED LIVE (same discipline as the rest of this
 *      module): this session cannot confirm R2's S3-compatible PutObject actually honors
 *      `If-None-Match: '*'` with a `412` on conflict — see docs/workflows/
 *      tenant-provision.md's live-verify-before-merge receipt for where this gets
 *      confirmed against a real bucket.
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

  // LAYER 1 — pre-PUT read (mupot#1524 round-2 P2-1; classification fixed mupot#1529
  // round-1 P1-2). `present` (a genuine digest in hand, from EITHER a clean read or a
  // 200-with-bad/no-metadata object) short-circuits here; `absent` (404 only) falls through
  // to the normal attempt-the-PUT path below, where `If-None-Match: '*'` is still the
  // backstop; `unknown` (403/500/anything else) fails CLOSED — zero PUTs, never assumed
  // absent.
  const preCheck = await verifyPotWorkerBundleObject({
    accountId,
    bucket,
    releaseSha,
    accessKeyId,
    secretAccessKey,
    signingClient: client,
    fetchImpl,
  })
  const preClass = classifyExistingObject(preCheck)
  if (preClass.state === 'present') {
    if (preClass.actualSha256 === sha256) {
      if (!preClass.verified) throw unverifiedIdenticalObjectError(key, preCheck)
      return { key, sha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }), alreadyPublished: true }
    }
    throw new BundleShaConflictError(
      `refusing to publish '${key}': an object already exists there with a DIFFERENT digest ` +
        `(existing ${preClass.actualSha256}, attempted ${sha256}) — a published RELEASE_SHA ` +
        'bundle is immutable; this commit must never resolve to two different bundles. Zero ' +
        'PUT requests were made — the pre-publish read caught this before any write attempt.',
      { key, existingSha256: preClass.actualSha256, attemptedSha256: sha256 },
    )
  }
  if (preClass.state === 'unknown') {
    throw new BundlePublishUnconfirmedError(
      `cannot confirm whether '${key}' already exists before publishing: the pre-publish ` +
        `read returned an inconclusive result (status ${preCheck.status ?? 'unknown'}: ` +
        `${preCheck.reason ?? 'no reason given'}) — refusing to attempt a PUT without ` +
        'knowing whether this would create the object or silently race an existing one. ' +
        'Zero PUT requests were made.',
      { key, getStatus: preCheck.status, reason: preCheck.reason },
    )
  }
  // preClass.state === 'absent' (404) — proceed to the normal PUT attempt below.

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
    // LAYER 2 — the server enforced the conditional write; a re-GET confirms what's there.
    // Same classification as LAYER 1 (mupot#1529 round-1 P1-2) — a 200-with-bad/no-metadata
    // object is still a CONFIRMED present object with a real digest in hand, not a wash.
    const existing = await verifyPotWorkerBundleObject({
      accountId,
      bucket,
      releaseSha,
      accessKeyId,
      secretAccessKey,
      signingClient: client,
      fetchImpl,
    })
    const existingClass = classifyExistingObject(existing)
    if (existingClass.state === 'present') {
      if (existingClass.actualSha256 === sha256) {
        if (!existingClass.verified) throw unverifiedIdenticalObjectError(key, existing)
        return { key, sha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }), alreadyPublished: true }
      }
      throw new BundleShaConflictError(
        `refusing to publish '${key}': an object already exists there with a DIFFERENT digest ` +
          `(existing ${existingClass.actualSha256}, attempted ${sha256}) — a published ` +
          'RELEASE_SHA bundle is immutable; this commit must never resolve to two different ' +
          'bundles.',
        { key, existingSha256: existingClass.actualSha256, attemptedSha256: sha256 },
      )
    }
    // mupot#1524 round-2 P2-4 (extended mupot#1529 round-1 P1-2): the confirming GET
    // itself was inconclusive (404 — the object vanished between the 412 and this GET,
    // itself an anomaly — or a transport error) — this is NOT a confirmed digest conflict,
    // it is an UNCONFIRMED publish outcome. Reporting it as `bundle_sha_conflict` would
    // claim a fact (the existing bytes differ) that was never actually established.
    throw new BundlePublishUnconfirmedError(
      `cannot confirm the publish outcome for '${key}': the server reported the object ` +
        `already exists (412), but the confirming GET (status ${existing.status ?? 'unknown'}) ` +
        `could not establish the existing digest (${existing.reason ?? 'no reason given'}) — ` +
        'this is neither a confirmed idempotent re-publish nor a confirmed digest conflict.',
      { key, getStatus: existing.status, reason: existing.reason },
    )
  }

  if (!res.ok) {
    const summary = summarizeS3Error(res.status, await res.text().catch(() => ''))
    throw new Error(`R2 PUT '${key}' failed: ${summary}`)
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
    return { ok: false, key, status: 404, reason: `no object published at '${key}'` }
  }
  if (!res.ok) {
    const summary = summarizeS3Error(res.status, await res.text().catch(() => ''))
    return { ok: false, key, status: res.status, reason: `R2 GET '${key}' failed: ${summary}` }
  }
  const recordedSha256 = res.headers.get(`x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}`)
  const bodyText = await res.text()
  const actualSha256 = sha256HexOfUtf8Text(bodyText)
  if (!recordedSha256) {
    return {
      ok: false,
      key,
      status: res.status,
      reason: `object exists but carries no 'x-amz-meta-${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}' metadata`,
      actualSha256,
    }
  }
  if (recordedSha256 !== actualSha256) {
    return {
      ok: false,
      key,
      status: res.status,
      reason: `digest mismatch: recorded ${recordedSha256}, computed ${actualSha256} from the bytes read back`,
      recordedSha256,
      actualSha256,
    }
  }
  return { ok: true, key, status: res.status, sha256: actualSha256, size: Buffer.byteLength(bodyText, 'utf8'), bucket, url: redactedR2ObjectUrl({ bucket, key }) }
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
