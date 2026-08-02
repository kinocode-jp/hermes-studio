use std::{
    env, fs,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;

use crate::capability::{
    persist_desktop_capability, read_persisted_desktop_capability, AttachedServerCapability,
    DesktopCapability, StudioServerProcess,
};
use crate::constants::{
    HEALTH_RESPONSE_TIMEOUT, STUDIO_SERVER_HOST, STUDIO_SERVER_PORT, START_TIMEOUT, STOP_TIMEOUT,
};
use crate::diagnostics::{
    child_stdio_paths, diagnostic_log_path, ensure_diagnostic_log, log_event,
};
use crate::health::{health_check, probe_existing_health, ProbeOutcome};
use crate::hex_util::generate_desktop_capability;
use crate::proof::{
    desktop_readiness_proof_check, desktop_readiness_proof_outcome, DesktopProofOutcome,
};
use crate::remote_config::prepare_desktop_remote_environment;
use crate::runtime::{
    inherit_studio_server_remote_environment, inherit_safe_environment, resolve_managed_runtime,
};
use crate::startup::{
    OwnedServerLaunchError, StartupFailure, StartupNoticeKind, StartupProbeError,
    StudioServerLaunch, StudioServerStartup,
};
use crate::web_ui::{probe_existing_web_ui, WebUiProbeOutcome};

#[cfg(debug_assertions)]
use crate::runtime::{resolve_repo_root, resolve_tsx_cli};

pub(crate) fn setup_studio_server(
    app: &tauri::AppHandle,
) -> Result<StudioServerLaunch, StartupFailure> {
    let _ = ensure_diagnostic_log();
    log_event("Desktop launcher starting Studio Server setup.");
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, STUDIO_SERVER_PORT));
    match classify_studio_server_startup(address).map_err(|error| {
        log_event(&format!("Port {STUDIO_SERVER_PORT} classification failed: {error}"));
        StartupFailure::from(error).with_optional_log()
    })? {
        StudioServerStartup::PortFree => {
            log_event(&format!("Port {STUDIO_SERVER_PORT} is free; starting owned Studio Server."));
            let desktop_capability = generate_desktop_capability();
            #[cfg(debug_assertions)]
            let mut child = start_studio_dev_server(app, &desktop_capability)
                .map_err(|error| StartupFailure::from(error).with_optional_log())?;
            #[cfg(not(debug_assertions))]
            let mut child = start_studio_server(app, &desktop_capability)
                .map_err(|error| StartupFailure::from(error).with_optional_log())?;
            if let Err(error) = wait_for_studio_server(&mut child, START_TIMEOUT, &desktop_capability)
            {
                let detail = format!("{error}");
                log_event(&format!("Owned Studio Server readiness failed: {detail}"));
                stop_studio_server(&mut child);
                return Err(StartupFailure::from_kind(StartupNoticeKind::OwnedServerReadinessFailed)
                    .with_detail(detail)
                    .with_optional_log());
            }
            let process_state = app.state::<StudioServerProcess>();
            let capability_state = app.state::<DesktopCapability>();
            let mut capability = match capability_state.0.lock() {
                Ok(capability) => capability,
                Err(_) => {
                    stop_studio_server(&mut child);
                    return Err(StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                        .with_optional_log());
                }
            };
            let mut process = match process_state.0.lock() {
                Ok(process) => process,
                Err(_) => {
                    stop_studio_server(&mut child);
                    return Err(StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                        .with_optional_log());
                }
            };
            if let Err(detail) = persist_desktop_capability(app, &desktop_capability) {
                stop_studio_server(&mut child);
                return Err(StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                    .with_detail(detail)
                    .with_optional_log());
            }
            *process = Some(child);
            *capability = Some(desktop_capability);
            log_event("Owned Studio Server is ready; Web UI may open.");
            Ok(StudioServerLaunch::OwnedReady)
        }
        StudioServerStartup::CompatibleCandidate => {
            // Public response shape is not identity. A second desktop instance
            // may attach only when the existing listener proves knowledge of the
            // first instance's user-private capability.
            let capability = read_persisted_desktop_capability(app).ok_or_else(|| {
                StartupFailure::from_kind(StartupNoticeKind::ExistingServerCandidate)
                    .with_optional_log()
            })?;
            let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
            if desktop_readiness_proof_outcome(address, &capability, deadline)
                != DesktopProofOutcome::Valid
            {
                return Err(StartupFailure::from_kind(
                    StartupNoticeKind::ExistingServerCandidate,
                )
                .with_optional_log());
            }
            let attached_state = app.state::<AttachedServerCapability>();
            let mut attached = attached_state.0.lock().map_err(|_| {
                StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                    .with_optional_log()
            })?;
            *attached = Some(capability);
            log_event(
                "Existing Studio Server listener passed the private desktop ownership proof; opening its loopback Web UI without taking process ownership.",
            );
            Ok(StudioServerLaunch::ExistingOpen)
        }
    }
}

