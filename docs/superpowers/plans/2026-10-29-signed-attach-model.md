# Signed attach model implementation plan

Goal: keyed agents can report a model without falling back to bearer attach.
Spec: Kasra brief `p3b-signed-attach-model-20261029.md`.

The optional raw model extends the signed bytes with a tagged JSON string suffix.
Omission preserves the original canonical bytes exactly; adding, removing, or changing
model invalidates a signature. JSON encoding keeps control characters unambiguous.
After verification, reuse cleanReported with MAX_REPORTED_MODEL (128). The existing
8 KB request cap bounds raw input, including values that need truncation.

- [x] Establish existing signed attach and bearer model test baseline.
- [x] Add real-migration SQL tests for signed model writes, key-derived provenance,
  tampering (including addition/removal and same-cleaned-value changes), omission,
  blank values, cleaning/truncation, invalid types, and nonce replay.
- [x] Add host signer signature tests and CLI env forwarding tests with generated
  in-memory keys or mocked signing; never read host secret files.
- [x] Observe new tests fail, then update server verifier/upsert and host signer/CLI.
- [x] Run affected suites with vitest --maxWorkers=2, Node tests and typecheck;
  require completed processes with exit code 0.
- [ ] Review the diff, commit, push own branch, open PR, report URL/SHA/commands.

No migration: fleet_agents.model already exists. No SessionStart hook change.
Kasra owns kasra-review and the fresh Opus gate, merge and deployment.

Ruling: provenance uses the existing key-derived fleet_agents.reported_by plus an
HTTP report receipt `{model, reported_by, signed:true}`. There is no persistent signed
column. The receipt describes only this report; model remains self-reported metadata.

Verification (all final commands exited 0):

```sh
npx vitest run tests/fleet-attach-signed-model.test.ts tests/fleet-attach-signed.test.ts tests/checkin-attach-model.test.ts tests/fleet-attach.test.ts tests/fleet-shared-nonce-ledger.test.ts tests/flight-harness-model.test.ts --maxWorkers=2
node --test fleet-runtime/fleet-sign.test.mjs fleet-runtime/fleet-daemon.test.mjs
npm run typecheck
node scripts/check-test-schema-source.mjs
git diff --check
```

85 Vitest tests and 34 Node tests passed. Baseline: 31 Vitest + 6 signer tests passed.
Before implementation the new server suite failed (15 tests), including unsigned
model addition returning 200 instead of 401; three host/CLI cases also failed.
An actual host-signer → signed attach → flight landing test now verifies the model
in the flight row and landing receipt. This is local proof, not deployed/live proof.
