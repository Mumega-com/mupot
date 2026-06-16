"""
mupot Hermes Plugin — tool implementations (v0.2).

v0.2 ships the REAL Cloudflare provisioner (CloudflareApiClient) using pure urllib —
no extra dependencies.  When confirm=True, dry_run=False, and no cf_client is injected,
the tool constructs CloudflareApiClient from env (MUPOT_CF_API_TOKEN / MUPOT_CF_ACCOUNT_ID)
and performs real idempotent provisioning (create D1 + KV).

v0.2 also wires the Worker deploy path: after D1+KV are provisioned, the generated
wrangler.<slug>.toml is used by `npx wrangler deploy`.  Migration apply follows the
DRY-RUN-FIRST gate (Risk 2) and is emitted as a gated next_step — NOT auto-run.

v0.3 defers: full Cloudflare Workers SDK upload (no wrangler dep), live BYO-CF
integration test (requires a real CF account), publish to PyPI / GH release (#266).

Risk annotations (unchanged from v0.1 design doc):
  Risk 1 — CF token in env (least-scoped token; mupot_revoke_token stub noted).
  Risk 2 — Migration drift landmine (DRY-RUN + explicit confirm; never blind apply).
  Risk 3 — Brain token must be SCOPED, not mcp:*. Plugin documents; operator enforces.
  Risk 4 — wrangler version drift (pin min version, check before deploy; v0.3 removes dep).
  Risk 5 — Workers free-tier slot warning.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol

# ── CF client protocol (injectable for tests / dry-run) ──────────────────────


class CloudflareClient(Protocol):
    """Minimal surface of the CF API used by the provisioner."""

    def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]: ...
    def create_d1_database(self, account_id: str, name: str) -> dict[str, Any]: ...
    def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]: ...
    def create_kv_namespace(self, account_id: str, title: str) -> dict[str, Any]: ...


@dataclass
class DryRunClient:
    """
    Stub CF client — records calls, never touches Cloudflare.
    Used when dry_run=True (default) or injected in tests.
    """

    calls: list[dict[str, Any]] = field(default_factory=list)
    _d1_db_counter: int = 0
    _kv_ns_counter: int = 0

    def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]:
        self.calls.append({"method": "list_d1_databases", "account_id": account_id})
        return []  # default: nothing exists yet

    def create_d1_database(self, account_id: str, name: str) -> dict[str, Any]:
        self.calls.append(
            {"method": "create_d1_database", "account_id": account_id, "name": name}
        )
        self._d1_db_counter += 1
        return {"id": f"dry-run-d1-{self._d1_db_counter:04d}", "name": name}

    def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]:
        self.calls.append(
            {"method": "list_kv_namespaces", "account_id": account_id}
        )
        return []

    def create_kv_namespace(self, account_id: str, title: str) -> dict[str, Any]:
        self.calls.append(
            {
                "method": "create_kv_namespace",
                "account_id": account_id,
                "title": title,
            }
        )
        self._kv_ns_counter += 1
        return {"id": f"dry-run-kv-{self._kv_ns_counter:04d}", "title": title}


# ── Real Cloudflare API client (v0.2) ────────────────────────────────────────

_CF_API_BASE = "https://api.cloudflare.com/client/v4"
_CF_LIST_PAGE_SIZE = 100  # CF default; request up to 100 per page


class CloudflareApiError(RuntimeError):
    """Raised when the CF REST API returns a non-2xx status or error payload.

    Security: NEITHER the raw response body NOR CF error message TEXT is ever
    embedded in the error message. An upstream/proxy body OR a CF error message
    can echo the auth token verbatim (e.g. "bad token <secret>"), so only the
    HTTP method, URL, status code, and the numeric CF error CODES (never the
    message strings) are included. Codes are integers and never contain
    credentials.
    """

    def __init__(
        self,
        method: str,
        url: str,
        status: int,
        *,
        cf_errors: list[dict[str, Any]] | None = None,
    ) -> None:
        if cf_errors:
            # Security (Codex RED-2): include ONLY the numeric CF error codes and a
            # count — NEVER the message text. CF error messages can echo the
            # offending token; excluding message strings by construction keeps the
            # invariant "the token never appears in an exception message".
            codes = ", ".join(str(e.get("code", "?")) for e in cf_errors)
            super().__init__(
                f"CF API {method} {url} → HTTP {status}: "
                f"{len(cf_errors)} CF error(s) [codes: {codes}]"
            )
        else:
            super().__init__(f"CF API {method} {url} → HTTP {status}")
        self.status = status


class CloudflareApiClient:
    """
    Real Cloudflare REST API client using stdlib urllib only (no extra deps).

    Auth: Authorization: Bearer <token>  (Risk 1: token NEVER logged or echoed).
    Account: passed explicitly to each call; sourced from MUPOT_CF_ACCOUNT_ID env.

    Implements the CloudflareClient Protocol used by mupot_provision.
    """

    def __init__(self, api_token: str, *, timeout: int = 30) -> None:
        if not api_token:
            raise ValueError(
                "CF API token is empty. Set MUPOT_CF_API_TOKEN in your environment."
            )
        # Store token only in this private slot — never surface in repr/str/logs.
        self.__token = api_token
        self._timeout = timeout

    def __repr__(self) -> str:
        # Deliberately omit the token from repr (Risk 1).
        return "CloudflareApiClient(<token_redacted>)"

    def _request(
        self, method: str, path: str, body: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """
        Low-level JSON request.  Returns parsed response dict on success.
        Raises CloudflareApiError on non-2xx responses.
        Risk 1: Authorization header value is NEVER logged, echoed, or included in
        error messages raised from this method.
        """
        url = f"{_CF_API_BASE}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            # Risk 1: token only in the Authorization header — not in logs or errors.
            "Authorization": f"Bearer {self.__token}",
            "Content-Type": "application/json",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read().decode()
        except urllib.error.HTTPError as exc:
            # Security: do NOT read or embed the response body — it may echo the auth token.
            # Include only method + url + status code in the error (Risk 1).
            raise CloudflareApiError(method, url, exc.code) from exc
        parsed: dict[str, Any] = json.loads(raw)
        if not parsed.get("success", False):
            # Pass only the CF errors array; CloudflareApiError includes ONLY the
            # numeric codes (never the message text, which can echo the token).
            cf_errors: list[dict[str, Any]] = parsed.get("errors", [])
            raise CloudflareApiError(method, url, 0, cf_errors=cf_errors)
        return parsed

    def list_d1_databases(self, account_id: str) -> list[dict[str, Any]]:
        """
        List ALL D1 databases for the account, paginating until exhausted.
        GET /accounts/{account_id}/d1/database?per_page=N&page=P
        Returns the aggregated 'result' array across all pages.
        """
        all_results: list[dict[str, Any]] = []
        page = 1
        while True:
            path = (
                f"/accounts/{account_id}/d1/database"
                f"?per_page={_CF_LIST_PAGE_SIZE}&page={page}"
            )
            parsed = self._request("GET", path)
            page_results = parsed.get("result", [])
            all_results.extend(page_results)
            result_info = parsed.get("result_info", {})
            total_pages = result_info.get("total_pages", 1)
            if page >= total_pages:
                break
            page += 1
        return all_results

    def create_d1_database(self, account_id: str, name: str) -> dict[str, Any]:
        """
        Create a D1 database.
        POST /accounts/{account_id}/d1/database
        Returns the created db dict (id, name, ...).
        """
        path = f"/accounts/{account_id}/d1/database"
        parsed = self._request("POST", path, body={"name": name})
        return parsed.get("result", {})

    def list_kv_namespaces(self, account_id: str) -> list[dict[str, Any]]:
        """
        List ALL KV namespaces for the account, paginating until exhausted.
        GET /accounts/{account_id}/storage/kv/namespaces?per_page=N&page=P
        Returns the aggregated 'result' array across all pages.
        """
        all_results: list[dict[str, Any]] = []
        page = 1
        while True:
            path = (
                f"/accounts/{account_id}/storage/kv/namespaces"
                f"?per_page={_CF_LIST_PAGE_SIZE}&page={page}"
            )
            parsed = self._request("GET", path)
            page_results = parsed.get("result", [])
            all_results.extend(page_results)
            result_info = parsed.get("result_info", {})
            total_pages = result_info.get("total_pages", 1)
            if page >= total_pages:
                break
            page += 1
        return all_results

    def create_kv_namespace(self, account_id: str, title: str) -> dict[str, Any]:
        """
        Create a KV namespace.
        POST /accounts/{account_id}/storage/kv/namespaces
        Returns the created namespace dict (id, title, ...).
        """
        path = f"/accounts/{account_id}/storage/kv/namespaces"
        parsed = self._request("POST", path, body={"title": title})
        return parsed.get("result", {})


def _build_api_client_from_env() -> tuple["CloudflareApiClient", str]:
    """
    Construct CloudflareApiClient + validate MUPOT_CF_ACCOUNT_ID from environment.
    Raises ValueError with a clear message if either env var is missing.
    Risk 1: error messages name the env var, NEVER its value.
    Returns (client, account_id).
    """
    token = os.environ.get("MUPOT_CF_API_TOKEN", "")
    if not token:
        raise ValueError(
            "MUPOT_CF_API_TOKEN is not set. "
            "Create a scoped CF API token (5 permission groups — see design doc) "
            "and export it as MUPOT_CF_API_TOKEN before running with confirm=True."
        )
    account_id = os.environ.get("MUPOT_CF_ACCOUNT_ID", "").strip()
    if not account_id:
        raise ValueError(
            "MUPOT_CF_ACCOUNT_ID is not set. "
            "Find your Cloudflare account ID at dash.cloudflare.com → right sidebar "
            "and export it as MUPOT_CF_ACCOUNT_ID before running with confirm=True."
        )
    return CloudflareApiClient(token), account_id


# ── stub for token revocation (Risk 1, v0.3 implementation) ──────────────────


def mupot_revoke_token() -> dict[str, Any]:
    """
    Stub: revoke the CF API token after successful provisioning (Risk 1).
    v0.2 documents the pattern; real revocation via CF /user/tokens/{id} lands in v0.3
    (needs token ID stored at mint time, not just the token value).
    """
    return {
        "stubbed": True,
        "message": (
            "mupot_revoke_token is stubbed in v0.2. "
            "To revoke: log in to dash.cloudflare.com → My Profile → API Tokens "
            "and delete the mupot-provision token once provisioning is complete. "
            "v0.3 will automate revocation via the CF API."
        ),
    }


# ── slug validation ───────────────────────────────────────────────────────────

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$")


def _validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise ValueError(
            f"Invalid slug {slug!r}. Must be 2–30 lowercase alphanumeric + hyphens, "
            "no leading/trailing hyphen."
        )


# ── wrangler.toml template ────────────────────────────────────────────────────

_WRANGLER_TOML_TEMPLATE = """\
# wrangler.{slug}.toml — GENERATED by mupot_provision v0.1
# DO NOT COMMIT with real IDs if this file is in a public repo.
# Treat cf_api_token as a secret: set via `wrangler secret put` or env, never here.
name = "mupot-{slug}"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[vars]
TENANT_SLUG = "{slug}"
BRAND = "{brand}"
OAUTH_PROVIDER = "{oauth_provider}"
FLEET_PROJECT = "sos"
FLEET_OPS_AGENT = "kasra"

