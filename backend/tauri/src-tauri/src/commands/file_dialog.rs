//! File dialog commands - native save/open dialogs
//!
//! Mirrors the Electron `file-save-dialog` and `file-open-dialog` IPC handlers.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// Filter for file dialogs (e.g., { name: "JSON", extensions: ["json"] })
#[derive(Debug, Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

// ── file-save-dialog ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct FileSaveResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn file_save_dialog(
    app: tauri::AppHandle,
    content: String,
    filename: Option<String>,
    mime_type: Option<String>,
) -> Result<FileSaveResponse, String> {
    // Build file filters based on MIME type
    let mut builder = app.dialog().file();

    if let Some(ref mime) = mime_type {
        match mime.as_str() {
            "application/json" => {
                builder = builder.add_filter("JSON", &["json"]);
            }
            "text/csv" => {
                builder = builder.add_filter("CSV", &["csv"]);
            }
            "text/plain" => {
                builder = builder.add_filter("Text", &["txt"]);
            }
            "text/html" => {
                builder = builder.add_filter("HTML", &["html", "htm"]);
            }
            _ => {}
        }
    }
    builder = builder.add_filter("All Files", &["*"]);

    // Set default filename
    if let Some(ref name) = filename {
        builder = builder.set_file_name(name);
    }

    // Show dialog (blocking on async channel)
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.save_file(move |path| {
        let _ = tx.send(path);
    });

    let file_path = rx.await.map_err(|e| format!("Dialog channel error: {}", e))?;

    match file_path {
        Some(path) => {
            let path_str = path.to_string_lossy().to_string();
            // Write content to the selected path
            if let Err(e) = std::fs::write(&path_str, &content) {
                return Ok(FileSaveResponse {
                    success: false,
                    path: None,
                    canceled: None,
                    error: Some(format!("Failed to write file: {}", e)),
                });
            }
            Ok(FileSaveResponse {
                success: true,
                path: Some(path_str),
                canceled: None,
                error: None,
            })
        }
        None => Ok(FileSaveResponse {
            success: false,
            path: None,
            canceled: Some(true),
            error: None,
        }),
    }
}

// ── file-open-dialog ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct FileOpenData {
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub content: Option<String>,
    #[serde(rename = "isText")]
    pub is_text: bool,
}

#[derive(Debug, Serialize)]
pub struct FileOpenResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<FileOpenData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn file_open_dialog(
    app: tauri::AppHandle,
) -> Result<FileOpenResponse, String> {
    let builder = app
        .dialog()
        .file()
        .add_filter("All Files", &["*"])
        .add_filter(
            "Text Files",
            &[
                "txt", "md", "json", "html", "csv", "xml", "yaml", "yml",
                "toml", "ini", "cfg", "log",
            ],
        )
        .add_filter("Documents", &["pdf", "doc", "docx", "rtf"]);

    // Show dialog
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_file(move |path| {
        let _ = tx.send(path);
    });

    let file_path = rx.await.map_err(|e| format!("Dialog channel error: {}", e))?;

    match file_path {
        Some(selected) => {
            let path_str = selected.to_string_lossy().to_string();
            let path = Path::new(&path_str);

            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            let ext = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default();

            let stats = std::fs::metadata(&path_str)
                .map_err(|e| format!("Failed to stat file: {}", e))?;

            let mime_type = ext_to_mime(&ext).to_string();

            let is_text = mime_type.starts_with("text/")
                || mime_type == "application/json"
                || mime_type == "application/xml"
                || mime_type == "image/svg+xml";

            let content = if is_text {
                std::fs::read_to_string(&path_str).ok()
            } else {
                None
            };

            Ok(FileOpenResponse {
                success: true,
                data: Some(FileOpenData {
                    name: file_name,
                    path: path_str,
                    size: stats.len(),
                    mime_type,
                    content,
                    is_text,
                }),
                canceled: None,
                error: None,
            })
        }
        None => Ok(FileOpenResponse {
            success: false,
            data: None,
            canceled: Some(true),
            error: None,
        }),
    }
}

/// Map file extension to MIME type, matching the Electron implementation
fn ext_to_mime(ext: &str) -> &'static str {
    match ext {
        ".md" | ".markdown" => "text/markdown",
        ".txt" | ".text" => "text/plain",
        ".json" => "application/json",
        ".html" | ".htm" => "text/html",
        ".csv" => "text/csv",
        ".xml" => "application/xml",
        ".yaml" | ".yml" => "text/yaml",
        ".toml" | ".ini" | ".cfg" | ".log" => "text/plain",
        ".js" => "text/javascript",
        ".ts" => "text/typescript",
        ".css" => "text/css",
        ".py" => "text/x-python",
        ".rb" => "text/x-ruby",
        ".sh" | ".bash" | ".zsh" => "text/x-shellscript",
        ".c" | ".h" => "text/x-c",
        ".cpp" => "text/x-c++",
        ".java" => "text/x-java",
        ".go" => "text/x-go",
        ".rs" => "text/x-rust",
        ".swift" => "text/x-swift",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
