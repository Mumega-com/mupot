// mupot — department microkernel: kernel-private mint seam.
//
// This file is the ONLY import site of createMintSeam(). It acquires the
// minting capability once at module load and re-exports only the narrow public
// interface needed by registry.ts.
//
// IMPORT DISCIPLINE:
//   - Only registry.ts may import from this file.
//   - Department modules MUST NOT import from kernel.ts.
//   - There is no circular dependency: ctx.ts → (no imports from kernel.ts);
//     kernel.ts → ctx.ts (for createMintSeam); registry.ts → kernel.ts.
//
// WHY A SEPARATE FILE:
//   CF Workers bundle everything in the same process. The only real boundary is
//   "a symbol that is never exported cannot be imported." By keeping the token
//   in this file's module-private const (_seam.token), and not re-exporting it,
//   department modules cannot obtain the token even if they import kernel.ts
//   (because the token is not in kernel.ts's export list either).
//   The only thing kernel.ts exports is `kernelMintCtx` — a function that
//   already has the token baked into its closure.

import { createMintSeam } from './ctx'
import type { KernelHandle, DepartmentCtx } from './ctx'
import type { DepartmentModule } from './contract'
import type { Capability } from '../types'

// ── Acquire the mint seam once (module-private) ────────────────────────────────
//
// _seam.token is NOT exported. _seam.mint is NOT exported.
// Only kernelMintCtx (which has the token baked in) is exported.

const _seam = createMintSeam()

// ── kernelMintCtx ─────────────────────────────────────────────────────────────
//
// The ONLY public path to create a DepartmentCtx. Used by registry.ts and by
// the conformance test harness. Department modules never receive or call this.
//
// The kernel token is closed over inside _seam — it is never passed to callers.

export function kernelMintCtx(
  handle: KernelHandle,
  opts: {
    tenantId: string
    departmentKey: string
    module: DepartmentModule
    capabilities: Capability[]
    now?: () => string
    idGen?: () => string
  },
): DepartmentCtx {
  return _seam.mint(_seam.token, handle, opts)
}

// ── _isKernelToken ────────────────────────────────────────────────────────────
//
// Test-harness helper: verify that a given symbol IS the kernel token.
// Used by the conformance harness to prove that a wrong symbol is rejected by
// the token gate.
//
// NOT useful for attacking the boundary: calling _isKernelToken(x) only tells
// you true/false; it does not give you the real token.

export function _isKernelToken(sym: symbol): boolean {
  return _seam.isToken(sym)
}
