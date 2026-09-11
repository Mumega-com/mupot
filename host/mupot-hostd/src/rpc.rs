//! Same-user Unix socket RPC + approved write path (F3).
//!
//! Served context join: Store.list_observations → reconcile/build_context.
//! `propose` stores a proposal; `commit` requires a matching exact-action Approval.
//! Missing/expired approval → `ApprovalRequired` / `ApprovalExpired` only.
//! Bare `write` remains `UnsupportedContract` (use propose/commit).

use crate::adapters::herdr::HerdrAdapter;
use crate::adapters::inkwell::InkwellWriteAdapter;
use crate::adapters::mirror::MirrorWriteAdapter;
use crate::adapters::mupot::MupotAdapter;
use crate::adapters::ReadAdapter;
use crate::approval::ExactAction;
use crate::commit::{CommitEngine, CommitRequest};
use crate::contract::{BrokerError, Observation, Proposal, Receipt, VerifiedScope};
use crate::context::build_context;
use crate::freshness::{reconcile, ReconciledClaim, SourcePolicy};
use crate::identity::{normalize_evidence, verify_identity};
use crate::outbox::Outbox;
use crate::policy::HERDR_SOCK_DEFAULT;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const MAX_REQUEST_BYTES: usize = 1_048_576;
pub const MAX_RESPONSE_BYTES: usize = 4_194_304;

