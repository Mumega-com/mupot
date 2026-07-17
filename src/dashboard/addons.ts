import { html } from 'hono/html'
import { LinearRouter } from 'hono/router/linear-router'
import { getAddonConsoleRenderer, type AddonConsoleRenderer } from '../addons/console-registry'
import type { AddonCatalogEntry } from '../addons/registry'
import type { AddonInstallation, AddonState } from '../addons/service'
import type { ConnectorListRow } from '../connectors/service'
import { pageHeader, pill } from './ui'

import '../addons/modules'

type ConsoleState = AddonState | 'available'
type LifecycleAction = 'install' | 'configure' | 'activate' | 'disable' | 'archive'

interface LifecycleCommand {
  action: LifecycleAction
  label: string
}

type AddonConsoleSection = AddonCatalogEntry['manifest']['consoleSections'][number]

export interface ResolvedAddonConsolePath {
  entry: AddonCatalogEntry
  section: AddonConsoleSection
  renderer: AddonConsoleRenderer
}

export interface DashboardRoutePattern {
  readonly method: string
  readonly path: string
}

export interface AddonConsoleResolver {
  resolve(path: string): ResolvedAddonConsolePath | null
}

function matchingRenderer(section: AddonConsoleSection): AddonConsoleRenderer | null {
  const renderer = getAddonConsoleRenderer(section.rendererKey)
  return renderer
    && renderer.key === section.rendererKey
    && renderer.path === section.path
    && renderer.title === section.title
    && renderer.navIcon === section.navIcon
    ? renderer
    : null
}

export function createAddonConsoleResolver(
  entries: readonly AddonCatalogEntry[],
  builtInRoutes: readonly DashboardRoutePattern[],
): AddonConsoleResolver {
  const builtInRouter = new LinearRouter<true>()
  for (const route of builtInRoutes) {
    if (route.method === 'GET') builtInRouter.add('GET', route.path, true)
  }
  return {
    resolve(path) {
      if (builtInRouter.match('GET', path)[0].length > 0) return null
      let resolved: ResolvedAddonConsolePath | null = null
      for (const entry of entries) {
        for (const section of entry.manifest.consoleSections) {
          if (section.path !== path) continue
          const renderer = matchingRenderer(section)
          if (!renderer || resolved) return null
          resolved = { entry, section, renderer }
        }
      }
      return resolved
    }
  }
}

export function installedAddonIdentityMatches(
  entry: AddonCatalogEntry,
  installation: AddonInstallation | undefined,
): installation is AddonInstallation {
  if (!installation) return false
  return installation.state !== 'archived'
    && installation.addonKey === entry.manifest.key
    && installation.installedVersion === entry.manifest.version
    && installation.publisher === entry.manifest.publisher
    && installation.trustClass === entry.manifest.trustClass
    && installation.mupotCompatibility === entry.manifest.mupotCompatibility
    && installation.manifestSha256 === entry.manifestSha256
}

