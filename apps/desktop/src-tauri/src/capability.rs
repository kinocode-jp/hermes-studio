use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    process::Child,
    sync::{Mutex, MutexGuard, TryLockError},
    thread,
    time::Instant,
};

use tauri::Manager;

use crate::constants::{
    CHILD_POLL_INTERVAL, HEALTH_RESPONSE_TIMEOUT, STUDIO_SERVER_PORT, OWNED_SERVER_MONITOR_INTERVAL,
    OWNED_SERVER_TRANSIENT_FAILURE_LIMIT,
};
use crate::hex_util::{decode_lower_hex_32, random_hex};
use crate::http::remaining_timeout;
use crate::proof::{desktop_readiness_proof_outcome, DesktopProofOutcome};

pub(crate) struct StudioServerProcess(pub(crate) Mutex<Option<Child>>);
pub(crate) struct DesktopCapability(pub(crate) Mutex<Option<String>>);
pub(crate) struct AttachedServerCapability(pub(crate) Mutex<Option<String>>);
pub(crate) struct DesktopProofGate(pub(crate) Mutex<()>);

const DESKTOP_CAPABILITY_FILE: &str = "desktop-capability";
const DESKTOP_CAPABILITY_LOCK_FILE: &str = ".desktop-capability.lock";

#[tauri::command]
pub(crate) async fn desktop_capability(app: tauri::AppHandle) -> Option<String> {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(capability) => Some(capability),
        OwnedCapabilityOutcome::Invalid => {
            close_owned_desktop_window(&app);
            None
        }
        // Attached existing Studio Server: no capability, no window close.
        OwnedCapabilityOutcome::NotOwned | OwnedCapabilityOutcome::TransientUnavailable => None,
    }
}

#[tauri::command]
pub(crate) async fn desktop_owned(app: tauri::AppHandle) -> Result<bool, String> {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => Ok(true),
        OwnedCapabilityOutcome::Invalid => {
            close_owned_desktop_window(&app);
            Err("Hermes Studio desktop ownership is no longer valid.".into())
        }
        // The packaged and desktop-development WebViews only open after this
        // shell starts an owned child. Never downgrade those trusted origins to
        // browser cookie auth when the proof is missing or temporarily busy.
        OwnedCapabilityOutcome::NotOwned => {
            Err("Hermes Studio does not own a local desktop server.".into())
        }
        OwnedCapabilityOutcome::TransientUnavailable => {
            Err("Hermes Studio desktop ownership is temporarily unavailable.".into())
        }
    }
}

pub(crate) enum OwnedCapabilityOutcome {
    Valid(String),
    /// This process owns no child, as on a fixed notice or authenticated attachment.
    NotOwned,
    Invalid,
    TransientUnavailable,
}

pub(crate) enum BoundedLockError {
    TimedOut,
    Poisoned,
}

pub(crate) fn lock_until<T>(
    mutex: &Mutex<T>,
    deadline: Instant,
) -> Result<MutexGuard<'_, T>, BoundedLockError> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(BoundedLockError::Poisoned),
            Err(TryLockError::WouldBlock) => {
                let Some(delay) = remaining_timeout(deadline, CHILD_POLL_INTERVAL) else {
                    return Err(BoundedLockError::TimedOut);
                };
                thread::sleep(delay);
            }
        }
    }
}

pub(crate) fn authenticated_owned_capability(app: &tauri::AppHandle) -> OwnedCapabilityOutcome {
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let proof_gate_state = app.state::<DesktopProofGate>();
    let _proof_gate = match lock_until(&proof_gate_state.0, deadline) {
        Ok(proof_gate) => proof_gate,
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return invalid_owned_capability(app, None),
    };
    let capability_state = app.state::<DesktopCapability>();
    let capability = match lock_until(&capability_state.0, deadline) {
        Ok(capability) => capability.clone(),
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return invalid_owned_capability(app, None),
    };
    let Some(capability) = capability else {
        // No owned child and no desktop capability. Do not treat this as
        // Invalid (which closes the window); a fixed startup notice may still
        // be using the native window.
        return OwnedCapabilityOutcome::NotOwned;
    };
    match owned_child_outcome(app, deadline) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            return invalid_owned_capability(app, Some(&capability));
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, STUDIO_SERVER_PORT));
    match desktop_readiness_proof_outcome(
        address,
        &capability,
        deadline,
    ) {
        DesktopProofOutcome::Valid => {}
        DesktopProofOutcome::Invalid => {
            return invalid_owned_capability(app, Some(&capability));
        }
        DesktopProofOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    match owned_child_outcome(app, deadline) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            return invalid_owned_capability(app, Some(&capability));
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let current = match lock_until(&capability_state.0, deadline) {
        Ok(current) => current,
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => {
            return invalid_owned_capability(app, Some(&capability))
        }
    };
    if current.as_deref() == Some(capability.as_str()) {
        OwnedCapabilityOutcome::Valid(capability)
    } else {
        drop(current);
        invalid_owned_capability(app, Some(&capability))
    }
}

