import { html } from 'hono/html'
import type { AddonCatalogEntry } from '../addons/registry'
import type { AddonInstallation, AddonState } from '../addons/service'
import { pageHeader, pill } from './ui'

import '../addons/modules'

type ConsoleState = AddonState | 'available'
type LifecycleAction = 'install' | 'configure' | 'activate' | 'disable' | 'archive'

interface LifecycleCommand {
  action: LifecycleAction
  label: string
}

function latestInstallationByKey(installations: AddonInstallation[]): Map<string, AddonInstallation> {
  const byKey = new Map<string, AddonInstallation>()
  for (const installation of installations) {
    const current = byKey.get(installation.addonKey)
    if (!current) {
      byKey.set(installation.addonKey, installation)
      continue
    }
    const installationArchivedAt = installation.archivedAt ?? installation.updatedAt
    const currentArchivedAt = current.archivedAt ?? current.updatedAt
    if (current.state === 'archived' && (
      installation.state !== 'archived' || installationArchivedAt > currentArchivedAt
    )) {
      byKey.set(installation.addonKey, installation)
    }
  }
  return byKey
}

function stateLabel(state: ConsoleState): string {
  return state === 'available' ? 'Available' : `${state.charAt(0).toUpperCase()}${state.slice(1)}`
}

function stateTone(state: ConsoleState): 'primary' | 'ok' | 'warn' | 'dim' {
  if (state === 'active') return 'ok'
  if (state === 'disabled' || state === 'archived') return 'dim'
  if (state === 'available') return 'primary'
  return 'warn'
}

function commandsForState(state: ConsoleState): LifecycleCommand[] {
  switch (state) {
    case 'available': return [{ action: 'install', label: 'Install' }]
    case 'installed': return [
      { action: 'configure', label: 'Configure' },
      { action: 'disable', label: 'Disable' },
    ]
    case 'configured': return [
      { action: 'activate', label: 'Activate' },
      { action: 'disable', label: 'Disable' },
    ]
    case 'active': return [{ action: 'disable', label: 'Disable' }]
    case 'disabled': return [
      { action: 'activate', label: 'Activate' },
      { action: 'archive', label: 'Uninstall' },
    ]
    case 'archived': return [{ action: 'install', label: 'Reinstall' }]
  }
}

function requestedSummary(entry: AddonCatalogEntry): string {
  const connectors = entry.manifest.connectorRequirements.length
  const authority = entry.manifest.authorityRequests.rankGrants.length + entry.manifest.authorityRequests.surfaceGrants.length
  if (connectors === 0 && authority === 0) return 'No connectors or authority requested'
  return `${connectors} connector request${connectors === 1 ? '' : 's'}; ${authority} authority requested`
}