export function latestInstallationByKey(installations: AddonInstallation[]): Map<string, AddonInstallation> {
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
      { action: 'configure', label: 'Configure' },
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

function defaultConfigureBody(entry: AddonCatalogEntry): string | null {
  const bindings = entry.manifest.connectorRequirements
    .filter((requirement) => requirement.required && requirement.accepts.includes('first_party'))
    .map((requirement) => ({
      slot: requirement.slot,
      adapter: 'first_party',
      bindingKind: 'internal_adapter',
    }))

  return bindings.length > 0 ? JSON.stringify({ bindings }) : null
}

function bindingOptionValue(
  slot: string,
  adapter: string,
  bindingKind: 'internal_adapter' | 'vault_connector',
  connectorId?: string,
): string {
  return JSON.stringify({
    slot,
    adapter,
    bindingKind,
    ...(connectorId ? { connectorId } : {}),
  })
}

function connectorSelectLabel(connector: ConnectorListRow): string {
  const scope = connector.scope_type === 'pot' ? 'pot' : `${connector.scope_type}:${connector.scope_id ?? 'unknown'}`
  return `${connector.label} (${connector.type}, ${scope})`
}

function connectorBindingControls(entry: AddonCatalogEntry, connectors: readonly ConnectorListRow[]) {
  const requirements = entry.manifest.connectorRequirements
  if (requirements.length === 0) return ''

  return html`
    <div class="addon-bindings" data-addon-bindings>
      ${requirements.map((requirement) => {
        const vaultConnectors = connectors.filter((connector) => requirement.accepts.includes(connector.type))
        const hasFirstParty = requirement.accepts.includes('first_party')
        return html`
          <label class="addon-binding-row">
            <span>
              <strong>${requirement.slot}</strong>
              <small>${requirement.required ? 'Required' : 'Optional'} read source</small>
            </span>
            <select data-addon-binding-select data-addon-binding-required="${requirement.required ? 'true' : 'false'}">
              ${requirement.required ? '' : html`<option value="">No binding</option>`}
              ${hasFirstParty
                ? html`<option value="${bindingOptionValue(requirement.slot, 'first_party', 'internal_adapter')}" selected>First-party internal data</option>`
                : ''}
              ${vaultConnectors.map((connector) => html`
                <option value="${bindingOptionValue(requirement.slot, connector.type, 'vault_connector', connector.id)}"${!hasFirstParty && connector.id === vaultConnectors[0]?.id ? ' selected' : ''}>
                  ${connectorSelectLabel(connector)}
                </option>
              `)}
              ${requirement.required && !hasFirstParty && vaultConnectors.length === 0
                ? html`<option value="" selected>No matching connector available</option>`
                : ''}
            </select>
          </label>`
      })}
    </div>`
}

export function addonsBody(
  entries: AddonCatalogEntry[],
  installations: AddonInstallation[],
  builtInRoutes: readonly DashboardRoutePattern[],
  connectors: readonly ConnectorListRow[] = [],
) {
  const installationsByKey = latestInstallationByKey(installations)
  const consoleResolver = createAddonConsoleResolver(entries, builtInRoutes)
  const cards = entries.map((entry) => {
    const installation = installationsByKey.get(entry.manifest.key)
    const state: ConsoleState = installation?.state ?? 'available'
    const digest = (installation?.manifestSha256 ?? entry.manifestSha256).slice(-12)
    const commands = commandsForState(state)
    const receiptsHref = `/api/addons/${encodeURIComponent(entry.manifest.key)}/receipts`
    const configureBody = defaultConfigureBody(entry)
    const consoleSections = installedAddonIdentityMatches(entry, installation)
      ? entry.manifest.consoleSections.filter((section) => {
          const resolved = consoleResolver.resolve(section.path)
          return resolved?.entry === entry
        })
      : []

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
        ${connectorBindingControls(entry, connectors)}
        <div class="addon-actions">
          ${consoleSections.map((section) => html`
              <a class="addon-console" href="${section.path}">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                ${consoleSections.length === 1 ? 'Open console' : `Open ${section.title}`}
              </a>`)}
          <a class="addon-receipts" href="${receiptsHref}">Receipts</a>
          <div class="addon-command-list">
            ${commands.map((command) => html`<button class="btn secondary sm addon-command" type="button" data-addon-key="${entry.manifest.key}" data-addon-action="${command.action}"${command.action === 'configure' && configureBody ? html` data-addon-configure-body="${configureBody}"` : ''}>${command.label}</button>`)}
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
      .addon-bindings { display: grid; gap: 8px; padding: 0 16px 14px; }
      .addon-binding-row { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(220px, 2fr); gap: 10px; align-items: center; }
      .addon-binding-row span { min-width: 0; }
      .addon-binding-row strong { display: block; color: var(--text2); font-size: 12.5px; line-height: 1.35; overflow-wrap: anywhere; }
      .addon-binding-row small { display: block; color: var(--dim); font-size: 11.5px; line-height: 1.3; }
      .addon-binding-row select { min-width: 0; width: 100%; min-height: 32px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface2); color: var(--text); padding: 0 8px; }
      .addon-actions { min-height: 50px; display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid var(--border-soft); }
      .addon-receipts { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
      .addon-console { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
      .addon-console svg { flex: none; }
      .addon-command-list { display: flex; gap: 8px; flex-wrap: wrap; }
      .addon-command { min-width: 92px; height: 32px; margin: 0; padding: 0 10px; }
      .addon-status { color: var(--dim); font-size: 12px; min-height: 18px; overflow-wrap: anywhere; }
      .addon-retention { color: var(--dim); flex-basis: 100%; font-size: 11.5px; line-height: 1.4; margin: 0; }
      @media (max-width: 680px) {
        .addon-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .addon-binding-row { grid-template-columns: 1fr; }
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
              var options = { method: 'POST' };
              if (action === 'configure') {
                var bindings = [];
                var selects = card ? card.querySelectorAll('[data-addon-binding-select]') : [];
                selects.forEach(function (select) {
                  if (!select.value) return;
                  try {
                    bindings.push(JSON.parse(select.value));
                  } catch (_) {}
                });
                if (bindings.length === 0 && button.dataset.addonConfigureBody) {
                  try {
                    bindings = JSON.parse(button.dataset.addonConfigureBody).bindings || [];
                  } catch (_) {}
                }
                options.headers = { 'content-type': 'application/json' };
                options.body = JSON.stringify({ bindings: bindings });
              }
              var response = await fetch('/api/addons/' + encodeURIComponent(key) + '/' + action, options);
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