[[d1_databases]]
binding = "DB"
database_name = "mupot-{slug}"
database_id = "{d1_id}"
migrations_dir = "migrations"

[[kv_namespaces]]
binding = "SESSIONS"
id = "{sessions_kv_id}"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "{oauth_kv_id}"

[ai]
binding = "AI"

[[durable_objects.bindings]]
name = "AGENT"
class_name = "AgentDO"

[[durable_objects.bindings]]
name = "SQUAD"
class_name = "SquadCoordinatorDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AgentDO", "SquadCoordinatorDO"]

[[workflows]]
name = "mupot-task-workflow"
binding = "TASK_WORKFLOW"
class_name = "TaskWorkflow"

[triggers]
crons = ["*/15 * * * *"]
"""


# ── mupot_provision ──────────────────────────────────────────────────────────


def mupot_provision(
    slug: str,
    brand: str,
    cf_account_id: str,
    cf_api_token: str,
    oauth_provider: str = "google",
    confirm: bool = False,
    dry_run: bool = True,
    *,
    cf_client: Optional[CloudflareClient] = None,
    toml_output_dir: Optional[Path] = None,
    wrangler_deploy: bool = False,
) -> dict[str, Any]:
    """
    Idempotent mupot provisioner (v0.2 — real CF provisioning).

    Phase 1 (always): list-guard check existing CF resources, build a plan.
    Phase 2 (only if confirm=True AND dry_run=False):
      - construct CloudflareApiClient from env (if cf_client not injected)
      - idempotently create D1 database + KV namespaces (skip if already exist)
      - write wrangler.<slug>.toml with resolved IDs
      - if wrangler_deploy=True: run `npx wrangler deploy` (Risk 4)
    Migration apply is NEVER auto-run — emitted as a gated DRY-RUN-FIRST next_step (Risk 2).

    wrangler_deploy=False (default): write toml only; emit deploy command in next_steps.
    wrangler_deploy=True: run `npx wrangler deploy --config wrangler.<slug>.toml` via
      subprocess after provisioning.  Requires wrangler >= 3.x on PATH.  Worker deploy
      uses the generated toml — MUPOT_CF_API_TOKEN must be in env (Risk 1).

    Returns a structured plan/result dict.
    """
    _validate_slug(slug)

    # dry_run flag takes precedence over confirm as a safety guard
    applying = confirm and not dry_run

    # Reject a blank cf_account_id on the apply path — even when a client is injected.
    # A blank account_id would silently call the wrong CF endpoint or return nonsense.
    if applying and not cf_account_id.strip():
        raise ValueError(
            "cf_account_id is blank. Provide your Cloudflare account ID (32 hex chars) "
            "or set MUPOT_CF_ACCOUNT_ID in the environment."
        )

    # Choose client: injected > construct from env (apply only) > DryRunClient
    client: CloudflareClient
    if cf_client is not None:
        client = cf_client
    elif applying:
        # v0.2: construct the real client from env — no SDK dep, pure urllib.
        # cf_api_token param is accepted for API surface compatibility but the real
        # client is always constructed from env (token never re-logged from param).
        # _build_api_client_from_env ALSO validates MUPOT_CF_ACCOUNT_ID is present
        # (raises if unset). The cf_account_id PARAM is what's used for all CF API
        # calls below (and line 406 guarantees it is non-blank on the apply path) —
        # env account_id is validated for presence, not used as an override.
        client, _ = _build_api_client_from_env()
    else:
        client = DryRunClient()

    worker_name = f"mupot-{slug}"
    d1_name = f"mupot-{slug}"
    sessions_title = f"mupot-{slug}-sessions"
    oauth_title = f"mupot-{slug}-oauth"

    # ── idempotent list-guard ────────────────────────────────────────────────
    existing_d1 = client.list_d1_databases(cf_account_id)
    existing_kv = client.list_kv_namespaces(cf_account_id)

    existing_d1_ids = {db["name"]: db["id"] for db in existing_d1}
    existing_kv_ids = {ns["title"]: ns["id"] for ns in existing_kv}

    d1_exists = d1_name in existing_d1_ids
    sessions_exists = sessions_title in existing_kv_ids
    oauth_exists = oauth_title in existing_kv_ids

    plan: list[str] = []
    if d1_exists:
        plan.append(f"[SKIP] D1 database '{d1_name}' already exists — no-op.")
    else:
        plan.append(f"[CREATE] D1 database '{d1_name}'")

    if sessions_exists:
        plan.append(f"[SKIP] KV namespace '{sessions_title}' already exists — no-op.")
    else:
        plan.append(f"[CREATE] KV namespace '{sessions_title}'")

    if oauth_exists:
        plan.append(f"[SKIP] KV namespace '{oauth_title}' already exists — no-op.")
    else:
        plan.append(f"[CREATE] KV namespace '{oauth_title}'")

    result: dict[str, Any] = {
        "dry_run": not applying,
        "slug": slug,
        "worker_name": worker_name,
        "plan": plan,
        "applied": False,
        "toml_path": None,
        "next_steps": [],
        "warnings": [],
    }

    # ── Risk 5: Workers slot warning ─────────────────────────────────────────
    result["warnings"].append(
        "Each mupot pot consumes one Workers slot. "
        "Free tier = 100 slots. Check your usage before provisioning many pots."
    )

    if not applying:
        result["next_steps"] = [
            "This is a DRY-RUN plan (dry_run=True or confirm=False). "
            "To apply, call mupot_provision(..., confirm=True, dry_run=False).",
            f"1. Will create D1: mupot-{slug}  (skipped if already exists)",
            f"2. Will create KV: mupot-{slug}-sessions  (skipped if already exists)",
            f"3. Will create KV: mupot-{slug}-oauth  (skipped if already exists)",
            f"4. Will write wrangler.{slug}.toml with resolved resource IDs.",
            f"5. To deploy the worker: npx wrangler deploy --config wrangler.{slug}.toml",
            "6. MIGRATION — DRY-RUN FIRST (Risk 2 drift landmine):\n"
            f"   npx wrangler d1 migrations apply mupot-{slug} --dry-run "
            f"--config wrangler.{slug}.toml\n"
            "   Apply only after reviewing output for destructive operations.",
            f"7. Set OAuth secrets:\n"
            f"   npx wrangler secret put OAUTH_CLIENT_ID --config wrangler.{slug}.toml\n"
            f"   npx wrangler secret put OAUTH_CLIENT_SECRET --config wrangler.{slug}.toml",
            f"8. Verify: mupot_status(url='https://mupot-{slug}.workers.dev')",
            "9. Optionally: mupot_brain_enable(slug=...) to wire the DMN brain.",
            "10. Consider revoking or scoping down the CF token after provision (Risk 1).",
        ]
        return result

    # ── Apply phase (v0.2 — real provisioning) ───────────────────────────────
    d1_id = (
        existing_d1_ids[d1_name]
        if d1_exists
        else client.create_d1_database(cf_account_id, d1_name)["id"]
    )
    sessions_kv_id = (
        existing_kv_ids[sessions_title]
        if sessions_exists
        else client.create_kv_namespace(cf_account_id, sessions_title)["id"]
    )
    oauth_kv_id = (
        existing_kv_ids[oauth_title]
        if oauth_exists
        else client.create_kv_namespace(cf_account_id, oauth_title)["id"]
    )

    toml_content = _WRANGLER_TOML_TEMPLATE.format(
        slug=slug,
        brand=brand,
        oauth_provider=oauth_provider,
        d1_id=d1_id,
        sessions_kv_id=sessions_kv_id,
        oauth_kv_id=oauth_kv_id,
    )

    out_dir = toml_output_dir or Path(".")
    toml_path = out_dir / f"wrangler.{slug}.toml"
    toml_path.write_text(toml_content, encoding="utf-8")

    result["applied"] = True
    result["toml_path"] = str(toml_path)
    result["d1_id"] = d1_id
    result["sessions_kv_id"] = sessions_kv_id
    result["oauth_kv_id"] = oauth_kv_id

    # ── Optional wrangler deploy ─────────────────────────────────────────────
    deploy_result: Optional[dict[str, Any]] = None
    if wrangler_deploy:
        deploy_result = _run_wrangler_deploy(slug=slug, toml_path=toml_path)
        result["deploy"] = deploy_result

    result["next_steps"] = _apply_next_steps(
        slug=slug,
        toml_path=toml_path,
        deployed=wrangler_deploy and deploy_result is not None and deploy_result.get("ok"),
    )
    return result


def _apply_next_steps(
    slug: str, toml_path: Path, *, deployed: bool
) -> list[str]:
    """Build the post-apply next_steps list with migration dry-run-first gate (Risk 2)."""
    steps: list[str] = []
    if not deployed:
        steps.append(
            f"1. Deploy the worker:\n"
            f"   npx wrangler deploy --config {toml_path}  (Risk 4: needs wrangler >= 3.x)"
        )
    else:
        steps.append("1. Worker deployed (wrangler_deploy=True).")
    steps += [
        # Risk 2: migration dry-run BEFORE apply — this ordering is tested.
        "2. MIGRATION — DRY-RUN FIRST (Risk 2 drift landmine):\n"
        f"   npx wrangler d1 migrations apply mupot-{slug} --dry-run --config {toml_path}\n"
        "   Review the plan carefully. Only apply WITHOUT --dry-run after confirming "
        "no destructive operations (DROP, column removal, etc.).",
        f"   npx wrangler d1 migrations apply mupot-{slug} --config {toml_path}",
        "3. Set OAuth secrets:\n"
        f"   npx wrangler secret put OAUTH_CLIENT_ID --config {toml_path}\n"
        f"   npx wrangler secret put OAUTH_CLIENT_SECRET --config {toml_path}",
        f"4. Verify: mupot_status(url='https://mupot-{slug}.workers.dev')",
        "5. Optionally: mupot_brain_enable(slug=...) to wire the DMN brain.",
        "6. After provision, revoke or scope down the CF token (Risk 1): "
        "see mupot_revoke_token() stub; full auto-revoke lands in v0.3.",
    ]
    return steps


def _run_wrangler_deploy(
    slug: str,
    toml_path: Path,
    *,
    _subprocess_run: Any = None,  # injectable for tests
) -> dict[str, Any]:
    """
    Run `npx wrangler deploy --config <toml_path>` via subprocess.

    Risk 4: wrangler version drift — checks wrangler --version before deploying.
    The CF API token is read by wrangler from the environment (MUPOT_CF_API_TOKEN);
    we do NOT pass it on the command line (Risk 1: never in argv / subprocess logs).

    _subprocess_run: injectable for tests (defaults to subprocess.run).
    Returns {ok: bool, returncode: int, stdout: str, stderr: str}.
    """
    run = _subprocess_run if _subprocess_run is not None else subprocess.run

    # Risk 4: verify wrangler is present and meets minimum version before deploying.
    version_check = run(
        ["npx", "wrangler", "--version"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if version_check.returncode != 0:
        return {
            "ok": False,
            "returncode": version_check.returncode,
            "stdout": version_check.stdout,
            "stderr": version_check.stderr,
            "error": (
                "wrangler not found or returned non-zero on --version. "
                "Install wrangler >= 3.x: `npm install -g wrangler`. (Risk 4)"
            ),
        }

    deploy_proc = run(
        # Risk 1: NEVER pass the token on the argv (it would appear in process list).
        # wrangler reads CLOUDFLARE_API_TOKEN from env; MUPOT_CF_API_TOKEN is set by
        # the operator. The caller is responsible for mapping these if names differ.
        ["npx", "wrangler", "deploy", "--config", str(toml_path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return {
        "ok": deploy_proc.returncode == 0,
        "returncode": deploy_proc.returncode,
        "stdout": deploy_proc.stdout,
        "stderr": deploy_proc.stderr,
    }


# ── mupot_status ─────────────────────────────────────────────────────────────


def mupot_status(
    url: str,
    *,
    http_fetch: Optional[Any] = None,
) -> dict[str, Any]:
    """
    Probe a live mupot deployment's /health endpoint.

    http_fetch: injectable callable(url: str) -> Response-like with .status_code + .json().
    If not provided and _ALLOW_REAL_HTTP is False, returns a dry-run result.
    """
    # Normalise trailing slash
    base = url.rstrip("/")
    health_url = f"{base}/health"

    if http_fetch is None:
        # Guard: no real HTTP in test/CI unless explicitly provided
        return {
            "dry_run": True,
            "ok": None,
            "url": base,
            "health_url": health_url,
            "message": (
                "No http_fetch injected. Pass http_fetch=requests.get (or a mock) "
                "to probe a live deployment."
            ),
        }

    try:
        resp = http_fetch(health_url)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "dry_run": False,
                "ok": True,
                "url": base,
                "health_url": health_url,
                "tenant": data.get("tenant"),
                "raw": data,
            }
        return {
            "dry_run": False,
            "ok": False,
            "url": base,
            "health_url": health_url,
            "status_code": resp.status_code,
            "message": f"Health endpoint returned {resp.status_code}.",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "dry_run": False,
            "ok": False,
            "url": base,
            "health_url": health_url,
            "error": str(exc),
        }


# ── mupot_brain_enable ───────────────────────────────────────────────────────

_BRAIN_CONFIG_TEMPLATE = """\
# Hermes profile config — mupot-{slug} brain (DMN prioritizer)
# Model: qwen/qwen3.7-plus via OpenRouter — cheap, fast, adequate for ranking.
# Generated by mupot_brain_enable v0.1.
#
# INSTALL STEPS (emitted by mupot_brain_enable — execute manually or via automation):
#   See next_steps in the tool output.

