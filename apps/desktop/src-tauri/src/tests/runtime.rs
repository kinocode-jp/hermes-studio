use std::{
    env,
    ffi::OsString,
    process::Command,
    time::Duration,
};

use crate::hex_util::random_desktop_capability;
use crate::runtime::{
    hermes_agent_is_detected, hermes_candidates_with_lookup, inherit_safe_environment_with_lookup,
    inherit_studio_server_remote_environment, node_candidates_with_lookup,
    node_version_is_compatible, run_version_command_with_timeout, validated_local_executable,
};

#[test]
fn executable_fallbacks_are_absolute() {
    assert!(node_candidates_with_lookup(None, |_| None)
        .iter()
        .all(|path| path.is_absolute()));
    assert!(hermes_candidates_with_lookup(None, |_| None)
        .iter()
        .all(|path| path.is_absolute()));
}

#[test]
fn absolute_hermes_home_candidates_are_prioritized_without_mutating_process_environment() {
    let native_home = std::path::Path::new("/Users/example");
    let hermes_home = std::path::Path::new("/Volumes/External SSD/custom-hermes");
    let lookup = |key: &str| {
        (key == "HERMES_HOME").then(|| OsString::from(hermes_home.as_os_str()))
    };

    let node = node_candidates_with_lookup(Some(native_home), lookup);
    assert_eq!(node.first(), Some(&hermes_home.join("node/bin/node")));

    let hermes = hermes_candidates_with_lookup(Some(native_home), lookup);
    assert_eq!(
        hermes.get(0),
        Some(&hermes_home.join("hermes-agent/venv/bin/hermes")),
    );
    assert_eq!(
        hermes.get(1),
        Some(&hermes_home.join("hermes-agent/hermes")),
    );
    assert_eq!(hermes.get(2), Some(&hermes_home.join("bin/hermes")));
}

#[test]
fn relative_hermes_home_is_not_an_executable_candidate() {
    let lookup = |key: &str| {
        (key == "HERMES_HOME").then(|| OsString::from("relative/hermes-home"))
    };
    assert!(node_candidates_with_lookup(None, lookup)
        .iter()
        .all(|path| path.is_absolute()));
    assert!(hermes_candidates_with_lookup(None, lookup)
        .iter()
        .all(|path| path.is_absolute()));
}

#[test]
fn safe_environment_inherits_hermes_home_via_injected_lookup() {
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    inherit_safe_environment_with_lookup(&mut command, |key| {
        (key == "HERMES_HOME").then(|| OsString::from("/Volumes/External SSD/custom-hermes"))
    });
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect();
    assert_eq!(
        envs,
        vec![(
            "HERMES_HOME".to_string(),
            "/Volumes/External SSD/custom-hermes".to_string(),
        )],
    );
}

#[test]
fn version_manager_candidates_are_not_truncated_before_validation() {
    use std::fs;

    let home = env::temp_dir().join(format!(
        "hermes-studio-node-candidates-{}-{}",
        std::process::id(),
        random_desktop_capability(),
    ));
    for index in 0..10 {
        fs::create_dir_all(home.join(format!(".nvm/versions/node/v22.{index}.0")))
            .expect("create nvm candidate");
    }
    for index in 0..14 {
        fs::create_dir_all(home.join(format!(".local/share/fnm/node-versions/v22.{index}.0")))
            .expect("create fnm candidate");
        fs::create_dir_all(home.join(format!(".asdf/installs/nodejs/22.{index}.0")))
            .expect("create asdf candidate");
    }

    let candidates = node_candidates_with_lookup(Some(&home), |_| None);
    let managed = candidates.iter().filter(|path| {
        path.starts_with(home.join(".nvm"))
            || path.starts_with(home.join(".local/share/fnm"))
            || path.starts_with(home.join(".asdf"))
    }).count();
    assert_eq!(managed, 38, "every filtered candidate must reach executable validation");

    fs::remove_dir_all(home).expect("remove node candidate fixture");
}

#[test]
fn runtime_versions_are_fail_closed() {
    assert!(node_version_is_compatible("v22.17.0"));
    assert!(!node_version_is_compatible("v23.0.0"));
    assert!(!node_version_is_compatible("v24.0.1"));
    assert!(!node_version_is_compatible("v21.9.0"));
    assert!(!node_version_is_compatible("not-node"));
    assert!(hermes_agent_is_detected("Hermes Agent v0.18.2"));
    assert!(hermes_agent_is_detected("Hermes Agent v0.19.0"));
    assert!(hermes_agent_is_detected("Hermes Agent v1.0.0"));
    assert!(!hermes_agent_is_detected("Hermes Agent development build"));
    assert!(!hermes_agent_is_detected("0.18.2"));
}

