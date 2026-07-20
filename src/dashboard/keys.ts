// mupot — scoped-key mint dashboard (deliverable 2 + 3).
//
// Exposes two data helpers (loadable and testable in isolation):
//   loadKeysView(env)  → { members, squads, departments, tokens }
//   mintScopedKey(env, params) → { ok: true; raw: string; tokenId: string }
//                              | { ok: false; error: string }
//
// And two pure HTML body generators:
//   keysPageBody(view, presets, squadId?, presetId?, error?) → HTML
//   keysMintedBody(...)  → show-once result HTML
//
// The route handlers (GET /admin/keys + POST /admin/keys/mint) live in
// src/dashboard/index.ts and call these — keeping the big shell() + CSS in
// one place while this module stays testable without the full Hono context.
//
// Security invariants (enforced here and in the calling routes):
//   1. isAdmin gate is checked in the route BEFORE calling mintScopedKey.
//   2. The raw token is returned ONCE and NEVER persisted or logged.
//   3. The capability grant is written atomically with the token (same D1 batch).
//   4. scope_id is only accepted from the pot's own squads/departments — the
//      caller cannot supply an arbitrary UUID to claim another pot's scope.
//   5. The minted preset's role rank MUST be STRICTLY LESS THAN the minter's
//      effective rank (passed as minterRank). An admin (rank 4) can mint lead,
//      member, or observer but NOT another admin (rank 4 >= 4 → 403). Only an
//      owner (rank 5) can mint admin (rank 4 < 5). This is enforced at the
//      service layer, not just by the preset list, so it holds even if a new
//      preset is added that assigns rank 4.

import { html, raw as honoRaw } from 'hono/html'
import type { Env } from '../types'
import { mintMemberToken } from '../members/service'
import { ROLE_PRESETS, findPreset } from '../auth/role-presets'
import type { RolePreset } from '../auth/role-presets'
import { capabilityRank, resolveCapabilities, hasCapability } from '../auth/capability'

// ── shapes ────────────────────────────────────────────────────────────────────

export interface ScopedKeyMember {
  id: string
  display_name: string
  email: string | null
}

export interface ScopedKeySquad {
  id: string
  name: string
  dept_name: string | null
}

export interface ScopedKeyDepartment {
  id: string
  name: string
}

export interface ScopedKeyToken {
  id: string
  member_id: string
  label: string
  created_at: string
}

export interface KeysView {
  members: ScopedKeyMember[]
  squads: ScopedKeySquad[]
  departments: ScopedKeyDepartment[]
  tokens: ScopedKeyToken[]
}

// ── data loaders ──────────────────────────────────────────────────────────────

export async function loadKeysView(env: Env): Promise<KeysView> {
  const [members, squads, departments, tokens] = await Promise.all([
    env.DB.prepare(
      `SELECT id, display_name, email FROM members WHERE status = 'active' ORDER BY display_name ASC`,
    ).all<ScopedKeyMember>(),

    env.DB.prepare(
      `SELECT s.id, s.name, d.name AS dept_name
         FROM squads s
         LEFT JOIN departments d ON d.id = s.department_id
        ORDER BY d.name ASC, s.name ASC`,
    ).all<ScopedKeySquad>(),

    env.DB.prepare(
      `SELECT id, name FROM departments ORDER BY name ASC`,
    ).all<ScopedKeyDepartment>(),

    // List live scoped tokens (those whose label starts with '[preset:')
    env.DB.prepare(
      `SELECT id, member_id, label, created_at
         FROM member_tokens
        WHERE tenant = ?1 AND revoked_at IS NULL AND label LIKE '[preset:%'
        ORDER BY created_at DESC`,
    ).bind(env.TENANT_SLUG).all<ScopedKeyToken>(),
  ])
  return {
    members: members.results ?? [],
    squads: squads.results ?? [],
    departments: departments.results ?? [],
    tokens: tokens.results ?? [],
  }
}

// ── mint helper ───────────────────────────────────────────────────────────────

export interface MintParams {
  memberId: string
  presetId: string
  /** squad id (required when preset.scopeHint === 'squad'), dept id for 'department'. Null for 'org'. */
  scopeId: string | null
  /**
   * The minter's effective rank on the org scope (owner=5, admin=4, …).
   * The preset's role rank MUST be strictly less than this value.
   * Pass the result of actorMaxRankOnScope (or capabilityRank(auth.role) for a
   * legacy web-login) — the route handler is responsible for resolving it.
   */
  minterRank: number
}