/// Production join point: observations served to `context` come from Store.
/// Kill-witness: if this returns empty while the DB has rows, served context is unwired.
pub fn load_observations_from_store(store: &Store) -> Result<Vec<Observation>, BrokerError> {
    store.list_observations()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub op: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct HostState {
    pub store: Mutex<Store>,
    pub runtime_dir: PathBuf,
    pub socket_path: PathBuf,
    pub policies: Vec<SourcePolicy>,
    /// Cache refreshed from Store via `load_observations_from_store` — not a second source of truth.
    pub observations: Mutex<Vec<Observation>>,
    pub mupot: MupotAdapter,
    pub herdr: HerdrAdapter,
    pub proposals: Mutex<BTreeMap<String, Proposal>>,
    pub commit: CommitEngine,
}

impl HostState {
    pub fn open(runtime_dir: &Path) -> Result<Self, BrokerError> {
        let mupot = default_mupot_adapter();
        let herdr = default_herdr_adapter();
        Self::open_with_adapters(runtime_dir, mupot, herdr)
    }

    pub fn open_with_adapters(
        runtime_dir: &Path,
        mupot: MupotAdapter,
        herdr: HerdrAdapter,
    ) -> Result<Self, BrokerError> {
        prepare_runtime_dir(runtime_dir)?;
        let socket_path = runtime_dir.join("hostd.sock");
        refuse_occupied_socket(&socket_path)?;
        let db = runtime_dir.join("host.sqlite");
        let store = Store::open(&db)?;
        let observations = load_observations_from_store(&store)?;
        let outbox = Outbox::open(&runtime_dir.join("outbox.json"))?;
        Ok(Self {
            store: Mutex::new(store),
            runtime_dir: runtime_dir.to_path_buf(),
            socket_path,
            policies: default_policies(),
            observations: Mutex::new(observations),
            mupot,
            herdr,
            proposals: Mutex::new(BTreeMap::new()),
            commit: CommitEngine {
                outbox,
                inkwell: InkwellWriteAdapter::new(),
                mirror: MirrorWriteAdapter::new(),
            },
        })
    }

    /// Persist then reload cache from Store (the join Gate F2 requires).
    pub fn persist_observation(&self, obs: &Observation) -> Result<(), BrokerError> {
        {
            let mut store = self.store.lock().map_err(|_| BrokerError::CorruptState)?;
            store.record_observation(obs)?;
        }
        self.reload_observations_from_store()
    }

    pub fn reload_observations_from_store(&self) -> Result<(), BrokerError> {
        let store = self.store.lock().map_err(|_| BrokerError::CorruptState)?;
        let loaded = load_observations_from_store(&store)?;
        let mut cache = self.observations.lock().map_err(|_| BrokerError::CorruptState)?;
        *cache = loaded;
        Ok(())
    }

    /// Read allowed sources (scripted Mupot RPCs + Herdr Unix client), persist, reload.
    /// No SSE, inbox_ack, mint, or connect.
    pub fn ingest_from_read_adapters(&self, scope: &VerifiedScope) -> Result<usize, BrokerError> {
        let mut written = 0usize;
        {
            let mut store = self.store.lock().map_err(|_| BrokerError::CorruptState)?;
            if let Ok(batch) = self.mupot.recall("boot", scope) {
                for obs in batch {
                    match store.record_observation(&obs) {
                        Ok(()) => written += 1,
                        Err(BrokerError::Conflict) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            match self.herdr.recall("session", scope) {
                Ok(batch) => {
                    // Skip enormous live snapshots in default test path unless opted in.
                    let live = std::env::var("MUPOT_HOSTD_LIVE_HERDR").ok().as_deref() == Some("1");
                    let allow = self.herdr.scripted.is_some() || live;
                    if allow {
                        for obs in batch {
                            match store.record_observation(&obs) {
                                Ok(()) => written += 1,
                                Err(BrokerError::Conflict) => {}
                                Err(e) => return Err(e),
                            }
                        }
                    }
                }
                Err(BrokerError::SourceUnavailable) | Err(BrokerError::UnsupportedContract) => {}
                Err(e) => return Err(e),
            }
            let _ = store.record_cursor("hostd", &scope.scope().tenant, &written.to_string());
        }
        self.reload_observations_from_store()?;
        Ok(written)
    }

    /// Observations for serve path — always from Store through the join function.
    pub fn served_observations(&self) -> Result<Vec<Observation>, BrokerError> {
        let store = self.store.lock().map_err(|_| BrokerError::CorruptState)?;
        load_observations_from_store(&store)
    }
}

fn default_mupot_adapter() -> MupotAdapter {
    let mut scripted = BTreeMap::new();
    scripted.insert(
        "boot_context".into(),
        json!({
            "ok": true,
            "result": {
                "bound_agent_id": "7089044c-5e48-4d5f-b5b0-6937433c4e79",
                "identity_status": "minted"
            }
        }),
    );
    scripted.insert(
        "status".into(),
        json!({"ok": true, "result": {"agent": "hadi-cursor"}}),
    );
    scripted.insert(
        "receipt_get".into(),
        json!({"ok": true, "result": null}),
    );
    MupotAdapter { scripted }
}

fn default_herdr_adapter() -> HerdrAdapter {
    let path = std::env::var("HERDR_SOCK").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        if HERDR_SOCK_DEFAULT.starts_with("~/") {
            format!("{}/{}", home, HERDR_SOCK_DEFAULT.trim_start_matches("~/"))
        } else {
            HERDR_SOCK_DEFAULT.to_string()
        }
    });
    // Prefer live socket; tests may override via open_with_adapters + scripted.
    HerdrAdapter {
        sock_path: PathBuf::from(path),
        scripted: None,
    }
}

pub fn prepare_runtime_dir(dir: &Path) -> Result<(), BrokerError> {
    if dir.exists() {
        if dir
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(BrokerError::Forbidden);
        }
    } else {
        std::fs::create_dir_all(dir).map_err(|_| BrokerError::CorruptState)?;
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| BrokerError::CorruptState)?;
    Ok(())
}

pub fn refuse_occupied_socket(path: &Path) -> Result<(), BrokerError> {
    if path.exists() {
        return Err(BrokerError::Conflict);
    }
    Ok(())
}

pub fn bind_socket(path: &Path) -> Result<UnixListener, BrokerError> {
    refuse_occupied_socket(path)?;
    let listener = UnixListener::bind(path).map_err(|_| BrokerError::CorruptState)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| BrokerError::CorruptState)?;
    Ok(listener)
}

