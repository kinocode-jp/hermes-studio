use std::time::Duration;

pub(crate) const OFFICE_HOST: &str = "127.0.0.1";
pub(crate) const OFFICE_PORT: u16 = 4317;
pub(crate) const OFFICE_URL: &str = "http://127.0.0.1:4317/";
pub(crate) const OFFICE_PROTOCOL_VERSION: i64 = 1;
pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(50);
pub(crate) const STOP_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
pub(crate) const HEALTH_RESPONSE_TIMEOUT: Duration = Duration::from_millis(750);
pub(crate) const OWNED_SERVER_MONITOR_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const OWNED_SERVER_TRANSIENT_FAILURE_LIMIT: u8 = 3;
pub(crate) const HTTP_READ_SLICE: Duration = Duration::from_millis(250);
pub(crate) const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);
pub(crate) const MAX_VERSION_OUTPUT: u64 = 4096;
pub(crate) const MAX_HEALTH_RESPONSE: u64 = 4096;
pub(crate) const MAX_WEB_UI_RESPONSE: usize = 128 * 1024;
// Compatibility proof domain shared with the server HMAC. Do not rename without
// a dual-domain rollout — existing desktop builds verify this exact string.
pub(crate) const DESKTOP_PROOF_DOMAIN: &str = "hermes-office-desktop-readiness";
pub(crate) const DESKTOP_PROOF_VERSION: &str = "1";
pub(crate) const DESKTOP_PROOF_NONCE_BYTES: usize = 32;
pub(crate) const SUPPORTED_NODE_MAJOR: u64 = 22;
