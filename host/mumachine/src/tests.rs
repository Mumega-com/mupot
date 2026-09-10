use crate::*;

#[test]
fn origin_accepts_only_unambiguous_https_origin() {
    assert_eq!(
        PotOrigin::parse("https://pot.example/").unwrap().as_str(),
        "https://pot.example"
    );
    for input in [
        "http://pot.example",
        "https://user:pass@pot.example",
        "https://pot.example/path",
        "https://pot.example?token=x",
        "https://pot.example#x",
        "https://pot.example/a/..",
        " https://pot.example",
        "https://pot.example\\",
        "https://pot.example/%2f",
    ] {
        assert!(
            PotOrigin::parse(input).is_err(),
            "accepted ambiguous origin: {input}"
        );
    }
}

#[test]
fn secret_debug_never_reveals_credential() {
    let secret = Secret::new("fixture-credential-not-live");
    assert!(!format!("{secret:?}").contains("fixture-credential"));
}

use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

fn fixture(responses: Vec<(u16, String)>) -> (MupotClient, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = PotOrigin::fixture(listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let fixture_origin = origin.as_str().to_owned();
    thread::spawn(move || {
        for (status, body) in responses {
            let body = body.replace("{{origin}}", &fixture_origin);
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                    Err(_) => return,
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..n]);
                if let Some(pos) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..pos]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|n| n.trim().parse().unwrap())
                        .unwrap_or(0);
                    if data.len() >= pos + 4 + length {
                        break;
                    }
                }
            }
            recorded
                .lock()
                .unwrap()
                .push(String::from_utf8(data).unwrap());
            let extra = if status == 302 {
                "Location: https://elsewhere.example/steal\r\n"
            } else {
                ""
            };
            let length = if status == 299 {
                String::new()
            } else {
                format!("Content-Length: {}\r\n", body.len())
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\n{length}{extra}Connection: close\r\n\r\n{body}"
            );
        }
    });
    (MupotClient::new(origin).unwrap(), requests)
}
fn ok(value: Value) -> (u16, String) {
    (200, value.to_string())
}
fn boot_data() -> Value {
    json!({"ok":true,"tool":"boot_context","result":{"tenant":"fixture","channel":"directory","identity_status":"minted","bound_agent_id":"agent-001"}})
}
fn orient_data() -> Value {
    json!({"ok":true,"tool":"orient","result":{"packet":{"agent":{"id":"agent-001","slug":"sample-agent","name":"Sample Agent","role":"analyst","status":"active"},"squad":{"id":"squad-001","name":"Sample Squad"},"squadmates":[{"agent_id":"agent-002","slug":"sample-peer","name":"Sample Peer","role":"reviewer","capability":"member"}]},"brief":"Fixture boot brief."}})
}
fn token_data() -> Value {
    json!({"access_token":"fixture-credential-not-live","token_type":"Bearer","expires_in":3600,"agent_id":"agent-001","agent_slug":"sample-agent"})
}
fn challenge() -> DeviceChallenge {
    DeviceChallenge {
        user_code: "ABCD-EFGH".into(),
        verification_uri: "https://pot.example/device".into(),
        expires_in: Duration::from_secs(15),
        interval: Duration::from_secs(5),
        device_code: Secret::new("fixture-device-code"),
        deadline: Instant::now() + Duration::from_secs(15),
    }
}