fn invalid_owned_capability(
    app: &tauri::AppHandle,
    expected: Option<&str>,
) -> OwnedCapabilityOutcome {
    let capability_state = app.state::<DesktopCapability>();
    let removed = {
        let mut current = capability_state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match expected {
            Some(expected) if current.as_deref() == Some(expected) => current.take(),
            Some(_) => None,
            None => current.take(),
        }
    };
    // Remove only the proof that this validation attempt owned. If a new owner
    // replaced it concurrently, compare-and-remove preserves the new proof.
    if let Some(capability) = removed.as_deref().or(expected) {
        remove_persisted_desktop_capability_if_matches(app, capability);
    }
    OwnedCapabilityOutcome::Invalid
}

pub(crate) fn clear_optional_state<T>(state: &Mutex<Option<T>>) {
    let mut value = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *value = None;
}

enum OwnedChildOutcome {
    Running,
    Exited,
    TransientUnavailable,
    InvalidState,
}

fn owned_child_outcome(app: &tauri::AppHandle, deadline: Instant) -> OwnedChildOutcome {
    let process_state = app.state::<StudioServerProcess>();
    let mut process = match lock_until(&process_state.0, deadline) {
        Ok(process) => process,
        Err(BoundedLockError::TimedOut) => return OwnedChildOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return OwnedChildOutcome::InvalidState,
    };
    let Some(child) = process.as_mut() else {
        return OwnedChildOutcome::Exited;
    };
    match child.try_wait() {
        Ok(None) => OwnedChildOutcome::Running,
        Ok(Some(_)) => OwnedChildOutcome::Exited,
        Err(_) => OwnedChildOutcome::TransientUnavailable,
    }
}

pub(crate) fn close_owned_desktop_window(app: &tauri::AppHandle) {
    // Exit through the normal application lifecycle so the owned child and its
    // persisted attach proof are cleaned up. Destroying only the WebView leaves
    // a headless native process and can orphan a healthy child after a transient
    // proof outage.
    app.exit(1);
}

pub(crate) fn monitor_outcome_requires_invalidation(
    outcome: &OwnedCapabilityOutcome,
    consecutive_transient_failures: &mut u8,
) -> bool {
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => {
            *consecutive_transient_failures = 0;
            false
        }
        OwnedCapabilityOutcome::NotOwned => false,
        OwnedCapabilityOutcome::Invalid => true,
        OwnedCapabilityOutcome::TransientUnavailable => {
            *consecutive_transient_failures =
                (*consecutive_transient_failures).saturating_add(1);
            *consecutive_transient_failures >= OWNED_SERVER_TRANSIENT_FAILURE_LIMIT
        }
    }
}

pub(crate) fn start_owned_server_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut consecutive_transient_failures = 0_u8;
        loop {
            thread::sleep(OWNED_SERVER_MONITOR_INTERVAL);
            let outcome = authenticated_owned_capability(&app);
            if monitor_outcome_requires_invalidation(
                &outcome,
                &mut consecutive_transient_failures,
            ) {
                close_owned_desktop_window(&app);
                return;
            }
        }
    });
}

pub(crate) fn start_attached_server_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut consecutive_transient_failures = 0_u8;
        loop {
            thread::sleep(OWNED_SERVER_MONITOR_INTERVAL);
            let attached_state = app.state::<AttachedServerCapability>();
            let capability = match attached_state.0.lock() {
                Ok(value) => value.clone(),
                Err(_) => {
                    app.exit(1);
                    return;
                }
            };
            let Some(capability) = capability else {
                return;
            };
            let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
            let address = SocketAddr::from((Ipv4Addr::LOCALHOST, STUDIO_SERVER_PORT));
            let outcome = match desktop_readiness_proof_outcome(address, &capability, deadline) {
                DesktopProofOutcome::Valid => OwnedCapabilityOutcome::Valid(capability),
                DesktopProofOutcome::Invalid => OwnedCapabilityOutcome::Invalid,
                DesktopProofOutcome::TransientUnavailable => {
                    OwnedCapabilityOutcome::TransientUnavailable
                }
            };
            if monitor_outcome_requires_invalidation(
                &outcome,
                &mut consecutive_transient_failures,
            ) {
                clear_optional_state(&app.state::<AttachedServerCapability>().0);
                // This process does not own the listener, so do not stop it.
                // Exiting prevents a replaced listener from entering the branded
                // WebView and avoids an unrecoverable headless window state.
                app.exit(1);
                return;
            }
        }
    });
}