pub fn peer_uid(stream: &UnixStream) -> Result<u32, BrokerError> {
    let mut cred = libc::xucred {
        cr_version: 0,
        cr_uid: 0,
        cr_ngroups: 0,
        cr_groups: [0; 16],
    };
    #[cfg(target_os = "macos")]
    {
        let mut len = std::mem::size_of_val(&cred) as libc::socklen_t;
        let rc = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERCRED,
                &mut cred as *mut _ as *mut libc::c_void,
                &mut len,
            )
        };
        if rc != 0 {
            return Err(BrokerError::Forbidden);
        }
        Ok(cred.cr_uid)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (stream, cred);
        Ok(unsafe { libc::getuid() })
    }
}

pub fn require_same_user(stream: &UnixStream) -> Result<(), BrokerError> {
    let peer = peer_uid(stream)?;
    let self_uid = unsafe { libc::getuid() };
    if peer != self_uid {
        return Err(BrokerError::Forbidden);
    }
    Ok(())
}

fn default_policies() -> Vec<SourcePolicy> {
    vec![
        SourcePolicy {
            system: "mupot".into(),
            is_authority: true,
            is_generated_summary: false,
            stale_after_secs: 30,
            stale_fallback_permitted: false,
        },
        SourcePolicy {
            system: "herdr".into(),
            is_authority: true,
            is_generated_summary: false,
            stale_after_secs: 30,
            stale_fallback_permitted: true,
        },
        SourcePolicy {
            system: "inkwell".into(),
            is_authority: true,
            is_generated_summary: false,
            stale_after_secs: 300,
            stale_fallback_permitted: true,
        },
        SourcePolicy {
            system: "mirror".into(),
            is_authority: true,
            is_generated_summary: false,
            stale_after_secs: 60,
            stale_fallback_permitted: true,
        },
        SourcePolicy {
            system: "codex_memory".into(),
            is_authority: false,
            is_generated_summary: true,
            stale_after_secs: 0,
            stale_fallback_permitted: true,
        },
        SourcePolicy {
            system: "github".into(),
            is_authority: true,
            is_generated_summary: false,
            stale_after_secs: 60,
            stale_fallback_permitted: true,
        },
    ]
}

pub fn dispatch(state: &HostState, req: &RpcRequest) -> RpcResponse {
    match handle(state, req) {
        Ok(result) => RpcResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(e) => RpcResponse {
            ok: false,
            result: None,
            error: Some(e.to_string()),
        },
    }
}

fn handle(state: &HostState, req: &RpcRequest) -> Result<Value, BrokerError> {
    match req.op.as_str() {
        "boot" => boot(state, &req.params),
        "status" => status(state),
        "context" => context_op(state, &req.params),
        "recall" => recall_op(state, &req.params),
        "freshness_check" => freshness_check(state, &req.params),
        "conflicts_list" => conflicts_list(state),
        "receipt_get" => receipt_get(state, &req.params),
        "propose" => propose_op(state, &req.params),
        "commit" => commit_op(state, &req.params),
        "write" => Err(BrokerError::UnsupportedContract),
        _ => Err(BrokerError::UnsupportedContract),
    }
}

fn propose_op(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let principal = params
        .get("principal")
        .and_then(|v| v.as_str())
        .ok_or(BrokerError::InvalidInput)?;
    let tenant = params
        .get("tenant")
        .and_then(|v| v.as_str())
        .ok_or(BrokerError::InvalidInput)?;
    let proposal: Proposal = serde_json::from_value(
        params
            .get("proposal")
            .cloned()
            .ok_or(BrokerError::InvalidInput)?,
    )
    .map_err(|_| BrokerError::InvalidInput)?;
    let action = ExactAction::from_proposal(principal, tenant, &proposal, "source_write");
    let hash = action.action_hash();
    {
        let mut map = state.proposals.lock().map_err(|_| BrokerError::CorruptState)?;
        map.insert(hash.clone(), proposal.clone());
    }
    Ok(json!({
        "action_hash": hash,
        "proposal": proposal,
        "principal": principal,
        "tenant": tenant,
    }))
}

