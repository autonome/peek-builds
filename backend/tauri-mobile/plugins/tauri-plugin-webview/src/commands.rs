use tauri::{command, AppHandle, Runtime};

use crate::Result;

// Note: The actual webview opening is handled by Swift code in Xcode builds.
// These commands are stubs that will be overridden by the native implementation
// when the app is built through Xcode with the Swift plugin.

#[command]
pub async fn open_webview<R: Runtime>(
    _app: AppHandle<R>,
    url: String,
    item_id: String,
) -> Result<()> {
    // This is a stub - the actual implementation is in Swift (WebviewPlugin.swift)
    // and is registered when building through Xcode.
    println!("[webview plugin] open_webview called: url={}, item_id={}", url, item_id);
    println!("[webview plugin] Note: Native webview requires Xcode build with Swift plugin");
    Ok(())
}

#[command]
pub async fn close_webview<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    // This is a stub - the actual implementation is in Swift
    println!("[webview plugin] close_webview called");
    Ok(())
}
