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
use window::{build_main_window, navigate_main_window, StartupView};

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
            // A fixed data: loading document is safe to show immediately while
            // runtime discovery and readiness run away from the main thread.
            // - Free port: start an owned child, prove readiness, navigate to bundled UI.
            // - Compatible existing server: require its private ownership proof,
            //   then open http://127.0.0.1:4317/ without taking process ownership.
            // - Other failures: fixed self-contained notice page.
            //
            // Never return Err from this hook: with release `panic = "abort"`,
            // Tauri turns setup errors into SIGABRT (macOS crash report). Exit
            // through the normal lifecycle when no recovery window can exist.
            if let Err(error) = build_main_window(app, StartupView::Loading) {
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
            } if label == "main" => {
                // Match normal macOS document-window behavior: keep the owned
                // server and WebView alive while the user closes the visible
                // window, then restore it from the Dock without re-running setup.
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(window) = handle.get_webview_window("main") {
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
        Ok(launch @ OfficeLaunch::OwnedReady) => (StartupView::BundledApp, Some(launch)),
        Ok(launch @ OfficeLaunch::ExistingOpen) => (StartupView::ExistingOffice, Some(launch)),
        Err(failure) => (StartupView::Notice(failure), None),
    };
    let transition_app = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        match navigate_main_window(&transition_app, view) {
            Ok(()) => {
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
                let notice = StartupFailure::from_kind(StartupNoticeKind::InternalStateUnavailable)
                    .with_detail(format!("Startup window transition failed: {error}"));
                if let Err(notice_error) =
                    navigate_main_window(&transition_app, StartupView::Notice(notice))
                {
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
