mod support;

use mupot_hostd::rpc::{
    bind_socket, dispatch, mcp_stdio_once, read_framed, require_same_user, write_framed, HostState,
    RpcRequest, RpcResponse,
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
fn mcp_stdio_bridge_and_writes_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = HostState::open(dir.path()).unwrap();
    let line = r#"{"op":"status","params":{}}"#;
    let out = mcp_stdio_once(&state, line);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["ok"], true);

    let write = mcp_stdio_once(&state, r#"{"op":"commit","params":{}}"#);
    let w: serde_json::Value = serde_json::from_str(&write).unwrap();
    assert_eq!(w["ok"], false);
    assert!(w["error"].as_str().unwrap().contains("approval"));
}

#[test]
fn refuse_occupied_socket_without_unlink() {
    let dir = tempfile::tempdir().unwrap();
    let state = HostState::open(dir.path()).unwrap();
    let _listener = bind_socket(&state.socket_path).unwrap();
    assert!(bind_socket(&state.socket_path).is_err());
}