export type MintResult =
  | { ok: true; raw: string; tokenId: string; label: string }
  | { ok: false; error: string }

/**
 * Mint a scoped API key for a member using the named preset.
 *
 * Security note: The caller MUST have verified isAdmin() before calling this.
 * This function does NOT re-check admin — it is an internal service layer, not a gate.
 *
 * Steps:
 *  1. Validate preset + rank ceiling: preset.role rank MUST be strictly less than
 *     minterRank. Rejects with 'rank_ceiling' if the minter's rank is <= the preset's.
 *  2. Validate member exists in this pot.
 *  3. When scope is squad/department, validate the scope_id belongs to this pot
 *     (prevents a caller from claiming another tenant's scope uuid).
 *  4. ATTEST, never GRANT (S1 fix). Verify the member ALREADY holds >= the preset's
 *     capability on the resolved scope. If not, reject with 'member_lacks_capability'
 *     — minting a key must never elevate the principal or write a standing grant.
 *     Grant the member the capability separately first, then mint an attesting key.
 *  5. Mint a member_token (channel='workspace') via the shared service. The token
 *     carries the member's OWN authority (resolved from `capabilities` at auth time);
 *     the preset is an audit label, not an enforced scope-down (per-key scope-down
 *     ships in v0.26 token_grants). Revoking the token removes exactly the token —
 *     it leaves no residual standing power, because mint wrote none.
 *  6. Return raw once; never persisted.
 */