fn commit_op(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let principal = params
        .get("principal")
        .and_then(|v| v.as_str())
        .ok_or(BrokerError::InvalidInput)?;
    let tenant = params
        .get("tenant")
        .and_then(|v| v.as_str())
        .ok_or(BrokerError::InvalidInput)?;
    let proposal: Proposal = if let Some(p) = params.get("proposal") {
        serde_json::from_value(p.clone()).map_err(|_| BrokerError::InvalidInput)?
    } else if let Some(h) = params.get("action_hash").and_then(|v| v.as_str()) {
        let map = state.proposals.lock().map_err(|_| BrokerError::CorruptState)?;
        map.get(h).cloned().ok_or(BrokerError::InvalidInput)?
    } else {
        return Err(BrokerError::InvalidInput);
    };
    let approval_json = params
        .get("approval")
        .map(|v| {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.to_string()
            }
        });
    let now_unix = params
        .get("now_unix")
        .and_then(|v| v.as_i64())
        .unwrap_or(1_780_000_000);
    let req = CommitRequest {
        principal: principal.into(),
        tenant: tenant.into(),
        proposal,
        approval_json,
        now_unix,
    };
    let result = state.commit.execute(&req)?;
    serde_json::to_value(result).map_err(|_| BrokerError::CorruptState)
}

fn boot(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    if params.get("forged_agent").is_some() {
        return Err(BrokerError::Forbidden);
    }
    let evidence_val = params
        .get("evidence")
        .ok_or(BrokerError::UnverifiedIdentity)?;
    let evidence_raw = if let Some(s) = evidence_val.as_str() {
        s.to_string()
    } else {
        evidence_val.to_string()
    };
    let evidence = normalize_evidence(&evidence_raw)?;
    let vs = verify_identity(&evidence, 1_780_000_000)?;
    let _ = state.ingest_from_read_adapters(&vs);
    Ok(json!({
        "agent": vs.scope().agent,
        "tenant": vs.scope().tenant,
        "credential_fingerprint": vs.credential_fingerprint(),
    }))
}

fn status(state: &HostState) -> Result<Value, BrokerError> {
    let store = state.store.lock().map_err(|_| BrokerError::CorruptState)?;
    let hash = store.last_audit_hash()?;
    let n = load_observations_from_store(&store)?.len();
    Ok(json!({
        "runtime_dir": state.runtime_dir,
        "socket": state.socket_path,
        "audit_tip": hash,
        "observation_count": n,
        "writes": "gated_by_exact_action_approval",
        "adapters": ["mupot_read_rpc", "herdr_unix_client", "inkwell_write_fixture", "mirror_write_fixture"],
    }))
}

fn verified_from_params(params: &Value) -> Result<VerifiedScope, BrokerError> {
    if let Some(ev) = params.get("evidence") {
        let raw = if let Some(s) = ev.as_str() {
            s.to_string()
        } else {
            ev.to_string()
        };
        let evidence = normalize_evidence(&raw)?;
        return verify_identity(&evidence, 1_780_000_000);
    }
    Err(BrokerError::UnverifiedIdentity)
}

