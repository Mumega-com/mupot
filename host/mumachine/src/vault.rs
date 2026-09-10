use crate::*;
pub const KEYCHAIN_SERVICE: &str = "com.mumega.mupot-connect.credentials.v1";
pub trait CredentialVault: Send + Sync {
    fn store(&self, account: &str, secret: &Secret) -> Result<()>;
    fn retrieve(&self, account: &str) -> Result<Option<Secret>>;
    fn remove(&self, account: &str) -> Result<()>;
}
pub struct KeychainVault;
impl CredentialVault for KeychainVault {
    fn store(&self, account: &str, secret: &Secret) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            security_framework::passwords::set_generic_password(
                KEYCHAIN_SERVICE,
                account,
                secret.expose().as_bytes(),
            )
            .map_err(|_| Error::Storage)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (account, secret);
            Err(Error::Unsupported)
        }
    }
    fn retrieve(&self, account: &str) -> Result<Option<Secret>> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
                Ok(bytes) => {
                    let bytes = zeroize::Zeroizing::new(bytes);
                    let value = std::str::from_utf8(&bytes).map_err(|_| Error::Storage)?;
                    Ok(Some(Secret::new(value)))
                }
                Err(error) if error.code() == -25300 => Ok(None),
                Err(_) => Err(Error::Storage),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = account;
            Err(Error::Unsupported)
        }
    }
    fn remove(&self, account: &str) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account)
            {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err(Error::Storage),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = account;
            Err(Error::Unsupported)
        }
    }
}
