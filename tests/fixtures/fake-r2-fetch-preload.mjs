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
// TWO configuration modes, both via env vars (never argv, so this file needs no changes
// per test case):
//
//  1. FLAT (single response for every request — the original mode):
//       FAKE_R2_STATUS       — HTTP status returned for every request (default 403).
//       FAKE_R2_BODY         — response body text (default: empty).
//       FAKE_R2_HEADERS_JSON — optional JSON object of extra response headers.
//
//  2. SCRIPTED (mupot#1529 round-1 P1-2 — per-request responses, in call order — needed to
//     exercise the pre-PUT classification layer, which makes MULTIPLE requests per publish
//     attempt: a pre-check GET, then possibly a PUT, then possibly a confirming GET):
//       FAKE_R2_SCRIPT_JSON  — a JSON array of `{ status, body, headers }` steps. The Nth
//                              request to a `.r2.cloudflarestorage.com` URL (0-indexed,
//                              across ALL methods — GET and PUT alike) gets script[N]; once
//                              the script is exhausted, the LAST step repeats for any
//                              further request (never throws on an unscripted extra call).
//
// Only intercepts requests to a `.r2.cloudflarestorage.com` host — anything else falls
// through to the real `fetch` (not expected to be hit by either script, but never silently
// swallowed if it somehow is).

const realFetch = globalThis.fetch

function loadScript() {
  const raw = process.env.FAKE_R2_SCRIPT_JSON
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return parsed
}

const script = loadScript()
let scriptCallIndex = 0

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url
  if (typeof url === 'string' && url.includes('.r2.cloudflarestorage.com')) {
    if (script) {
      const step = script[Math.min(scriptCallIndex, script.length - 1)]
      scriptCallIndex++
      return new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers ?? {} })
    }
    const status = Number(process.env.FAKE_R2_STATUS || '403')
    const body = process.env.FAKE_R2_BODY || ''
    const extraHeaders = process.env.FAKE_R2_HEADERS_JSON ? JSON.parse(process.env.FAKE_R2_HEADERS_JSON) : {}
    return new Response(body, { status, headers: extraHeaders })
  }
  return realFetch(input, init)
}
