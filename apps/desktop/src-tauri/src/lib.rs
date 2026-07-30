mod capability;
mod constants;
mod diagnostics;
mod health;
mod hex_util;
mod http;
mod proof;
mod remote_config;
mod runtime;
mod secret_transfer;
mod server;
mod startup;
mod web_ui;
mod window;

#[cfg(test)]
mod tests;

use std::{sync::Mutex, thread};

use tauri::{Manager, RunEvent};
#[cfg(target_os = "macos")]
use tauri::WindowEvent;

use capability::{
    clear_optional_state, desktop_capability, desktop_owned,
    remove_persisted_desktop_capability_if_matches, start_attached_server_monitor,
    start_owned_server_monitor, AttachedServerCapability, DesktopCapability, DesktopProofGate,
    OfficeServerProcess,
};
use secret_transfer::deposit_secret_transfer;
use server::{setup_office, stop_office_server};
use startup::{OfficeLaunch, StartupFailure, StartupNoticeKind};
use window::{
    build_startup_window, replace_startup_window, show_startup_notice, StartupView,
    STARTUP_WINDOW_LABEL,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .manage(DesktopCapability(Mutex::new(None)))
        .manage(AttachedServerCapability(Mutex::new(None)))
        .manage(DesktopProofGate(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            desktop_capability,
            desktop_owned,
            deposit_secret_transfer
        ])
        .setup(|app| {
            // `main` has `create: false` in tauri.conf.json. Do not create a
            // privileged WebView until the loopback listener has been classified.
            // A fixed data: loading document is safe to show immediately in a
            // separate unprivileged WebView while runtime discovery and readiness
            // run away from the main thread.
            // - Free port: start an owned child, prove readiness, then create a
            //   fresh privileged WebView directly on the packaged app origin.
            //   Creating it at its final URL avoids the document-start IPC race
            //   without giving up desktop capability auth or origin-scoped data.
            // - Compatible existing server: require its private ownership proof,
            //   then open http://127.0.0.1:4317/ without taking process ownership.
            // - Other failures: fixed self-contained notice page.
            //
            // Never return Err from this hook: with release `panic = "abort"`,
            // Tauri turns setup errors into SIGABRT (macOS crash report). Exit
            // through the normal lifecycle when no recovery window can exist.
            if let Err(error) = build_startup_window(app) {
                eprintln!("Hermes Studio could not create its startup window: {error}");
                app.handle().exit(1);
                return Ok(());
            }
            let app_handle = app.handle().clone();
            thread::spawn(move || finish_office_setup(app_handle));
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Hermes Studio could not start safely: {error}");
            return;
        }
    };

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        match &event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if is_managed_desktop_window(label) => {
                // Match normal macOS document-window behavior: keep the owned
                // server and WebView alive while the user closes the visible
                // window, then restore it from the Dock without re-running setup.
                api.prevent_close();
                if let Some(window) = handle
                    .get_webview_window("main")
                    .or_else(|| handle.get_webview_window(STARTUP_WINDOW_LABEL))
                {
                    let _ = window.hide();
                }
            }
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(window) = handle
                    .get_webview_window("main")
                    .or_else(|| handle.get_webview_window(STARTUP_WINDOW_LABEL))
                {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_owned_office(handle);
        }
    });
}

fn finish_office_setup(app: tauri::AppHandle) {
    let (view, launch) = match setup_office(&app) {
        Ok(launch) => (startup_view_for_launch(launch), Some(launch)),
        Err(failure) => (StartupView::Notice(failure), None),
    };
    let transition_app = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        diagnostics::log_event("Creating the classified main application window.");
        match replace_startup_window(&transition_app, view) {
            Ok(()) => {
                diagnostics::log_event("Main application window is ready.");
                match launch {
                    Some(OfficeLaunch::OwnedReady) => {
                        start_owned_server_monitor(transition_app.clone());
                    }
                    Some(OfficeLaunch::ExistingOpen) => {
                        start_attached_server_monitor(transition_app.clone());
                    }
                    None => {}
                }
            }
            Err(error) => {
                stop_owned_office(&transition_app);
                diagnostics::log_event(&format!(
                    "Main application window creation failed: {error}"
                ));
                let notice = StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                    .with_detail(format!("Startup window transition failed: {error}"));
                if let Err(notice_error) = show_startup_notice(&transition_app, notice) {
                    eprintln!(
                        "Hermes Studio could not finish its startup window ({error}) or show its recovery notice ({notice_error})."
                    );
                    transition_app.exit(1);
                }
            }
        }
    });
    if let Err(error) = scheduled {
        stop_owned_office(&app);
        eprintln!(
            "Hermes Studio could not schedule its startup window transition: {error}"
        );
        app.exit(1);
    }
}

pub(crate) fn startup_view_for_launch(launch: OfficeLaunch) -> StartupView {
    match launch {
        OfficeLaunch::OwnedReady => StartupView::BundledApp,
        OfficeLaunch::ExistingOpen => StartupView::ExistingOffice,
    }
}

pub(crate) fn is_managed_desktop_window(label: &str) -> bool {
    label == "main" || label == STARTUP_WINDOW_LABEL
}

fn stop_owned_office(app: &tauri::AppHandle) {
    clear_optional_state(&app.state::<AttachedServerCapability>().0);
    let capability_state = app.state::<DesktopCapability>();
    let mut capability = capability_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let owned_capability = capability.take();
    drop(capability);
    let process_state = app.state::<OfficeServerProcess>();
    let mut process = process_state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let child = process.take();
    drop(process);
    if let Some(mut child) = child {
        // Remove the rendezvous secret before releasing port 4317 so another
        // instance cannot mistake a stale proof for a new owner. A delayed old
        // owner may run after a replacement has started, so it may delete only
        // the capability value that this process actually persisted.
        if let Some(owned_capability) = owned_capability {
            remove_persisted_desktop_capability_if_matches(app, &owned_capability);
        }
        stop_office_server(&mut child);
    }
}
