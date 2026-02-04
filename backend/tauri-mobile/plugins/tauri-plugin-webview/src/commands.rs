use tauri::{command, AppHandle, Runtime};

use crate::Result;

#[command]
pub async fn open_webview<R: Runtime>(
    _app: AppHandle<R>,
    url: String,
    item_id: String,
) -> Result<()> {
    #[cfg(target_os = "ios")]
    {
        if crate::open_webview_native(&url, &item_id) {
            Ok(())
        } else {
            Err(crate::Error::Webview("Failed to open webview".to_string()))
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (url, item_id);
        println!("[webview plugin] open_webview not supported on this platform");
        Ok(())
    }
}

#[command]
pub async fn close_webview<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
    #[cfg(target_os = "ios")]
    {
        crate::close_webview_native();
    }
    Ok(())
}
