use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub use error::{Error, Result};

mod commands;
mod error;

// Note: The iOS native webview functionality requires building through Xcode.
// When building with `cargo tauri build`, the plugin will be a no-op on iOS.
// The Swift plugin code in ios/Sources/WebviewPlugin.swift is compiled by Xcode.

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webview")
        .invoke_handler(tauri::generate_handler![
            commands::open_webview,
            commands::close_webview
        ])
        .build()
}