pub(crate) fn persist_desktop_capability(
    app: &tauri::AppHandle,
    capability: &str,
) -> Result<(), String> {
    if decode_lower_hex_32(capability).is_none() {
        return Err("Desktop capability is invalid.".into());
    }
    let directory = desktop_capability_directory(app)?;
    let _capability_lock = lock_capability_directory(&directory)?;
    let path = directory.join(DESKTOP_CAPABILITY_FILE);
    let temporary = directory.join(format!(
        ".{DESKTOP_CAPABILITY_FILE}.{}.{}",
        std::process::id(),
        random_hex::<8>()
    ));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Desktop capability file could not be created.".to_owned())?;
        file.write_all(capability.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Desktop capability file could not be written.".to_owned())?;
        drop(file);
        set_private_path_permissions(&temporary, false)?;
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|_| "Previous desktop capability file could not be replaced.".to_owned())?;
        }
        fs::rename(&temporary, &path)
            .map_err(|_| "Desktop capability file could not be installed.".to_owned())?;
        set_private_path_permissions(&path, false)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        remove_capability_path_if_matches(&path, capability);
    }
    result
}

pub(crate) fn read_persisted_desktop_capability(app: &tauri::AppHandle) -> Option<String> {
    let path = desktop_capability_path(app).ok()?;
    let directory = path.parent()?;
    let _capability_lock = lock_capability_directory(directory).ok()?;
    read_capability_path(&path)
}

pub(crate) fn remove_persisted_desktop_capability_if_matches(
    app: &tauri::AppHandle,
    expected: &str,
) {
    if decode_lower_hex_32(expected).is_none() {
        return;
    }
    if let Ok(path) = desktop_capability_path(app) {
        let Some(directory) = path.parent() else {
            return;
        };
        let Ok(_capability_lock) = lock_capability_directory(directory) else {
            return;
        };
        remove_capability_path_if_matches(&path, expected);
    }
}

fn read_capability_path(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return None;
        }
    }
    #[cfg(target_os = "windows")]
    set_private_path_permissions(path, false).ok()?;
    let value = fs::read_to_string(path).ok()?;
    decode_lower_hex_32(&value).map(|_| value)
}

fn remove_capability_path_if_matches(path: &Path, expected: &str) {
    // Every reader, writer, and remover holds the cross-process lock. The
    // content check and unlink therefore form one ownership transaction: an
    // old desktop cannot delete a replacement owner's freshly-renamed proof.
    if read_capability_path(path).as_deref() == Some(expected) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(unix)]
struct CapabilityFileLock(fs::File);

#[cfg(unix)]
impl Drop for CapabilityFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(unix)]
fn lock_capability_directory(directory: &Path) -> Result<CapabilityFileLock, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let path = directory.join(DESKTOP_CAPABILITY_LOCK_FILE);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(&path)
        .map_err(|_| "Desktop capability lock could not be opened.".to_owned())?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "Desktop capability lock permissions could not be secured.".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Desktop capability lock is unavailable.".to_owned())?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("Desktop capability lock is not private.".into());
    }

    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(CapabilityFileLock(file));
        }
        let error = std::io::Error::last_os_error();
        let retryable = matches!(error.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EINTR));
        if !retryable || Instant::now() >= deadline {
            return Err("Desktop capability lock is busy.".into());
        }
        thread::sleep(CHILD_POLL_INTERVAL);
    }
}

#[cfg(target_os = "windows")]
struct CapabilityFileLock {
    _file: fs::File,
}