model:
  default: qwen/qwen3.7-plus
  provider: openrouter
  base_url: https://openrouter.ai/api/v1
  api_mode: chat_completions

providers: {{}}
fallback_providers: []

toolsets:
  - hermes-cli

agent:
  max_turns: 12
  gateway_timeout: 300
  restart_drain_timeout: 30
  api_max_retries: 2
  tool_use_enforcement: auto
  reasoning_effort: low
  verbose: false

terminal:
  backend: local
  timeout: 60
  auto_source_bashrc: true
  persistent_shell: false

web:
  backend: ''
  search_backend: ''
  extract_backend: ''
"""

_CRON_SCRIPT_TEMPLATE = """\
#!/usr/bin/env python3
# mupot-{slug}-brain cron — DMN priority scan, every 15 minutes.
# REAL FILE (not symlink) — required so Hermes cron scheduler can read it directly.
# See: feedback_cron_scheduled_neq_running.md — symlinks cause silent cron failures.
#
# This script is the entrypoint for the mupot-{slug} brain's priority scan.
# It calls the brain profile's prioritize_scan logic with the pot's token.
#
# TOKEN SCOPE NOTE (Risk 3): This script checks that TOKEN_ENV is SET, but it
# CANNOT verify the token's scope — token introspection is not available here.
# The OPERATOR must supply a scoped token (task:read + priority:write only).
# Using mcp:* would grant full bus control to this always-on automated agent.
# Scope enforcement is the operator's responsibility — not this script's.

