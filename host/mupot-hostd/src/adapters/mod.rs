//! Source adapters. Read-only in Flight 2.

pub mod codex_memory;
pub mod github;
pub mod herdr;
pub mod inkwell;
pub mod mirror;
pub mod mupot;

use crate::contract::{BrokerError, Observation, Readback, SourceRef, VerifiedScope};

pub trait ReadAdapter: Send + Sync {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError>;
    fn recall(&self, query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError>;
}

pub fn narrow_scope_ok(requested_tenant: &str, verified: &VerifiedScope) -> Result<(), BrokerError> {
    if requested_tenant != verified.scope().tenant {
        return Err(BrokerError::Forbidden);
    }
    Ok(())
}
