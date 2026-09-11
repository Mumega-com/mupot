use mupot_hostd::contract::BrokerError;
use mupot_hostd::identity::verify_fixture;
use mupot_hostd::secrets::{MemorySecretProvider, SecretHandle, SecretProvider};
use mupot_hostd::adapters::herdr::HerdrAdapter;
use mupot_hostd::adapters::mupot::MupotAdapter;
use mupot_hostd::policy::herdr_method_allowed;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::thread;

#[test]
fn live_seat_cannot_override_bearer_mismatch() {
    let input = include_str!("fixtures/identity.json");
    let result = verify_fixture(input, 1000);
    assert!(matches!(result, Err(BrokerError::Conflict)));
}

#[test]
fn matching_bearer_passes() {
    let input = r#"{
      "bearer_agent_id":"7089044c-5e48-4d5f-b5b0-6937433c4e79",
      "requested_principal":"7089044c-5e48-4d5f-b5b0-6937433c4e79",
      "tenant":"mumega",
      "credential_fingerprint":"fp",
      "mupot_available":true
    }"#;
    assert!(verify_fixture(input, 1000).is_ok());
}

#[test]
fn secret_debug_redacts_bytes() {
    let h = SecretHandle::from_bytes("svc", "acct", b"fixture-credential".to_vec());
    let rendered = format!("{h:?}");
    assert!(!rendered.contains("fixture-credential"));
    assert!(rendered.contains("<redacted>"));
}

#[test]
fn revoked_credential_refused() {
    let input = r#"{
      "bearer_agent_id":"a","requested_principal":"a","tenant":"t","revoked":true
    }"#;
    assert!(matches!(
        verify_fixture(input, 1),
        Err(BrokerError::Revoked)
    ));
}

#[test]
fn mupot_adapter_read_rpcs_only() {
    let mut scripted = BTreeMap::new();
    scripted.insert(
        "boot_context".into(),
        json!({"ok":true,"result":{"bound_agent_id":"7089044c-5e48-4d5f-b5b0-6937433c4e79"}}),
    );
    let adapter = MupotAdapter { scripted };
    assert!(adapter.call_rpc("boot_context").is_ok());
    assert!(adapter.call_rpc("inbox_ack").is_err());
    assert!(adapter.call_rpc("connect").is_err());
}

#[test]
fn herdr_adapter_uses_session_snapshot_not_snapshot() {
    assert!(herdr_method_allowed("session.snapshot").is_ok());
    assert!(herdr_method_allowed("snapshot").is_err());
    assert!(herdr_method_allowed("agent.prompt").is_err());
    assert!(herdr_method_allowed("server.stop").is_err());

    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("herdr.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let sock2 = sock.clone();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("session.snapshot"));
        assert!(!line.contains("\"method\":\"snapshot\""));
        let resp = json!({"id":"hostd-1","result":{"type":"session_snapshot","snapshot":{"protocol":22}}});
        stream.write_all(format!("{resp}\n").as_bytes()).unwrap();
        let _ = sock2;
    });
    let adapter = HerdrAdapter::connect_path(&sock);
    let _ = adapter.session_snapshot().unwrap();
}

#[test]
fn memory_secret_provider_lookup() {
    let p = MemorySecretProvider {
        entries: vec![("s".into(), "a".into(), b"x".to_vec())],
    };
    assert!(p.lookup("s", "a").is_ok());
    assert!(p.lookup("s", "missing").is_err());
}

#[test]
fn unavailable_mupot_fails_closed() {
    let input = r#"{
      "bearer_agent_id":"a","requested_principal":"a","tenant":"t","mupot_available":false
    }"#;
    assert!(matches!(
        verify_fixture(input, 1),
        Err(BrokerError::SourceUnavailable)
    ));
}

#[allow(dead_code)]
fn _keep_arc() {
    let _ = Arc::new(1);
}
