use std::{
    env,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::constants::{
    CHILD_POLL_INTERVAL, MAX_VERSION_OUTPUT, SUPPORTED_NODE_MAJOR, VERSION_TIMEOUT,
};
/// Prefer HERMES_STUDIO_* ; fall back to deprecated HERMES_OFFICE_* .
fn brand_env(suffix: &str) -> Option<OsString> {
    let studio = format!("HERMES_STUDIO_{suffix}");
    let legacy = format!("HERMES_OFFICE_{suffix}");
    match env::var_os(&studio) {
        Some(value) => (!value.is_empty()).then_some(value),
        None => env::var_os(&legacy).filter(|value| !value.is_empty()),
    }
}

/// Lookup helper used when the process environment was already env_clear'd on a Command.
fn brand_env_lookup(suffix: &str, lookup: &impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    let studio = format!("HERMES_STUDIO_{suffix}");
    let legacy = format!("HERMES_OFFICE_{suffix}");
    match lookup(&studio) {
        Some(value) => (!value.is_empty()).then_some(value),
        None => lookup(&legacy).filter(|value| !value.is_empty()),
    }
}

pub(crate) fn resolve_managed_runtime() -> Result<(PathBuf, PathBuf), String> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let node_paths = node_candidates(home.as_deref());
    let hermes_paths = hermes_candidates(home.as_deref());
    let node = find_compatible_executable_branded(
        "NODE",
        &node_paths,
        node_version_is_compatible,
    )?
    .ok_or_else(|| {
        format!(
            "Node.js 22.x was not found. Checked: {}.",
            summarize_candidates(&node_paths)
        )
    })?;
    let hermes = find_compatible_executable_branded(
        "HERMES_EXECUTABLE",
        &hermes_paths,
        hermes_agent_is_detected,
    )?
    .ok_or_else(|| {
        format!(
            "Hermes Agent was not found. Checked: {}.",
            summarize_candidates(&hermes_paths)
        )
    })?;
    Ok((node, hermes))
}

fn summarize_candidates(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return "(none)".to_owned();
    }
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(debug_assertions)]
pub(crate) fn resolve_tsx_cli(repo_root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let candidate = repo_root.join("node_modules/tsx/dist/cli.mjs");
    if !candidate.is_file() {
        return Err(format!(
            "tsx CLI is not installed at {}. Run `npm install` in the repository root.",
            candidate.display()
        )
        .into());
    }
    Ok(candidate)
}

#[cfg(debug_assertions)]
pub(crate) fn resolve_repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Tauri dev's current_dir depends on the package manager. Anchor the lookup
    // to the Cargo manifest of this crate for a stable, debug-only path.
    let crate_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut current = crate_manifest.as_path();
    loop {
        let package = current.join("package.json");
        let tauri_conf = current.join("apps/desktop/src-tauri/tauri.conf.json");
        if package.is_file() && tauri_conf.is_file() {
            return Ok(current.to_path_buf());
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    Err("Could not locate the Hermes Studio repository root. Ensure the working directory is inside the repository.".into())
}

fn find_compatible_executable_branded(
    suffix: &str,
    candidates: &[PathBuf],
    version_is_compatible: fn(&str) -> bool,
) -> Result<Option<PathBuf>, String> {
    let override_name = format!("HERMES_STUDIO_{suffix}");
    find_compatible_executable_with_override(
        &override_name,
        brand_env(suffix),
        candidates,
        version_is_compatible,
    )
}

fn find_compatible_executable_with_override(
    override_name: &str,
    override_value: Option<OsString>,
    candidates: &[PathBuf],
    version_is_compatible: fn(&str) -> bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(value) = override_value {
        let path = PathBuf::from(value);
        let executable = validated_local_executable(&path).ok_or_else(|| {
            format!("{override_name} must identify an eligible absolute executable")
        })?;
        let version = run_version_command(&executable, version_is_compatible)?;
        if !version_is_compatible(&version) {
            return Err(format!("{override_name} has an unsupported version"));
        }
        return Ok(Some(executable));
    }
    for path in candidates {
        let Some(executable) = validated_local_executable(path) else {
            continue;
        };
        let Ok(version) = run_version_command(&executable, version_is_compatible) else {
            continue;
        };
        if version_is_compatible(&version) {
            return Ok(Some(executable));
        }
    }
    Ok(None)
}

// This validates a local-install boundary; it does not attest publisher identity
// or protect against replacement by the same OS user who owns the executable.
pub(crate) fn validated_local_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = metadata.permissions().mode();
        let owner = metadata.uid();
        let effective_user = unsafe { libc::geteuid() };
        if mode & 0o6000 != 0
            || mode & 0o111 == 0
            || mode & 0o022 != 0
            || (owner != 0 && owner != effective_user)
        {
            return None;
        }
    }
    Some(canonical)
}

