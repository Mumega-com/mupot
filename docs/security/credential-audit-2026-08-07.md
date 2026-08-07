# Credential audit — GitHub + Mac-local scopes, 2026-08-07

Companion to [secrets-inventory.md](secrets-inventory.md) (PR #763), which covers the
Hetzner/VPS/Cloudflare scopes. This document covers the two scopes owned by Dara per
tonight's partition: **GitHub security** and **Mac-local security** — plus a proposed
secrets-storage policy going forward. Every claim is tagged CONFIRMED (verified directly)
or UNSURE. No secret values appear anywhere in this document — names, IDs, prefixes, and
counts only.

## GitHub findings

### The "mystery org secret" resolved — it isn't `mupot`, it's `inkwell`

CONFIRMED: `Mumega-com/mupot`'s two workflows (`ci.yml`, `staleness-check.yml`) reference
no secrets at all — `staleness-check.yml` documents itself in-file as "no Cloudflare
credentials, no secrets, cannot deploy or touch any tenant pot."

CONFIRMED: `Mumega-com/inkwell`'s `deploy.yml` references
`secrets.CLOUDFLARE_API_TOKEN` / `secrets.CLOUDFLARE_ACCOUNT_ID`, but the repo has **zero**
repo-level secrets (`gh secret list` empty) and the org has **zero** org-level secrets
(confirmed via the org Settings → Secrets and variables → Actions page: "This organization
has no secrets"). Neither exists anywhere for this workflow to resolve.

CONFIRMED: every one of the last 5 runs of "Deploy mumega.com" has failed, back to
2026-05-10. This is not a hidden-secret mystery — the secret genuinely doesn't exist, and
the workflow has been silently broken for 3 months.

### GitHub Actions secrets that do exist

CONFIRMED, repo-level:
- `Mumega-com/mumega-com` (private): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
  (updated 2026-05-03 — matches secrets-inventory.md Scope 4), `SOS_BUS_TOKEN`,
  `SOS_BUS_URL`.
- `Mumega-com/therealmofpatterns` (public): `CLOUDFLARE_ACCOUNT_ID` (2026-01-30),
  `CLOUDFLARE_API_TOKEN` (2026-01-31) — its **own**, separate, older token. Six months
  stale — a stronger rotation candidate than the one already flagged.
- `Mumega-com/sos` and `Mumega-com/mirror`: `HETZNER_HOST`, `HETZNER_SSH_KEY`,
  `HETZNER_USER`, `DISCORD_DEPLOY_WEBHOOK` (all 2026-04-05).

CONFIRMED: zero org-level Actions secrets exist, org-wide.

### Secret scanning / push protection

CONFIRMED, via `security_and_analysis` on each repo:
- **All public repos** (checked: mupot, inkwell, sos, torivers.com, mumega-docs):
  secret scanning **enabled**, push protection **enabled**.
- **All private repos checked** (mumega-com, shabrang, mumega-state,
  mcpwp-operations, mumega-sos-internal, mumega, mcpwp, mumcp-broker, gaf,
  tenant-viamar, tenant-dnu, agent-ops-ledger, fractalresonance-com,
  shabrang-backup, shabrang-inkwell, mumega-prefrontal — 15 repos): secret
  scanning **unavailable** (`security_and_analysis` returns null — not a paid
  GHAS tier for private repos on the current plan).

**This matters because private repos are where the real deploy/ops config lives**
(`mumega-com` holds the CF/SOS Actions secrets directly). They have zero automated
coverage if a credential is ever committed by accident.

CONFIRMED, historical secret-scanning alerts (public repos only, since that's all that's
scanned): 6 alerts across 6 repos, **all resolved 2026-08-03** in one bulk pass (matches
the mupot#764 cleanup) — 5 `revoked`, 1 `false_positive` (a Stripe-key-shaped string in
`torivers.com` that was not a real key).

### Public repo exposure review

Full inventory (29 public repos across `servathadi`, `Digidinc`, `Mumega-com`) reviewed
for whether public visibility is intentional. UNSURE is a judgment call, not a scan —
flagging for a decision, not asserting these are compromised:

**Recommend private** (internal tooling/ops with no product reason to be public):
`Digidinc/qbo-mini`, `Digidinc/qbo-torivers` (QuickBooks OAuth/token-refresh utilities),
`Mumega-com/mumcp-proxy` (live backend routing customer WordPress traffic — no
"fork this" framing unlike mupot/sos/mirror), `Mumega-com/mumega-docs` (described as
"architecture, operations, projects" — internal ops docs, not user docs),
`Digidinc/Digid-MCP`, `Digidinc/mumega-cli` (near-empty internal stubs),
`Mumega-com/archive-ai-team`, `archive-mumega-marketing`, `archive-wp-ai-operator`,
`archive-mumega-cms` (retired, no active purpose; `archive-mumega-marketing` is one of
the 6 repos with a real revoked secret in its history).

**Keep public** (intentional OSS products or public-facing sites): mupot, mupot-plugin,
sos, inkwell, mirror, mcpwp-claude-plugin, shabrang, shabrang-cms, torivers.com,
mumega-motion-theme, the formflow suite, Mydiv/myDivClient, therealmofpatterns,
the two generic templates, fractalresonance.

Awaiting Hadi's decision before any visibility changes — this is a real, hard-to-reverse
change (old clone URLs break, forks keep their own copy) and out of scope for an agent to
do unilaterally.

## Mac-local findings

CONFIRMED CLEAN: `~/.claude/projects` (Dara's own Claude Code session transcripts) — 0
matches for `KNOWN_SECRET_NAME=<real-looking value>` patterns across the full secret-name
set used in secrets-inventory.md Scope 2/3.

🔴 **CONFIRMED — the same leak class as mupot#764 exists on the Mac, unremediated.**
`~/.codex/sessions` has 35 files matching a known secret key name (`CLOUDFLARE_API_TOKEN`,
`STRIPE_SECRET_KEY`, `HERMES_WEBHOOK_SECRET`, `HERMES_RELAY_SECRET`, `MUPOT_OWNER_TOKEN`,
R2/AWS-shaped names) paired with what looks like a real assigned value (12+ chars), not a
bare mention. Span: 2026-06-01 to 2026-07-29. One file: 22 hits. **Not yet redacted** —
the server-side redaction pass recorded in secrets-inventory.md's Remediation table
(`.codex/sessions`, `.hermes/sessions`, `agents/gemini`, `~/.claude/projects`) covered the
**Hetzner host**, not this Mac. This is a distinct, additional surface.

UNSURE which specific values are captured — deliberately not opened, to avoid re-leaking
into this document/session. Given `CLOUDFLARE_API_TOKEN` is unrotated since 2026-05-03 and
these files run through 2026-07-29, treat it as likely present until the redaction script
runs and proves otherwise.

CONFIRMED: `~/.gemini` — 11 pattern hits, all traced to bundled Cloudflare skill reference
docs (`skills/cloudflare/references/**/configuration.md`, placeholder examples, not real
captures) except one real transcript file (`antigravity/brain/.../transcript.jsonl`, 1
hit) — UNSURE, not yet checked.

CONFIRMED PRESENT on disk, metadata only (no values read): `~/.env.secrets` (0600, 374
bytes, modified 2026-06-16) and `~/.hermes/.env` (0600, 25KB, modified 2026-08-05 — 2 days
before this audit, actively in use). Key names only: `.env.secrets` holds bus/agent tokens
(`SOS_TOKEN`, `DARA_SOS_TOKEN`, `CYRUS_SOS_TOKEN`, `DELEGATION_HMAC_KEY`); `.hermes/.env`
holds a longer list including `MUPOT_OWNER_TOKEN` and per-agent mupot tokens. Neither has a
key literally named `CLOUDFLARE_API_TOKEN` / `R2_*` / `STRIPE_*`.

## Remediation status (Mac-local, adds to secrets-inventory.md's table)

| item | status |
|---|---|
| Transcript redaction — Mac `~/.codex/sessions` (35 files flagged) | ❌ open |
| Transcript redaction — Mac `~/.claude/projects` | ✅ confirmed clean, nothing to redact |
| Transcript redaction — Mac `~/.gemini` | ⚠️ 1 file needs review, rest false-positive |
| `mumega R2 User Token` (Scope 5) deleted | ✅ done 2026-08-07 (this doc's table in secrets-inventory.md was stale as of the version reviewed) |

## Proposed secrets-storage policy

Prompted directly by tonight: the root failure wasn't *where* a secret lived, it was that
an agent was asked to read a file that held many secrets at once, and that read became a
permanent transcript. Moving the same flat file to a different location doesn't fix that —
only changing what agents are allowed to read does.

**Three tiers, by consumer:**

1. **A Cloudflare Worker needs it at runtime** → Worker Secrets
   (`wrangler secret put`), as today. No change — this tier already works.
2. **A person needs to look it up occasionally** (Stripe console, Cloudflare dashboard
   token, a GitHub PAT) → Bitwarden (vault, not a flat file). In progress as of this audit
   for the Scope 5 tokens.
3. **A server-side process on the VPS needs it at startup** (bots, agents, cron jobs) —
   **this is the tier that broke.** `~/.env.secrets` (106 vars, 75 credential-shaped, ~50
   consuming services per secrets-inventory.md Scope 2) is the single largest blast-radius
   object on the host, and it's exactly the kind of file an agent gets asked to `cat` for
   an unrelated reason. Recommendation: replace it with a secrets-injection tool —
   **Bitwarden Secrets Manager** (same vendor as tier 2, has a CLI (`bws`) built for
   injecting env vars into a process at launch) or **Infisical** (open source,
   self-hostable, same purpose) — so no flat file holding many secrets sits on disk for an
   agent to read wholesale. Per-consumer scoping (rule 1 in secrets-inventory.md: "one
   credential per named consumer") gets easier too, since each service pulls only what it
   declares rather than inheriting the whole file via `EnvironmentFile=`.

This doesn't replace secrets-inventory.md's four rules — it's the concrete mechanism for
rule 2 ("Never `.env.secrets`. Each consumer gets its own file") and for finally closing
"Capture mechanism fixed ❌" in that document's Remediation table.

## Open items

- Mac `~/.codex/sessions` redaction — needs the same script/approach as the Hetzner pass,
  adapted for this host. Not yet run.
- `~/.gemini/antigravity/brain/.../transcript.jsonl` — needs a value-blind check.
- Decision needed from Hadi on the 10 "recommend private" repos above.
- Secrets-manager selection (Bitwarden Secrets Manager vs. Infisical) for VPS process
  secrets — not yet decided, proposed here for the first time.

## Prelaunch security posture — external research, 2026-08-07

Requested by Hadi: what is the industry seeing on AI-coding-agent secret leaks, and does
it change the public/private repo decision above. Summary of external research (sources
inline); full findings available on request.

### This incident is a named, documented pattern — not a one-off

- **"Comment and Control"** (Aonan Guan, covered by VentureBeat): prompt injection via
  GitHub PR/issue comments got Claude Code, Gemini CLI, and GitHub Copilot Agent to read
  `/proc/*/environ` and exfiltrate `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GITHUB_TOKEN`.
  Command-blocklisting (Anthropic blocked `ps`) didn't hold — equivalent commands achieved
  the same exfiltration.
- Anthropic's own March 2026 tracker confirmed Claude Code printing full API keys into
  **model-visible output and session history** — the same failure mode as tonight's
  incident, at a different vendor.
- **GitGuardian State of Secrets Sprawl 2026**: commits co-authored by Claude Code leak
  secrets at **~2x the baseline rate** across public GitHub. 29M new hardcoded secrets
  exposed on public GitHub in 2025 (+34% YoY); secrets tied to AI services specifically:
  1.27M, +81% YoY.

### MCP-specific risk — directly relevant, this is our own product surface

- "Tool poisoning" (CVE-2025-54136 MCPoison, CVE-2025-54135 CurXecute): a compromised MCP
  server embeds adversarial instructions in tool descriptions at connect time; responses
  aren't re-vetted at runtime, so a poisoned server can instruct the agent to read a
  sensitive file and pass its contents as a parameter, exfiltrating silently.
- GitGuardian: **24,008 unique secrets found sitting in MCP configuration files**
  industry-wide. We run MCP infrastructure (sos, mcpwp, mumcp-proxy) — this is exposure
  in our own product category, not just background risk.

### New action item — `CLAUDE.md` as a supply-chain vector

The "TrapDoor" campaign (May 2026, 34 malicious packages across npm/PyPI/Crates.io)
planted invisible instructions inside `.cursorrules` and `CLAUDE.md` files that hijack the
agent on next read (a fake "security scan" that steals credentials). Separately, 5
typosquatting npm packages hijacked Claude Code's `SessionStart` hook to re-execute on
every session.

CONFIRMED: public `CLAUDE.md` files exist in `sos`, `mcpwp-claude-plugin`, `torivers.com`,
and `therealmofpatterns`. Not evidence of tampering — no review has been done yet — but
worth a clean-history check before launch, especially `mcpwp-claude-plugin` since it's
distributed as an installable Claude Code plugin (a direct analogue to the TrapDoor
vector).

### Does this change the public/private recommendation above? No — it reframes the fix.

GitGuardian: **private repositories are 6x more likely to contain hardcoded secrets than
public ones** — the privacy of a private repo creates false security, while public-repo
pressure forces better hygiene. The data does not support "go private for safety." It
supports the opposite lever: **credential brokering** — secrets live in infrastructure
outside the agent's sandbox and are injected server-side, so the agent's context (and
therefore its transcript) never contains the raw value, regardless of whether the repo is
public or private.

Anthropic converged on the same architecture and open-sourced it, May 2026:
`anthropic-experimental/sandbox-runtime` — OS-level sandboxing (Seatbelt/bubblewrap),
filesystem writes confined to the workspace, network denied by default, credential proxy
living *outside* the sandbox so tokens are structurally unreachable from code the agent
runs. Reported 84% fewer permission prompts alongside improved containment.

**This is the stronger version of issue #772.** Bitwarden Secrets Manager / Infisical
solves "no giant flat file for an agent to `cat`." Sandboxing the agent process itself
solves it at the layer above: the agent structurally cannot reach the secret store at all,
so even a successful prompt-injection attempt (section above) has nothing to exfiltrate.

### Indexing / backlink check (informed the keep-public list above)

Two passes: an API-based search first, then redone through an actual Google browser
session (real `site:` queries against live Google results, not an API tool) since that's
the more reliable signal — it corrected two items from the first pass, both noted below.

CONFIRMED via live Google search: `github.com/Mumega-com` and `mumega.com` both rank on
**page 1** for the branded query "mumega mupot agent os," alongside `github.com/servathadi`
(personal account, surfacing `inkwell`). `mupot`, `sos`, `inkwell`, and `mumcp-proxy` are
also indexed and cross-linked from real MCP-ecosystem discovery surfaces — Glama, PulseMCP,
awesome-claude-code, wordpress.org's plugin directory. This is live backlink/discovery
value, not hypothetical — reinforces keeping these public. (`mumcp-proxy`'s indexed page is
thin — just its Pull Requests listing, not real product content — so this doesn't change
the recommend-private call on it below.)

CORRECTION to the first-pass finding: **`mumega-docs` is NOT indexed** — the earlier API
search result was a false read. Confirmed via a direct `site:` query: zero results. No SEO
cost to privatizing it, consistent with the original recommendation.

CONFIRMED via live Google search: `qbo-mini`, `qbo-torivers`, `Digid-MCP`, `mumega-cli`,
`archive-wp-ai-operator`, and `archive-mumega-cms` have **zero indexing footprint** —
nothing links to them, nothing surfaces under any query tried. Flipping these private
costs nothing on the SEO/discovery side.

**One real exception, and it changes the plan for one repo:** `archive-mumega-marketing`
**is indexed with real content** — Google surfaces `brand/GUIDELINES.md` directly,
containing live brand messaging copy ("Mumega is the operating system for the Sovereign
Economy. We build autonomous digital employees that liberate human potential."). This repo
also has a real revoked secret in its history (telegram_bot_token + google_api_key, from
the 2026-08-03 cleanup pass in the earlier findings). `archive-ai-team` is also indexed,
but only a thin issues/views UI page, not real content — already privatized below.

**Resolved — no migration needed.** Hadi's rule: content older than 3 months gets ignored
rather than migrated. CONFIRMED via commit history: `brand/GUIDELINES.md` has exactly 2
commits, both 2026-01-06 — over 7 months old, past the cutoff. Privatized directly, no
migration.

## Status — repo visibility changes (2026-08-07, on Hadi's instruction)

DONE — all 10, flipped to private and verified via API afterward:

| repo | notes |
|---|---|
| `Digidinc/qbo-mini` | |
| `Digidinc/qbo-torivers` | |
| `Digidinc/Digid-MCP` | |
| `Digidinc/mumega-cli` | |
| `Mumega-com/mumcp-proxy` | |
| `Mumega-com/mumega-docs` | |
| `Mumega-com/archive-ai-team` | |
| `Mumega-com/archive-wp-ai-operator` | |
| `Mumega-com/archive-mumega-cms` | GitHub-archived repos are read-only for visibility changes via API — unarchived, flipped to private, re-archived. Confirmed still archived + now private afterward. |
| `Mumega-com/archive-mumega-marketing` | Same archived-repo dance. `brand/GUIDELINES.md` was past Hadi's 3-month freshness cutoff (last touched 2026-01-06), so migrated nothing — privatized directly per his call. |

All items from the original public-repo review are now closed.
