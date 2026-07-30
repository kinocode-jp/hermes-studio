use std::path::PathBuf;

use crate::constants::OFFICE_URL;
use crate::startup::{OfficeLaunch, StartupFailure, StartupNoticeKind};
use crate::window::{
    html_escape, percent_encode_data, startup_loading_data_url, startup_loading_html,
    replacement_window_should_show, startup_notice_data_url, startup_notice_data_url_kind,
    startup_notice_html, startup_notice_html_kind, startup_window_url, StartupView,
    STARTUP_WINDOW_LABEL,
};
use crate::{is_managed_desktop_window, startup_view_for_launch};

#[test]
fn desktop_window_can_reach_the_phone_breakpoint() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri config should contain valid JSON");
    let main = &config["app"]["windows"][0];
    assert_eq!(main["label"], "main");
    assert_eq!(main["minWidth"], 320);
    assert!(main["minWidth"].as_u64().unwrap_or(u64::MAX) <= 768);
}

#[test]
fn startup_notice_escapes_html_and_percent_encodes_the_document() {
    assert_eq!(
        html_escape("<&>\"' <script>alert(1)</script>"),
        "&lt;&amp;&gt;&quot;&#39; &lt;script&gt;alert(1)&lt;/script&gt;"
    );
    assert_eq!(percent_encode_data("<a b='c'>&"), "%3Ca%20b%3D%27c%27%3E%26");

    let url = startup_notice_data_url_kind(StartupNoticeKind::ExistingWebUiUnavailable);
    assert!(url.starts_with("data:text/html;charset=utf-8,"));
    assert!(!url.contains('<'));
    assert!(!url.contains('>'));
    assert!(!url.contains(' '));
    assert!(!url.contains("<script"));
}

#[test]
fn startup_window_uses_app_assets_only_after_owned_server_readiness() {
    let app_url = tauri::WebviewUrl::App(PathBuf::from("index.html"));
    assert_eq!(
        startup_window_url(&app_url, &StartupView::BundledApp)
            .expect("app URL should be preserved"),
        app_url
    );
}

#[test]
fn owned_and_attached_servers_keep_distinct_application_origins() {
    assert_eq!(
        startup_view_for_launch(OfficeLaunch::OwnedReady),
        StartupView::BundledApp
    );
    assert_eq!(
        startup_view_for_launch(OfficeLaunch::ExistingOpen),
        StartupView::ExistingOffice
    );
}

#[test]
fn startup_close_state_is_carried_into_the_replacement_window() {
    assert!(is_managed_desktop_window("main"));
    assert!(is_managed_desktop_window(STARTUP_WINDOW_LABEL));
    assert!(!is_managed_desktop_window("other"));
    assert!(!replacement_window_should_show(Some(false)));
    assert!(replacement_window_should_show(Some(true)));
    assert!(replacement_window_should_show(None));
}

#[test]
fn startup_window_uses_a_fixed_local_loading_document_before_readiness() {
    assert_eq!(STARTUP_WINDOW_LABEL, "startup");
    let app_url = tauri::WebviewUrl::App(PathBuf::from("index.html"));
    let url = startup_window_url(&app_url, &StartupView::Loading)
        .expect("loading URL should parse");

    let tauri::WebviewUrl::CustomProtocol(url) = url else {
        panic!("loading view must be a fixed data URL");
    };
    assert_eq!(url.scheme(), "data");
    assert!(startup_loading_data_url().starts_with("data:text/html;charset=utf-8,"));
    assert!(!startup_loading_html().contains("127.0.0.1"));
    assert!(!startup_loading_html().contains("<script"));
}

#[test]
fn startup_window_opens_existing_compatible_office_on_loopback() {
    let app_url = tauri::WebviewUrl::App(PathBuf::from("index.html"));
    let url = startup_window_url(&app_url, &StartupView::ExistingOffice)
        .expect("existing office URL should parse");

    let tauri::WebviewUrl::External(url) = url else {
        panic!("existing office must load as External loopback URL");
    };
    assert_eq!(url.as_str(), OFFICE_URL);
}

