//! Codex local memory — read-only hints; disabled if controls indeterminate.

use crate::adapters::ReadAdapter;
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, SourceRef, VerifiedScope,
};
use std::path::{Path, PathBuf};

pub struct CodexMemoryAdapter {
    pub enabled: bool,
    pub allowed_root: Option<PathBuf>,
}

impl CodexMemoryAdapter {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            allowed_root: None,
        }
    }
}

impl ReadAdapter for CodexMemoryAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        if !self.enabled {
            return Err(BrokerError::SourceUnavailable);
        }
        let root = self
            .allowed_root
            .as_ref()
            .ok_or(BrokerError::SourceUnavailable)?;
        let path = Path::new(&source.id);
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(BrokerError::Forbidden);
        }
        let full = root.join(path);
        if !full.starts_with(root) {
            return Err(BrokerError::Forbidden);
        }
        if full.is_symlink() {
            return Err(BrokerError::Forbidden);
        }
        let _ = scope;
        Ok(Readback {
            source: source.clone(),
            value_hash: format!("codex-hint:{}", source.id),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let rb = self.read(
            &SourceRef {
                system: "codex_memory".into(),
                id: query.into(),
                revision: "hint".into(),
            },
            scope,
        )?;
        Ok(vec![Observation {
            fact_key: format!("codex_memory.{query}"),
            value: Some(serde_json::json!("historical hint only")),
            value_hash: Some(rb.value_hash),
            source_system: "codex_memory".into(),
            source_uri: Some(format!("codex:{query}")),
            source_id: Some(query.into()),
            source_revision: Some("hint".into()),
            subject_type: "memory".into(),
            subject_id: query.into(),
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: Some(0.1),
            writer_principal: None,
            receipt_ref: None,
            classification: Classification::Private,
            freshness: Some(Freshness::Stale),
        }])
    }
}
