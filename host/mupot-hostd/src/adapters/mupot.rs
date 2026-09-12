//! Mupot read adapter — boot_context / status / receipt_get only.
//! Never SSE, inbox, inbox_ack, connect, or mint.

use crate::adapters::ReadAdapter;
use crate::contract::{BrokerError, Observation, Readback, SourceRef, VerifiedScope};
use crate::identity::{IdentityEvidence, verify_identity};
use crate::policy::{AllowedMupotRpc, mupot_rpc_allowed};
use crate::secrets::SecretHandle;
use serde_json::Value;

enum MupotBackend {
    Scripted(std::collections::BTreeMap<String, Value>),
    Http {
        base_url: String,
        token: SecretHandle,
        expected_agent_id: Option<String>,
    },
}

pub struct MupotAdapter {
    backend: MupotBackend,
}

impl MupotAdapter {
    pub fn scripted(responses: std::collections::BTreeMap<String, Value>) -> Self {
        Self {
            backend: MupotBackend::Scripted(responses),
        }
    }

    /// Construct the read-only live adapter. Plain HTTP is accepted only for
    /// loopback fixture servers; remote endpoints must use HTTPS.
    pub fn http(
        base_url: String,
        token: SecretHandle,
        expected_agent_id: Option<String>,
    ) -> Result<Self, BrokerError> {
        let base_url = base_url.trim_end_matches('/').to_string();
        let loopback = base_url.starts_with("http://127.0.0.1:")
            || base_url.starts_with("http://localhost:")
            || base_url.starts_with("http://[::1]:");
        if !base_url.starts_with("https://") && !loopback {
            return Err(BrokerError::Forbidden);
        }
        if token.as_bytes().is_empty() {
            return Err(BrokerError::UnverifiedIdentity);
        }
        Ok(Self {
            backend: MupotBackend::Http {
                base_url,
                token,
                expected_agent_id,
            },
        })
    }

    pub fn call_rpc(&self, name: &str) -> Result<Value, BrokerError> {
        let allowed = mupot_rpc_allowed(name)?;
        let key = match allowed {
            AllowedMupotRpc::BootContext => "boot_context",
            AllowedMupotRpc::Status => "status",
            AllowedMupotRpc::ReceiptGet => "receipt_get",
        };
        let response = match &self.backend {
            MupotBackend::Scripted(scripted) => scripted
                .get(key)
                .cloned()
                .ok_or(BrokerError::SourceUnavailable)?,
            MupotBackend::Http {
                base_url, token, ..
            } => {
                let bearer = std::str::from_utf8(token.as_bytes())
                    .map_err(|_| BrokerError::UnverifiedIdentity)?
                    .trim();
                if bearer.is_empty() {
                    return Err(BrokerError::UnverifiedIdentity);
                }
                let response = ureq::post(&format!("{base_url}/actions/{key}"))
                    .set("Authorization", &format!("Bearer {bearer}"))
                    .set("User-Agent", "mupot-hostd/0.1")
                    .send_json(serde_json::json!({}));
                match response {
                    Ok(response) => response
                        .into_json::<Value>()
                        .map_err(|_| BrokerError::SourceUnavailable)?,
                    Err(ureq::Error::Status(401, _)) => {
                        return Err(BrokerError::UnverifiedIdentity);
                    }
                    Err(ureq::Error::Status(403, _)) => return Err(BrokerError::Forbidden),
                    Err(_) => return Err(BrokerError::SourceUnavailable),
                }
            }
        };

        if key == "boot_context" {
            self.verify_expected_agent(&response)?;
        }
        Ok(response)
    }

    fn verify_expected_agent(&self, response: &Value) -> Result<(), BrokerError> {
        let expected = match &self.backend {
            MupotBackend::Http {
                expected_agent_id, ..
            } => expected_agent_id.as_deref(),
            MupotBackend::Scripted(_) => None,
        };
        let Some(expected) = expected else {
            return Ok(());
        };
        let actual = response
            .pointer("/result/bound_agent_id")
            .and_then(Value::as_str)
            .ok_or(BrokerError::UnverifiedIdentity)?;
        if actual != expected {
            return Err(BrokerError::Conflict);
        }
        Ok(())
    }

    /// Resolve a principal from the authenticated Mupot boot response. Caller
    /// evidence supplies only the requested identity and tenant; it cannot
    /// assert its own bearer identity or credential fingerprint.
    pub fn verified_scope(
        &self,
        requested_principal: &str,
        tenant: &str,
        now_unix: i64,
    ) -> Result<VerifiedScope, BrokerError> {
        let boot = self.call_rpc("boot_context")?;
        let bearer_agent_id = boot
            .pointer("/result/bound_agent_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(BrokerError::UnverifiedIdentity)?;
        let credential_fingerprint = match &self.backend {
            MupotBackend::Http { token, .. } => token.fingerprint(),
            MupotBackend::Scripted(_) => format!("scripted:{bearer_agent_id}"),
        };
        verify_identity(
            &IdentityEvidence {
                bearer_agent_id: bearer_agent_id.into(),
                requested_principal: requested_principal.into(),
                documentary_principal: None,
                seat_live: false,
                seat_agent_id: None,
                tenant: tenant.into(),
                credential_fingerprint: Some(credential_fingerprint),
                revoked: false,
                expired: false,
                mupot_available: Some(true),
            },
            now_unix,
        )
    }
}

impl ReadAdapter for MupotAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        if source.system != "mupot" {
            return Err(BrokerError::UnsupportedContract);
        }
        let boot = self.call_rpc("boot_context")?;
        if let Some(requested) = scope.scope().agent.as_deref() {
            let actual = boot
                .pointer("/result/bound_agent_id")
                .and_then(Value::as_str)
                .ok_or(BrokerError::UnverifiedIdentity)?;
            if actual != requested {
                return Err(BrokerError::Conflict);
            }
        }
        Ok(Readback {
            source: source.clone(),
            value_hash: format!("mupot:{}", scope.credential_fingerprint()),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, _query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let boot = self.call_rpc("boot_context")?;
        let agent = boot
            .pointer("/result/bound_agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if let Some(requested) = scope.scope().agent.as_deref()
            && agent != requested
        {
            return Err(BrokerError::Conflict);
        }
        Ok(vec![Observation {
            fact_key: "mupot.bound_agent".into(),
            value: Some(Value::String(agent.into())),
            value_hash: None,
            source_system: "mupot".into(),
            source_uri: Some("rpc:boot_context".into()),
            source_id: Some(agent.into()),
            source_revision: Some("boot".into()),
            subject_type: "agent".into(),
            subject_id: agent.into(),
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: None,
            writer_principal: Some(agent.into()),
            receipt_ref: Some("boot".into()),
            classification: crate::contract::Classification::Squad,
            freshness: Some(crate::contract::Freshness::Fresh),
        }])
    }
}
