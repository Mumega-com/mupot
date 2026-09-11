//! Stdio MCP bridge — forwards validated ops to local host state.
//! Does not hold credentials or invent session identity.

use mupot_hostd::rpc::{mcp_stdio_once, HostState};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

fn main() {
    let runtime = std::env::var("MUPOT_HOSTD_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".mupot-hostd")
        });
    let state = match HostState::open(&runtime) {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(io::stderr(), "mcp bridge open failed: {e}");
            std::process::exit(1);
        }
    };
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let out = mcp_stdio_once(&state, &line);
        println!("{out}");
        let _ = io::stdout().flush();
    }
}