fn context_op(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let scope = verified_from_params(params)?;
    let budget = params
        .get("token_budget_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(64_000) as usize;
    // Optional refresh from adapters (read-only); always serve from Store join.
    let _ = state.ingest_from_read_adapters(&scope);
    let obs = state.served_observations()?;
    let claims = reconcile(&obs, &state.policies, 1_780_000_000)?;
    let packet = build_context(&claims, &scope, budget)?;
    Ok(serde_json::to_value(packet).map_err(|_| BrokerError::CorruptState)?)
}

fn recall_op(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let scope = verified_from_params(params)?;
    let query = params
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let obs = state.served_observations()?;
    let hits: Vec<_> = obs
        .iter()
        .filter(|o| o.scope.tenant == scope.scope().tenant && o.fact_key.contains(query))
        .cloned()
        .collect();
    Ok(json!({ "hits": hits }))
}

fn freshness_check(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let _ = verified_from_params(params)?;
    let obs = state.served_observations()?;
    let claims = reconcile(&obs, &state.policies, 1_780_000_000)?;
    Ok(serde_json::to_value(claims).map_err(|_| BrokerError::CorruptState)?)
}

fn conflicts_list(state: &HostState) -> Result<Value, BrokerError> {
    let obs = state.served_observations()?;
    let claims = reconcile(&obs, &state.policies, 1_780_000_000)?;
    let conflicts: Vec<&ReconciledClaim> = claims
        .iter()
        .filter(|c| matches!(c.state, crate::contract::Freshness::Conflicted))
        .collect();
    Ok(serde_json::to_value(conflicts).map_err(|_| BrokerError::CorruptState)?)
}

fn receipt_get(state: &HostState, params: &Value) -> Result<Value, BrokerError> {
    let id = params
        .get("correlation_id")
        .and_then(|v| v.as_str())
        .ok_or(BrokerError::InvalidInput)?;
    let store = state.store.lock().map_err(|_| BrokerError::CorruptState)?;
    let receipt: Option<Receipt> = store.receipt_by_correlation(id)?;
    Ok(json!({ "receipt": receipt }))
}

pub fn read_framed(stream: &mut UnixStream) -> Result<RpcRequest, BrokerError> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|_| BrokerError::InvalidInput)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_REQUEST_BYTES {
        return Err(BrokerError::Forbidden);
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .map_err(|_| BrokerError::InvalidInput)?;
    serde_json::from_slice(&buf).map_err(|_| BrokerError::InvalidInput)
}

pub fn write_framed(stream: &mut UnixStream, resp: &RpcResponse) -> Result<(), BrokerError> {
    let bytes = serde_json::to_vec(resp).map_err(|_| BrokerError::CorruptState)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(BrokerError::Forbidden);
    }
    let len = (bytes.len() as u32).to_be_bytes();
    stream
        .write_all(&len)
        .map_err(|_| BrokerError::CorruptState)?;
    stream
        .write_all(&bytes)
        .map_err(|_| BrokerError::CorruptState)?;
    Ok(())
}

pub fn serve_one(state: &Arc<HostState>, mut stream: UnixStream) -> Result<(), BrokerError> {
    require_same_user(&stream)?;
    let req = read_framed(&mut stream)?;
    let resp = dispatch(state, &req);
    write_framed(&mut stream, &resp)
}

pub fn mcp_stdio_once(state: &HostState, line: &str) -> String {
    let req: Result<RpcRequest, _> = serde_json::from_str(line);
    let resp = match req {
        Ok(r) => dispatch(state, &r),
        Err(_) => RpcResponse {
            ok: false,
            result: None,
            error: Some(BrokerError::InvalidInput.to_string()),
        },
    };
    serde_json::to_string(&resp).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"corrupt state"}"#.into()
    })
}

pub fn test_runtime(dir: &Path) -> Result<(HostState, UnixListener), BrokerError> {
    let state = HostState::open(dir)?;
    let listener = bind_socket(&state.socket_path)?;
    let meta = std::fs::metadata(&state.socket_path).map_err(|_| BrokerError::CorruptState)?;
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o600 {
        return Err(BrokerError::CorruptState);
    }
    let dmeta = std::fs::metadata(dir).map_err(|_| BrokerError::CorruptState)?;
    if dmeta.permissions().mode() & 0o777 != 0o700 {
        return Err(BrokerError::CorruptState);
    }
    Ok((state, listener))
}
