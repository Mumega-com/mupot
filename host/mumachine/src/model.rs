use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidOrigin,
    InvalidInput,
    Transport,
    ResponseTooLarge,
    InvalidResponse,
    Refused,
    IdentityMismatch,
    Expired,
    StaleOperation,
    Storage,
    Unsupported,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PotOrigin(String);
impl PotOrigin {
    pub fn parse(input: &str) -> Result<Self> {
        if !input.starts_with("https://")
            || input
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
        {
            return Err(Error::InvalidOrigin);
        }
        let authority = &input[8..];
        if authority.contains(['@', '?', '#'])
            || authority.trim_end_matches('/').contains('/')
            || authority.ends_with("//")
        {
            return Err(Error::InvalidOrigin);
        }
        let url = url::Url::parse(input).map_err(|_| Error::InvalidOrigin)?;
        if url.host_str().is_none()
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::InvalidOrigin);
        }
        Ok(Self(url.origin().ascii_serialization()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    #[cfg(test)]
    pub(crate) fn fixture(address: std::net::SocketAddr) -> Self {
        Self(format!("http://{address}"))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub service: String,
    pub tenant: String,
    pub version: String,
    pub commit: Option<String>,
    pub clean: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub role: String,
    pub status: String,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Squad {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct RosterMember {
    pub agent_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub role: String,
    pub capability: String,
}
#[derive(Debug, Clone)]
pub struct BootSnapshot {
    pub agent: Agent,
    pub squad: Squad,
    pub tenant: String,
    pub channel: String,
    pub brief: String,
    pub roster: Vec<RosterMember>,
    pub verification: Verification,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    BoundIdentityVerified,
}
#[derive(Debug, Clone)]
pub struct DeviceChallenge {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: Duration,
    pub interval: Duration,
    pub(crate) device_code: Secret,
    pub(crate) deadline: Instant,
}
#[derive(Debug)]
pub struct VerifiedConnection {
    pub(crate) token: Secret,
    pub origin: PotOrigin,
    pub snapshot: BootSnapshot,
    pub(crate) expires_at: Instant,
    pub expires_unix: u64,
}
impl VerifiedConnection {
    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}
#[derive(Debug)]
pub enum DevicePoll {
    Pending(Duration),
    SlowDown(Duration),
    Denied,
    Expired,
    Verified(Box<VerifiedConnection>),
}
#[derive(Debug, Clone)]
pub struct CheckInReceipt {
    pub agent_id: String,
    pub seat: String,
}

/// Credentials deliberately cannot be serialized.
/// ```compile_fail
/// let secret = mumachine::Secret::new("fixture");
/// let _ = serde_json::to_string(&secret);
/// ```
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}
