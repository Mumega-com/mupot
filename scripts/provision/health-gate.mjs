// Health gate — P0 core (flight/zero-install-p0-provision-core)
//
// Verified shape (§2/§8.1 — PostHog deploy-hobby file-level check): poll every
// 5s, timeout 600s, elapsed reported. Gate condition (research §2 lesson 3):
// /health returns 200 AND commit == pinned SHA AND clean == true
// (deploy-stamp parity — a 200 from a stale deploy is a FAIL, not a pass).

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 600_000;

export async function gate({ tenant, expectedSha, healthUrl, fetchImpl, onProgress }) {
  const log = onProgress ?? (() => {});
  const url = healthUrl ?? `https://${tenant}.mupot.mumega.com/health`;
  const doFetch = fetchImpl ?? fetch;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    let body = null;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) body = await res.json();
    } catch {
      // transient — keep polling until timeout
    }
    if (body && body.ok === true && body.commit === expectedSha && body.clean === true) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      log(`health gate green after ${elapsed}s (commit=${body.commit}, clean=${body.clean})\n`);
      return { ok: true, elapsed };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  log(`health gate TIMEOUT after ${elapsed}s — last body: ${JSON.stringify(body)}\n`);
  return { ok: false, elapsed, lastBody: body };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
