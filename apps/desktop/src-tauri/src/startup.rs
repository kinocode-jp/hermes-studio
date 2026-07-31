use std::path::PathBuf;

use crate::constants::STUDIO_SERVER_PORT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StudioServerStartup {
    /// Loopback port is free; this desktop instance should start and own the
    /// Studio Server child.
    PortFree,
    /// A listener with the expected protocol and Web UI shape is already on
    /// the port. The launcher opens that loopback Web UI without owning or
    /// stopping the process. Public shape checks are not cryptographic identity.
    CompatibleCandidate,
}

/// Successful desktop setup outcomes (failures use [`StartupFailure`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StudioServerLaunch {
    /// Owned child is ready; open the packaged app bundle and enable capability.
    OwnedReady,
    /// Existing compatible listener; open `http://127.0.0.1:4317/` without
    /// capability, child ownership, or killing the process on exit.
    ExistingOpen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartupProbeError {
    Incompatible,
    Malformed,
    Timeout,
    OtherService,
    ExistingWebUiUnavailable,
    ExistingWebUiTimeout,
}

impl std::fmt::Display for StartupProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupProbeError::Incompatible => {
                write!(formatter, "A listener on port {STUDIO_SERVER_PORT} returned a Studio Server health response with an incompatible protocol version. Verify the port owner before closing or updating it.")
            }
            StartupProbeError::Malformed => {
                write!(formatter, "A listener on port {STUDIO_SERVER_PORT} returned a malformed health response. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::Timeout => {
                write!(formatter, "A listener on port {STUDIO_SERVER_PORT} did not complete the health probe in time. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::OtherService => {
                write!(formatter, "Port {STUDIO_SERVER_PORT} is already in use by a service that was not recognized as Hermes Studio. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::ExistingWebUiUnavailable => {
                write!(formatter, "A listener on port {STUDIO_SERVER_PORT} returned the compatible health shape but not the expected Hermes Studio Web UI shape. Verify the port owner before changing that service.")
            }
            StartupProbeError::ExistingWebUiTimeout => {
                write!(formatter, "A listener on port {STUDIO_SERVER_PORT} returned the compatible health shape, but its Web UI probe timed out. Verify the port owner before changing that service.")
            }
        }
    }
}

impl std::error::Error for StartupProbeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupNoticeKind {
    ExistingServerCandidate,
    ExistingServerIncompatible,
    ExistingServerMalformed,
    ExistingServerTimeout,
    PortUsedByOtherService,
    ExistingWebUiUnavailable,
    ExistingWebUiTimeout,
    OwnedManagedRuntimeUnavailable,
    OwnedBundledResourceUnavailable,
    OwnedRemoteConfigurationUnavailable,
    OwnedChildLaunchFailed,
    OwnedServerReadinessFailed,
    InternalStateUnavailable,
}

/// User-facing startup failure with optional diagnostic detail and log path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StartupFailure {
    pub kind: StartupNoticeKind,
    pub detail: Option<String>,
    pub log_path: Option<PathBuf>,
}

impl StartupFailure {
    pub(crate) fn from_kind(kind: StartupNoticeKind) -> Self {
        Self {
            kind,
            detail: None,
            log_path: None,
        }
    }

    pub(crate) fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    #[cfg(test)]
    pub(crate) fn with_log_path(mut self, path: PathBuf) -> Self {
        self.log_path = Some(path);
        self
    }
}

impl From<StartupNoticeKind> for StartupFailure {
    fn from(kind: StartupNoticeKind) -> Self {
        Self::from_kind(kind)
    }
}

impl From<StartupProbeError> for StartupFailure {
    fn from(error: StartupProbeError) -> Self {
        StartupFailure::from_kind(StartupNoticeKind::from(error))
    }
}

impl From<StartupProbeError> for StartupNoticeKind {
    fn from(error: StartupProbeError) -> Self {
        match error {
            StartupProbeError::Incompatible => Self::ExistingServerIncompatible,
            StartupProbeError::Malformed => Self::ExistingServerMalformed,
            StartupProbeError::Timeout => Self::ExistingServerTimeout,
            StartupProbeError::OtherService => Self::PortUsedByOtherService,
            StartupProbeError::ExistingWebUiUnavailable => Self::ExistingWebUiUnavailable,
            StartupProbeError::ExistingWebUiTimeout => Self::ExistingWebUiTimeout,
        }
    }
}

