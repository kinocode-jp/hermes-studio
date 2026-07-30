use crate::constants::OFFICE_URL;
use crate::startup::StartupFailure;
#[cfg(test)]
use crate::startup::StartupNoticeKind;
use tauri::Manager;

const BUNDLED_APP_BOOTSTRAP_RECOVERY: &str = r#"
if (window.location.protocol !== 'data:') {
  setTimeout(function () {
    var root = document.getElementById('app');
    if (!root || root.childElementCount === 0) window.location.reload();
  }, 1500);
}
"#;

/// What the main window should load after classification / setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StartupView {
    /// Fixed local document shown while runtime discovery and readiness run off
    /// the main thread. It never connects to or renders loopback content.
    Loading,
    /// Packaged frontend after an owned server passed readiness.
    BundledApp,
    /// Existing listener passed health + Web UI shape; open loopback Office URL.
    ExistingOffice,
    /// Recoverable failure with a fixed self-contained notice page.
    Notice(StartupFailure),
}

pub(crate) fn build_main_window(
    app: &tauri::App,
    view: StartupView,
) -> Result<(), Box<dyn std::error::Error>> {
    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Hermes Studio main window configuration is unavailable")?;
    let mut window_config = main_config.clone();
    window_config.url = startup_window_url(&main_config.url, &view)?;
    let window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;
    if matches!(view, StartupView::BundledApp) {
        // WKWebView can occasionally leave the first bundled-app navigation at
        // an empty document while the native setup hook is still unwinding.
        // Retry once only when Preact has not mounted; successful startups and
        // external/error views are untouched.
        window.eval(BUNDLED_APP_BOOTSTRAP_RECOVERY)?;
    }
    Ok(())
}

pub(crate) fn startup_window_url(
    app_url: &tauri::WebviewUrl,
    view: &StartupView,
) -> Result<tauri::WebviewUrl, Box<dyn std::error::Error>> {
    match view {
        StartupView::Loading => Ok(tauri::WebviewUrl::CustomProtocol(tauri::Url::parse(
            &startup_loading_data_url(),
        )?)),
        StartupView::BundledApp => Ok(app_url.clone()),
        StartupView::ExistingOffice => Ok(tauri::WebviewUrl::External(tauri::Url::parse(
            OFFICE_URL,
        )?)),
        StartupView::Notice(notice) => Ok(tauri::WebviewUrl::CustomProtocol(tauri::Url::parse(
            &startup_notice_data_url(notice),
        )?)),
    }
}

/// Replace the fixed loading document after background startup completes.
pub(crate) fn navigate_main_window(
    app: &tauri::AppHandle,
    view: StartupView,
) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("Hermes Studio main window is unavailable")?;
    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Hermes Studio main window configuration is unavailable")?;
    let target = resolve_navigation_url(
        app,
        main_config.use_https_scheme,
        startup_window_url(&main_config.url, &view)?,
    )?;
    window.navigate(target)?;
    if matches!(view, StartupView::BundledApp) {
        // This is only a best-effort WKWebView recovery. A transient eval race
        // with the native navigation must not tear down an otherwise-ready
        // owned server or replace the app with a startup failure notice.
        let _ = window.eval(BUNDLED_APP_BOOTSTRAP_RECOVERY);
    }
    Ok(())
}

fn resolve_navigation_url(
    app: &tauri::AppHandle,
    use_https_scheme: bool,
    value: tauri::WebviewUrl,
) -> Result<tauri::Url, Box<dyn std::error::Error>> {
    match value {
        tauri::WebviewUrl::External(url) | tauri::WebviewUrl::CustomProtocol(url) => Ok(url),
        tauri::WebviewUrl::App(path) => {
            #[cfg(debug_assertions)]
            let base = app
                .config()
                .build
                .dev_url
                .clone()
                .unwrap_or(bundled_app_base_url(use_https_scheme)?);
            #[cfg(not(debug_assertions))]
            let base = {
                let _ = app;
                bundled_app_base_url(use_https_scheme)?
            };
            if path.to_str() == Some("index.html") {
                Ok(base)
            } else {
                Ok(base.join(&path.to_string_lossy())?)
            }
        }
        _ => Err("Hermes Studio startup URL is unsupported".into()),
    }
}

fn bundled_app_base_url(
    use_https_scheme: bool,
) -> Result<tauri::Url, Box<dyn std::error::Error>> {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let value = if use_https_scheme {
        "https://tauri.localhost"
    } else {
        "http://tauri.localhost"
    };
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let value = {
        let _ = use_https_scheme;
        "tauri://localhost"
    };
    Ok(tauri::Url::parse(value)?)
}

#[cfg(test)]
pub(crate) fn startup_notice_html_kind(notice: StartupNoticeKind) -> String {
    startup_notice_html(&StartupFailure::from_kind(notice))
}

pub(crate) fn startup_notice_html(notice: &StartupFailure) -> String {
    let title = html_escape("Hermes Studio needs attention");
    let explanation = html_escape(notice.kind.explanation());
    let recovery_steps = notice
        .kind
        .recovery_steps()
        .iter()
        .map(|step| format!("<li>{}</li>", html_escape(step)))
        .collect::<String>();
    let detail = notice
        .detail
        .as_deref()
        .map(|value| {
            format!(
                "<p><strong>Details</strong></p><pre>{}</pre>",
                html_escape(value)
            )
        })
        .unwrap_or_default();
    let log = notice
        .log_path
        .as_ref()
        .map(|path| {
            format!(
                "<p><strong>Diagnostic log</strong></p><p><code>{}</code></p>",
                html_escape(&path.display().to_string())
            )
        })
        .unwrap_or_default();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>html{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,-apple-system,sans-serif;background:#111827;color:#f8fafc}}main{{box-sizing:border-box;width:min(720px,calc(100% - 40px));padding:32px;border:1px solid #374151;border-radius:16px;background:#1f2937}}h1{{margin:0 0 16px;font-size:26px}}p,ol{{margin:12px 0}}li+li{{margin-top:8px}}pre{{white-space:pre-wrap;word-break:break-word;padding:12px;border-radius:8px;background:#111827;border:1px solid #374151;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e5e7eb}}code{{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}}</style></head><body><main><h1>{title}</h1><p>{explanation}</p><p>No external server or process was stopped or replaced.</p>{detail}{log}<p><strong>What to do next</strong></p><ol>{recovery_steps}</ol><p>Office API target remains <code>{}</code> when the owned server is running.</p></main></body></html>",
        html_escape(OFFICE_URL.trim_end_matches('/'))
    )
}

pub(crate) fn startup_loading_html() -> String {
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Hermes Studio</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,-apple-system,sans-serif;background:#111827;color:#f8fafc}main{text-align:center}h1{margin:0 0 12px;font-size:26px}p{margin:0;color:#cbd5e1}</style></head><body><main><h1>Hermes Studio</h1><p>Starting the local runtime&hellip;</p></main></body></html>".to_owned()
}

pub(crate) fn html_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

pub(crate) fn percent_encode_data(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

pub(crate) fn startup_notice_data_url(notice: &StartupFailure) -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode_data(&startup_notice_html(notice))
    )
}

pub(crate) fn startup_loading_data_url() -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode_data(&startup_loading_html())
    )
}

// Keep a simple kind-only helper for unit tests and call sites that have no detail.
#[cfg(test)]
pub(crate) fn startup_notice_data_url_kind(notice: StartupNoticeKind) -> String {
    startup_notice_data_url(&StartupFailure::from_kind(notice))
}