export async function mintScopedKey(env: Env, params: MintParams): Promise<MintResult> {
  const { memberId, presetId, scopeId, minterRank } = params

  // 1. Validate preset.
  const preset = findPreset(presetId)
  if (!preset) return { ok: false, error: 'unknown_preset' }

  // 1b. Rank-ceiling check: the preset's role rank must be STRICTLY LESS THAN the
  //     minter's effective rank.  An admin (rank 4) cannot mint another admin (rank 4);
  //     only an owner (rank 5) can.  This prevents lateral admin proliferation.
  const presetRank = capabilityRank(preset.role)
  if (presetRank >= minterRank) {
    return { ok: false, error: 'rank_ceiling' }
  }

  // 2. Validate member belongs to this pot (D1 is per-tenant — no extra tenant column
  //    needed, but we check existence to give a clean error vs a FK violation).
  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND status = 'active' LIMIT 1`,
  )
    .bind(memberId)
    .first<{ id: string }>()
  if (!member) return { ok: false, error: 'member_not_found' }

  // 3. Validate scope_id when required (tenant-scoped — the rows must exist in this DB).
  if (preset.scopeHint === 'squad' && !scopeId) {
    return { ok: false, error: 'scope_id_required_for_squad_preset' }
  }
  if (preset.scopeHint === 'department' && !scopeId) {
    return { ok: false, error: 'scope_id_required_for_department_preset' }
  }
  if (scopeId && preset.scopeHint === 'squad') {
    const squadRow = await env.DB.prepare(`SELECT id FROM squads WHERE id = ?1 LIMIT 1`)
      .bind(scopeId)
      .first<{ id: string }>()
    if (!squadRow) return { ok: false, error: 'squad_not_found' }
  }
  if (scopeId && preset.scopeHint === 'department') {
    const deptRow = await env.DB.prepare(`SELECT id FROM departments WHERE id = ?1 LIMIT 1`)
      .bind(scopeId)
      .first<{ id: string }>()
    if (!deptRow) return { ok: false, error: 'department_not_found' }
  }

  const resolvedScopeId = preset.scopeHint === 'org' ? null : (scopeId ?? null)

  // 4. ATTEST, never GRANT (S1 fix — the one live HIGH).
  //    The old path wrote a rank-max `capabilities` row and per-surface `gate_grants`
  //    rows on the MEMBER at mint time. Those are STANDING principal grants: caps are
  //    resolved from `capabilities` at auth (resolveCapabilities), the token carries no
  //    scope of its own, and the rows SURVIVE token revocation. So minting a "scoped
  //    key" permanently elevated the principal and could never be walked back by
  //    revoking the key. Fixed: mint writes NOTHING to the principal. It only verifies
  //    the member ALREADY holds >= the preset capability on the resolved scope; if not,
  //    it refuses (never elevate). Grant the member the capability out-of-band first.
  //    Per-key scope-DOWN (an observer key for an admin member) requires token-scoped
  //    grants and lands in v0.26 (token_grants); until then the token honestly carries
  //    the member's own authority and the preset is an audit label only.
  const grants = await resolveCapabilities(env, memberId)
  const scopeDeptId =
    preset.scopeType === 'squad' && resolvedScopeId
      ? (
          await env.DB.prepare(`SELECT department_id FROM squads WHERE id = ?1 LIMIT 1`)
            .bind(resolvedScopeId)
            .first<{ department_id: string | null }>()
        )?.department_id ?? null
      : null
  const alreadyHolds = hasCapability(
    grants,
    preset.scopeType,
    resolvedScopeId,
    preset.role,
    scopeDeptId,
  )
  if (!alreadyHolds) {
    return { ok: false, error: 'member_lacks_capability' }
  }

  // 5. Mint a member_token. Label encodes the preset + scope for the audit trail.
  //    The `[preset:<id>]` prefix is what loadKeysView uses to list scoped keys.
  //    The token resolves the member's own capabilities at auth; mint added none.
  const scopeLabel = resolvedScopeId ? `:${resolvedScopeId}` : ''
  const label = `[preset:${preset.id}${scopeLabel}]`
  const minted = await mintMemberToken(env, memberId, label, 'workspace')

  return { ok: true, raw: minted.raw, tokenId: minted.id, label }
}

// ── HTML views ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The guide panel for a preset — what it allows and what it denies. */
function presetGuidePanel(preset: RolePreset): string {
  // Enterprise rendering: surface the scope-type tag as "team"/"organization".
  // The allow/deny entries below are permission/scope identifiers (the API
  // contract) and are shown verbatim by design.
  const scopeTypeLabel =
    preset.scopeType === 'squad' ? 'team' : preset.scopeType === 'org' ? 'organization' : preset.scopeType
  const allows = preset.allows
    .map((a) => `<li class="guide-allow">&#10003; ${esc(a)}</li>`)
    .join('')
  const denies = preset.denies
    .map((d) => `<li class="guide-deny">&#10007; ${esc(d)}</li>`)
    .join('')
  return (
    `<div class="guide-panel" id="guide-${esc(preset.id)}">` +
    `<div class="guide-header">` +
    `<strong>${esc(preset.label)}</strong>` +
    `<span class="tag cap">${esc(preset.role)}</span>` +
    `<span class="tag">${esc(scopeTypeLabel)}</span>` +
    `</div>` +
    `<p class="guide-desc">${esc(preset.description)}</p>` +
    `<div class="guide-cols">` +
    `<div><div class="guide-sec-label">Allows</div><ul class="guide-list">${allows}</ul></div>` +
    `<div><div class="guide-sec-label">Denies</div><ul class="guide-list">${denies}</ul></div>` +
    `</div>` +
    `<div class="guide-note">` +
    `<strong>Enforcement note:</strong> Rank + scope are enforced server-side. ` +
    `Per-surface grants (e.g. outreach:send-gated) are <em>documented policy</em> — ` +
    `route-level gates for individual surfaces are a pending follow-up. ` +
    `The deny list is blast-radius documentation, not a runtime block on unlisted surfaces.` +
    `</div>` +
    `</div>`
  )
}

