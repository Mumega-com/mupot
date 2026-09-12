mod support;

use mupot_hostd::rpc::{
    HostState, RpcRequest, RpcResponse, bind_socket, dispatch, mcp_stdio_once, read_framed,
    require_same_user, write_framed,
};
use serde_json::json;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::thread;

#[test]
fn local_transport_is_not_an_authority_grant() {
    support::run_case("rpc", "same_user_forged_scope_denied");
    support::run_case("rpc", "different_user_denied");
    support::run_case("rpc", "oversized_request_denied");
}

#[test]
fn socket_permissions_and_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(HostState::open(dir.path()).unwrap());
    let listener = bind_socket(&state.socket_path).unwrap();
    let path = state.socket_path.clone();
    let st = Arc::clone(&state);
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        require_same_user(&stream).unwrap();
        let mut stream = stream;
        let req = read_framed(&mut stream).unwrap();
        let resp = dispatch(&st, &req);
        write_framed(&mut stream, &resp).unwrap();
    });
    let mut client = UnixStream::connect(&path).unwrap();
    let req = RpcRequest {
        op: "status".into(),
        params: json!({}),
    };
    let bytes = serde_json::to_vec(&req).unwrap();
    let len = (bytes.len() as u32).to_be_bytes();
    use std::io::Write;
    client.write_all(&len).unwrap();
    client.write_all(&bytes).unwrap();
    let mut client = client;
    // read response
    use std::io::Read;
    let mut len_buf = [0u8; 4];
    client.read_exact(&mut len_buf).unwrap();
    let n = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; n];
    client.read_exact(&mut buf).unwrap();
    let resp: RpcResponse = serde_json::from_slice(&buf).unwrap();
    assert!(resp.ok);
    assert!(path.ends_with("hostd.sock"));
}

