use crate::*;
const AGENT_ID: &str = "00000000-0000-4000-8000-000000000001";

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
    json!({"ok":true,"tool":"boot_context","result":{"tenant":"fixture","channel":"directory","identity_status":"minted","bound_agent_id":"00000000-0000-4000-8000-000000000001"}})
}
fn orient_data() -> Value {
    json!({"ok":true,"tool":"orient","result":{"packet":{"agent":{"id":"00000000-0000-4000-8000-000000000001","slug":"sample-agent","name":"Sample Agent","role":"analyst","status":"active"},"squad":{"id":"squad-001","name":"Sample Squad"},"squadmates":[{"agent_id":"00000000-0000-4000-8000-000000000002","slug":"sample-peer","name":"Sample Peer","role":"reviewer","capability":"member"}]},"brief":"Fixture boot brief."}})
}
fn token_data() -> Value {
    json!({"access_token":"fixture-credential-not-live","token_type":"Bearer","expires_in":3600,"agent_id":"00000000-0000-4000-8000-000000000001","agent_slug":"sample-agent"})
}
fn challenge() -> DeviceChallenge {
    DeviceChallenge {
        user_code: "ABCD-EFGH".into(),
        verification_uri: "https://pot.example/device".into(),
        expires_in: Duration::from_secs(15),
        interval: Duration::from_secs(5),
        device_code: Secret::new("fixture-device-code"),
        deadline: Instant::now() + Duration::from_secs(15),
        origin: PotOrigin::parse("https://pot.example").unwrap(),
        desired_agent: AGENT_ID.into(),
        started: Instant::now(),
        started_unix: crate::client::unix_now().unwrap(),
    }
}

