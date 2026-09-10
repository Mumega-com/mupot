use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryStatus {
    Available,
    Unavailable,
    Failed,
    TimedOut,
    InvalidOutput,
}
#[derive(Debug, Clone)]
pub struct LocalRuntime {
    pub name: String,
    pub kind: String,
    pub state: String,
}
#[derive(Debug, Clone)]
pub struct InstalledApp {
    pub name: String,
    pub path: PathBuf,
}
#[derive(Debug, Clone)]
pub struct DiscoverySnapshot {
    pub runtimes: Vec<LocalRuntime>,
    pub apps: Vec<InstalledApp>,
    pub herdr_status: DiscoveryStatus,
}
pub fn discover_local() -> DiscoverySnapshot {
    let mut snapshot = DiscoverySnapshot {
        runtimes: vec![],
        apps: vec![],
        herdr_status: DiscoveryStatus::Unavailable,
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = &home {
        roots.push(home.join("Applications"));
    }
    snapshot.apps = installed_apps(&roots);
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|p| p.is_absolute())
                .map(|p| p.join("herdr"))
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/herdr"));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/herdr"),
        PathBuf::from("/usr/local/bin/herdr"),
    ]);
    let executable = candidates.into_iter().find_map(|p| {
        let canonical = p.canonicalize().ok()?;
        let meta = canonical.metadata().ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        Some(canonical)
    });
    if let Some(executable) = executable {
        match run_bounded(&executable, &["agent", "list"], Duration::from_secs(3)) {
            Ok(bytes) => match parse_runtimes(&bytes) {
                Ok(runtimes) => {
                    snapshot.runtimes = runtimes;
                    snapshot.herdr_status = DiscoveryStatus::Available
                }
                Err(_) => snapshot.herdr_status = DiscoveryStatus::InvalidOutput,
            },
            Err(status) => snapshot.herdr_status = status,
        }
    }
    snapshot
}
pub(crate) fn installed_apps(roots: &[PathBuf]) -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    for (name, bundle) in [
        ("Codex", "Codex.app"),
        ("Claude", "Claude.app"),
        ("Cursor", "Cursor.app"),
        ("Termius", "Termius.app"),
        ("Herdr", "Herdr.app"),
        ("ChatGPT", "ChatGPT.app"),
        ("Antigravity", "Antigravity.app"),
        ("Grok Bot", "Grok Bot.app"),
    ] {
        for root in roots {
            let path = root.join(bundle);
            if path.is_dir() {
                apps.push(InstalledApp {
                    name: name.into(),
                    path,
                });
                break;
            }
        }
    }
    apps
}
pub(crate) fn parse_runtimes(data: &[u8]) -> crate::Result<Vec<LocalRuntime>> {
    let value: serde_json::Value =
        serde_json::from_slice(data).map_err(|_| crate::Error::InvalidResponse)?;
    let rows = value["result"]["agents"]
        .as_array()
        .ok_or(crate::Error::InvalidResponse)?;
    if value["result"]["type"] != "agent_list" || rows.len() > 512 {
        return Err(crate::Error::InvalidResponse);
    }
    rows.iter()
        .map(|row| {
            let field = |key: &str| {
                row.get(key)
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
                    .map(str::to_owned)
                    .ok_or(crate::Error::InvalidResponse)
            };
            Ok(LocalRuntime {
                name: field("name")?,
                kind: field("agent")?,
                state: field("agent_status")?,
            })
        })
        .collect()
}
pub(crate) fn run_bounded(
    path: &Path,
    args: &[&str],
    timeout: Duration,
) -> std::result::Result<Vec<u8>, DiscoveryStatus> {
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let mut child = Command::new(path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    DiscoveryStatus::Unavailable
                } else {
                    DiscoveryStatus::Failed
                }
            })?;
        let result = (|| {
            let mut stdout = child.stdout.take().ok_or(DiscoveryStatus::Failed)?;
            // SAFETY: stdout fd is open and owned until this closure returns.
            if unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
                return Err(DiscoveryStatus::Failed);
            }
            let deadline = Instant::now() + timeout;
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                loop {
                    match stdout.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            bytes.extend_from_slice(&buffer[..n]);
                            if bytes.len() > 262144 {
                                return Err(DiscoveryStatus::InvalidOutput);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => return Err(DiscoveryStatus::Failed),
                    }
                }
                if let Some(status) = child.try_wait().map_err(|_| DiscoveryStatus::Failed)? {
                    // Drain data written just before exit; still bound the total.
                    loop {
                        match stdout.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(n) => {
                                bytes.extend_from_slice(&buffer[..n]);
                                if bytes.len() > 262144 {
                                    return Err(DiscoveryStatus::InvalidOutput);
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                            Err(_) => return Err(DiscoveryStatus::Failed),
                        }
                    }
                    return if status.success() {
                        Ok(bytes)
                    } else {
                        Err(DiscoveryStatus::Failed)
                    };
                }
                if Instant::now() >= deadline {
                    return Err(DiscoveryStatus::TimedOut);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })();
        if result.is_err() {
            // SAFETY: negative child PID targets only the process group created above.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.kill();
            let _ = child.wait();
        }
        result
    }
    #[cfg(not(unix))]
    {
        let _ = (path, args, timeout);
        Err(DiscoveryStatus::Unavailable)
    }
}
