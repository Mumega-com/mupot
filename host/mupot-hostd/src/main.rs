//! Foreground mupot-hostd — read-only local broker. No launchd.
//! Constructs allowed read adapters (scripted Mupot RPCs + Herdr Unix client).

use mupot_hostd::adapters::herdr::HerdrAdapter;
use mupot_hostd::adapters::mupot::MupotAdapter;
use mupot_hostd::contract::BrokerError;
use mupot_hostd::rpc::{HostState, bind_socket, serve_one};
use mupot_hostd::secrets::SecretHandle;
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    let runtime = match std::env::var("MUPOT_HOSTD_RUNTIME") {
        Ok(p) => PathBuf::from(p),
        Err(_) => {
            dirs_runtime().unwrap_or_else(|| PathBuf::from("/tmp/mupot-hostd-should-not-use"))
        }
    };
    if runtime.starts_with("/tmp") && std::env::var("MUPOT_HOSTD_ALLOW_TMP").is_err() {
        eprintln!("set MUPOT_HOSTD_RUNTIME to a private directory (0700)");
        std::process::exit(2);
    }

    let mupot = match production_mupot_adapter() {
        Ok(adapter) => adapter,
        Err(e) => {
            eprintln!("mupot adapter configuration failed: {e}");
            std::process::exit(1);
        }
    };
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

fn production_mupot_adapter() -> Result<MupotAdapter, BrokerError> {
    let home = std::env::var("HOME").map_err(|_| BrokerError::UnverifiedIdentity)?;
    let token_path = std::env::var("MUPOT_HOSTD_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home).join(".fleet/agents/hadi-codex.token"));
    let token = SecretHandle::from_private_file("mupot", "hostd", &token_path)?;
    let base_url =
        std::env::var("MUPOT_HOSTD_URL").unwrap_or_else(|_| "https://mupot.mumega.com".into());
    let expected_agent_id = std::env::var("MUPOT_HOSTD_EXPECTED_AGENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty());
    MupotAdapter::http(base_url, token, expected_agent_id)
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