#[test]
fn client_requests_real_action_paths_and_auth_headers() {
    let (client, requests) = fixture(vec![ok(boot_data()), ok(orient_data())]);
    let snapshot = client
        .boot(
            &Secret::new("fixture-credential-not-live"),
            AGENT_ID,
            "fixture",
        )
        .unwrap();
    assert_eq!(snapshot.agent.id, "00000000-0000-4000-8000-000000000001");
    assert_eq!(snapshot.channel, "directory");
    assert_eq!(
        snapshot.roster[0].agent_id,
        "00000000-0000-4000-8000-000000000002"
    );
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
                .boot(
                    &Secret::new("fixture-token"),
                    "00000000-0000-4000-8000-000000000001",
                    "fixture"
                )
                .unwrap_err(),
            Error::IdentityMismatch
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    let mut orient = orient_data();
    orient["result"]["packet"]["agent"]["id"] = json!("wrong-id");
    let (client, _) = fixture(vec![ok(boot_data()), ok(orient)]);
    assert_eq!(
        client
            .boot(&Secret::new("fixture-token"), AGENT_ID, "fixture")
            .unwrap_err(),
        Error::IdentityMismatch
    );
}
#[test]
fn device_token_requires_bearer_expiry_and_redeemed_identity() {
    for (field, value) in [
        ("token_type", json!("Basic")),
        ("expires_in", json!(0)),
        ("agent_id", json!("00000000-0000-4000-8000-000000000009")),
    ] {
        let mut token = token_data();
        token[field] = value;
        let (client, requests) = fixture(vec![ok(token)]);
        assert!(
            client
                .poll_device(&poll_request(&client), "fixture")
                .is_err()
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(requests.lock().unwrap()[0].starts_with("POST /device/token HTTP/1.1"));
    }
    let (client, _) = fixture(vec![ok(token_data()), ok(boot_data()), ok(orient_data())]);
    assert!(matches!(
        client
            .poll_device(&poll_request(&client), "fixture")
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
            .poll_device(&poll_request(&client), "fixture")
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
        client.start_device(AGENT_ID).unwrap_err(),
        Error::InvalidResponse
    );
    assert!(requests.lock().unwrap()[0].starts_with("POST /device/code HTTP/1.1"));
    assert!(requests.lock().unwrap()[0].ends_with(&format!("{{\"agent\":\"{AGENT_ID}\"}}")));
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
                id: "00000000-0000-4000-8000-000000000001".into(),
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
    token["agent_id"] = json!("00000000-0000-4000-8000-000000000009");
    token["agent_slug"] = json!(uuid);
    let mut orient = orient_data();
    orient["result"]["packet"]["agent"]["slug"] = json!(uuid);
    let (client, requests) = fixture(vec![ok(token), ok(boot_data()), ok(orient)]);
    assert_eq!(
        client
            .poll_device(&poll_request(&client), "fixture")
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
    let challenge = client.start_device(AGENT_ID).unwrap();
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
        .boot(&Secret::new("fixture-secret"), AGENT_ID, "fixture")
        .unwrap_err();
    assert_eq!(error, Error::Refused);
    assert!(!format!("{error}").contains("secret"));
}
#[test]
fn refresh_restore_and_checkin_revalidate_before_presence() {
    let (client, requests) = fixture(vec![
        ok(boot_data()),
        ok(orient_data()),
        ok(
            json!({"ok":true,"result":{"ok":true,"agent_id":"00000000-0000-4000-8000-000000000001","seat":"mupot-connect"}}),
        ),
    ]);
    let mut connection = connection();
    connection.origin = client.origin().clone();
    assert_eq!(
        client.check_in(&connection).unwrap().agent_id,
        "00000000-0000-4000-8000-000000000001"
    );
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
        agent_id: "00000000-0000-4000-8000-000000000001".into(),
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

fn poll_request(client: &MupotClient) -> PollRequest {
    let now = Instant::now();
    let mut challenge = challenge();
    challenge.origin = client.origin().clone();
    let mut flow = DeviceFlow::default();
    let op = flow.begin();
    flow.accept_challenge(op, challenge, now).unwrap();
    flow.poll_request(now + Duration::from_secs(5))
        .unwrap()
        .unwrap()
}

#[test]
fn round1_slug_is_refused_before_device_or_boot_network() {
    for desired in ["sample-agent", "00000000-0000-4000-8000-00000000000A"] {
        let (client, requests) = fixture(vec![ok(json!({}))]);
        assert_eq!(
            client.start_device(desired).unwrap_err(),
            Error::InvalidInput
        );
        assert_eq!(
            client
                .boot(&Secret::new("fixture"), desired, "fixture")
                .unwrap_err(),
            Error::InvalidInput
        );
        assert!(requests.lock().unwrap().is_empty());
    }
}
#[test]
fn round1_http400_token_payload_is_never_redeemed_as_success() {
    let (client, requests) = fixture(vec![
        (400, token_data().to_string()),
        ok(boot_data()),
        ok(orient_data()),
    ]);
    assert_eq!(
        client
            .poll_device(&poll_request(&client), "fixture")
            .unwrap_err(),
        Error::Refused
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn round1_delayed_first_redemption_keeps_original_challenge_token_expiry() {
    let (client, _) = fixture(vec![ok(token_data()), ok(boot_data()), ok(orient_data())]);
    let mut request = poll_request(&client);
    request.started = Instant::now() - Duration::from_secs(300);
    request.started_unix = crate::client::unix_now().unwrap() - 300;
    let original = request.started;
    let original_unix = request.started_unix;
    let DevicePoll::Verified(connection) = client.poll_device(&request, "fixture").unwrap() else {
        panic!("expected token")
    };
    assert!(connection.expires_at <= original + Duration::from_secs(3600));
    assert!(connection.expires_unix <= original_unix + 3600);
    let dir = tempfile::tempdir().unwrap();
    let repo = ProfileRepository::open(dir.path().join("profiles")).unwrap();
    // Loopback fixture origins cannot be persisted as production profiles.
    let mut connection = *connection;
    connection.origin = PotOrigin::parse("https://pot.example").unwrap();
    let profile = repo.save(&connection, &TestVault::default()).unwrap();
    assert!(profile.expires_unix <= original_unix + 3600);
}
#[test]
fn round1_poll_request_cannot_move_to_another_origin_or_expired_challenge() {
    let (first, _) = fixture(vec![]);
    let mut request = poll_request(&first);
    let (other, requests) = fixture(vec![ok(token_data()), ok(boot_data()), ok(orient_data())]);
    assert_eq!(
        other.poll_device(&request, "fixture").unwrap_err(),
        Error::IdentityMismatch
    );
    assert!(requests.lock().unwrap().is_empty());
    request.deadline = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        first.poll_device(&request, "fixture").unwrap_err(),
        Error::Expired
    );
}
#[test]
fn round1_checkin_refuses_another_descriptive_seat() {
    let (client, _) = fixture(vec![
        ok(boot_data()),
        ok(orient_data()),
        ok(json!({"ok":true,"result":{"ok":true,"agent_id":AGENT_ID,"seat":"other-seat"}})),
    ]);
    let mut connection = connection();
    connection.origin = client.origin().clone();
    assert_eq!(
        client.check_in(&connection).unwrap_err(),
        Error::IdentityMismatch
    );
}
#[test]
fn round1_installed_apps_include_confirmed_bundles_without_fabrication() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["Antigravity.app", "Grok Bot.app"] {
        std::fs::create_dir(dir.path().join(name)).unwrap();
    }
    let apps = crate::discovery::installed_apps(&[dir.path().to_owned()]);
    assert_eq!(
        apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>(),
        vec!["Antigravity", "Grok Bot"]
    );
    assert!(apps.iter().all(|app| app.path.is_dir()));
}
#[test]
fn round1_forget_failure_restores_previous_vault_item() {
    use std::os::unix::fs::PermissionsExt;
    struct FailingForget {
        inner: TestVault,
        path: std::path::PathBuf,
    }
    impl CredentialVault for FailingForget {
        fn store(&self, key: &str, value: &Secret) -> Result<()> {
            self.inner.store(key, value)
        }
        fn retrieve(&self, key: &str) -> Result<Option<Secret>> {
            self.inner.retrieve(key)
        }
        fn remove(&self, key: &str) -> Result<()> {
            self.inner.remove(key)?;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o500)).unwrap();
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let repo = ProfileRepository::open(path.clone()).unwrap();
    let vault = FailingForget {
        inner: TestVault::default(),
        path: path.clone(),
    };
    let profile = repo.save(&connection(), &vault).unwrap();
    assert_eq!(repo.forget(&profile, &vault).unwrap_err(), Error::Storage);
    assert_eq!(
        vault
            .retrieve(&profile.account())
            .unwrap()
            .unwrap()
            .expose(),
        "fixture-stored-secret"
    );
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(repo.list().unwrap(), vec![profile]);
}
#[test]
fn round1_repository_lock_blocks_other_repository_and_process_without_waiting() {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let repo = ProfileRepository::open(path.clone()).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path.join(".profiles.lock"))
        .unwrap();
    // SAFETY: open test lock fd, advisory exclusive nonblocking lock.
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let started = Instant::now();
    assert_eq!(repo.list().unwrap_err(), Error::StorageBusy);
    assert!(started.elapsed() < Duration::from_secs(1));
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::round1_profile_lock_child", "--nocapture"])
        .env("MUMACHINE_FIXTURE_LOCK_DIR", &path)
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stdout)
    );
    drop(lock);
    assert!(repo.list().unwrap().is_empty());
}
#[test]
fn round1_profile_lock_child() {
    let Some(path) = std::env::var_os("MUMACHINE_FIXTURE_LOCK_DIR") else {
        return;
    };
    let repo = ProfileRepository::open(path.into()).unwrap();
    assert_eq!(repo.list().unwrap_err(), Error::StorageBusy);
}

#[test]
fn round1_nonblocking_transaction_spans_vault_and_preserves_both_saves() {
    struct BlockingVault {
        inner: TestVault,
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl CredentialVault for BlockingVault {
        fn store(&self, key: &str, value: &Secret) -> Result<()> {
            self.inner.store(key, value)?;
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            Ok(())
        }
        fn retrieve(&self, key: &str) -> Result<Option<Secret>> {
            self.inner.retrieve(key)
        }
        fn remove(&self, key: &str) -> Result<()> {
            self.inner.remove(key)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let first = ProfileRepository::open(path.clone()).unwrap();
    let second = ProfileRepository::open(path).unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let vault = Arc::new(BlockingVault {
        inner: TestVault::default(),
        entered: entered_tx,
        release: Mutex::new(release_rx),
    });
    let worker_vault = vault.clone();
    let worker = thread::spawn(move || first.save(&connection(), &*worker_vault));
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut other = connection();
    other.snapshot.agent.id = "00000000-0000-4000-8000-000000000003".into();
    let started = Instant::now();
    assert_eq!(
        second.save(&other, &vault.inner).unwrap_err(),
        Error::StorageBusy
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(vault.inner.0.lock().unwrap().len(), 1);
    release_tx.send(()).unwrap();
    worker.join().unwrap().unwrap();
    second.save(&other, &vault.inner).unwrap();
    assert_eq!(second.list().unwrap().len(), 2);
    assert_eq!(vault.inner.0.lock().unwrap().len(), 2);
}
#[test]
fn round1_transaction_lock_rejects_symlink_and_public_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("profiles");
    let repo = ProfileRepository::open(path.clone()).unwrap();
    let outside = dir.path().join("outside");
    std::fs::write(&outside, "fixture").unwrap();
    let lock = path.join(".profiles.lock");
    symlink(&outside, &lock).unwrap();
    assert_eq!(repo.list().unwrap_err(), Error::Storage);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "fixture");
    std::fs::remove_file(&lock).unwrap();
    std::fs::write(&lock, "").unwrap();
    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(repo.list().unwrap_err(), Error::Storage);
}
#[test]
fn round1_device_request_encoding_is_correct_and_container_debug_is_redacted() {
    let (client, requests) = fixture(vec![(
        400,
        json!({"error":"authorization_pending","interval":5}).to_string(),
    )]);
    let mut request = poll_request(&client);
    request.code = Secret::new("fixture-quoted-\"code");
    let debug = format!("{request:?}");
    assert!(!debug.contains("fixture-quoted"));
    assert!(debug.contains("REDACTED"));
    assert!(matches!(
        client.poll_device(&request, "fixture").unwrap(),
        DevicePoll::Pending(_)
    ));
    let requests = requests.lock().unwrap();
    let body: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body, json!({"device_code":"fixture-quoted-\"code"}));
    assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
}
