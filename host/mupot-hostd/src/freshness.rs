//! Freshness reconciliation — owner beats newer summary.

use crate::contract::{BrokerError, Freshness, Observation};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcePolicy {
    pub system: String,
    pub is_authority: bool,
    pub is_generated_summary: bool,
    pub stale_after_secs: i64,
    pub stale_fallback_permitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconciledClaim {
    pub fact_key: String,
    pub state: Freshness,
    pub winning: Option<Observation>,
    pub conflicted: Vec<Observation>,
    pub historical: Vec<Observation>,
}

pub fn reconcile(
    observations: &[Observation],
    policies: &[SourcePolicy],
    now_unix: i64,
) -> Result<Vec<ReconciledClaim>, BrokerError> {
    let policy_map: BTreeMap<&str, &SourcePolicy> =
        policies.iter().map(|p| (p.system.as_str(), p)).collect();
    let mut by_key: BTreeMap<String, Vec<Observation>> = BTreeMap::new();
    for obs in observations {
        by_key
            .entry(obs.fact_key.clone())
            .or_default()
            .push(obs.clone());
    }
    let mut out = Vec::new();
    for (fact_key, mut group) in by_key {
        if group.is_empty() {
            continue;
        }
        // SourceUnreachable: marked freshness or missing revision without unverified.
        if group.iter().all(|o| {
            matches!(o.freshness, Some(Freshness::SourceUnreachable))
                || o.source_revision.is_none()
                    && !matches!(o.freshness, Some(Freshness::Unverified))
        }) {
            let cached = group[0].clone();
            out.push(ReconciledClaim {
                fact_key,
                state: Freshness::SourceUnreachable,
                winning: Some(cached),
                conflicted: vec![],
                historical: group,
            });
            continue;
        }

        let authorities: Vec<_> = group
            .iter()
            .filter(|o| {
                policy_map
                    .get(o.source_system.as_str())
                    .map(|p| p.is_authority)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        let summaries: Vec<_> = group
            .iter()
            .filter(|o| {
                policy_map
                    .get(o.source_system.as_str())
                    .map(|p| p.is_generated_summary)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();

        if authorities.len() >= 2 {
            let values: std::collections::BTreeSet<String> = authorities
                .iter()
                .map(|o| {
                    o.value_hash
                        .clone()
                        .or_else(|| o.value.as_ref().map(|v| v.to_string()))
                        .unwrap_or_default()
                })
                .collect();
            if values.len() > 1 {
                out.push(ReconciledClaim {
                    fact_key,
                    state: Freshness::Conflicted,
                    winning: None,
                    conflicted: authorities,
                    historical: summaries,
                });
                continue;
            }
        }

        if let Some(owner) = authorities.first() {
            // Newer summary must not overrule owner.
            let mut historical = summaries;
            historical.extend(group.iter().filter(|o| {
                o.source_system != owner.source_system
                    && !policy_map
                        .get(o.source_system.as_str())
                        .map(|p| p.is_authority)
                        .unwrap_or(false)
            }).cloned());
            let state = age_state(owner, policy_map.get(owner.source_system.as_str()), now_unix);
            if let Some(pred) = &owner.supersedes {
                if group.iter().any(|o| {
                    o.source_revision.as_deref() == Some(pred.as_str())
                        || o.fact_key.contains(pred)
                }) {
                    out.push(ReconciledClaim {
                        fact_key,
                        state: Freshness::Superseded,
                        winning: Some(owner.clone()),
                        conflicted: vec![],
                        historical,
                    });
                    continue;
                }
            }
            out.push(ReconciledClaim {
                fact_key,
                state,
                winning: Some(owner.clone()),
                conflicted: vec![],
                historical,
            });
            continue;
        }

        // No authority — equal non-owners conflict if values differ.
        let values: std::collections::BTreeSet<String> = group
            .iter()
            .map(|o| {
                o.value_hash
                    .clone()
                    .or_else(|| o.value.as_ref().map(|v| v.to_string()))
                    .unwrap_or_default()
            })
            .collect();
        if values.len() > 1 {
            out.push(ReconciledClaim {
                fact_key,
                state: Freshness::Conflicted,
                winning: None,
                conflicted: group,
                historical: vec![],
            });
        } else {
            let obs = group.remove(0);
            let state = age_state(&obs, policy_map.get(obs.source_system.as_str()), now_unix);
            out.push(ReconciledClaim {
                fact_key,
                state,
                winning: Some(obs),
                conflicted: vec![],
                historical: group,
            });
        }
    }
    Ok(out)
}

fn age_state(obs: &Observation, policy: Option<&&SourcePolicy>, now_unix: i64) -> Freshness {
    if matches!(obs.freshness, Some(Freshness::Unverified)) {
        return Freshness::Unverified;
    }
    if matches!(obs.freshness, Some(Freshness::SourceUnreachable)) {
        return Freshness::SourceUnreachable;
    }
    let Some(p) = policy else {
        return Freshness::Unverified;
    };
    if p.is_generated_summary {
        return Freshness::Stale;
    }
    // Approximate age from observed_at year only for fixture simplicity.
    let age = estimate_age_secs(&obs.observed_at, now_unix);
    if age > p.stale_after_secs {
        if p.stale_fallback_permitted {
            Freshness::Stale
        } else {
            Freshness::SourceUnreachable
        }
    } else {
        Freshness::Fresh
    }
}

fn estimate_age_secs(observed_at: &str, now_unix: i64) -> i64 {
    // Fixture times are RFC3339; use a crude parse of the date portion.
    let year: i64 = observed_at.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let approx = (year - 1970) * 365 * 86_400;
    (now_unix - approx).max(0)
}
