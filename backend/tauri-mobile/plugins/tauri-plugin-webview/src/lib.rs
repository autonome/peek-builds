use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub use error::{Error, Result};

mod commands;
mod error;

// Note: The webview plugin commands are kept for potential future use,
// but the actual native webview on iOS is invoked via direct Tauri commands
// (open_native_webview, close_native_webview) in lib.rs to avoid iOS plugin routing issues.

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    println!("[webview plugin] Creating plugin builder...");
    Builder::new("webview")
        .invoke_handler(tauri::generate_handler![
            commands::open_webview,
            commands::close_webview
        ])
        .build()
}