trait WithOptionalLog {
    fn with_optional_log(self) -> Self;
}

impl WithOptionalLog for StartupFailure {
    fn with_optional_log(mut self) -> Self {
        if self.log_path.is_none() {
            if let Some(path) = diagnostic_log_path() {
                self.log_path = Some(path);
            }
        }
        self
    }
}

pub(crate) fn start_studio_server(
    app: &tauri::AppHandle,
    desktop_capability: &str,
) -> Result<Child, OwnedServerLaunchError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| OwnedServerLaunchError::BundledResourceUnavailable {
            detail: format!("resource_dir unavailable: {error}"),
        })?;
    let script = resource_dir.join("resources/server/hermes-studio-server.mjs");
    if !script.is_file() {
        return Err(OwnedServerLaunchError::BundledResourceUnavailable {
            detail: format!(
                "Bundled Studio Server module missing at {}.",
                script.display()
            ),
        });
    }

    let (node, hermes) = resolve_managed_runtime().map_err(|detail| {
        log_event(&format!("Managed runtime resolution failed: {detail}"));
        OwnedServerLaunchError::ManagedRuntimeUnavailable { detail }
    })?;
    log_event(&format!(
        "Using Node at {} and Hermes at {}.",
        node.display(),
        hermes.display()
    ));

    let remote_environment = prepare_desktop_remote_environment().map_err(|detail| {
        log_event(&format!("Desktop remote configuration preparation failed: {detail}"));
        OwnedServerLaunchError::RemoteConfigurationUnavailable { detail }
    })?;

    let mut command = Command::new(&node);
    command.env_clear();
    inherit_safe_environment(&mut command);
    // Studio Server remote-device configuration comes from the explicit host
    // environment or the desktop owner's validated Keychain entry. Pass it to
    // the server child only; do not forward it to managed Hermes runtimes.
    inherit_studio_server_remote_environment(&mut command, |key| {
        env::var_os(key).or_else(|| remote_environment.lookup(key))
    });
    command
        .arg(&script)
        .env("HERMES_STUDIO_HOST", STUDIO_SERVER_HOST)
        .env("HERMES_STUDIO_PORT", STUDIO_SERVER_PORT.to_string())
        .env("HERMES_STUDIO_HERMES_MODE", "managed")
        .env("HERMES_STUDIO_HERMES_EXECUTABLE", &hermes)
        .env("HERMES_STUDIO_DESKTOP_CAPABILITY", desktop_capability)
        // Keep a private pipe open for the lifetime of the desktop parent. The
        // server watches EOF and shuts itself down if the native shell crashes
        // or is force-quit before Tauri can run its normal exit handler.
        .env("HERMES_STUDIO_DESKTOP_PARENT_PIPE", "true")
        .stdin(Stdio::piped());

    // Prefer serving the packaged web dist from the same origin when present so
    // a manual browser open of http://127.0.0.1:4317/ also works.
    let web_root_candidates = [
        resource_dir.join("resources/web"),
        resource_dir.join("../Resources/resources/web"),
    ];
    for candidate in web_root_candidates {
        if candidate.join("index.html").is_file() {
            command.env("HERMES_STUDIO_WEB_ROOT", &candidate);
            log_event(&format!("HERMES_STUDIO_WEB_ROOT={}", candidate.display()));
            break;
        }
    }

    apply_child_stdio(&mut command);
    let home = env::var_os("HOME").map(PathBuf::from);
    let current_dir = home.filter(|path| path.is_dir()).unwrap_or_else(|| resource_dir.clone());
    command.current_dir(current_dir);
    command.spawn().map_err(|error| {
        let detail = format!(
            "Failed to spawn Studio Server (node={}, script={}): {error}",
            node.display(),
            script.display()
        );
        log_event(&detail);
        OwnedServerLaunchError::ChildLaunchFailed { detail }
    })
}

