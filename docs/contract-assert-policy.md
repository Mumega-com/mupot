# Contract assert policy

**What this is:** a machine-checkable **lint** for mupot machine contracts
(JSON + TS module + vitest suite source text). It is **not** enforcement —
a motivated builder can step around it in one or two lines (omit a mirror
declaration with its assertion, comment out an assertion token, or alias a
lifecycle literal). Do not describe it as a production gate.

**Owner of `src/contracts/contract-assert-policy.ts`:** this branch
(`cursor/contract-assert-policy`). Consumer lanes (owner-experience,
brain-learning-ranker, …) must copy the blob verbatim and must not diverge.
Divergent edits land without merge conflicts and silently weaken other
consumers — pick this owner before a third adopter.

## Rules

1. **Lifecycle fields** (`status`, `mode`, `phase`): the policy spec must declare `allowedValues` and `whoMayFlip`. Contract JSON values must be members of `allowedValues`. Tests must **not** use `expect(contract.status).toBe('literal')` — assert membership in the declared set instead. `whoMayFlip` length-only checks are decorative unless the consumer also drift-locks the contents against a design doc / frozen TS constant.

2. **JSON↔TS mirrors**: mirrored JSON paths must match exported TS constants. Tests must assert `expect(contract.path).toEqual([...TS_CONSTANT])` or `.toBe(TS_CONSTANT)` — never retype literals (`['talk', 'know']`) in the test. Missing TS export is a finding. Finding code `json_ts_mirror_assertion_token_absent` means the suite **source text** lacks the assertion token — commented-out / `it.skip` / dead-branch text still counts. Rename honesty: this is token presence, not "assertion runs".

## Usage

```typescript
import { runContractAssertPolicy } from '../src/contracts/contract-assert-policy'

const findings = runContractAssertPolicy({
  spec: { lifecycleFields, jsonTsMirrors },
  contractJson,
  tsExports,
  testSource,
})
expect(findings).toEqual([])
```

Implementation: `src/contracts/contract-assert-policy.ts`. Self-test (all finding codes + mutation battery): `tests/contract-assert-policy.test.ts`.
