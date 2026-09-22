// tests/fixtures/fake-r2-fetch-preload.mjs — a `node --import` preload hook that replaces
// `globalThis.fetch` BEFORE the target script (scripts/verify-pot-bundle.mjs /
// scripts/publish-pot-bundle.mjs) ever runs, so a REAL CLI process can be spawned end-to-
// end (tests/pot-bundle-r2.test.ts) without ever making a real network call.
//
// Both CLI scripts call `putPotWorkerBundleObject`/`verifyPotWorkerBundleObject` with NO
// `fetchImpl` argument, which defaults to `fetch` looked up in the CALLER's scope at
// invocation time — so overriding the global here (which runs strictly before the target
// module is imported) is picked up exactly as if it were injected via the `fetchImpl`
// parameter, but through the real process boundary the CLI scripts themselves run in.
//
// Configured entirely via env vars (never argv, so this file needs no changes per test
// case):
//   FAKE_R2_STATUS      — HTTP status the fake R2 endpoint returns for every request
//                          (default 403).
//   FAKE_R2_BODY        — response body text (default: empty).
//   FAKE_R2_HEADERS_JSON — optional JSON object of extra response headers.
//
// Only intercepts requests to a `.r2.cloudflarestorage.com` host — anything else falls
// through to the real `fetch` (not expected to be hit by either script, but never silently
// swallowed if it somehow is).

const realFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url
  if (typeof url === 'string' && url.includes('.r2.cloudflarestorage.com')) {
    const status = Number(process.env.FAKE_R2_STATUS || '403')
    const body = process.env.FAKE_R2_BODY || ''
    const extraHeaders = process.env.FAKE_R2_HEADERS_JSON ? JSON.parse(process.env.FAKE_R2_HEADERS_JSON) : {}
    return new Response(body, { status, headers: extraHeaders })
  }
  return realFetch(input, init)
}