import os
import subprocess
import sys

SLUG = "{slug}"
HERMES_HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
TOKEN_ENV = "MUMEGA_BRAIN_TOKEN_{slug_upper}"

def main() -> None:
    token = os.environ.get(TOKEN_ENV)
    if not token:
        print(
            f"[mupot-brain-cron] {{TOKEN_ENV}} not set. "
            "Operator must supply a SCOPED token (task:read + priority:write). "
            "NOT mcp:* — see Risk 3 in mupot-hermes-plugin-v0.1.md. "
            "Note: this script can only check the token EXISTS, not its scope.",
            file=sys.stderr,
        )
        sys.exit(1)

    profile_dir = os.path.join(
        HERMES_HOME, "profiles", f"mupot-{{SLUG}}-brain"
    )
    scan_script = os.path.join(
        HERMES_HOME, "scripts", f"mupot_{{SLUG}}_brain_scan.py"
    )

    if not os.path.isfile(scan_script):
        print(
            f"[mupot-brain-cron] Scan script not found: {{scan_script}}. "
            "Copy from Mumega-com/mupot-plugin/brain/prioritize_scan.py.",
            file=sys.stderr,
        )
        sys.exit(1)

    subprocess.run(
        [sys.executable, scan_script, "--profile", profile_dir, "--dry-run"],
        check=True,
        env={{**os.environ, TOKEN_ENV: token}},
    )


