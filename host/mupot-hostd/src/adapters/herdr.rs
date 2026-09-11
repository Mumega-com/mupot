//! Herdr Unix-socket JSON-RPC client (protocol 22).
//! Allowed methods only — never agent.prompt / server.stop / inbox stream.

use crate::adapters::ReadAdapter;
use crate::contract::{BrokerError, Observation, Readback, SourceRef, VerifiedScope};
use crate::policy::{herdr_method_allowed, HERDR_PROTOCOL};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub struct HerdrAdapter {
    pub sock_path: PathBuf,
    /// When set, skip socket I/O and return this scripted JSON (tests).
    pub scripted: Option<Value>,
}

impl HerdrAdapter {
    pub fn connect_path(path: impl AsRef<Path>) -> Self {
        Self {
            sock_path: path.as_ref().to_path_buf(),
            scripted: None,
        }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, BrokerError> {
        herdr_method_allowed(method)?;
        if let Some(scripted) = &self.scripted {
            return Ok(scripted.clone());
        }
        let mut stream = UnixStream::connect(&self.sock_path)
            .map_err(|_| BrokerError::SourceUnavailable)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| BrokerError::SourceUnavailable)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| BrokerError::SourceUnavailable)?;
        let req = json!({
            "id": "hostd-1",
            "method": method,
            "params": params,
        });
        let line = format!("{req}\n");
        stream
            .write_all(line.as_bytes())
            .map_err(|_| BrokerError::SourceUnavailable)?;
        let mut reader = BufReader::new(stream);
        let mut resp_line = String::new();
        reader
            .read_line(&mut resp_line)
            .map_err(|_| BrokerError::SourceUnavailable)?;
        let resp: Value =
            serde_json::from_str(&resp_line).map_err(|_| BrokerError::CorruptState)?;
        if resp.get("error").is_some() {
            return Err(BrokerError::SourceUnavailable);
        }
        if method == "ping" {
            let protocol = resp
                .pointer("/result/protocol")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if protocol != HERDR_PROTOCOL {
                return Err(BrokerError::UnsupportedContract);
            }
        }
        Ok(resp)
    }

    pub fn ping(&self) -> Result<(), BrokerError> {
        let _ = self.call("ping", json!({}))?;
        Ok(())
    }

    pub fn session_snapshot(&self) -> Result<Value, BrokerError> {
        self.call("session.snapshot", json!({}))
    }

    pub fn list_agents(&self) -> Result<Value, BrokerError> {
        self.call("agent.list", json!({}))
    }
}

impl ReadAdapter for HerdrAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        if source.system != "herdr" {
            return Err(BrokerError::UnsupportedContract);
        }
        let _ = self.list_agents()?;
        Ok(Readback {
            source: source.clone(),
            value_hash: format!("herdr:{}", scope.credential_fingerprint()),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, _query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let snap = self.session_snapshot()?;
        Ok(vec![Observation {
            fact_key: "herdr.session".into(),
            value: Some(snap),
            value_hash: None,
            source_system: "herdr".into(),
            source_uri: Some("rpc:session.snapshot".into()),
            source_id: Some("session".into()),
            source_revision: Some(HERDR_PROTOCOL.to_string()),
            subject_type: "runtime".into(),
            subject_id: "herdr".into(),
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: None,
            writer_principal: scope.scope().agent.clone(),
            receipt_ref: Some("session.snapshot".into()),
            classification: crate::contract::Classification::Squad,
            freshness: Some(crate::contract::Freshness::Fresh),
        }])
    }
}
