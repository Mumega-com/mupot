// src/ingress/guards.ts — Structural Ingress & Untrusted-Content Fencing (FLIGHT-UNTRUSTED / F6).
//
// Elevates untrusted content from a mere prose tag convention to structural type invariants:
// 1. Ingress Trust Boundary: Distinguishes 'directive' (verified owner) from 'untrusted_data'.
// 2. Structural Instruction-vs-Data Separation:
//    - Wraps untrusted text in structural envelopes that cannot masquerade as system instructions.
// 3. Directive Sender Validation: Platform-authenticated sender ID mapping.

export type IngressTrustLevel = 'directive' | 'untrusted_data'

export interface StructuredIngressPayload {
  trustLevel: IngressTrustLevel
  isDirective: boolean
  rawText: string
  sanitizedBody: string
  senderId: string
  platform: string
}

export const DIRECTIVE_SENDERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  telegram: ['765204057'], // Hadi, platform-authenticated sender id
}

/**
 * Validates if the sender is authenticated as directive-capable.
 */
export function isDirectiveSender(platform: string, senderId: string): boolean {
  const allowed = DIRECTIVE_SENDERS[platform] ?? []
  return allowed.includes(senderId)
}

/**
 * Creates a structural ingress envelope enforcing data vs instruction separation.
 */
export function wrapIngressContent(
  platform: string,
  senderId: string,
  text: string,
): StructuredIngressPayload {
  const isDirective = isDirectiveSender(platform, senderId)
  const trustLevel: IngressTrustLevel = isDirective ? 'directive' : 'untrusted_data'

  let sanitizedBody = text
  if (!isDirective) {
    // Structural untrusted content tag
    sanitizedBody = text.startsWith('[UNTRUSTED-INGRESS]')
      ? text
      : `[UNTRUSTED-INGRESS] ${text}`
  }

  return {
    trustLevel,
    isDirective,
    rawText: text,
    sanitizedBody,
    senderId,
    platform,
  }
}

/**
 * Asserts that an operation requiring directive-level trust has verified provenance.
 */
export function assertDirectiveAuthority(ingress: StructuredIngressPayload): void {
  if (ingress.trustLevel !== 'directive' || !ingress.isDirective) {
    throw new Error('Directive-required: only verified owner directives can execute this action. Input treated as untrusted data.')
  }
}
