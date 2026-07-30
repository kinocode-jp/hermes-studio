use std::{collections::BTreeMap, env, ffi::OsString};

use serde::{Deserialize, Serialize};

const PERSIST_ENV: &str = "HERMES_STUDIO_PERSIST_REMOTE_CONFIG";
const CONFIG_VERSION: u8 = 1;
const MIN_TOKEN_LENGTH: usize = 32;
const MAX_TOKEN_LENGTH: usize = 4_096;
const MAX_KEYCHAIN_PAYLOAD: usize = 32 * 1024;
const MAX_ALLOWED_ORIGINS: usize = 16;
const PERSISTED_REMOTE_SUFFIXES: [&str; 4] = [
    "REMOTE_TOKEN",
    "ALLOWED_ORIGINS",
    "TRUSTED_PROXY_HOPS",
    "REMOTE_PRIVILEGED",
];

/// Remote values loaded from the user's macOS keychain. Environment values
/// supplied for the current launch always take precedence in `server.rs`.
pub(crate) struct DesktopRemoteEnvironment {
    values: BTreeMap<&'static str, OsString>,
}

impl DesktopRemoteEnvironment {
    pub(crate) fn lookup(&self, key: &str) -> Option<OsString> {
        let suffix = key.strip_prefix("HERMES_STUDIO_")?;
        self.values.get(suffix).cloned()
    }

