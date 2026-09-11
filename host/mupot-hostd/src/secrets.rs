//! Secret handles — never Debug-print credential material.

use crate::contract::BrokerError;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Opaque credential wrapper. Debug redacts contents.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretHandle {
    #[zeroize(skip)]
    pub service: String,
    #[zeroize(skip)]
    pub account: String,
    bytes: Vec<u8>,
}

impl std::fmt::Debug for SecretHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretHandle")
            .field("service", &self.service)
            .field("account", &self.account)
            .field("bytes", &"<redacted>")
            .finish()
    }
}

impl SecretHandle {
    pub fn from_bytes(service: impl Into<String>, account: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
            bytes,
        }
    }

    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&self.bytes);
        hex::encode(h.finalize())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub trait SecretProvider: Send + Sync {
    fn lookup(&self, service: &str, account: &str) -> Result<SecretHandle, BrokerError>;
}

/// macOS Keychain-backed provider (Flight 2). Lookup only — no mint/provision.
#[cfg(target_os = "macos")]
pub struct KeychainSecretProvider;

#[cfg(target_os = "macos")]
impl SecretProvider for KeychainSecretProvider {
    fn lookup(&self, service: &str, account: &str) -> Result<SecretHandle, BrokerError> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(service, account) {
            Ok(bytes) => Ok(SecretHandle::from_bytes(service, account, bytes)),
            Err(_) => Err(BrokerError::UnverifiedIdentity),
        }
    }
}

/// Linux / unsupported: fail closed until configured.
pub struct FailClosedSecretProvider;

impl SecretProvider for FailClosedSecretProvider {
    fn lookup(&self, _service: &str, _account: &str) -> Result<SecretHandle, BrokerError> {
        Err(BrokerError::UnsupportedContract)
    }
}

pub fn platform_secret_provider() -> Box<dyn SecretProvider> {
    #[cfg(target_os = "macos")]
    {
        Box::new(KeychainSecretProvider)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(FailClosedSecretProvider)
    }
}

/// In-memory provider for fixtures only.
pub struct MemorySecretProvider {
    pub entries: Vec<(String, String, Vec<u8>)>,
}

impl SecretProvider for MemorySecretProvider {
    fn lookup(&self, service: &str, account: &str) -> Result<SecretHandle, BrokerError> {
        self.entries
            .iter()
            .find(|(s, a, _)| s == service && a == account)
            .map(|(_, _, b)| SecretHandle::from_bytes(service, account, b.clone()))
            .ok_or(BrokerError::UnverifiedIdentity)
    }
}
