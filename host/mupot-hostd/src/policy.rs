//! Operation policy — dual-consumer fence with seatlink.
//!
//! Bound from Hermes `INBOX-FENCE.md` and River `HERDR-ADAPTER.md`
//! (flight hostd-canonical-host-20260910). Seatlink owns live seat mail.
//! hostd may only use read Mupot RPCs and allowed Herdr socket methods.

use crate::contract::BrokerError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Hermes artifact: live UUID fence + Mupot read-only tool list.
pub const INBOX_FENCE_DOC: &str = "INBOX-FENCE.md";

/// River artifact: Herdr Unix-socket client allow/deny (protocol 22).
pub const HERDR_ADAPTER_DOC: &str = "HERDR-ADAPTER.md";

/// Default Herdr socket path (River HERDR-ADAPTER §1). Configurable via `HERDR_SOCK`.
pub const HERDR_SOCK_DEFAULT: &str = "~/.config/herdr/herdr.sock";

/// Required Herdr wire protocol version (River HERDR-ADAPTER §1 / §3).
pub const HERDR_PROTOCOL: u32 = 22;

/// Live seat UUIDs from Hermes INBOX-FENCE.md (both River rows fenced until canonicalized).
pub const FENCED_LIVE_SEAT_UUIDS: &[&str] = &[
    "870a5024-afd2-407e-86b3-fe2596e89bd1", // hadi-hermes
    "7089044c-5e48-4d5f-b5b0-6937433c4e79", // hadi-cursor
    "f23a6c2c-7377-492f-8d69-96c3946a7148", // hadi-river (bridge)
    "bec1bb7a-b37e-4594-b018-1f608ae38d47", // hadi-river (inbox-watch)
    "087a816b-ab9f-400f-8d53-f6f97b94a725", // hadi-codex-cli
    "95b5ba06-72a7-4c17-ab4b-c95ed8ff2dd3", // dara
    "cb14cb85-f7c6-447b-a6dd-52db44872d2e", // hadi-opencode
    "7b3cbfcd-51ac-4d16-bcf0-d6e1a069dbed", // hadi-pi
    "a065e61c-6a93-42fc-b070-b541631202f1", // hadi-grok
    "5498e2bb-c67f-40dc-87cb-1c7f7be360f2", // cyrus-prime
    "454bcf06-b337-4dfe-96f3-3f7fe9e97796", // stem-claude
];

/// Allowed Herdr JSON-RPC methods (River HERDR-ADAPTER §3). Exact names.
pub const HERDR_ALLOWED_METHODS: &[&str] = &[
    "ping",
    "session.snapshot",
    "agent.list",
    "agent.get",
    "pane.get",
    "pane.list",
    "pane.process_info",
    "workspace.list",
    "workspace.get",
];

/// Forbidden Herdr methods (River HERDR-ADAPTER §4) plus disproven `snapshot`.
pub const HERDR_FORBIDDEN_METHODS: &[&str] = &[
    "agent.prompt",
    "pane.send_text",
    "pane.send_input",
    "pane.send_keys",
    "server.stop",
    "server.live_handoff",
    "server.reload_config",
    "server.reload_agent_manifests",
    "pane.close",
    "pane.split",
    "pane.resize",
    "pane.move",
    "pane.swap",
    "pane.clear_agent_authority",
    "pane.release_agent",
    "workspace.close",
    "workspace.create",
    "workspace.move",
    "plugin.enable",
    "plugin.disable",
    "plugin.link",
    "plugin.unlink",
    "plugin.action.invoke",
    "events.subscribe",
    "snapshot", // not in protocol 22; authoritative name is session.snapshot
];

/// Mupot RPCs hostd may call (INBOX-FENCE + LANES). Read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllowedMupotRpc {
    BootContext,
    Status,
    ReceiptGet,
}

/// Actions that would make hostd a second consumer of live seat mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForbiddenSeatConsumerAction {
    /// Open or attach an SSE stream on a seat inbox UUID.
    Sse,
    /// Poll / cursor-advance a live seat inbox.
    PollCursor,
    /// Consume / lease an inbox row addressed to a live seat.
    Consume,
    /// Correlated or transport ACK (`inbox_ack` / kind=ack closing seat mail).
    InboxAck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatConsumerAttempt {
    /// Live seat agent UUID from INBOX-FENCE.md.
    pub seat_or_delivery_uuid: String,
    pub action: ForbiddenSeatConsumerAction,
}

/// Returns `Forbidden` for any attempt to SSE/poll/consume/ACK a live seat UUID.
pub fn refuse_seat_consumer(attempt: &SeatConsumerAttempt) -> Result<(), BrokerError> {
    if attempt.seat_or_delivery_uuid.trim().is_empty() {
        return Err(BrokerError::InvalidInput);
    }
    let _ = attempt.action;
    Err(BrokerError::Forbidden)
}

pub fn is_fenced_live_seat_uuid(uuid: &str) -> bool {
    FENCED_LIVE_SEAT_UUIDS.contains(&uuid)
}

pub fn allowed_mupot_rpcs() -> BTreeSet<AllowedMupotRpc> {
    use AllowedMupotRpc::*;
    [BootContext, Status, ReceiptGet].into_iter().collect()
}

pub fn mupot_rpc_allowed(name: &str) -> Result<AllowedMupotRpc, BrokerError> {
    match name {
        "boot_context" => Ok(AllowedMupotRpc::BootContext),
        "status" => Ok(AllowedMupotRpc::Status),
        "receipt_get" | "execution_receipt_get" => Ok(AllowedMupotRpc::ReceiptGet),
        "inbox" | "inbox_lease" | "inbox_ack" | "send" | "squad_message" | "connect"
        | "mint_agent_token" | "grant_agent_capability" => Err(BrokerError::Forbidden),
        _ => Err(BrokerError::UnsupportedContract),
    }
}

/// Herdr method allow/deny from HERDR-ADAPTER.md. No I/O — name check only.
pub fn herdr_method_allowed(method: &str) -> Result<(), BrokerError> {
    if HERDR_FORBIDDEN_METHODS.contains(&method) {
        return Err(BrokerError::Forbidden);
    }
    if HERDR_ALLOWED_METHODS.contains(&method) {
        return Ok(());
    }
    Err(BrokerError::UnsupportedContract)
}

pub fn allowed_herdr_methods() -> BTreeSet<&'static str> {
    HERDR_ALLOWED_METHODS.iter().copied().collect()
}