pub(crate) fn run_version_command(
    path: &Path,
    version_is_compatible: fn(&str) -> bool,
) -> Result<String, String> {
    run_version_command_with_timeout(path, VERSION_TIMEOUT, version_is_compatible)
}

pub(crate) fn run_version_command_with_timeout(
    path: &Path,
    timeout: Duration,
    version_is_compatible: fn(&str) -> bool,
) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .env_clear()
        // Hermes Agent prints its version before performing a best-effort update
        // check. Flush those lines even when stdout is a pipe so the bounded
        // launcher probe can use them if that network check outlives the probe.
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    inherit_safe_environment(&mut command);
    let mut child = command.spawn().map_err(|_| "runtime version probe failed".to_owned())?;
    let stdout = child.stdout.take().ok_or_else(|| "runtime version output unavailable".to_owned())?;
    let stderr = child.stderr.take().ok_or_else(|| "runtime version output unavailable".to_owned())?;
    let stdout_reader = thread::spawn(move || read_limited(stdout));
    let stderr_reader = thread::spawn(move || read_limited(stderr));
    let status = wait_for_bounded_child(&mut child, timeout)
        .map_err(|_| "runtime version probe failed".to_owned())?;
    let stdout = stdout_reader.join().map_err(|_| "runtime version probe failed".to_owned())??;
    let stderr = stderr_reader.join().map_err(|_| "runtime version probe failed".to_owned())??;
    if status.is_some_and(|status| !status.success()) {
        return Err("runtime version probe failed".to_owned());
    }
    let output = if stdout.is_empty() { stderr } else { stdout };
    let output = String::from_utf8(output)
        .map(|value| value.trim().to_owned())
        .map_err(|_| "runtime version output is not UTF-8".to_owned())?;
    if status.is_none() && !version_is_compatible(&output) {
        return Err("runtime version probe timed out".to_owned());
    }
    Ok(output)
}

/// Wait for a short-lived helper process and reap it. A timed-out helper is
/// killed and reaped before this function returns; `None` represents timeout.
pub(crate) fn wait_for_bounded_child(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        };
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(std::cmp::min(remaining, CHILD_POLL_INTERVAL));
    }
}

fn read_limited(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_VERSION_OUTPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "runtime version output could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_VERSION_OUTPUT {
        return Err("runtime version output exceeded its limit".to_owned());
    }
    Ok(bytes)
}

pub(crate) fn node_version_is_compatible(output: &str) -> bool {
    parse_leading_version(output.strip_prefix('v').unwrap_or(output))
        .is_some_and(|(major, _, _)| major == SUPPORTED_NODE_MAJOR)
}

pub(crate) fn hermes_agent_is_detected(output: &str) -> bool {
    let Some(version) = output.lines().find_map(|line| line.strip_prefix("Hermes Agent v")) else {
        return false;
    };
    parse_leading_version(version).is_some()
}

pub(crate) fn parse_leading_version(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.split_whitespace().next()?;
    let core = version.split(['-', '+']).next()?;
    let mut components = core.split('.');
    let result = (
        components.next()?.parse().ok()?,
        components.next()?.parse().ok()?,
        components.next()?.parse().ok()?,
    );
    (components.next().is_none()).then_some(result)
}

pub(crate) fn inherit_safe_environment(command: &mut Command) {
    inherit_safe_environment_with_lookup(command, |key| env::var_os(key));
}

pub(crate) fn inherit_safe_environment_with_lookup(
    command: &mut Command,
    lookup: impl Fn(&str) -> Option<OsString>,
) {
    for key in [
        "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LANG", "LANGUAGE",
        "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
        "HERMES_HOME",
    ] {
        if let Some(value) = lookup(key).filter(|value| !value.is_empty()) {
            command.env(key, value);
        }
    }
}

