// Advice only: refusal guidance never grants archive authority or changes task state.
export const ARCHIVE_PROPOSE_NEXT_STEP =
  'If this task should be archived, propose it with archive_propose; a human can review it at /board/cleanup.'

// Keep a more-specific existing hint (for example, a flight recovery action)
// while adding the optional archive route for the person at the keyboard.
export function withArchiveProposeNextStep<T extends Record<string, unknown>>(refusal: T): T & { next_step: string } {
  const existing = typeof refusal.next_step === 'string' && refusal.next_step.trim().length > 0
    ? `${refusal.next_step} `
    : ''
  return { ...refusal, next_step: `${existing}${ARCHIVE_PROPOSE_NEXT_STEP}` }
}