#[cfg(target_os = "windows")]
fn lock_capability_directory(directory: &Path) -> Result<CapabilityFileLock, String> {
    use std::os::windows::fs::OpenOptionsExt;

    let path = directory.join(DESKTOP_CAPABILITY_LOCK_FILE);
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    loop {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            // No sharing: the open handle is the cross-process lock.
            .share_mode(0);
        match options.open(&path) {
            Ok(file) => {
                set_private_path_permissions(&path, false)?;
                if !file.metadata().map(|value| value.is_file()).unwrap_or(false) {
                    return Err("Desktop capability lock is unavailable.".into());
                }
                return Ok(CapabilityFileLock { _file: file });
            }
            Err(error)
                if matches!(error.raw_os_error(), Some(32) | Some(33))
                    && Instant::now() < deadline =>
            {
                thread::sleep(CHILD_POLL_INTERVAL);
            }
            Err(_) => return Err("Desktop capability lock could not be opened.".into()),
        }
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
struct CapabilityFileLock;

#[cfg(not(any(unix, target_os = "windows")))]
fn lock_capability_directory(_directory: &Path) -> Result<CapabilityFileLock, String> {
    Ok(CapabilityFileLock)
}

fn desktop_capability_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(desktop_capability_directory(app)?.join(DESKTOP_CAPABILITY_FILE))
}

fn desktop_capability_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Desktop capability local app-data directory is unavailable.".to_owned())?;
    fs::create_dir_all(&directory)
        .map_err(|_| "Desktop capability directory could not be created.".to_owned())?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|_| "Desktop capability directory is unavailable.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Desktop capability directory is invalid.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Desktop capability directory has an invalid owner.".into());
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Desktop capability directory permissions could not be secured.".to_owned())?;
    }
    #[cfg(target_os = "windows")]
    set_private_path_permissions(&directory, true)?;
    Ok(directory)
}

fn set_private_path_permissions(path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| {
            "Desktop capability path permissions could not be secured.".to_owned()
        })?;
    }
    #[cfg(target_os = "windows")]
    set_private_windows_acl(path, directory)?;
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = (path, directory);
        return Err("Private desktop capability permissions are unsupported.".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_private_windows_acl(path: &Path, directory: bool) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};

    const SDDL_REVISION_1: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;

    let sid = current_windows_user_sid()?;
    let sddl = if directory {
        format!("D:P(A;OICI;GA;;;{sid})")
    } else {
        format!("D:P(A;;GA;;;{sid})")
    };
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let path_wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor: *mut c_void = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(format!(
            "Desktop capability ACL could not be created: {}",
            std::io::Error::last_os_error()
        ));
    }
    let secured = unsafe {
        SetFileSecurityW(
            path_wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if secured == 0 {
        return Err(format!(
            "Desktop capability ACL could not be applied: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn current_windows_user_sid() -> Result<String, String> {
    use std::{ffi::c_void, mem, ptr, slice};

    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER_CLASS: u32 = 1;

    let mut token: *mut c_void = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "Current Windows user token could not be opened: {}",
            std::io::Error::last_os_error()
        ));
    }

    let result = (|| -> Result<String, String> {
        let mut required = 0_u32;
        unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                ptr::null_mut(),
                0,
                &mut required,
            );
        }
        if required == 0 {
            return Err(format!(
                "Current Windows user identity size is unavailable: {}",
                std::io::Error::last_os_error()
            ));
        }
        let word_size = mem::size_of::<usize>();
        let mut token_user = vec![0_usize; (required as usize).div_ceil(word_size)];
        if unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                token_user.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(format!(
                "Current Windows user identity could not be read: {}",
                std::io::Error::last_os_error()
            ));
        }

        // TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first field is PSID.
        let sid = unsafe { *(token_user.as_ptr().cast::<*mut c_void>()) };
        if sid.is_null() {
            return Err("Current Windows user SID is unavailable.".into());
        }
        let mut sid_text: *mut u16 = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 || sid_text.is_null() {
            return Err(format!(
                "Current Windows user SID could not be converted: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut length = 0_usize;
        unsafe {
            while *sid_text.add(length) != 0 {
                length += 1;
            }
        }
        let value = String::from_utf16(unsafe { slice::from_raw_parts(sid_text, length) })
            .map_err(|_| "Current Windows user SID is invalid.".to_owned());
        unsafe {
            LocalFree(sid_text.cast());
        }
        value
    })();

    unsafe {
        CloseHandle(token);
    }
    result
}

#[cfg(target_os = "windows")]
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(
        process_handle: *mut std::ffi::c_void,
        desired_access: u32,
        token_handle: *mut *mut std::ffi::c_void,
    ) -> i32;
    fn GetTokenInformation(
        token_handle: *mut std::ffi::c_void,
        token_information_class: u32,
        token_information: *mut std::ffi::c_void,
        token_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(
        sid: *mut std::ffi::c_void,
        string_sid: *mut *mut u16,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string_security_descriptor: *const u16,
        string_sd_revision: u32,
        security_descriptor: *mut *mut std::ffi::c_void,
        security_descriptor_size: *mut u32,
    ) -> i32;
    fn SetFileSecurityW(
        file_name: *const u16,
        security_information: u32,
        security_descriptor: *mut std::ffi::c_void,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}
