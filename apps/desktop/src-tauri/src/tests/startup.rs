use crate::startup::{OwnedServerLaunchError, StartupFailure, StartupNoticeKind};

#[test]
fn owned_launch_failures_map_to_safe_specific_notices() {
    assert_eq!(
        StartupNoticeKind::from(OwnedServerLaunchError::ManagedRuntimeUnavailable {
            detail: "missing node".into()
        }),
        StartupNoticeKind::OwnedManagedRuntimeUnavailable
    );
    assert_eq!(
        StartupNoticeKind::from(OwnedServerLaunchError::BundledResourceUnavailable {
            detail: "missing script".into()
        }),
        StartupNoticeKind::OwnedBundledResourceUnavailable
    );
    assert_eq!(
        StartupNoticeKind::from(OwnedServerLaunchError::RemoteConfigurationUnavailable {
            detail: "keychain locked".into()
        }),
        StartupNoticeKind::OwnedRemoteConfigurationUnavailable
    );
    assert_eq!(
        StartupNoticeKind::from(OwnedServerLaunchError::ChildLaunchFailed {
            detail: "spawn failed".into()
        }),
        StartupNoticeKind::OwnedChildLaunchFailed
    );
}

#[test]
fn owned_launch_failures_preserve_detail_on_startup_failure() {
    let failure = StartupFailure::from(OwnedServerLaunchError::ManagedRuntimeUnavailable {
        detail: "Node.js 22.x was not found. Checked: /opt/homebrew/bin/node.".into(),
    });
    assert_eq!(failure.kind, StartupNoticeKind::OwnedManagedRuntimeUnavailable);
    assert!(failure
        .detail
        .as_deref()
        .unwrap_or_default()
        .contains("Node.js 22.x was not found"));
}