#[cfg(debug_assertions)]
pub(crate) fn start_studio_dev_server(
    _app: &tauri::AppHandle,
    desktop_capability: &str,
) -> Result<Child, OwnedServerLaunchError> {
    let repo_root = resolve_repo_root().map_err(|error| {
        OwnedServerLaunchError::BundledResourceUnavailable {
            detail: format!("Repository root unavailable: {error}"),
        }
    })?;
    let (node, hermes) = resolve_managed_runtime().map_err(|detail| {
        log_event(&format!("Managed runtime resolution failed: {detail}"));
        OwnedServerLaunchError::ManagedRuntimeUnavailable { detail }
    })?;
    let tsx = resolve_tsx_cli(&repo_root).map_err(|error| {
        OwnedServerLaunchError::BundledResourceUnavailable {
            detail: format!("{error}"),
        }
    })?;
    log_event(&format!(
        "Dev mode: node={}, hermes={}, tsx={}, repo={}",
        node.display(),
        hermes.display(),
        tsx.display(),
        repo_root.display()
    ));

    let remote_environment = prepare_desktop_remote_environment().map_err(|detail| {
        log_event(&format!("Desktop remote configuration preparation failed: {detail}"));
        OwnedServerLaunchError::RemoteConfigurationUnavailable { detail }
    })?;

    let mut command = Command::new(&node);
    command.env_clear();
    inherit_safe_environment(&mut command);
    inherit_studio_server_remote_environment(&mut command, |key| {
        env::var_os(key).or_else(|| remote_environment.lookup(key))
    });
    command
        .current_dir(&repo_root)
        .arg(&tsx)
        .arg("watch")
        .arg(repo_root.join("apps/server/src/index.ts"))
        .env("HERMES_STUDIO_HOST", STUDIO_SERVER_HOST)
        .env("HERMES_STUDIO_PORT", STUDIO_SERVER_PORT.to_string())
        .env("HERMES_STUDIO_HERMES_MODE", "managed")
        .env("HERMES_STUDIO_HERMES_EXECUTABLE", &hermes)
        .env("HERMES_STUDIO_DESKTOP_CAPABILITY", desktop_capability)
        .env("HERMES_STUDIO_DESKTOP_ORIGINS", "http://localhost:4173")
        .env("HERMES_STUDIO_DESKTOP_PARENT_PIPE", "true")
        .stdin(Stdio::piped());
    // Dev keeps console inheritance for interactive diagnosis; also mirror to log files.
    apply_child_stdio_dev(&mut command);
    command.spawn().map_err(|error| {
        let detail = format!("Failed to spawn dev Studio Server: {error}");
        log_event(&detail);
        OwnedServerLaunchError::ChildLaunchFailed { detail }
    })
}

fn apply_child_stdio(command: &mut Command) {
    if let Some((stdout_path, stderr_path)) = child_stdio_paths() {
        match (fs::File::create(&stdout_path), fs::File::create(&stderr_path)) {
            (Ok(stdout), Ok(stderr)) => {
                log_event(&format!(
                    "Studio Server logs: stdout={}, stderr={}",
                    stdout_path.display(),
                    stderr_path.display()
                ));
                command.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
                return;
            }
            _ => {
                log_event("Could not open Studio Server log files; discarding child stdio.");
            }
        }
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());
}

#[cfg(debug_assertions)]
fn apply_child_stdio_dev(command: &mut Command) {
    // Prefer inherited consoles in dev; still try to tee via files when possible.
    if let Some((stdout_path, stderr_path)) = child_stdio_paths() {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stdout_path);
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stderr_path);
        log_event(&format!(
            "Dev Studio Server also has log files at {} and {} (primary output inherits the terminal).",
            stdout_path.display(),
            stderr_path.display()
        ));
    }
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
}

pub(crate) fn classify_studio_server_startup(
    address: SocketAddr,
) -> Result<StudioServerStartup, StartupProbeError> {
    if let Ok(listener) = TcpListener::bind(address) {
        drop(listener);
        return Ok(StudioServerStartup::PortFree);
    }

    match probe_existing_health(address) {
        ProbeOutcome::Compatible => match probe_existing_web_ui(address) {
            WebUiProbeOutcome::Compatible => Ok(StudioServerStartup::CompatibleCandidate),
            WebUiProbeOutcome::Unavailable => {
                Err(StartupProbeError::ExistingWebUiUnavailable)
            }
            WebUiProbeOutcome::Timeout => Err(StartupProbeError::ExistingWebUiTimeout),
        },
        ProbeOutcome::Incompatible => Err(StartupProbeError::Incompatible),
        ProbeOutcome::Malformed => Err(StartupProbeError::Malformed),
        ProbeOutcome::Timeout => Err(StartupProbeError::Timeout),
        ProbeOutcome::OtherService => Err(StartupProbeError::OtherService),
    }
}

pub(crate) fn wait_for_studio_server(
    child: &mut Child,
    timeout: Duration,
    desktop_capability: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, STUDIO_SERVER_PORT));
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            let log_hint = child_stdio_paths()
                .map(|(_, stderr)| format!(" See {}.", stderr.display()))
                .unwrap_or_default();
            return Err(format!(
                "Studio Server exited during startup ({status}).{log_hint}"
            )
            .into());
        }
        if health_check(address, deadline)
            && desktop_readiness_proof_check(address, desktop_capability, deadline)
        {
            if let Some(status) = child.try_wait()? {
                return Err(format!("Studio Server exited during startup ({status}).").into());
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let log_hint = child_stdio_paths()
        .map(|(_, stderr)| format!(" See {}.", stderr.display()))
        .unwrap_or_default();
    Err(format!("Studio Server did not become ready within 50 seconds.{log_hint}").into())
}

pub(crate) fn stop_studio_server(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    send_terminate(child);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn send_terminate(child: &mut Child) {
    // Studio Server handles SIGTERM and closes its managed Hermes processes.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn send_terminate(child: &mut Child) {
    let _ = child.kill();
}