#[test]
#[cfg(unix)]
fn runtime_probe_accepts_a_valid_version_before_a_slow_update_check_finishes() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let directory = env::temp_dir().join(format!(
        "hermes-studio-version-probe-{}-{}",
        std::process::id(),
        random_desktop_capability(),
    ));
    fs::create_dir(&directory).expect("create version probe fixture directory");
    let executable = directory.join("hermes");
    fs::write(
        &executable,
        b"#!/bin/sh\nprintf 'Hermes Agent v0.19.0\\n'\nexec sleep 5\n",
    )
    .expect("write version probe fixture");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
        .expect("make version probe fixture executable");

    let output = run_version_command_with_timeout(
        &executable,
        Duration::from_millis(100),
        hermes_agent_is_detected,
    )
    .expect("accept version output produced before the timeout");
    assert!(hermes_agent_is_detected(&output));

    fs::remove_dir_all(directory).expect("remove version probe fixture directory");
}

#[test]
#[cfg(unix)]
fn executable_validation_canonicalizes_and_rejects_writable_files() {
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    let directory = env::temp_dir().join(format!(
        "hermes-studio-runtime-validation-{}-{}",
        std::process::id(),
        random_desktop_capability(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    let executable = directory.join("runtime");
    fs::write(&executable, b"#!/bin/sh\nexit 0\n").expect("write fixture executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
        .expect("make fixture executable");
    let link = directory.join("runtime-link");
    symlink(&executable, &link).expect("create fixture symlink");

    assert_eq!(
        validated_local_executable(&link),
        Some(executable.canonicalize().expect("canonical fixture path")),
    );
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o777))
        .expect("make fixture writable");
    assert_eq!(validated_local_executable(&link), None);

    fs::set_permissions(&executable, fs::Permissions::from_mode(0o4755))
        .expect("make fixture setuid");
    assert_eq!(validated_local_executable(&link), None);

    fs::set_permissions(&executable, fs::Permissions::from_mode(0o2755))
        .expect("make fixture setgid");
    assert_eq!(validated_local_executable(&link), None);

    fs::remove_dir_all(directory).expect("remove fixture directory");
}

#[test]
fn studio_server_remote_environment_allowlist_is_exact_when_host_values_present() {
    let mut lookup = std::collections::HashMap::new();
    lookup.insert("HERMES_STUDIO_REMOTE_TOKEN", OsString::from("office-token"));
    lookup.insert("HERMES_STUDIO_ALLOWED_ORIGINS", OsString::from("https://office.example"));
    lookup.insert("HERMES_STUDIO_TRUSTED_PROXY_HOPS", OsString::from("1"));
    lookup.insert("HERMES_STUDIO_REMOTE_PRIVILEGED", OsString::from("true"));
    lookup.insert("HERMES_STUDIO_CHAT_SESSION_LEASES_PER_PROFILE", OsString::from("16"));
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    inherit_studio_server_remote_environment(&mut command, |key| lookup.get(key).cloned());
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        })
        .collect();
    assert!(envs.contains(&("HERMES_STUDIO_REMOTE_TOKEN".to_string(), "office-token".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_ALLOWED_ORIGINS".to_string(), "https://office.example".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_TRUSTED_PROXY_HOPS".to_string(), "1".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_REMOTE_PRIVILEGED".to_string(), "true".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_CHAT_SESSION_LEASES_PER_PROFILE".to_string(), "16".to_string())));
    assert_eq!(envs.len(), 5, "only the five configured Studio Server keys may be forwarded");
}

#[test]
fn studio_server_remote_environment_allowlist_ignores_empty_or_missing_values() {
    let mut lookup = std::collections::HashMap::new();
    lookup.insert("HERMES_STUDIO_REMOTE_TOKEN", OsString::from(""));
    lookup.insert("HERMES_OFFICE_REMOTE_TOKEN", OsString::from("deprecated-value"));
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    inherit_studio_server_remote_environment(&mut command, |key| lookup.get(key).cloned());
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        })
        .collect();
    assert!(
        envs.is_empty(),
        "an explicitly empty Studio value must disable legacy fallback",
    );
}
