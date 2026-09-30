# Decision port (`src/decisions/`)

A microkernel for small decision models (a classifier or judge) so the model behind it
can be swapped without touching callers or policy.

## The rule

A decision model may **rank or propose, never authorize**. Its output is data
(probabilities, a score), never a permission. No type in `src/decisions/port.ts` and no
column in `decision_receipts` carries an authorize/allow/approved field
(`tests/decisions-port.test.ts` pins this). Every failure path returns a non-proposal
outcome, i.e. it goes to a human.

## Status of this PR

Nothing calls `decide()` except tests. `src/mcp/agent-lifecycle.ts` is unchanged and
still uses its own Jev call. The default adapter is `human`, so merging changes no
behaviour. Migration 0186 is not applied by this PR; a human applies it.

## Entry point

`decide(env, request, config)` in `src/decisions/decide.ts` is the only entry. In order:

1. Request shape is validated. Every `noul` and `choice` question needs a threshold in
   `config.thresholds`; a missing one is `invalid_request` (no silent default).
2. `request.state` is fenced (`fence.ts`): hidden/bidi characters, chat-template tokens,
   code fences, role-prefixed lines and "ignore previous instructions" phrasing are
   neutralized and length is capped (default 2000). This is defence in depth, not a
   guarantee; the structural containment is the rule above.
3. Data-class gate: `request.dataClass` must be <= `adapter.dataPolicy.maxDataClass`
   (`none < metadata < personal < financial < regulated`), else `data_class_not_allowed`
   and the adapter is never called. `workers-ai` and `typesafe` are max `metadata`.
4. Hard timeout (default 2000 ms) enforced by racing the adapter, so an adapter that
   ignores the abort signal still cannot hold the caller.
5. Output is validated against this request: right answer type per question,
   probabilities finite and in [0,1], choice keys subset of the allowed options, sum
   within 0.02 of 1, score finite and within optional min/max, `modelVersion` present
   and not one of the adapter's declared aliases. Anything else is `malformed_output`.
6. Thresholds: noul uses top = max(p, 1-p); choice uses the top probability and the gap
   to the runner-up. Below either bound the outcome is `declined_low_confidence`
   (answers are returned as data, but the outcome is not a proposal). Score questions
   have no threshold.
7. One `decision_receipts` row is written per call, success or failure, before
   returning. If the write fails, the caller gets `failed` / `receipt_write_failed` and
   no answers.

Outcomes: `proposed`, `declined_low_confidence`, `failed`, `deferred_to_human`.

## Adapters

Selected by `env.DECISION_ADAPTER` (`human` default; `workers-ai`; `typesafe`); an unknown
value selects `human`.

| id | what | max data class |
|----|------|----------------|
| `human` | always `deferred_to_human`; sends nothing | regulated (nothing leaves) |
| `workers-ai` | `env.AI.run('typesafe/jev', {state, questions}, {gateway?: {id: env.DECISION_GATEWAY_ID}})` | metadata |
| `typesafe` | POST `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, `env.TYPESAFE_API_KEY` | metadata |

To add an adapter: implement `DecisionAdapter` (`id`, `dataPolicy`, optional `aliases`,
`decide(request, signal)`) returning a `DecisionResult` and not throwing for expected
failures, add a `case` in `registry.ts`, and give it a conservative `maxDataClass`.
Callers and policy do not change.

## Receipt fields (`decision_receipts`)

`id, tenant (nullable), use_case, data_class, adapter_id, model, model_version, criteria_hash,
input_hash, answers_json, threshold_json, outcome, reason, latency_ms, input_tokens,
created_at`. `criteria_hash` is sha256 of canonical JSON `{criteriaVersion, questions}`
(key-order independent). `input_hash` is sha256 of canonical JSON
`{useCase, dataClass, fenced state}`. The raw input text is never stored. Both tables
have `no_update`/`no_delete` triggers. `decision_outcomes` (`accepted`/`overridden` by a
member) is a separate append-only table that can only reference a `proposed` receipt;
this PR adds no code that writes to it.

## Workers AI gateway prerequisite

A live probe of the Cloudflare REST path for the third-party `typesafe/jev` model returned
403 code 2049 "Gateway authentication is required to use unified billing. Enable
authentication on your gateway or provide your own API key (BYOK)". The `workers-ai`
adapter maps that error (code 2049 or the message text) to `gateway_auth_required`. To use
it, an authenticated AI Gateway (or BYOK) must exist and its id set as
`DECISION_GATEWAY_ID`.

## Open items / not verified

- Not run against any live provider from this PR. Whether the `env.AI` binding path
  returns the same 2049 error as REST, and its exact response shape, are unverified.
- Only the `choice` response shape is copied from a live-verified caller
  (`agent-lifecycle.ts`). The `noul` (`{probability}`) and `score` (`{score}`) shapes are
  assumed. The response `model` field is used as `modelVersion`; if a provider omits it or
  returns an alias, the call fails closed as `malformed_output`.
- `input_hash` of short or low-entropy text can be brute-forced by anyone holding the
  receipt table; it is a fingerprint, not a secret-preserving commitment.
- Provider residency/retention strings are placeholders (`per-provider-terms-unverified`).
- No writer for `decision_outcomes`, no caller wiring, no rate limiting or spend cap.
