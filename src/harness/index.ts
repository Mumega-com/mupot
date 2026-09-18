// src/harness/index.ts — Unified Harness Adapter SPI entry point.

import { cursorCloudAdapter } from './adapters/cursor'
import { grokCliAdapter } from './adapters/grok'
import { registerHarnessAdapter } from './registry'

// Register built-in adapters
registerHarnessAdapter(cursorCloudAdapter)
registerHarnessAdapter(grokCliAdapter)

export * from './types'
export * from './reservations'
export * from './registry'
export { cursorCloudAdapter } from './adapters/cursor'
export { grokCliAdapter } from './adapters/grok'