#[test]
fn attached_loopback_view_uses_the_verified_server_origin() {
    let app_url = tauri::WebviewUrl::App(PathBuf::from("index.html"));
    let url = startup_window_url(&app_url, &StartupView::ExistingOffice)
        .expect("verified desktop server URL should parse");

    assert_eq!(
        url,
        tauri::WebviewUrl::External(
            tauri::Url::parse(OFFICE_URL).expect("Office URL should parse")
        )
    );
}

#[test]
fn startup_window_uses_fixed_notice_as_its_initial_url_on_failure() {
    let app_url = tauri::WebviewUrl::External(
        tauri::Url::parse("http://127.0.0.1:4317/server-supplied")
            .expect("fixture URL should parse"),
    );
    let failure = StartupFailure::from_kind(StartupNoticeKind::PortUsedByOtherService);
    let url = startup_window_url(&app_url, &StartupView::Notice(failure))
        .expect("fixed notice URL should parse");

    let tauri::WebviewUrl::CustomProtocol(url) = url else {
        panic!("notice must be the initial custom-protocol data URL");
    };
    assert_eq!(url.scheme(), "data");
    assert!(url.as_str().starts_with("data:text/html;charset=utf-8,"));
    assert!(!url.as_str().contains("server-supplied"));
}

#[test]
fn startup_notices_include_detail_and_log_path_when_present() {
    let failure = StartupFailure::from_kind(StartupNoticeKind::OwnedManagedRuntimeUnavailable)
        .with_detail("Node.js 22.x was not found. Checked: /tmp/node.")
        .with_log_path(PathBuf::from("/tmp/desktop-startup.log"));
    let html = startup_notice_html(&failure);
    assert!(html.contains("Node.js 22.x was not found"));
    assert!(html.contains("/tmp/desktop-startup.log"));
    assert!(html.contains("Diagnostic log"));
}

#[test]
fn startup_notices_use_cause_specific_fixed_recovery_instructions() {
    let candidate = startup_notice_html_kind(StartupNoticeKind::ExistingServerCandidate);
    assert!(candidate.contains("do not verify its identity"));
    assert!(candidate.contains("manually open http://127.0.0.1:4317/"));
    assert!(candidate.contains("do not open the URL"));

    let port_used = startup_notice_html_kind(StartupNoticeKind::PortUsedByOtherService);
    assert!(port_used.contains("which application owns loopback port 4317"));
    assert!(port_used.contains("close it normally"));
    assert!(port_used.contains("Do not force-kill"));
    assert!(!port_used.contains("build the web assets"));
    assert!(!port_used.contains("combined development surface"));

    let incompatible = startup_notice_html_kind(StartupNoticeKind::ExistingServerIncompatible);
    assert!(incompatible.contains("verify that the process owning loopback port 4317"));
    assert!(incompatible.contains("update it to a version"));
    assert!(incompatible.contains("compatible server"));

    let malformed = startup_notice_html_kind(StartupNoticeKind::ExistingServerMalformed);
    assert!(malformed.contains("listener and its logs"));
    assert!(malformed.contains("health response is invalid"));

    let timeout = startup_notice_html_kind(StartupNoticeKind::ExistingServerTimeout);
    assert!(timeout.contains("health check timed out"));
    assert!(timeout.contains("Restart that service normally"));

    let web_timeout = startup_notice_html_kind(StartupNoticeKind::ExistingWebUiTimeout);
    assert!(web_timeout.contains("Web UI response timed out"));
    assert!(web_timeout.contains("listener and its logs"));

    let web_ui = startup_notice_html_kind(StartupNoticeKind::ExistingWebUiUnavailable);
    assert!(web_ui.contains("normal combined development surface"));

    let runtime = startup_notice_html_kind(StartupNoticeKind::OwnedManagedRuntimeUnavailable);
    assert!(runtime.contains("Node.js 22.x"));
    assert!(runtime.contains("installed Hermes Agent"));
    assert!(runtime.contains("not bundled"));

    // Keep data URL helper callable without detail.
    let _ = startup_notice_data_url(&StartupFailure::from_kind(
        StartupNoticeKind::OwnedChildLaunchFailed,
    ));
}