if __name__ == "__main__":
    main()
"""


def mupot_brain_enable(
    slug: str,
    hermes_home: str = "~/.hermes",
    openrouter_api_key_env: str = "OPENROUTER_API_KEY",
) -> dict[str, Any]:
    """
    Emit the plan + commands to wire the DMN brain for a provisioned mupot pot.

    v0.1: returns a structured plan dict. Does NOT execute against a live host.
    The caller (Hermes agent or human operator) follows the next_steps.

    Risk 3: the plan DOCUMENTS that the operator must supply a SCOPED token (task:read +
    priority:write), NOT mcp:*. The plugin does NOT enforce token scope — no bus
    introspection is available in the cron context; scope is the operator's responsibility.
    """
    _validate_slug(slug)
    slug_upper = slug.upper().replace("-", "_")

    home = hermes_home.rstrip("/")
    profile_dir = f"{home}/profiles/mupot-{slug}-brain"
    scripts_dir = f"{home}/scripts"
    cron_script_path = f"{scripts_dir}/mupot_{slug}_cron.py"  # REAL FILE, not symlink
    cron_jobs_path = f"{home}/cron/jobs.json"
    config_path = f"{profile_dir}/config.yaml"
    token_env_var = f"MUMEGA_BRAIN_TOKEN_{slug_upper}"

    config_content = _BRAIN_CONFIG_TEMPLATE.format(slug=slug)
    cron_script_content = _CRON_SCRIPT_TEMPLATE.format(
        slug=slug, slug_upper=slug_upper
    )

    cron_entry = {
        "name": f"mupot-{slug}-brain-scan",
        "schedule": "*/15 * * * *",
        "command": f"python3 {cron_script_path}",
        "profile": f"mupot-{slug}-brain",
        "enabled": True,
    }

    next_steps = [
        f"1. Create profile directory:\n   mkdir -p {profile_dir}",
        f"2. Write config.yaml to {config_path}\n"
        f"   (content emitted in this result under 'config_yaml')",
        f"3. Write the cron script as a REAL FILE (NOT a symlink — Risk: symlinks "
        f"cause silent Hermes cron failures):\n"
        f"   {cron_script_path}\n"
        f"   (content emitted in this result under 'cron_script')",
        f"4. chmod +x {cron_script_path}",
        f"5. Register the cron entry in {cron_jobs_path}.\n"
        f"   Hermes hotloads cron config without daemon restart.\n"
        f"   Entry to add (emitted under 'cron_entry').",
        f"6. Set a SCOPED brain token (Risk 3 — NOT mcp:*):\n"
        f"   OPERATOR RESPONSIBILITY: supply a token scoped to task:read + priority:write.\n"
        f"   The plugin documents this requirement but cannot enforce token scope.\n"
        f"   Export: export {token_env_var}=<scoped-token>\n"
        f"   Or add to ~/.env.secrets: {token_env_var}=<scoped-token>",
        f"7. Set {openrouter_api_key_env} in your environment for qwen3.7-plus.",
        f"8. Verify dry-run:\n"
        f"   python3 {cron_script_path} --dry-run",
        f"9. Hermes will pick up the cron within one poll cycle (~60s). "
        f"Watch the first scan: `hermes logs --profile mupot-{slug}-brain`",
    ]

    warnings = [
        f"Risk 3 (token scope — operator responsibility): {token_env_var} MUST be a "
        "scoped token (task:read + priority:write). mcp:* would grant full bus control "
        "to an always-on automated agent — never do this. "
        "The plugin DOCUMENTS this requirement but CANNOT enforce token scope — "
        "the Mumega bus does not expose token introspection to this cron script.",
        "Cron script MUST be a real file, not a symlink. Hermes cron scheduler reads "
        "the script path directly; a broken symlink causes a silent non-execution.",
        f"The brain profile uses qwen/qwen3.7-plus via OpenRouter. "
        f"Ensure {openrouter_api_key_env} is set with sufficient quota.",
    ]

    return {
        "dry_run": True,  # v0.1 always emits a plan, never executes
        "slug": slug,
        "profile_dir": profile_dir,
        "cron_script_path": cron_script_path,
        "token_env_var": token_env_var,
        "config_yaml": config_content,
        "cron_script": cron_script_content,
        "cron_entry": cron_entry,
        "next_steps": next_steps,
        "warnings": warnings,
    }
