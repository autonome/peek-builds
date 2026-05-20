//! Net fetch command - CORS-bypassing HTTP proxy
//!
//! Mirrors the Electron `net-fetch` IPC handler.
//! Used by extensions that need to fetch from external APIs.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct NetFetchOptions {
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct NetFetchResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn net_fetch(
    url: String,
    options: Option<NetFetchOptions>,
) -> Result<NetFetchResponse, String> {
    // Only allow http/https URLs
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(NetFetchResponse {
            success: false,
            data: None,
            status: None,
            error: Some("Only http/https URLs are allowed".to_string()),
        });
    }

    let opts = options.unwrap_or(NetFetchOptions {
        method: None,
        headers: None,
        timeout: None,
    });

    let timeout_ms = opts.timeout.unwrap_or(5000);
    let method_str = opts.method.as_deref().unwrap_or("GET");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let method = method_str
        .parse::<reqwest::Method>()
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let mut request = client.request(method, &url);

    // Forward custom headers
    if let Some(headers) = opts.headers {
        for (key, value) in headers {
            request = request.header(&key, &value);
        }
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();

            if !response.status().is_success() {
                let status_text = response.status().canonical_reason().unwrap_or("Unknown");
                return Ok(NetFetchResponse {
                    success: false,
                    data: None,
                    status: Some(status),
                    error: Some(format!("HTTP {}: {}", status, status_text)),
                });
            }

            match response.text().await {
                Ok(text) => Ok(NetFetchResponse {
                    success: true,
                    data: Some(text),
                    status: Some(status),
                    error: None,
                }),
                Err(e) => Ok(NetFetchResponse {
                    success: false,
                    data: None,
                    status: Some(status),
                    error: Some(format!("Failed to read response body: {}", e)),
                }),
            }
        }
        Err(e) => Ok(NetFetchResponse {
            success: false,
            data: None,
            status: None,
            error: Some(e.to_string()),
        }),
    }
}
