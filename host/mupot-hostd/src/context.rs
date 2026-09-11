//! Bounded context assembly — labelled sections, no model summarizer.

use crate::contract::{BrokerError, Freshness, Observation, VerifiedScope};
use crate::freshness::ReconciledClaim;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextPacket {
    pub current_facts: Vec<Observation>,
    pub historical_hints: Vec<Observation>,
    pub conflicts: Vec<Observation>,
    pub required_decisions: Vec<String>,
    pub bytes_used: usize,
}

pub fn build_context(
    claims: &[ReconciledClaim],
    scope: &VerifiedScope,
    token_budget_bytes: usize,
) -> Result<ContextPacket, BrokerError> {
    let mut packet = ContextPacket::default();
    for claim in claims {
        let tenant_ok = |o: &Observation| o.scope.tenant == scope.scope().tenant;
        let in_scope = claim
            .winning
            .as_ref()
            .map(tenant_ok)
            .or_else(|| claim.conflicted.first().map(tenant_ok))
            .unwrap_or(false);
        if !in_scope {
            if claim.conflicted.iter().any(tenant_ok) {
                // keep conflicted in-tenant only below
            } else {
                continue;
            }
        }

        match claim.state {
            Freshness::Conflicted => {
                packet
                    .conflicts
                    .extend(claim.conflicted.iter().filter(|o| tenant_ok(o)).cloned());
                packet
                    .required_decisions
                    .push(format!("resolve conflict on {}", claim.fact_key));
            }
            Freshness::Fresh | Freshness::Unverified => {
                if let Some(w) = &claim.winning {
                    if tenant_ok(w) {
                        packet.current_facts.push(w.clone());
                    }
                }
                packet.historical_hints.extend(claim.historical.clone());
            }
            Freshness::Stale | Freshness::Superseded | Freshness::SourceUnreachable => {
                if let Some(w) = &claim.winning {
                    packet.historical_hints.push(w.clone());
                }
                packet.historical_hints.extend(claim.historical.clone());
            }
        }
    }

    let mut used = 0usize;
    let mut trim = |items: &mut Vec<Observation>| {
        let mut kept = Vec::new();
        for obs in items.drain(..) {
            let sz = serde_json::to_vec(&obs).map(|b| b.len()).unwrap_or(0);
            if used + sz > token_budget_bytes {
                break;
            }
            used += sz;
            kept.push(obs);
        }
        *items = kept;
    };
    trim(&mut packet.current_facts);
    trim(&mut packet.historical_hints);
    trim(&mut packet.conflicts);
    packet.bytes_used = used;
    Ok(packet)
}