/// Studio Server host configuration is only meaningful to the Studio Server child.
/// Preserve it across env_clear without forwarding it to Hermes runtimes.
pub(crate) fn inherit_studio_server_remote_environment(
    command: &mut Command,
    lookup: impl Fn(&str) -> Option<OsString>,
) {
    // Forward as canonical HERMES_STUDIO_* keys (accept deprecated HERMES_OFFICE_*).
    for suffix in [
        "REMOTE_TOKEN",
        "ALLOWED_ORIGINS",
        "TRUSTED_PROXY_HOPS",
        "REMOTE_PRIVILEGED",
        "CHAT_SESSION_LEASES_PER_OWNER",
        "CHAT_SESSION_LEASES_PER_PROFILE",
        "CHAT_SESSION_LEASES_TOTAL",
    ] {
        if let Some(value) = brand_env_lookup(suffix, &lookup) {
            command.env(format!("HERMES_STUDIO_{suffix}"), value);
        }
    }
}

pub(crate) fn node_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    node_candidates_with_lookup(home, |key| env::var_os(key))
}

pub(crate) fn node_candidates_with_lookup(
    home: Option<&Path>,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut values = Vec::new();
    if let Some(hermes_home) = absolute_hermes_home(&lookup) {
        values.push(hermes_home.join("node/bin/node"));
    }
    if let Some(home) = home {
        values.push(home.join(".hermes/node/bin/node"));
        values.push(home.join(".local/bin/node"));
        // Common version managers (still absolute paths; ownership/mode validated later).
        push_version_manager_nodes(home, &mut values);
    }
    values.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/opt/homebrew/opt/node@22/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/local/opt/node@22/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);
    values
}

fn push_version_manager_nodes(home: &Path, values: &mut Vec<PathBuf>) {
    // nvm: ~/.nvm/versions/node/v22.*/bin/node
    let nvm_root = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut version_dirs = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("v22."))
            })
            .collect::<Vec<_>>();
        version_dirs.sort();
        version_dirs.reverse();
        for dir in version_dirs {
            values.push(dir.join("bin/node"));
        }
    }
    // fnm
    let fnm_root = home.join(".local/share/fnm/node-versions");
    if let Ok(entries) = std::fs::read_dir(&fnm_root) {
        let mut version_dirs = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(|name| name.strip_prefix('v').unwrap_or(name))
                    .is_some_and(|name| name.starts_with("22."))
            })
            .collect::<Vec<_>>();
        version_dirs.sort();
        version_dirs.reverse();
        for path in version_dirs {
            values.push(path.join("installation/bin/node"));
        }
    }
    // asdf
    let asdf_root = home.join(".asdf/installs/nodejs");
    if let Ok(entries) = std::fs::read_dir(&asdf_root) {
        let mut version_dirs = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("22."))
            })
            .collect::<Vec<_>>();
        version_dirs.sort();
        version_dirs.reverse();
        for path in version_dirs {
            values.push(path.join("bin/node"));
        }
    }
}

pub(crate) fn hermes_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    hermes_candidates_with_lookup(home, |key| env::var_os(key))
}

pub(crate) fn hermes_candidates_with_lookup(
    home: Option<&Path>,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut values = Vec::new();
    if let Some(hermes_home) = absolute_hermes_home(&lookup) {
        values.push(hermes_home.join("hermes-agent/venv/bin/hermes"));
        values.push(hermes_home.join("hermes-agent/hermes"));
        values.push(hermes_home.join("bin/hermes"));
    }
    if let Some(home) = home {
        values.push(home.join(".local/bin/hermes"));
        values.push(home.join(".hermes/hermes-agent/venv/bin/hermes"));
        values.push(home.join(".hermes/hermes-agent/hermes"));
        values.push(home.join(".hermes/bin/hermes"));
    }
    values.extend([
        PathBuf::from("/opt/homebrew/bin/hermes"),
        PathBuf::from("/usr/local/bin/hermes"),
    ]);
    values
}

fn absolute_hermes_home(lookup: &impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(lookup("HERMES_HOME").filter(|value| !value.is_empty())?);
    path.is_absolute().then_some(path)
}
