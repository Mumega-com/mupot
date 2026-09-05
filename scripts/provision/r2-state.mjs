// R2 entitlement state machine — P0 core (flight/zero-install-p0-provision-core)
//
// Owner: Loom (lane split 2026-09-04). Skeleton by Mubot for interface lock.
//
// Invariants (plan §3, dual-signed):
//   R1: entitlement probe runs BEFORE any bucket op.
//   R2: worker deploy is REFUSED while state ≠ entitlement_active — including
//       the 10136 split (R2 data-plane reachable but binding entitlement off).
//   R3: awaiting_r2_activation parks with deep link printed (exit 3); resume
//       re-probes, never replays an entitlement write (no such write exists —
//       research 7.1a: activation is dashboard-only, workers-sdk#15468).
//   Detection strings per research 7.1a (VT-2 to confirm live on a virgin
//   account; shapes documented, tests assert on the documented shapes).
//
// NOTE: setup.sh is UNTOUCHED (owner Kasra absent) — this module is the NEW
// provisioner path under scripts/provision/ (plan §5 P0; wrap-vs-rework
// decision deferred to owner's return).

export const R2_STATES = Object.freeze([
  'entitlement_unknown',
  'entitlement_required', // 10042 — account not entitled to R2
  'entitlement_active',
  'buckets_created',
  'worker_deployed', // terminal for this module; deploy itself lives in provision.mjs
]);

export const R2_DASHBOARD_DEEP_LINK = 'https://dash.cloudflare.com/?to=/:account/r2/activation';

// Documented detection shapes (research 7.1a; VT-2 pending — do not change
// without a live capture):
export const ERR_NOT_ENTITLED = '10042'; // "not entitled to use R2"
export const ERR_BINDING_ENTITLEMENT = '10136'; // worker deploy w/ r2_buckets binding fails despite data-plane OK

// Probe entitlement via GET /accounts/{id}/r2/buckets.
// cfClient: { request(method, path, body) -> { status, json } } — injected so
// tests run without network (TEST-ORD-1..3 run offline against fixtures).
export async function probeEntitlement(cfClient) {
  const res = await cfClient.request('GET', `/accounts/${cfClient.accountId}/r2/buckets`);
  if (res.status === 200) return { state: 'entitlement_active', evidence: `GET /r2/buckets 200` };
  const code = res.json?.code ?? extractErrorCode(res.raw ?? '');
  if (String(code) === ERR_NOT_ENTITLED) {
    return { state: 'entitlement_required', evidence: `GET /r2/buckets code:10042 (not entitled to use R2)` };
  }
  return { state: 'entitlement_unknown', evidence: `GET /r2/buckets ${res.status} code:${code ?? 'none'}` };
}

// Order-guard: refuse deploy unless entitlement is verified active.
// Returns { allowed: true } | { allowed: false, reason, exit } — provision.mjs
// treats reason 'entitlement_required' as exit 3 (parked, deep link printed).
export function guardWorkerDeploy(entitlementState) {
  if (entitlementState === 'entitlement_active' || entitlementState === 'buckets_created') {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: entitlementState === 'entitlement_required' ? 'entitlement_required' : 'entitlement_unknown',
    exit: entitlementState === 'entitlement_required' ? 3 : 2,
    message:
      entitlementState === 'entitlement_required'
        ? `R2 is not enabled on this account. Open ${R2_DASHBOARD_DEEP_LINK} to activate, then re-run — provisioning resumes automatically.`
        : 'R2 entitlement could not be verified (entitlement_unknown). Fix connectivity/permissions and re-run.',
  };
}

// Classify a FAILED worker-deploy response into the state machine (TEST-ORD-2).
// 10136 ⇒ binding entitlement off despite reachable data-plane: same park as
// entitlement_required (dashboard deep link, exit 3). Anything else passes
// through untouched — the caller owns non-entitlement deploy failures.
export function classifyDeployError(res) {
  const code = String(res?.json?.code ?? extractErrorCode(res?.raw ?? '') ?? '');
  if (code === ERR_BINDING_ENTITLEMENT) {
    return {
      state: 'entitlement_required',
      exit: 3,
      evidence: 'POST worker versions code:10136 (r2 binding entitlement off)',
      message: `Worker deploy refused the R2 binding (code 10136): entitlement lapsed after probe. Open ${R2_DASHBOARD_DEEP_LINK}, then re-run — provisioning resumes automatically.`,
    };
  }
  return { state: null, exit: null, evidence: null, message: null, passthrough: res ?? null };
}

// Tolerant code extraction from non-JSON error bodies (wrangler/CF text errors).
function extractErrorCode(text) {
  const m = /\bcode[:\s]+(\d{4,5})\b/.exec(String(text ?? ''));
  return m ? m[1] : null;
}
