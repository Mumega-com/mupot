//! Foreground mupot-hostd — read-only local broker. No launchd.

use mupot_hostd::rpc::{bind_socket, serve_one, HostState};
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    let runtime = std::env::var("MUPOT_HOSTD_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_runtime().unwrap_or_else(|| PathBuf::from("/tmp/mupot-hostd-should-not-use"))
        });
    // Prefer explicit runtime; refuse defaulting to shared /tmp in production paths.
    if runtime.starts_with("/tmp") && std::env::var("MUPOT_HOSTD_ALLOW_TMP").is_err() {
        eprintln!("set MUPOT_HOSTD_RUNTIME to a private directory (0700)");
        std::process::exit(2);
    }
    let state = match HostState::open(&runtime) {
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
    eprintln!("mupot-hostd listening on {}", state.socket_path.display());
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

fn dirs_runtime() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".mupot-hostd"))
}