    fn empty() -> Self {
        Self {
            values: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRemoteConfiguration {
    version: u8,
    remote_token: String,
    allowed_origins: Vec<String>,
    trusted_proxy_hops: u8,
    remote_privileged: bool,
}

impl StoredRemoteConfiguration {
    fn from_environment() -> Result<Self, String> {
        let remote_token = required_brand_env("REMOTE_TOKEN")?;
        let allowed_origins = required_brand_env("ALLOWED_ORIGINS")?
            .split(',')
            .map(str::trim)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let trusted_proxy_hops = required_brand_env("TRUSTED_PROXY_HOPS")?
            .parse::<u8>()
            .map_err(|_| "Trusted proxy hops are invalid for keychain persistence.".to_owned())?;
        let remote_privileged = match required_brand_env("REMOTE_PRIVILEGED")?.as_str() {
            "true" => true,
            _ => return Err("Remote privileged access is invalid for keychain persistence.".to_owned()),
        };
        let configuration = Self {
            version: CONFIG_VERSION,
            remote_token,
            allowed_origins,
            trusted_proxy_hops,
            remote_privileged,
        };
        configuration.validate()?;
        Ok(configuration)
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != CONFIG_VERSION {
            return Err("The saved remote configuration version is unsupported.".to_owned());
        }
        let token_length = self.remote_token.encode_utf16().count();
        if !(MIN_TOKEN_LENGTH..=MAX_TOKEN_LENGTH).contains(&token_length)
            || self.remote_token.contains('\0')
        {
            return Err("The saved remote enrollment token is invalid.".to_owned());
        }
        if self.allowed_origins.is_empty() || self.allowed_origins.len() > MAX_ALLOWED_ORIGINS {
            return Err("The saved remote origin list is invalid.".to_owned());
        }
        let mut remote_origins = 0usize;
        for origin in &self.allowed_origins {
            let parsed = tauri::Url::parse(origin)
                .map_err(|_| "The saved remote origin list is invalid.".to_owned())?;
            if parsed.username() != ""
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || parsed.path() != "/"
                || parsed.origin().ascii_serialization() != origin.as_str()
            {
                return Err("The saved remote origin list is invalid.".to_owned());
            }
            let hostname = parsed
                .host_str()
                .ok_or_else(|| "The saved remote origin list is invalid.".to_owned())?
                .to_ascii_lowercase();
            let loopback = matches!(hostname.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]");
            if loopback {
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err("The saved remote origin list is invalid.".to_owned());
                }
                continue;
            }
            remote_origins += 1;
            if parsed.scheme() != "https"
                || parsed.port().is_some()
                || !valid_tailscale_hostname(&hostname)
            {
                return Err("The saved remote origin list is invalid.".to_owned());
            }
        }
        if remote_origins != 1 {
            return Err("The saved remote configuration must contain one Tailnet HTTPS origin.".to_owned());
        }
        if !(1..=8).contains(&self.trusted_proxy_hops) || !self.remote_privileged {
            return Err("The saved remote proxy configuration is invalid.".to_owned());
        }
        Ok(())
    }

    fn into_environment(self) -> DesktopRemoteEnvironment {
        let mut values = BTreeMap::new();
        values.insert("REMOTE_TOKEN", OsString::from(self.remote_token));
        values.insert("ALLOWED_ORIGINS", OsString::from(self.allowed_origins.join(",")));
        values.insert(
            "TRUSTED_PROXY_HOPS",
            OsString::from(self.trusted_proxy_hops.to_string()),
        );
        values.insert("REMOTE_PRIVILEGED", OsString::from("true"));
        DesktopRemoteEnvironment { values }
    }
}

pub(crate) fn prepare_desktop_remote_environment() -> Result<DesktopRemoteEnvironment, String> {
    let persist = persist_requested()?;
    if persist {
        let configuration = StoredRemoteConfiguration::from_environment()?;
        persist_configuration(&configuration)?;
        return Ok(configuration.into_environment());
    }

    // Any explicit remote value, including an empty Studio value, suppresses
    // the entire stored fallback. Never mix part of one persisted deployment
    // with part of a process environment deployment.
    if PERSISTED_REMOTE_SUFFIXES.iter().any(|suffix| brand_env_present(suffix)) {
        return Ok(DesktopRemoteEnvironment::empty());
    }

    match load_configuration()? {
        Some(configuration) => Ok(configuration.into_environment()),
        None => Ok(DesktopRemoteEnvironment::empty()),
    }
}

fn persist_requested() -> Result<bool, String> {
    match env::var_os(PERSIST_ENV) {
        None => Ok(false),
        Some(value) if value.is_empty() => Ok(false),
        Some(value) if value.to_str() == Some("true") => Ok(true),
        Some(_) => Err("The desktop remote persistence request is invalid.".to_owned()),
    }
}

fn brand_env_present(suffix: &str) -> bool {
    env::var_os(format!("HERMES_STUDIO_{suffix}")).is_some()
        || env::var_os(format!("HERMES_OFFICE_{suffix}")).is_some()
}

fn required_brand_env(suffix: &str) -> Result<String, String> {
    let studio_key = format!("HERMES_STUDIO_{suffix}");
    let legacy_key = format!("HERMES_OFFICE_{suffix}");
    let value = match env::var_os(&studio_key) {
        Some(value) => value,
        None => env::var_os(&legacy_key)
            .ok_or_else(|| "The remote environment is incomplete for keychain persistence.".to_owned())?,
    };
    let value = value
        .into_string()
        .map_err(|_| "The remote environment must be valid UTF-8 for keychain persistence.".to_owned())?;
    if value.is_empty() {
        return Err("The remote environment is incomplete for keychain persistence.".to_owned());
    }
    Ok(value)
}

fn valid_tailscale_hostname(hostname: &str) -> bool {
    if hostname.len() < 8 || hostname.len() > 253 || !hostname.ends_with(".ts.net") {
        return false;
    }
    hostname.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && label.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
            && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

#[cfg(target_os = "macos")]
fn persist_configuration(configuration: &StoredRemoteConfiguration) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(configuration)
        .map_err(|_| "The remote configuration could not be encoded for Keychain.".to_owned())?;
    if encoded.len() > MAX_KEYCHAIN_PAYLOAD {
        encoded.fill(0);
        return Err("The remote configuration is too large for Keychain persistence.".to_owned());
    }
    let result = macos_keychain::upsert(&encoded);
    encoded.fill(0);
    result
}

#[cfg(not(target_os = "macos"))]
fn persist_configuration(_configuration: &StoredRemoteConfiguration) -> Result<(), String> {
    Err("Desktop remote persistence currently requires macOS Keychain.".to_owned())
}

#[cfg(target_os = "macos")]
fn load_configuration() -> Result<Option<StoredRemoteConfiguration>, String> {
    let Some(mut encoded) = macos_keychain::read()? else {
        return Ok(None);
    };
    if encoded.len() > MAX_KEYCHAIN_PAYLOAD {
        encoded.fill(0);
        return Err("The saved remote Keychain entry is too large.".to_owned());
    }
    let decoded = serde_json::from_slice::<StoredRemoteConfiguration>(&encoded)
        .map_err(|_| "The saved remote Keychain entry is invalid.".to_owned());
    encoded.fill(0);
    let configuration = decoded?;
    configuration.validate()?;
    Ok(Some(configuration))
}

#[cfg(not(target_os = "macos"))]
fn load_configuration() -> Result<Option<StoredRemoteConfiguration>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
mod macos_keychain {
    use std::{ffi::c_void, ptr, slice};

    const SERVICE: &[u8] = b"app.hermesoffice.desktop.remote-config";
    const ACCOUNT: &[u8] = b"tailnet-owner";
    const ERR_SEC_SUCCESS: i32 = 0;
    const ERR_SEC_DUPLICATE_ITEM: i32 = -25_299;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
    const MAX_DATA_LENGTH: u32 = 32 * 1024;

    type SecKeychainItemRef = *mut c_void;

    struct ItemRef(SecKeychainItemRef);

    impl Drop for ItemRef {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0.cast_const()) };
            }
        }
    }

    pub(super) fn read() -> Result<Option<Vec<u8>>, String> {
        let mut length = 0u32;
        let mut data: *mut c_void = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                &mut length,
                &mut data,
                ptr::null_mut(),
            )
        };
        if status == ERR_SEC_ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != ERR_SEC_SUCCESS {
            return Err(status_error("read", status));
        }
        if data.is_null() && length != 0 {
            return Err("macOS Keychain returned invalid remote configuration data.".to_owned());
        }
        if length > MAX_DATA_LENGTH {
            if !data.is_null() {
                unsafe { SecKeychainItemFreeContent(ptr::null_mut(), data) };
            }
            return Err("The saved remote Keychain entry is too large.".to_owned());
        }
        let bytes = if length == 0 {
            Vec::new()
        } else {
            unsafe { slice::from_raw_parts(data.cast::<u8>(), length as usize).to_vec() }
        };
        let free_status = if data.is_null() {
            ERR_SEC_SUCCESS
        } else {
            unsafe { SecKeychainItemFreeContent(ptr::null_mut(), data) }
        };
        if free_status != ERR_SEC_SUCCESS {
            let mut bytes = bytes;
            bytes.fill(0);
            return Err(status_error("release", free_status));
        }
        Ok(Some(bytes))
    }

    pub(super) fn upsert(data: &[u8]) -> Result<(), String> {
        let length = u32::try_from(data.len())
            .map_err(|_| "The remote configuration is too large for macOS Keychain.".to_owned())?;
        if let Some(item) = find_item()? {
            return modify_item(&item, length, data);
        }
        let status = unsafe {
            SecKeychainAddGenericPassword(
                ptr::null_mut(),
                SERVICE.len() as u32,
                SERVICE.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                length,
                data.as_ptr().cast(),
                ptr::null_mut(),
            )
        };
        if status == ERR_SEC_SUCCESS {
            return Ok(());
        }
        if status == ERR_SEC_DUPLICATE_ITEM {
            let item = find_item()?.ok_or_else(|| {
                "macOS Keychain reported a duplicate remote configuration that could not be reopened.".to_owned()
            })?;
            return modify_item(&item, length, data);
        }
        Err(status_error("store", status))
    }

    fn find_item() -> Result<Option<ItemRef>, String> {
        let mut item: SecKeychainItemRef = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr().cast(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr().cast(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        match status {
            ERR_SEC_SUCCESS if !item.is_null() => Ok(Some(ItemRef(item))),
            ERR_SEC_SUCCESS => Err("macOS Keychain returned an invalid remote configuration item.".to_owned()),
            ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            _ => Err(status_error("open", status)),
        }
    }

    fn modify_item(item: &ItemRef, length: u32, data: &[u8]) -> Result<(), String> {
        let status = unsafe {
            SecKeychainItemModifyAttributesAndData(
                item.0,
                ptr::null(),
                length,
                data.as_ptr().cast(),
            )
        };
        if status == ERR_SEC_SUCCESS {
            Ok(())
        } else {
            Err(status_error("update", status))
        }
    }

    fn status_error(operation: &str, status: i32) -> String {
        format!("macOS Keychain could not {operation} the remote configuration (status {status}).")
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainAddGenericPassword(
            keychain: *mut c_void,
            service_name_length: u32,
            service_name: *const i8,
            account_name_length: u32,
            account_name: *const i8,
            password_length: u32,
            password_data: *const c_void,
            item_ref: *mut SecKeychainItemRef,
        ) -> i32;
        fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_name_length: u32,
            service_name: *const i8,
            account_name_length: u32,
            account_name: *const i8,
            password_length: *mut u32,
            password_data: *mut *mut c_void,
            item_ref: *mut SecKeychainItemRef,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item_ref: SecKeychainItemRef,
            attribute_list: *const c_void,
            length: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attribute_list: *mut c_void, data: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
}

#[cfg(test)]
mod tests {
    use super::{valid_tailscale_hostname, StoredRemoteConfiguration, CONFIG_VERSION};

    fn valid_configuration() -> StoredRemoteConfiguration {
        StoredRemoteConfiguration {
            version: CONFIG_VERSION,
            remote_token: "a".repeat(32),
            allowed_origins: vec!["https://macbook.example.ts.net".to_owned()],
            trusted_proxy_hops: 1,
            remote_privileged: true,
        }
    }

    #[test]
    fn saved_remote_configuration_requires_one_exact_tailnet_origin() {
        assert!(valid_configuration().validate().is_ok());
        let mut insecure = valid_configuration();
        insecure.allowed_origins = vec!["http://macbook.example.ts.net".to_owned()];
        assert!(insecure.validate().is_err());
        let mut alternate = valid_configuration();
        alternate.allowed_origins.push("https://other.example.ts.net".to_owned());
        assert!(alternate.validate().is_err());
        let mut alternate_port = valid_configuration();
        alternate_port.allowed_origins = vec!["https://macbook.example.ts.net:8443".to_owned()];
        assert!(alternate_port.validate().is_err());
    }

    #[test]
    fn saved_remote_configuration_rejects_invalid_token_and_proxy_shape() {
        let mut short = valid_configuration();
        short.remote_token = "short".to_owned();
        assert!(short.validate().is_err());
        let mut hops = valid_configuration();
        hops.trusted_proxy_hops = 0;
        assert!(hops.validate().is_err());
        let mut unprivileged = valid_configuration();
        unprivileged.remote_privileged = false;
        assert!(unprivileged.validate().is_err());
    }

    #[test]
    fn tailscale_hostname_validation_is_strict() {
        assert!(valid_tailscale_hostname("macbook.example.ts.net"));
        assert!(!valid_tailscale_hostname("example.com"));
        assert!(!valid_tailscale_hostname("-macbook.example.ts.net"));
        assert!(!valid_tailscale_hostname("macbook..example.ts.net"));
    }
}