#[test]
fn client_requests_real_action_paths_and_auth_headers() {
    let (client, requests) = fixture(vec![ok(boot_data()), ok(orient_data())]);
    let snapshot = client
        .boot(
            &Secret::new("fixture-credential-not-live"),
            "sample-agent",
            "fixture",
        )
        .unwrap();
    assert_eq!(snapshot.agent.id, "agent-001");
    assert_eq!(snapshot.channel, "directory");
    assert_eq!(snapshot.roster[0].agent_id, "agent-002");
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("POST /actions/boot_context HTTP/1.1"));
    assert!(requests[1].starts_with("POST /actions/orient HTTP/1.1"));
    assert!(requests.iter().all(|r| {
        r.to_lowercase()
            .contains("authorization: bearer fixture-credential-not-live")
    }));
    assert!(requests[1].ends_with("{}"));
}
#[test]
fn client_refuses_mismatched_identity_and_unminted_before_orient() {
    for (field, value) in [
        ("tenant", "other"),
        ("bound_agent_id", "different"),
        ("identity_status", "unminted"),
    ] {
        let mut boot = boot_data();
        boot["result"][field] = json!(value);
        let (client, requests) = fixture(vec![ok(boot), ok(orient_data())]);
        assert_eq!(
            client
                .boot(&Secret::new("fixture-token"), "agent-001", "fixture")
                .unwrap_err(),
            Error::IdentityMismatch
        );
        assert_eq!(
            requests.lock().unwrap().len(),
            if field == "bound_agent_id" { 2 } else { 1 }
        );
    }
    let mut orient = orient_data();
    orient["result"]["packet"]["agent"]["slug"] = json!("wrong-slug");
    let (client, _) = fixture(vec![ok(boot_data()), ok(orient)]);
    assert_eq!(
        client
            .boot(&Secret::new("fixture-token"), "sample-agent", "fixture")
            .unwrap_err(),
        Error::IdentityMismatch
    );
}
#[test]
fn device_token_requires_bearer_expiry_and_redeemed_identity() {
    for (field, value) in [
        ("token_type", json!("Basic")),
        ("expires_in", json!(0)),
        ("agent_slug", json!("other-agent")),
    ] {
        let mut token = token_data();
        token[field] = value;
        let (client, requests) = fixture(vec![ok(token)]);
        assert!(
            client
                .poll_device(
                    &Secret::new("fixture-device-code"),
                    "sample-agent",
                    "fixture"
                )
                .is_err()
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(requests.lock().unwrap()[0].starts_with("POST /device/token HTTP/1.1"));
    }
    let (client, _) = fixture(vec![ok(token_data()), ok(boot_data()), ok(orient_data())]);
    assert!(matches!(
        client
            .poll_device(
                &Secret::new("fixture-device-code"),
                "sample-agent",
                "fixture"
            )
            .unwrap(),
        DevicePoll::Verified(_)
    ));
}
#[test]
fn device_denial_pending_slowdown_and_expiry_are_typed() {
    for (status, variant) in [
        ("authorization_pending", 0),
        ("slow_down", 1),
        ("access_denied", 2),
        ("expired_token", 3),
    ] {
        let (client, _) = fixture(vec![(
            400,
            json!({"error":status,"interval":5}).to_string(),
        )]);
        let outcome = client
            .poll_device(
                &Secret::new("fixture-device-code"),
                "sample-agent",
                "fixture",
            )
            .unwrap();
        assert!(matches!(
            (outcome, variant),
            (DevicePoll::Pending(_), 0)
                | (DevicePoll::SlowDown(_), 1)
                | (DevicePoll::Denied, 2)
                | (DevicePoll::Expired, 3)
        ));
    }
}
#[test]
fn health_refuses_redirect_malformed_oversize_and_server_error_without_echo() {
    for (status, body, error) in [
        (302, "{}".into(), Error::Refused),
        (200, "not-json-secret".into(), Error::InvalidResponse),
        (200, "x".repeat(1_048_577), Error::ResponseTooLarge),
        (500, "fixture-secret-error".into(), Error::Refused),
    ] {
        let (client, _) = fixture(vec![(status, body)]);
        assert_eq!(client.health().unwrap_err(), error);
    }
    let (client, requests) = fixture(vec![ok(
        json!({"ok":true,"service":"mupot","tenant":"fixture","version":"0.1","clean":false,"commit":null}),
    )]);
    assert_eq!(client.health().unwrap().tenant, "fixture");
    assert!(!requests.lock().unwrap()[0].contains("Authorization"));
}
#[test]
fn device_begin_refuses_cross_origin_browser_uri() {
    let (client, requests) = fixture(vec![ok(
        json!({"device_code":"fixture-device","user_code":"ABCD-EFGH","verification_uri":"https://evil.example/device","expires_in":600,"interval":5}),
    )]);
    assert_eq!(
        client.start_device("sample-agent").unwrap_err(),
        Error::InvalidResponse
    );
    assert!(requests.lock().unwrap()[0].starts_with("POST /device/code HTTP/1.1"));
    assert!(requests.lock().unwrap()[0].ends_with("{\"agent\":\"sample-agent\"}"));
}
#[test]
fn polling_respects_interval_single_inflight_cancel_and_local_expiry() {
    let now = Instant::now();
    let mut flow = DeviceFlow::default();
    let op = flow.begin();
    flow.accept_challenge(op, challenge(), now).unwrap();
    assert!(flow.poll_request(now).unwrap().is_none());
    let request = flow
        .poll_request(now + Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert_eq!(request.operation, op);
    assert!(
        flow.poll_request(now + Duration::from_secs(6))
            .unwrap()
            .is_none()
    );
    flow.complete_poll(
        op,
        DevicePoll::Pending(Duration::from_secs(5)),
        now + Duration::from_secs(6),
    )
    .unwrap();
    assert!(
        flow.poll_request(now + Duration::from_secs(10))
            .unwrap()
            .is_none()
    );
    assert!(
        flow.poll_request(now + Duration::from_secs(11))
            .unwrap()
            .is_some()
    );
    flow.cancel();
    assert_eq!(
        flow.complete_poll(op, DevicePoll::Denied, now).unwrap_err(),
        Error::StaleOperation
    );
    assert!(flow.challenge().is_none());
    let op = flow.begin();
    flow.accept_challenge(op, challenge(), now).unwrap();
    assert_eq!(
        flow.poll_request(now + Duration::from_secs(15))
            .unwrap_err(),
        Error::Expired
    );
}

#[derive(Default)]
struct TestVault(Mutex<std::collections::HashMap<String, Secret>>);
impl CredentialVault for TestVault {
    fn store(&self, key: &str, value: &Secret) -> Result<()> {
        self.0.lock().unwrap().insert(key.into(), value.clone());
        Ok(())
    }
    fn retrieve(&self, key: &str) -> Result<Option<Secret>> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn remove(&self, key: &str) -> Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
fn connection() -> VerifiedConnection {
    VerifiedConnection {
        token: Secret::new("fixture-stored-secret"),
        origin: PotOrigin::parse("https://pot.example").unwrap(),
        snapshot: BootSnapshot {
            agent: Agent {
                id: "agent-001".into(),
                slug: "sample-agent".into(),
                name: "Sample Agent".into(),
                role: "analyst".into(),
                status: "active".into(),
            },
            squad: Squad {
                id: "squad-001".into(),
                name: "Sample Squad".into(),
            },
            tenant: "fixture".into(),
            channel: "directory".into(),
            brief: "Fixture brief".into(),
            roster: vec![],
            verification: Verification::BoundIdentityVerified,
        },
        expires_at: Instant::now() + Duration::from_secs(3600),
        expires_unix: crate::client::unix_now().unwrap() + 3600,
    }
}
#[test]
fn profile_is_private_secret_free_and_forget_removes_only_app_account() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let repository = ProfileRepository::open(path.clone()).unwrap();
    let vault = TestVault::default();
    vault
        .store("unrelated-item", &Secret::new("unrelated-secret"))
        .unwrap();
    let profile = repository.save(&connection(), &vault).unwrap();
    assert_eq!(repository.list().unwrap(), vec![profile.clone()]);
    assert_eq!(
        repository.load(&profile, &vault).unwrap().expose(),
        "fixture-stored-secret"
    );
    let bytes = std::fs::read_to_string(path.join("profiles.json")).unwrap();
    assert!(
        !bytes.contains("secret")
            && !bytes.contains("device_code")
            && !bytes.contains("access_token")
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(path.join("profiles.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    repository.forget(&profile, &vault).unwrap();
    assert!(repository.list().unwrap().is_empty());
    assert!(vault.retrieve(&profile.account()).unwrap().is_none());
    assert!(vault.retrieve("unrelated-item").unwrap().is_some());
}
#[test]
fn profile_refuses_symlinks_public_permissions_and_write_failures() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    symlink(dir.path(), &path).unwrap();
    assert!(ProfileRepository::open(path.clone()).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ProfileRepository::open(path.clone()).is_err());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let repo = ProfileRepository::open(path.clone()).unwrap();
    let vault = TestVault::default();
    let outside = dir.path().join("outside.json");
    std::fs::write(&outside, "[]").unwrap();
    symlink(&outside, path.join("profiles.json")).unwrap();
    assert!(repo.save(&connection(), &vault).is_err());
    assert!(vault.0.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "[]");
    std::fs::remove_file(path.join("profiles.json")).unwrap();
    std::fs::create_dir(path.join("profiles.json")).unwrap();
    assert!(repo.save(&connection(), &vault).is_err());
    assert!(vault.0.lock().unwrap().is_empty());
}
#[test]
fn discovery_parses_only_real_runtime_rows_and_bounds_child_failure() {
    let result=crate::discovery::parse_runtimes(br#"{"id":"cli:agent:list","result":{"type":"agent_list","agents":[{"name":"fixture-local","agent":"codex","agent_status":"idle","agent_session":{"value":"ignored-session"}}]}}"#).unwrap();
    assert_eq!(result[0].name, "fixture-local");
    assert_eq!(result[0].state, "idle");
    assert!(crate::discovery::parse_runtimes(b"unexpected text").is_err());
    assert!(crate::discovery::parse_runtimes(br#"[{"name":"fake"}]"#).is_err());
    assert_eq!(
        crate::discovery::run_bounded(
            std::path::Path::new("/usr/bin/false"),
            &[],
            Duration::from_secs(1)
        )
        .unwrap_err(),
        DiscoveryStatus::Failed
    );
    assert_eq!(
        crate::discovery::run_bounded(
            std::path::Path::new("/bin/sleep"),
            &["2"],
            Duration::from_millis(20)
        )
        .unwrap_err(),
        DiscoveryStatus::TimedOut
    );
    assert_eq!(
        crate::discovery::run_bounded(
            std::path::Path::new("/usr/bin/yes"),
            &[],
            Duration::from_secs(1)
        )
        .unwrap_err(),
        DiscoveryStatus::InvalidOutput
    );
}

#[test]
fn desired_uuid_cannot_be_satisfied_by_a_slug() {
    let uuid = "00000000-0000-4000-8000-000000000001";
    let mut token = token_data();
    token["agent_slug"] = json!(uuid);
    let mut orient = orient_data();
    orient["result"]["packet"]["agent"]["slug"] = json!(uuid);
    let (client, requests) = fixture(vec![ok(token), ok(boot_data()), ok(orient)]);
    assert_eq!(
        client
            .poll_device(&Secret::new("fixture-code"), uuid, "fixture")
            .unwrap_err(),
        Error::IdentityMismatch
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn challenge_start_accepts_actual_server_shape_and_delayed_acceptance_expires() {
    let (client, _) = fixture(vec![ok(
        json!({"device_code":"fixture-device","user_code":"ABCD-EFGH","verification_uri":"{{origin}}/device","expires_in":10,"interval":5}),
    )]);
    let challenge = client.start_device("sample-agent").unwrap();
    assert_eq!(challenge.user_code, "ABCD-EFGH");
    assert!(!format!("{challenge:?}").contains("fixture-device"));
    let mut flow = DeviceFlow::default();
    let op = flow.begin();
    assert_eq!(
        flow.accept_challenge(op, challenge, Instant::now() + Duration::from_secs(20))
            .unwrap_err(),
        Error::Expired
    );
}
#[test]
fn rejected_stale_completion_cannot_deliver_connection_and_slowdown_persists() {
    let now = Instant::now();
    let mut flow = DeviceFlow::default();
    let op = flow.begin();
    flow.accept_challenge(op, challenge(), now).unwrap();
    flow.poll_request(now + Duration::from_secs(5))
        .unwrap()
        .unwrap();
    flow.complete_poll(
        op,
        DevicePoll::SlowDown(Duration::from_secs(5)),
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        flow.poll_request(now + Duration::from_secs(10))
            .unwrap()
            .is_none()
    );
    flow.cancel();
    let _new = flow.begin();
    assert_eq!(
        flow.complete_poll(op, DevicePoll::Verified(Box::new(connection())), now)
            .unwrap_err(),
        Error::StaleOperation
    );
}
#[test]
fn streaming_body_limit_and_envelope_failure_are_safe() {
    let (client, _) = fixture(vec![(299, "x".repeat(1_048_577))]);
    assert_eq!(client.health().unwrap_err(), Error::ResponseTooLarge);
    let (client, _) = fixture(vec![ok(json!({"ok":false,"error":"fixture-secret-error"}))]);
    let error = client
        .boot(&Secret::new("fixture-secret"), "sample-agent", "fixture")
        .unwrap_err();
    assert_eq!(error, Error::Refused);
    assert!(!format!("{error}").contains("secret"));
}
#[test]
fn refresh_restore_and_checkin_revalidate_before_presence() {
    let (client, requests) = fixture(vec![
        ok(boot_data()),
        ok(orient_data()),
        ok(json!({"ok":true,"result":{"ok":true,"agent_id":"agent-001","seat":"mupot-connect"}})),
    ]);
    let mut connection = connection();
    connection.origin = client.origin().clone();
    assert_eq!(client.check_in(&connection).unwrap().agent_id, "agent-001");
    let request = requests.lock().unwrap()[2].clone();
    assert!(request.starts_with("POST /actions/check_in HTTP/1.1"));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        json!({"harness":"unknown","seat":"mupot-connect","source":"mumachine"})
    );
    let mut boot = boot_data();
    boot["result"]["tenant"] = json!("other");
    let (client, requests) = fixture(vec![ok(boot)]);
    connection.origin = client.origin().clone();
    assert_eq!(
        client.check_in(&connection).unwrap_err(),
        Error::IdentityMismatch
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    let (client, _) = fixture(vec![ok(boot_data()), ok(orient_data())]);
    let profile = Profile {
        origin: client.origin().as_str().into(),
        agent_id: "agent-001".into(),
        agent_slug: "sample-agent".into(),
        tenant: "fixture".into(),
        expires_unix: crate::client::unix_now().unwrap() + 3600,
    };
    assert_eq!(
        client
            .restore(&profile, Secret::new("fixture-secret"))
            .unwrap()
            .snapshot
            .tenant,
        "fixture"
    );
}

#[test]
fn metadata_commit_failure_rolls_back_only_the_current_keychain_item() {
    use std::os::unix::fs::PermissionsExt;
    struct FailingCommitVault {
        inner: TestVault,
        path: std::path::PathBuf,
    }
    impl CredentialVault for FailingCommitVault {
        fn store(&self, key: &str, value: &Secret) -> Result<()> {
            self.inner.store(key, value)?;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o500)).unwrap();
            Ok(())
        }
        fn retrieve(&self, key: &str) -> Result<Option<Secret>> {
            self.inner.retrieve(key)
        }
        fn remove(&self, key: &str) -> Result<()> {
            self.inner.remove(key)
        }
    }
    for previous in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles");
        let repo = ProfileRepository::open(path.clone()).unwrap();
        let inner = TestVault::default();
        let connection = connection();
        let account = format!(
            "{}|{}",
            connection.origin.as_str(),
            connection.snapshot.agent.id
        );
        if previous {
            inner
                .store(&account, &Secret::new("fixture-old-secret"))
                .unwrap();
        }
        inner
            .store("another-app-account", &Secret::new("fixture-unrelated"))
            .unwrap();
        let vault = FailingCommitVault {
            inner,
            path: path.clone(),
        };
        assert_eq!(repo.save(&connection, &vault).unwrap_err(), Error::Storage);
        let retained = vault.retrieve(&account).unwrap();
        if previous {
            assert_eq!(retained.unwrap().expose(), "fixture-old-secret");
        } else {
            assert!(retained.is_none());
        }
        assert!(vault.retrieve("another-app-account").unwrap().is_some());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(repo.list().unwrap().is_empty());
    }
}

#[test]
fn profile_refuses_secret_fields_and_insecure_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let repo = ProfileRepository::open(path.clone()).unwrap();
    let vault = TestVault::default();
    repo.save(&connection(), &vault).unwrap();
    let file = path.join("profiles.json");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(repo.list().is_err());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut data: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    data[0]["access_token"] = json!("fixture-unwanted-secret");
    std::fs::write(file, data.to_string()).unwrap();
    assert!(repo.list().is_err());
}
