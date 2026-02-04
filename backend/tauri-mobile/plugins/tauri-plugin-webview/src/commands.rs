use tauri::{command, AppHandle, Runtime};

use crate::Result;

// Note: These plugin commands are kept for API compatibility but are no longer used.
// The actual native webview is invoked via direct Tauri commands (open_native_webview,
// close_native_webview) defined in the main app's lib.rs.

#[command]
pub async fn open_webview<R: Runtime>(
    _app: AppHandle<R>,
    url: String,
    item_id: String,
) -> Result<()> {
    println!("[webview plugin] open_webview command invoked (stub): url={}, item_id={}", url, item_id);
    let _ = (url, item_id);
    Ok(())
}

#[command]
pub async fn close_webview<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    println!("[webview plugin] close_webview command invoked (stub)");
    Ok(())
}
