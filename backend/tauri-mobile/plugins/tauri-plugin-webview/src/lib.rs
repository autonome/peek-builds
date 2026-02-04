use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub use error::{Error, Result};

mod commands;
mod error;

// FFI declarations for the Swift functions
#[cfg(target_os = "ios")]
extern "C" {
    fn init_plugin_webview() -> *mut std::ffi::c_void;
    fn webview_plugin_open(url: *const std::ffi::c_char, item_id: *const std::ffi::c_char) -> bool;
    fn webview_plugin_close();
}

#[cfg(target_os = "ios")]
pub fn open_webview_native(url: &str, item_id: &str) -> bool {
    use std::ffi::CString;
    let url_cstr = CString::new(url).unwrap();
    let item_id_cstr = CString::new(item_id).unwrap();
    unsafe { webview_plugin_open(url_cstr.as_ptr(), item_id_cstr.as_ptr()) }
}

#[cfg(target_os = "ios")]
pub fn close_webview_native() {
    unsafe { webview_plugin_close() }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webview")
        .invoke_handler(tauri::generate_handler![
            commands::open_webview,
            commands::close_webview
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                // Initialize the Swift plugin
                unsafe { init_plugin_webview() };
            }
            Ok(())
        })
        .build()
}
