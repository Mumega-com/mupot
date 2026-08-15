// src/dashboard/tentacles-view.ts — Flight-004 TENTACLES: Seat Fan-Out Visualization
//
// Pure view component rendering the three-layer colony execution graph:
// Agent -> Seat -> Tentacle (bounded runner).
// Interactive SVG fan-out with status-colored nodes and collapsible log/evidence cards.

import { html } from 'hono/html'
import type { Html } from './ui'
import type { RunnerReceipt } from '../runners/types'

export interface TentaclesViewProps {
  runners: RunnerReceipt[]
  nowMs?: number
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function renderTentaclesPanel(props: TentaclesViewProps): Html {
  const { runners, nowMs = Date.now() } = props

  // Group runners by seat_agent_id
  const runnersBySeat = new Map<string, RunnerReceipt[]>()
  for (const r of runners) {
    const list = runnersBySeat.get(r.seat_agent_id) ?? []
    list.push(r)
    runnersBySeat.set(r.seat_agent_id, list)
  }

  const seatEntries = Array.from(runnersBySeat.entries())
  const totalRunners = runners.length
  const runningCount = runners.filter((r) => r.status === 'running').length
  const landedCount = runners.filter((r) => r.status === 'landed').length
  const failedCount = runners.filter((r) => r.status === 'failed').length

  return html`
    <section class="tentacles-container" style="margin-top: 1.5rem; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <!-- Telemetry Stats Bar -->
      <div style="display: flex; gap: 1rem; align-items: center; justify-content: space-between; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.5rem;">
        <div>
          <h2 style="margin: 0; font-size: 1.1rem; font-weight: 600; color: #f8fafc; display: flex; align-items: center; gap: 0.5rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            Colony Fan-Out (Tentacles)
          </h2>
          <p style="margin: 0.25rem 0 0; font-size: 0.8rem; color: #94a3b8;">
            Real-time telemetry for seat subagents, gate verifiers, and background tasks.
          </p>
        </div>
        <div style="display: flex; gap: 0.75rem;">
          <span style="font-size: 0.75rem; padding: 0.35rem 0.65rem; border-radius: 6px; background: #1e293b; color: #f8fafc; border: 1px solid #334155;">
            Total: <strong>${totalRunners}</strong>
          </span>
          <span style="font-size: 0.75rem; padding: 0.35rem 0.65rem; border-radius: 6px; background: #064e3b; color: #34d399; border: 1px solid #059669;">
            Landed: <strong>${landedCount}</strong>
          </span>
          <span style="font-size: 0.75rem; padding: 0.35rem 0.65rem; border-radius: 6px; background: #0c4a6e; color: #38bdf8; border: 1px solid #0284c7;">
            Running: <strong>${runningCount}</strong>
          </span>
          ${failedCount > 0
            ? html`<span style="font-size: 0.75rem; padding: 0.35rem 0.65rem; border-radius: 6px; background: #7f1d1d; color: #f87171; border: 1px solid #dc2626;">
                Failed: <strong>${failedCount}</strong>
              </span>`
            : ''}
        </div>
      </div>

      ${seatEntries.length === 0
        ? html`
            <div style="text-align: center; padding: 3rem 1rem; background: #0b1120; border: 1px dashed #1e293b; border-radius: 8px; color: #64748b;">
              <p style="margin: 0; font-size: 0.95rem;">No active or historical tentacles recorded for this scope.</p>
              <p style="margin: 0.5rem 0 0; font-size: 0.8rem;">When seats spawn bounded subagent runners, their execution graphs and evidence receipts will stream here live.</p>
            </div>
          `
        : html`
            <div style="display: flex; flex-direction: column; gap: 1.5rem;">
              ${seatEntries.map(([seatAgentId, seatRunners]) => {
                return html`
                  <div class="seat-card" style="background: #0b1120; border: 1px solid #1e293b; border-radius: 8px; overflow: hidden;">
                    <!-- Seat Header -->
                    <div style="background: #0f172a; padding: 0.75rem 1.25rem; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between;">
                      <div style="display: flex; align-items: center; gap: 0.6rem;">
                        <div style="width: 10px; height: 10px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8;"></div>
                        <span style="font-size: 0.9rem; font-weight: 600; color: #f8fafc; font-family: monospace;">Seat: ${escapeHtml(seatAgentId)}</span>
                        ${seatRunners[0]?.squad_id ? html`<span style="font-size: 0.75rem; color: #64748b; font-family: monospace;">(${escapeHtml(seatRunners[0].squad_id)})</span>` : ''}
                      </div>
                      <span style="font-size: 0.75rem; color: #94a3b8;">${seatRunners.length} runners recorded</span>
                    </div>

                    <!-- Fan-Out Cards Grid -->
                    <div style="padding: 1rem 1.25rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem;">
                      ${seatRunners.map((r) => {
                        const statusColor = r.status === 'landed' ? '#34d399' : r.status === 'failed' ? '#f87171' : '#38bdf8'
                        const statusBg = r.status === 'landed' ? '#064e3b22' : r.status === 'failed' ? '#7f1d1d22' : '#0c4a6e22'
                        const statusBorder = r.status === 'landed' ? '#059669' : r.status === 'failed' ? '#dc2626' : '#0284c7'

                        const durationMs = (r.ended_at ?? nowMs) - r.started_at
                        const durationSec = Math.max(1, Math.round(durationMs / 1000))

                        return html`
                          <div class="tentacle-card" style="background: #0f172a; border: 1px solid #1e293b; border-left: 3px solid ${statusBorder}; border-radius: 6px; padding: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem; transition: border-color 0.2s ease;">
                            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem;">
                              <span style="font-size: 0.85rem; font-weight: 600; color: #f1f5f9; font-family: monospace; word-break: break-all;">
                                ${escapeHtml(r.name)}
                              </span>
                              <span style="font-size: 0.7rem; font-weight: 600; text-transform: uppercase; padding: 0.15rem 0.45rem; border-radius: 4px; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder};">
                                ${escapeHtml(r.status)}
                              </span>
                            </div>

                            <p style="margin: 0; font-size: 0.8rem; color: #cbd5e1; line-height: 1.4;">
                              ${escapeHtml(r.task)}
                            </p>

                            ${r.verdict_line
                              ? html`<div style="font-size: 0.75rem; color: ${statusColor}; font-family: monospace; background: #0b1120; padding: 0.35rem 0.5rem; border-radius: 4px; border: 1px solid #1e293b;">
                                  Verdict: ${escapeHtml(r.verdict_line)}
                                </div>`
                              : ''}

                            ${r.evidence_summary
                              ? html`<div style="font-size: 0.75rem; color: #94a3b8; font-style: italic;">
                                  Evidence: ${escapeHtml(r.evidence_summary)}
                                </div>`
                              : ''}

                            <div style="margin-top: auto; padding-top: 0.5rem; border-top: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem; color: #64748b;">
                              <span>Duration: ${durationSec}s</span>
                              ${r.log_url
                                ? html`<a href="${escapeHtml(r.log_url)}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: none; display: flex; align-items: center; gap: 0.25rem;">
                                    View Log &rarr;
                                  </a>`
                                : html`<span style="font-family: monospace; color: #475569;">${escapeHtml(r.id.slice(0, 8))}</span>`}
                            </div>
                          </div>
                        `
                      })}
                    </div>
                  </div>
                `
              })}
            </div>
          `}
    </section>
  `
}