/** The full GET /admin/keys page body. */
export function keysPageBody(
  view: KeysView,
  selectedPresetId?: string,
  selectedScopeId?: string,
  error?: string,
) {
  const { members, squads, departments, tokens } = view

  // ── preset selector options ──
  // Enterprise rendering: surface the 'squad' scope type as "team" / 'org' as
  // "organization" in the visible label; the option value stays the preset id.
  const scopeTypeLabel = (t: string) =>
    t === 'squad' ? 'team' : t === 'org' ? 'organization' : t
  const presetOptions = ROLE_PRESETS.map(
    (p) =>
      `<option value="${esc(p.id)}"${selectedPresetId === p.id ? ' selected' : ''}>` +
      `${esc(p.label)} (${esc(p.role)} / ${esc(scopeTypeLabel(p.scopeType))})` +
      `</option>`,
  ).join('')

  // ── member options ──
  const memberOptions = members.map(
    (m) =>
      `<option value="${esc(m.id)}">${esc(m.display_name)}${m.email ? ` &lt;${esc(m.email)}&gt;` : ''}</option>`,
  ).join('')

  // ── scope picker (squad list) ──
  const squadOptions = squads.map(
    (s) =>
      `<option value="${esc(s.id)}"${selectedScopeId === s.id ? ' selected' : ''}>` +
      `${s.dept_name ? esc(s.dept_name) + ' / ' : ''}${esc(s.name)}` +
      `</option>`,
  ).join('')

  const deptOptions = departments.map(
    (d) =>
      `<option value="${esc(d.id)}"${selectedScopeId === d.id ? ' selected' : ''}>${esc(d.name)}</option>`,
  ).join('')

  // ── guide panels (all presets, visibility toggled by JS) ──
  const guidePanels = ROLE_PRESETS.map((p) => presetGuidePanel(p)).join('')

  // ── existing scoped tokens table ──
  const tokenRows =
    tokens.length === 0
      ? `<tr><td colspan="4" class="empty">No active scoped keys yet.</td></tr>`
      : tokens
          .map((t) => {
            const memberName =
              members.find((m) => m.id === t.member_id)?.display_name ?? t.member_id
            return (
              `<tr>` +
              `<td>${esc(memberName)}</td>` +
              `<td><code class="inline">${esc(t.label)}</code></td>` +
              `<td>${esc(t.created_at.slice(0, 10))}</td>` +
              `<td class="actions">` +
              `<form method="post" action="/members/${esc(t.member_id)}/tokens/${esc(t.id)}/revoke" style="display:inline">` +
              `<button class="btn sm secondary" type="submit" onclick="return confirm('Revoke this key?')">Revoke</button>` +
              `</form>` +
              `</td>` +
              `</tr>`
            )
          })
          .join('')

  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/admin/members">People &amp; Access</a> › Scoped API Keys</div>
<h1>Scoped API Keys</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px">
  Provision a fine-grained API key for a person based on a role preset. The key is shown <strong>exactly once</strong>
  and never stored in plain text. Pick the preset — the guide shows what it allows and denies — then pick a person
  and (for team/department presets) the target scope.
</p>

${honoRaw(errorHtml)}

<h2>Provision a key</h2>
<div class="card">
  <form method="post" action="/admin/keys/mint" id="mintForm">
    <div class="adminform" style="flex-direction:column;align-items:stretch">

      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:end">
        <label>
          Role preset
          <select name="preset_id" id="presetSelect" required onchange="updateGuide(this.value)">
            <option value="">— choose a preset —</option>
            ${honoRaw(presetOptions)}
          </select>
        </label>
        <label>
          Person
          <select name="member_id" required>
            <option value="">— choose a person —</option>
            ${honoRaw(memberOptions)}
          </select>
        </label>
        <div id="scopePickerContainer" style="display:none">
          <label id="squadPickerLabel">
            Team (scope)
            <select name="scope_id" id="squadPicker">
              <option value="">— choose a team —</option>
              ${honoRaw(squadOptions)}
            </select>
          </label>
          <label id="deptPickerLabel" style="display:none">
            Department (scope)
            <select name="scope_id" id="deptPicker">
              <option value="">— choose a department —</option>
              ${honoRaw(deptOptions)}
            </select>
          </label>
        </div>
      </div>

      <div id="guidePanelContainer" style="margin-top:14px">
        ${honoRaw(guidePanels)}
      </div>

      <div style="margin-top:16px">
        <button class="btn" type="submit" id="mintBtn" disabled>Provision key</button>
        <span style="font-size:13px;color:var(--muted);margin-left:12px">
          The raw key is shown once and never stored.
        </span>
      </div>
    </div>
  </form>
</div>

<h2>Active scoped keys</h2>
<div class="card" style="padding:0;overflow:hidden">
  <table class="grid">
    <thead><tr>
      <th>Person</th><th>Label (preset:scope)</th><th>Created</th><th></th>
    </tr></thead>
    <tbody>${honoRaw(tokenRows)}</tbody>
  </table>
</div>

<style>
  .guide-panel { display:none; background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-top:4px; }
  .guide-panel.active { display:block; }
  .guide-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .guide-desc { color:var(--muted); font-size:13px; margin:0 0 12px; line-height:1.5; }
  .guide-cols { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .guide-sec-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin-bottom:6px; font-weight:600; }
  .guide-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
  .guide-list li { font-size:13px; }
  .guide-allow { color:var(--ok); }
  .guide-deny { color:var(--warn); }
  .guide-note { margin-top:12px; font-size:12px; color:var(--dim); background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px 12px; line-height:1.5; }
  .guide-note strong { color:var(--muted); }
</style>

<script>
  // Preset metadata for scope picker visibility + guide toggling.
  // Populated from the server-rendered preset list (no fetch needed).
  const PRESET_META = ${honoRaw(
    JSON.stringify(
      Object.fromEntries(
        ROLE_PRESETS.map((p) => [p.id, { scopeHint: p.scopeHint }]),
      ),
    ),
  )};

  function updateGuide(presetId) {
    // Toggle guide panels.
    document.querySelectorAll('.guide-panel').forEach(el => el.classList.remove('active'));
    if (presetId) {
      const panel = document.getElementById('guide-' + presetId);
      if (panel) panel.classList.add('active');
    }

    // Show/hide scope picker.
    const meta = PRESET_META[presetId];
    const container = document.getElementById('scopePickerContainer');
    const squadLabel = document.getElementById('squadPickerLabel');
    const deptLabel = document.getElementById('deptPickerLabel');
    if (!meta || meta.scopeHint === 'org') {
      container.style.display = 'none';
    } else if (meta.scopeHint === 'squad') {
      container.style.display = '';
      squadLabel.style.display = '';
      deptLabel.style.display = 'none';
    } else {
      container.style.display = '';
      squadLabel.style.display = 'none';
      deptLabel.style.display = '';
    }

    // Enable mint button only when a preset is selected.
    document.getElementById('mintBtn').disabled = !presetId;
  }

  // Initialize on load (in case of server-side pre-selection).
  document.addEventListener('DOMContentLoaded', function() {
    const sel = document.getElementById('presetSelect');
    if (sel.value) updateGuide(sel.value);
  });
</script>`
}

/** Show-once token reveal page. Raw key must NOT be re-displayable after this render. */
export function keysMintedBody(
  memberName: string,
  label: string,
  presetLabel: string,
  raw: string,
) {
  // Honest disclosure: the token carries the member's OWN authority (resolved from
  // `capabilities` at auth). The preset is an audit label, not an enforced scope-down —
  // per-key scope-down ships in v0.26 (token_grants). Never let the preset label read as
  // a capability boundary it does not yet enforce.
  const scopeNotice = `<div class="warn-box" style="margin-bottom:14px;border-color:var(--warn)">
    <strong>Scope not yet enforced per-key.</strong>
    This token carries <strong>${esc(memberName)}</strong>'s own capabilities. The preset
    names the intended scope for the audit trail; per-key scope-down is enforced starting
    v0.26. Do not treat the preset label as a capability boundary. Revoking this token
    removes exactly this token — it leaves no standing grant behind.
  </div>`
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/admin/keys">Scoped API Keys</a> › Key provisioned</div>
<h1>Key provisioned</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Scoped key for <strong>${memberName}</strong> · Preset: <strong>${presetLabel}</strong>
  </p>
  ${honoRaw(scopeNotice)}
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Show once only.</strong> Copy this key now — it cannot be retrieved again.
    Store it in a secrets manager. Do not paste it in logs, chat, or version control.
  </div>
  <code class="token" id="rawToken">${label} ${raw}</code>
  <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
    <button class="btn secondary sm" onclick="copyKey()">Copy</button>
    <a href="/admin/keys" class="btn secondary sm">Done</a>
    <span id="copyFeedback" style="font-size:13px;color:var(--ok);display:none">Copied!</span>
  </div>
</div>
<script>
  function copyKey() {
    const text = document.getElementById('rawToken').textContent.trim();
    navigator.clipboard.writeText(text).then(function() {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline';
      setTimeout(function() { fb.style.display = 'none'; }, 2000);
    });
  }
</script>`
}
