use mupot_hostd::adapters::herdr::HerdrAdapter;
use mupot_hostd::adapters::mupot::MupotAdapter;
use mupot_hostd::contract::BrokerError;
use mupot_hostd::identity::verify_fixture;
use mupot_hostd::policy::herdr_method_allowed;
use mupot_hostd::secrets::{MemorySecretProvider, SecretHandle, SecretProvider};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::sync::mpsc;
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
    let adapter = MupotAdapter::scripted(scripted);
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
        let resp =
            json!({"id":"hostd-1","result":{"type":"session_snapshot","snapshot":{"protocol":22}}});
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

#[test]
fn live_mupot_boot_is_bearer_bound_and_rejects_requested_rava_mismatch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            request.push_str(&line);
        }
        tx.send(request).unwrap();
        let body = r#"{"ok":true,"result":{"bound_agent_id":"76f81c84-0000-0000-0000-000000000000","identity_status":"minted"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });

    let token = SecretHandle::from_bytes("mupot", "test", b"sentinel-token".to_vec());
    let adapter = MupotAdapter::http(
        format!("http://{addr}"),
        token,
        Some("e9597210-edc5-4de5-80cd-b9cbea8ff422".into()),
    )
    .unwrap();
    assert_eq!(adapter.call_rpc("boot_context"), Err(BrokerError::Conflict));

    let request = rx.recv().unwrap();
    assert!(request.starts_with("POST /actions/boot_context HTTP/1.1"));
    let lower = request.to_ascii_lowercase();
    assert!(lower.contains("user-agent: mupot-hostd/0.1"));
    assert!(lower.contains("authorization: bearer sentinel-token"));
}

#[allow(dead_code)]
fn _keep_arc() {
    let _ = Arc::new(1);
}