export function addonsBody(entries: AddonCatalogEntry[], installations: AddonInstallation[]) {
  const installationsByKey = latestInstallationByKey(installations)
  const cards = entries.map((entry) => {
    const installation = installationsByKey.get(entry.manifest.key)
    const state: ConsoleState = installation?.state ?? 'available'
    const digest = (installation?.manifestSha256 ?? entry.manifestSha256).slice(-12)
    const commands = commandsForState(state)
    const receiptsHref = `/api/addons/${encodeURIComponent(entry.manifest.key)}/receipts`

    return html`
      <section class="addon-card" data-addon-card>
        <div class="addon-head">
          <div class="addon-title-group">
            <span class="addon-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M7.2 3.5v3.1a2.1 2.1 0 1 0 2.1 2.1h3.2v-2a1.9 1.9 0 1 1 3.8 0v2H17v6.1H9.3a2.1 2.1 0 1 0-2.1 2.1v-2.1H3.5V9h2.1a2.1 2.1 0 1 0 1.6-3.4V3.5z"/></svg>
            </span>
            <div>
              <h2>${entry.manifest.name}</h2>
              <p>${entry.manifest.description}</p>
            </div>
          </div>
          ${pill(stateLabel(state), stateTone(state))}
        </div>
        <div class="addon-facts">
          <div class="addon-fact"><span>Version</span><strong>${entry.manifest.version}</strong></div>
          <div class="addon-fact"><span>Publisher</span><strong>${entry.manifest.publisher}</strong></div>
          <div class="addon-fact"><span>Digest</span><code>${digest}</code></div>
          <div class="addon-fact addon-fact-wide"><span>Requested</span><strong>${requestedSummary(entry)}</strong></div>
        </div>
        <div class="addon-actions">
          <a class="addon-receipts" href="${receiptsHref}">Receipts</a>
          <div class="addon-command-list">
            ${commands.map((command) => html`<button class="btn secondary sm addon-command" type="button" data-addon-key="${entry.manifest.key}" data-addon-action="${command.action}">${command.label}</button>`)}
          </div>
          <span class="addon-status" role="status" aria-live="polite"></span>
          ${state === 'disabled'
            ? html`<p class="addon-retention">Uninstall retains tasks, flights, metrics, audit records, and receipts.</p>`
            : ''}
        </div>
      </section>`
  })

  return html`
    <style>
      .addons-list { display: grid; gap: 12px; margin-top: 18px; }
      .addon-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
      .addon-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--border-soft); }
      .addon-title-group { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
      .addon-icon { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 7px; color: var(--primary); background: var(--primary-soft); display: inline-flex; align-items: center; justify-content: center; flex: none; }
      .addon-title-group h2 { font-family: var(--font-body); font-size: 14px; margin: 0; line-height: 1.35; }
      .addon-title-group p { color: var(--dim); font-size: 12.5px; margin: 2px 0 0; line-height: 1.45; }
      .addon-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; padding: 13px 16px; }
      .addon-fact { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .addon-fact span { color: var(--dim); font-family: var(--font-mono); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
      .addon-fact strong, .addon-fact code { color: var(--text2); font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
      .addon-fact code { font-family: var(--font-mono); }
      .addon-fact-wide { grid-column: 1 / -1; }
      .addon-actions { min-height: 50px; display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid var(--border-soft); }
      .addon-receipts { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
      .addon-command-list { display: flex; gap: 8px; flex-wrap: wrap; }
      .addon-command { min-width: 92px; height: 32px; margin: 0; padding: 0 10px; }
      .addon-status { color: var(--dim); font-size: 12px; min-height: 18px; overflow-wrap: anywhere; }
      .addon-retention { color: var(--dim); flex-basis: 100%; font-size: 11.5px; line-height: 1.4; margin: 0; }
      @media (max-width: 680px) {
        .addon-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .addon-actions { align-items: flex-start; flex-wrap: wrap; }
        .addon-status { width: 100%; }
      }
    </style>
    ${pageHeader({ crumbs: 'Console', title: 'Addons' })}
    <div class="addons-list">${cards}</div>
    <script>
      (function () {
        var commands = document.querySelectorAll('[data-addon-action][data-addon-key]');
        commands.forEach(function (button) {
          button.addEventListener('click', async function () {
            var key = button.dataset.addonKey;
            var action = button.dataset.addonAction;
            var card = button.closest('[data-addon-card]');
            var status = card && card.querySelector('.addon-status');
            if (!key || !action || !['install', 'configure', 'activate', 'disable', 'archive'].includes(action)) return;
            button.disabled = true;
            if (status) status.textContent = 'Working...';
            try {
              var response = await fetch('/api/addons/' + encodeURIComponent(key) + '/' + action, { method: 'POST' });
              var data = {};
              try { data = await response.json(); } catch (_) {}
              if (!response.ok) {
                if (status) status.textContent = data.error || 'request_failed';
                button.disabled = false;
                return;
              }
              window.location.reload();
            } catch (_) {
              if (status) status.textContent = 'network_error';
              button.disabled = false;
            }
          });
        });
      })();
    </script>`
}
