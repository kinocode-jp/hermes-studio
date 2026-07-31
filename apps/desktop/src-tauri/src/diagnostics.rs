use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// Bounded, secret-scrubbed diagnostic log for desktop launcher failures.
/// Never write remote tokens or desktop capabilities into these files.
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) fn diagnostic_log_path() -> Option<PathBuf> {
    LOG_PATH.lock().ok().and_then(|guard| guard.clone())
}

pub(crate) fn ensure_diagnostic_log() -> Option<PathBuf> {
    if let Some(path) = diagnostic_log_path() {
        return Some(path);
    }
    let dir = diagnostic_log_dir()?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("desktop-startup.log");
    if let Ok(mut guard) = LOG_PATH.lock() {
        *guard = Some(path.clone());
    }
    append_line(&path, "=== Hermes Studio desktop launcher diagnostic log ===");
    Some(path)
}

pub(crate) fn diagnostic_log_dir() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from)?;
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Logs/HermesStudio"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(home.join(".hermes-studio/logs"))
    }
}

pub(crate) fn log_event(message: &str) {
    let Some(path) = ensure_diagnostic_log() else {
        return;
    };
    append_line(&path, &format!("{}  {}", timestamp(), scrub_secrets(message)));
}

pub(crate) fn child_stdio_paths() -> Option<(PathBuf, PathBuf)> {
    let dir = diagnostic_log_dir()?;
    fs::create_dir_all(&dir).ok()?;
    Some((dir.join("studio-server.stdout.log"), dir.join("studio-server.stderr.log")))
}

pub(crate) fn scrub_secrets(value: &str) -> String {
    let mut scrubbed = value.to_owned();
    for key in [
        "HERMES_STUDIO_REMOTE_TOKEN",
        "HERMES_STUDIO_DESKTOP_CAPABILITY",
        "HERMES_STUDIO_HERMES_TOKEN",
        "remoteToken",
        "desktopCapability",
        "Authorization",
    ] {
        // Redact common env-style and key=value / key: value secret patterns.
        scrubbed = redact_key_values(&scrubbed, key);
    }
    scrubbed
}

fn redact_key_values(input: &str, key: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    let patterns = [
        format!("{key}="),
        format!("{key}:"),
        format!("\"{key}\":"),
    ];
    while let Some((idx, pattern)) = patterns
        .iter()
        .filter_map(|pattern| rest.find(pattern).map(|idx| (idx, pattern.as_str())))
        .min_by_key(|(idx, _)| *idx)
    {
        output.push_str(&rest[..idx]);
        output.push_str(pattern);
        rest = &rest[idx + pattern.len()..];
        let trimmed = rest.trim_start_matches([' ', '"', '\'']);
        let consumed = rest.len() - trimmed.len();
        rest = trimmed;
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '}' | ']'))
            .unwrap_or(rest.len());
        output.push_str("***");
        rest = &rest[end..];
        if consumed > 0 {
            // keep going
        }
    }
    output.push_str(rest);
    output
}

fn append_line(path: &Path, line: &str) {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("unix={seconds}")
}

#[cfg(test)]
mod tests {
    use super::scrub_secrets;

    #[test]
    fn scrub_secrets_redacts_tokens_and_capabilities() {
        let raw = "HERMES_STUDIO_REMOTE_TOKEN=super-secret-token path=/tmp HERMES_STUDIO_DESKTOP_CAPABILITY=abcdef";
        let scrubbed = scrub_secrets(raw);
        assert!(!scrubbed.contains("super-secret-token"));
        assert!(!scrubbed.contains("abcdef"));
        assert!(scrubbed.contains("***"));
        assert!(scrubbed.contains("path=/tmp"));
    }
}
