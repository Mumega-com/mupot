use crate::*;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub origin: String,
    pub agent_id: String,
    pub agent_slug: String,
    pub tenant: String,
    pub expires_unix: u64,
}
impl Profile {
    pub fn account(&self) -> String {
        format!("{}|{}", self.origin, self.agent_id)
    }
}
pub struct ProfileRepository {
    directory: File,
    lock: Mutex<()>,
}
pub fn default_directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or(Error::Storage)?;
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(home).join("Library/Application Support/Mupot Connect"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PathBuf::from(home).join(".local/share/mupot-connect"))
    }
}
impl ProfileRepository {
    pub fn open(path: PathBuf) -> Result<Self> {
        #[cfg(unix)]
        {
            if !path.is_absolute() {
                return Err(Error::Storage);
            }
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => return Err(Error::Storage),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let parent = path.parent().ok_or(Error::Storage)?;
                    std::fs::create_dir_all(parent).map_err(|_| Error::Storage)?;
                    std::fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&path)
                        .map_err(|_| Error::Storage)?;
                }
                Err(_) => return Err(Error::Storage),
            }
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|_| Error::Storage)?;
            private(&directory, true)?;
            Ok(Self {
                directory,
                lock: Mutex::new(()),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err(Error::Unsupported)
        }
    }
    pub fn list(&self) -> Result<Vec<Profile>> {
        let _guard = self.lock.lock().map_err(|_| Error::Storage)?;
        self.read_profiles()
    }
    pub fn save(
        &self,
        connection: &VerifiedConnection,
        vault: &dyn CredentialVault,
    ) -> Result<Profile> {
        let _guard = self.lock.lock().map_err(|_| Error::Storage)?;
        if connection.is_expired() {
            return Err(Error::Expired);
        }
        let profile = Profile {
            origin: connection.origin.as_str().into(),
            agent_id: connection.snapshot.agent.id.clone(),
            agent_slug: connection.snapshot.agent.slug.clone(),
            tenant: connection.snapshot.tenant.clone(),
            expires_unix: connection.expires_unix,
        };
        validate(&profile)?;
        let mut profiles = self.read_profiles()?;
        profiles.retain(|p| p.account() != profile.account());
        profiles.push(profile.clone());
        let previous = vault.retrieve(&profile.account())?;
        vault.store(&profile.account(), &connection.token)?;
        if self.write_profiles(&profiles).is_err() {
            // Metadata failed: restore the previous app item, or remove this new one.
            match previous {
                Some(secret) => vault.store(&profile.account(), &secret)?,
                None => vault.remove(&profile.account())?,
            };
            return Err(Error::Storage);
        }
        Ok(profile)
    }
    pub fn load(&self, profile: &Profile, vault: &dyn CredentialVault) -> Result<Secret> {
        validate(profile)?;
        if profile.expires_unix <= crate::client::unix_now()? {
            return Err(Error::Expired);
        }
        if !self.list()?.contains(profile) {
            return Err(Error::Storage);
        }
        vault.retrieve(&profile.account())?.ok_or(Error::Storage)
    }
    pub fn forget(&self, profile: &Profile, vault: &dyn CredentialVault) -> Result<()> {
        let _guard = self.lock.lock().map_err(|_| Error::Storage)?;
        validate(profile)?;
        let mut profiles = self.read_profiles()?;
        if !profiles.contains(profile) {
            return Err(Error::Storage);
        }
        vault.remove(&profile.account())?;
        profiles.retain(|p| p.account() != profile.account());
        self.write_profiles(&profiles)
    }
    fn read_profiles(&self) -> Result<Vec<Profile>> {
        #[cfg(unix)]
        {
            private(&self.directory, true)?;
            // SAFETY: constant NUL-terminated basename, directory fd is held open.
            let fd = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    c"profiles.json".as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                    Ok(vec![])
                } else {
                    Err(Error::Storage)
                };
            }
            // SAFETY: newly owned fd returned by openat.
            let file = unsafe { File::from_raw_fd(fd) };
            private(&file, false)?;
            let mut bytes = Vec::new();
            file.take(262145)
                .read_to_end(&mut bytes)
                .map_err(|_| Error::Storage)?;
            if bytes.len() > 262144 {
                return Err(Error::Storage);
            }
            let profiles: Vec<Profile> =
                serde_json::from_slice(&bytes).map_err(|_| Error::Storage)?;
            if profiles.len() > 100 {
                return Err(Error::Storage);
            }
            for profile in &profiles {
                validate(profile)?;
            }
            Ok(profiles)
        }
        #[cfg(not(unix))]
        {
            Err(Error::Unsupported)
        }
    }
    fn write_profiles(&self, profiles: &[Profile]) -> Result<()> {
        #[cfg(unix)]
        {
            static SERIAL: AtomicU64 = AtomicU64::new(0);
            private(&self.directory, true)?;
            let bytes = serde_json::to_vec_pretty(profiles).map_err(|_| Error::Storage)?;
            if profiles.len() > 100 || bytes.len() > 262144 {
                return Err(Error::Storage);
            }
            let name = std::ffi::CString::new(format!(
                ".profiles-{}-{}.tmp",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ))
            .map_err(|_| Error::Storage)?;
            // SAFETY: held directory fd and owned NUL-terminated basename; no path traversal.
            let fd = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(Error::Storage);
            }
            // SAFETY: newly owned fd returned by openat.
            let mut file = unsafe { File::from_raw_fd(fd) };
            let result = (|| {
                private(&file, false)?;
                file.write_all(&bytes).map_err(|_| Error::Storage)?;
                file.sync_all().map_err(|_| Error::Storage)?;
                // Recheck existing destination's kind and permissions before replacing.
                self.read_profiles()?;
                // SAFETY: both paths are relative to this repository's held directory fd.
                if unsafe {
                    libc::renameat(
                        self.directory.as_raw_fd(),
                        name.as_ptr(),
                        self.directory.as_raw_fd(),
                        c"profiles.json".as_ptr(),
                    )
                } < 0
                {
                    return Err(Error::Storage);
                }
                self.directory.sync_all().map_err(|_| Error::Storage)
            })();
            // SAFETY: removes only this call's temporary basename; rename may have consumed it.
            unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
            result
        }
        #[cfg(not(unix))]
        {
            let _ = profiles;
            Err(Error::Unsupported)
        }
    }
}
fn validate(profile: &Profile) -> Result<()> {
    if PotOrigin::parse(&profile.origin)?.as_str() != profile.origin {
        return Err(Error::Storage);
    }
    crate::client::identifier(&profile.agent_id)?;
    crate::client::identifier(&profile.agent_slug)?;
    crate::client::identifier(&profile.tenant)?;
    Ok(())
}
#[cfg(unix)]
fn private(file: &File, directory: bool) -> Result<()> {
    let meta = file.metadata().map_err(|_| Error::Storage)?;
    // SAFETY: geteuid has no arguments or memory preconditions.
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        || if directory {
            !meta.is_dir()
        } else {
            !meta.is_file() || meta.nlink() != 1
        }
    {
        return Err(Error::Storage);
    }
    Ok(())
}
