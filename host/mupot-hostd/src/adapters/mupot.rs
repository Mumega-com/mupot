//! Mupot read adapter — boot_context / status / receipt_get only.
//! Never SSE, inbox, inbox_ack, connect, or mint.

use crate::adapters::ReadAdapter;
use crate::contract::{BrokerError, Observation, Readback, SourceRef, VerifiedScope};
use crate::policy::{mupot_rpc_allowed, AllowedMupotRpc};
use serde_json::Value;

pub struct MupotAdapter {
    /// Scripted responses for fixtures / loopback. Keyed by RPC name.
    pub scripted: std::collections::BTreeMap<String, Value>,
}

impl MupotAdapter {
    pub fn call_rpc(&self, name: &str) -> Result<Value, BrokerError> {
        let allowed = mupot_rpc_allowed(name)?;
        let key = match allowed {
            AllowedMupotRpc::BootContext => "boot_context",
            AllowedMupotRpc::Status => "status",
            AllowedMupotRpc::ReceiptGet => "receipt_get",
        };
        self.scripted
            .get(key)
            .cloned()
            .ok_or(BrokerError::SourceUnavailable)
    }
}

impl ReadAdapter for MupotAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        if source.system != "mupot" {
            return Err(BrokerError::UnsupportedContract);
        }
        let _ = self.call_rpc("boot_context")?;
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