impl StartupNoticeKind {
    pub(crate) fn explanation(self) -> &'static str {
        match self {
            Self::ExistingServerCandidate => {
                "A listener on port 4317 has the expected Hermes Studio protocol and Web UI shape, but those public responses do not verify its identity. Nothing was opened automatically."
            }
            Self::ExistingServerIncompatible => {
                "The listener on port 4317 returned a Studio Server health response, but its protocol version is not compatible with this desktop launcher. This does not authenticate the listener."
            }
            Self::ExistingServerMalformed => {
                "The listener on port 4317 returned an invalid health response and has not been authenticated as Hermes Studio."
            }
            Self::ExistingServerTimeout => {
                "The listener on port 4317 did not complete the health probe in time and has not been authenticated as Hermes Studio."
            }
            Self::PortUsedByOtherService => {
                "Port 4317 is occupied by a service that could not be verified as Hermes Studio."
            }
            Self::ExistingWebUiUnavailable => {
                "The listener on port 4317 returned the compatible health shape but is not serving the expected Hermes Studio Web UI shape from /. Its identity is not authenticated."
            }
            Self::ExistingWebUiTimeout => {
                "The listener on port 4317 returned the compatible health shape, but its Web UI probe did not respond in time. Its identity is not authenticated."
            }
            Self::OwnedManagedRuntimeUnavailable => {
                "The desktop launcher could not find or validate the managed Node.js 22.x runtime and an installed Hermes Agent required to start its Studio Server. These are not bundled with the app."
            }
            Self::OwnedBundledResourceUnavailable => {
                "The desktop launcher could not locate the bundled Studio Server resources required to start its own server."
            }
            Self::OwnedRemoteConfigurationUnavailable => {
                "The desktop launcher could not safely save or load its remote-access configuration from macOS Keychain."
            }
            Self::OwnedChildLaunchFailed => {
                "The desktop launcher found its runtime and resources, but could not launch its Studio Server process."
            }
            Self::OwnedServerReadinessFailed => {
                "The desktop launcher started its Studio Server process, but the server exited early or did not become ready in time."
            }
            Self::InternalStateUnavailable => {
                "The desktop launcher could not safely update its internal ownership state."
            }
        }
    }

    pub(crate) fn recovery_steps(self) -> &'static [&'static str] {
        match self {
            Self::ExistingServerCandidate => &[
                "First confirm that the process which owns loopback port 4317 is your Studio Server.",
                "Only after confirming the owner, manually open http://127.0.0.1:4317/ in a normal browser.",
                "If the owner is unknown, do not open the URL. Inspect or stop that process through its normal management procedure; Hermes Studio will not kill it automatically.",
                "To let this app start its own server instead, free port 4317 by stopping the owner normally, then open Hermes Studio again.",
            ],
            Self::PortUsedByOtherService => &[
                "Check which application owns loopback port 4317 (for example: lsof -nP -iTCP:4317 -sTCP:LISTEN).",
                "If that application is not needed, close it normally, then start Hermes Studio again. Do not force-kill an unknown process.",
            ],
            Self::ExistingServerIncompatible => &[
                "First verify that the process owning loopback port 4317 is your Studio Server.",
                "After verification, update it to a version compatible with this desktop launcher, or close it normally.",
                "Start the desktop launcher again after the compatible server is ready or port 4317 is free.",
            ],
            Self::ExistingServerMalformed => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Hermes Studio health response is invalid.",
                "Restart that service normally, or close it and start a compatible Studio Server before retrying.",
            ],
            Self::ExistingServerTimeout => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Hermes Studio health check timed out.",
                "Restart that service normally, then retry after it responds on port 4317.",
            ],
            Self::ExistingWebUiUnavailable => &[
                "First verify that the process owning loopback port 4317 is your Studio Server.",
                "For development, run the normal combined development surface so the server and Web UI start together.",
                "For a packaged or local production setup, build the web assets and serve them from / on the same port 4317 listener.",
                "Only after verifying the owner and making the Web UI available, manually open http://127.0.0.1:4317/ in a normal browser.",
            ],
            Self::ExistingWebUiTimeout => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Web UI response timed out.",
                "Restart that service normally, then retry after the Web UI responds on port 4317.",
            ],
            Self::OwnedManagedRuntimeUnavailable => &[
                "Install Node.js 22.x for your user account (the launcher prefers ~/.hermes/node/bin/node).",
                "Install Hermes Agent so `hermes --version` reports a valid Hermes Agent version (for example via the official Hermes install, which places the binary under ~/.local/bin/hermes).",
                "Optional overrides: HERMES_STUDIO_NODE and HERMES_STUDIO_HERMES_EXECUTABLE may point at absolute, user-owned executables.",
                "Repair or reinstall the managed runtime, free port 4317 if needed, then start Hermes Studio again.",
            ],
            Self::OwnedBundledResourceUnavailable => &[
                "Reinstall Hermes Studio from a complete application bundle so its server resources are restored.",
                "If this is a development checkout, run `npm install` and ensure apps/desktop/src-tauri/resources/server/hermes-studio-server.mjs exists after `npm run build:desktop-assets`.",
            ],
            Self::OwnedRemoteConfigurationUnavailable => &[
                "Unlock the login keychain, then start Hermes Studio again and allow access if macOS asks.",
                "To replace the saved configuration, quit Hermes Studio and run `npm run start:tailnet:desktop` again with the intended enrollment token.",
                "Inspect the diagnostic detail below; Hermes Studio does not fall back to an unverified saved remote configuration.",
            ],
            Self::OwnedChildLaunchFailed => &[
                "Confirm the managed runtime and installed Hermes Studio bundle are readable and allowed to launch processes.",
                "Open the diagnostic log listed below for the spawn error, then restart Hermes Studio.",
                "If it still fails, reinstall the application and its managed Node/Hermes runtimes.",
            ],
            Self::OwnedServerReadinessFailed => &[
                "Close Hermes Studio normally, then start it again.",
                "Open the diagnostic log and studio-server stderr log listed below for the child process exit reason.",
                "Confirm Node 22.x and Hermes Agent work from a terminal, and that port 4317 is free before retrying.",
                "Repair or reinstall the managed runtime or Hermes Studio application bundle if the server still does not become ready.",
            ],
            Self::InternalStateUnavailable => &[
                "Close Hermes Studio normally and start it again.",
                "If the problem continues, reinstall the application; do not manually stop unrelated processes.",
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OwnedServerLaunchError {
    ManagedRuntimeUnavailable { detail: String },
    BundledResourceUnavailable { detail: String },
    RemoteConfigurationUnavailable { detail: String },
    ChildLaunchFailed { detail: String },
}

impl OwnedServerLaunchError {
    pub(crate) fn detail(&self) -> &str {
        match self {
            Self::ManagedRuntimeUnavailable { detail }
            | Self::BundledResourceUnavailable { detail }
            | Self::RemoteConfigurationUnavailable { detail }
            | Self::ChildLaunchFailed { detail } => detail,
        }
    }
}

impl From<OwnedServerLaunchError> for StartupFailure {
    fn from(error: OwnedServerLaunchError) -> Self {
        let kind = match &error {
            OwnedServerLaunchError::ManagedRuntimeUnavailable { .. } => {
                StartupNoticeKind::OwnedManagedRuntimeUnavailable
            }
            OwnedServerLaunchError::BundledResourceUnavailable { .. } => {
                StartupNoticeKind::OwnedBundledResourceUnavailable
            }
            OwnedServerLaunchError::RemoteConfigurationUnavailable { .. } => {
                StartupNoticeKind::OwnedRemoteConfigurationUnavailable
            }
            OwnedServerLaunchError::ChildLaunchFailed { .. } => {
                StartupNoticeKind::OwnedChildLaunchFailed
            }
        };
        StartupFailure::from_kind(kind).with_detail(error.detail().to_owned())
    }
}

impl From<OwnedServerLaunchError> for StartupNoticeKind {
    fn from(error: OwnedServerLaunchError) -> Self {
        match error {
            OwnedServerLaunchError::ManagedRuntimeUnavailable { .. } => {
                Self::OwnedManagedRuntimeUnavailable
            }
            OwnedServerLaunchError::BundledResourceUnavailable { .. } => {
                Self::OwnedBundledResourceUnavailable
            }
            OwnedServerLaunchError::RemoteConfigurationUnavailable { .. } => {
                Self::OwnedRemoteConfigurationUnavailable
            }
            OwnedServerLaunchError::ChildLaunchFailed { .. } => Self::OwnedChildLaunchFailed,
        }
    }
}
