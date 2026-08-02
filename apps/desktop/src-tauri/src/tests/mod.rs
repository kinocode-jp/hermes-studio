//! Unit tests for the desktop Tauri library modules.
//! Split by domain so each file stays under the 800-line limit.

mod capability;
mod health;
mod hex_util;
mod http;
mod proof;
mod runtime;
mod secret_transfer;
mod server;
mod startup;
mod web_ui;
mod window;

// diagnostics unit tests live in the diagnostics module itself under cfg(test).
