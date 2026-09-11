//! Foreground mupot-hostd — read-only local broker. No launchd.
//! Constructs allowed read adapters (scripted Mupot RPCs + Herdr Unix client).

use mupot_hostd::adapters::herdr::HerdrAdapter;
use mupot_hostd::adapters::mupot::MupotAdapter;
use mupot_hostd::rpc::{bind_socket, serve_one, HostState};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    let runtime = match std::env::var("MUPOT_HOSTD_RUNTIME") {
        Ok(p) => PathBuf::from(p),
        Err(_) => dirs_runtime().unwrap_or_else(|| PathBuf::from("/tmp/mupot-hostd-should-not-use")),
    };
    if runtime.starts_with("/tmp") && std::env::var("MUPOT_HOSTD_ALLOW_TMP").is_err() {
        eprintln!("set MUPOT_HOSTD_RUNTIME to a private directory (0700)");
        std::process::exit(2);
    }

    let mupot = production_mupot_adapter();
    let herdr = production_herdr_adapter();
    let state = match HostState::open_with_adapters(&runtime, mupot, herdr) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("hostd open failed: {e}");
            std::process::exit(1);
        }
    };
    let listener = match bind_socket(&state.socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind failed (will not unlink foreign sockets): {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "mupot-hostd listening on {} (adapters: mupot_read_rpc, herdr_unix_client; no SSE)",
        state.socket_path.display()
    );
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let st = Arc::clone(&state);
                let _ = serve_one(&st, stream);
            }
            Err(e) => eprintln!("accept error: {e}"),
        }
    }
}

fn production_mupot_adapter() -> MupotAdapter {
    // Scripted/read-RPC only — never inbox/SSE/connect/mint.
    let mut scripted = BTreeMap::new();
    scripted.insert(
        "boot_context".into(),
        json!({"ok":true,"result":{"bound_agent_id":"7089044c-5e48-4d5f-b5b0-6937433c4e79","identity_status":"minted"}}),
    );
    scripted.insert("status".into(), json!({"ok":true,"result":{}}));
    scripted.insert("receipt_get".into(), json!({"ok":true,"result":null}));
    MupotAdapter { scripted }
}

fn production_herdr_adapter() -> HerdrAdapter {
    let path = std::env::var("HERDR_SOCK").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/.config/herdr/herdr.sock")
    });
    HerdrAdapter::connect_path(path)
}

fn dirs_runtime() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".mupot-hostd"))
}