#[test]
fn mcp_stdio_bridge_and_writes_gated() {
    let dir = tempfile::tempdir().unwrap();
    let state = HostState::open(dir.path()).unwrap();
    let line = r#"{"op":"status","params":{}}"#;
    let out = mcp_stdio_once(&state, line);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["ok"], true);
    assert!(v["result"]["writes"].as_str().unwrap().contains("approval"));

    // Bare write remains unsupported.
    let write = mcp_stdio_once(&state, r#"{"op":"write","params":{}}"#);
    let w: serde_json::Value = serde_json::from_str(&write).unwrap();
    assert_eq!(w["ok"], false);
    assert!(w["error"].as_str().unwrap().contains("unsupported"));

    // Commit without approval → ApprovalRequired (not UnsupportedContract).
    let commit = mcp_stdio_once(
        &state,
        r#"{"op":"commit","params":{"principal":"hadi","tenant":"mumega","proposal":{"target":{"system":"inkwell","id":"x","revision":"1"},"expected_revision":"1","payload_hash":"p","classification":"private","expires_at":"2099-01-01T00:00:00Z"}}}"#,
    );
    let c: serde_json::Value = serde_json::from_str(&commit).unwrap();
    assert_eq!(c["ok"], false);
    assert!(
        c["error"].as_str().unwrap().contains("approval"),
        "expected ApprovalRequired, got {:?}",
        c["error"]
    );

    // Propose with empty params → InvalidInput.
    let propose = mcp_stdio_once(&state, r#"{"op":"propose","params":{}}"#);
    let p: serde_json::Value = serde_json::from_str(&propose).unwrap();
    assert_eq!(p["ok"], false);
    assert!(p["error"].as_str().unwrap().contains("invalid"));
}

#[test]
fn boot_rejects_self_asserted_bearer_that_disagrees_with_mupot() {
    let dir = tempfile::tempdir().unwrap();
    let state = HostState::open(dir.path()).unwrap();
    let claimed = "e9597210-edc5-4de5-80cd-b9cbea8ff422";
    let resp = dispatch(
        &state,
        &RpcRequest {
            op: "boot".into(),
            params: json!({
                "evidence": {
                    "bearer_agent_id": claimed,
                    "requested_principal": claimed,
                    "tenant": "mumega",
                    "credential_fingerprint": "self-asserted"
                }
            }),
        },
    );
    assert!(!resp.ok, "self-asserted bearer must not grant identity");
    assert_eq!(resp.error.as_deref(), Some("conflict"));
}

#[test]
fn refuse_occupied_socket_without_unlink() {
    let dir = tempfile::tempdir().unwrap();
    let state = HostState::open(dir.path()).unwrap();
    let _listener = bind_socket(&state.socket_path).unwrap();
    assert!(bind_socket(&state.socket_path).is_err());
}

/// Kill-witness for GATE-F2 `served-context-unwired`.
/// Goes RED if Store→load→labelled `context` join is cut (empty in-memory only).
#[test]
fn kill_witness_served_context_requires_store_load() {
    use mupot_hostd::context::build_context;
    use mupot_hostd::contract::{Classification, Observation, Scope};
    use mupot_hostd::freshness::reconcile;
    use mupot_hostd::policy::FENCED_LIVE_SEAT_UUIDS;
    use mupot_hostd::rpc::load_observations_from_store;
    use mupot_hostd::store::Store;

    assert!(
        FENCED_LIVE_SEAT_UUIDS.contains(&"870a5024-afd2-407e-86b3-fe2596e89bd1"),
        "Hermes 870a5024 must remain fenced"
    );

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("host.sqlite");
    let obs = Observation {
        fact_key: "mupot.bound_agent".into(),
        value: Some(json!("7089044c-5e48-4d5f-b5b0-6937433c4e79")),
        value_hash: Some("h1".into()),
        source_system: "mupot".into(),
        source_uri: Some("rpc:boot_context".into()),
        source_id: Some("7089044c-5e48-4d5f-b5b0-6937433c4e79".into()),
        source_revision: Some("boot".into()),
        subject_type: "agent".into(),
        subject_id: "7089044c-5e48-4d5f-b5b0-6937433c4e79".into(),
        scope: Scope {
            tenant: "mumega".into(),
            project: None,
            squad: None,
            agent: Some("7089044c-5e48-4d5f-b5b0-6937433c4e79".into()),
            seat: None,
            flight: None,
            run: None,
            content_tiers: vec![],
            entity: None,
        },
        observed_at: "2026-09-11T12:00:00Z".into(),
        valid_from: None,
        valid_until: None,
        supersedes: None,
        confidence: None,
        writer_principal: None,
        receipt_ref: Some("boot".into()),
        classification: Classification::Squad,
        freshness: Some(mupot_hostd::contract::Freshness::Fresh),
    };

    {
        let mut store = Store::open(&db).unwrap();
        store.record_observation(&obs).unwrap();
        assert_eq!(store.list_observations().unwrap().len(), 1);
    }

    // Cut join (empty vec) → empty packet — documents the unwired failure mode.
    let cut: Vec<Observation> = vec![];
    let policies = vec![mupot_hostd::freshness::SourcePolicy {
        system: "mupot".into(),
        is_authority: true,
        is_generated_summary: false,
        stale_after_secs: 30,
        stale_fallback_permitted: false,
    }];
    let scope = mupot_hostd::contract::VerifiedScope::from_parts(
        obs.scope.clone(),
        "fp".into(),
        1_780_000_000,
    );
    let cut_claims = reconcile(&cut, &policies, 1_780_000_000).unwrap();
    let cut_packet = build_context(&cut_claims, &scope, 64_000).unwrap();
    assert!(
        cut_packet.current_facts.is_empty() && cut_packet.historical_hints.is_empty(),
        "cut load must yield empty context (witness of the AMEND defect)"
    );

    // Production join after restart: load from Store, serve labelled context on dispatch.
    let state = HostState::open(dir.path()).unwrap();
    let loaded = {
        let store = state.store.lock().unwrap();
        load_observations_from_store(&store).unwrap()
    };
    assert_eq!(
        loaded.len(),
        1,
        "HostState::open must load observations from Store"
    );
    assert_eq!(loaded[0].source_system, "mupot");

    let evidence = json!({
        "bearer_agent_id": "7089044c-5e48-4d5f-b5b0-6937433c4e79",
        "requested_principal": "7089044c-5e48-4d5f-b5b0-6937433c4e79",
        "tenant": "mumega",
        "credential_fingerprint": "fp",
        "mupot_available": true
    });
    let resp = dispatch(
        &state,
        &RpcRequest {
            op: "context".into(),
            params: json!({ "evidence": evidence, "token_budget_bytes": 64000 }),
        },
    );
    assert!(resp.ok, "context failed: {:?}", resp.error);
    let result = resp.result.unwrap();
    let current = result["current_facts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let hints = result["historical_hints"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let conflicts = result["conflicts"].as_array().cloned().unwrap_or_default();
    assert!(
        !current.is_empty() || !hints.is_empty() || !conflicts.is_empty(),
        "served context must be non-empty after persist→load join; got {result}"
    );
    let labelled = current
        .iter()
        .chain(hints.iter())
        .chain(conflicts.iter())
        .any(|f| {
            matches!(
                f.get("source_system").and_then(|s| s.as_str()),
                Some("mupot" | "herdr" | "mirror" | "inkwell" | "github")
            )
        });
    assert!(
        labelled,
        "packet must carry source_system label; got {result}"
    );
}
