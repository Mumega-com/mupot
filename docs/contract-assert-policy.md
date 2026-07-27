# Contract assert policy

Machine-checkable guardrails for mupot machine contracts (JSON + TS module + vitest suite).

## Rules

1. **Lifecycle fields** (`status`, `mode`, `phase`): the policy spec must declare `allowedValues` and `whoMayFlip`. Contract JSON values must be members of `allowedValues`. Tests must **not** use `expect(contract.status).toBe('literal')` — assert membership in the declared set instead.

2. **JSON↔TS mirrors**: mirrored JSON paths must match exported TS constants. Tests must assert `expect(contract.path).toEqual([...TS_CONSTANT])` or `.toBe(TS_CONSTANT)` — never retype literals (`['talk', 'know']`) in the test. Missing TS export is a finding.

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

Implementation: `src/contracts/contract-assert-policy.ts`. Tests (including mutation fixtures): `tests/contract-assert-policy.test.ts`.
