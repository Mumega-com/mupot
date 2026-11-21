// Advice only: refusal guidance never grants archive authority or changes task state.
export function taskCloseNextStep(audience: 'agent' | 'human', evidence: boolean = false): string {
  const evidenceStep = evidence ? 'Submit evidence for review first. ' : ''
  const archivalStep = audience === 'agent'
    ? 'If work is truly superseded, propose archival with archive_propose; a human can review it at /board/cleanup.'
    : 'If work is truly superseded, ask a human to review it at /board/cleanup.'
  return `${evidenceStep}${archivalStep}`
}
