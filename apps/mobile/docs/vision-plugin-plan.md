# Tauri Vision Plugin Plan

## Overview

A Tauri 2 mobile plugin that provides full Vision framework analysis for images stored in Peek. This extends beyond the Share Extension's lightweight `.fast` OCR to offer comprehensive image intelligence within the main app, where memory limits are much higher.

## Plugin Structure

Following the Tauri 2 mobile plugin pattern (reference: `plugins/tauri-plugin-webview/`):

```
plugins/tauri-plugin-vision/
  src/
    lib.rs          # Plugin init, Builder::new("vision")
    commands.rs     # Tauri #[command] functions
    error.rs        # Error types with Serialize
  ios/
    Package.swift   # Swift package depending on Tauri API
    Sources/
      VisionPlugin.swift   # Swift implementation with Vision/NLP
  Cargo.toml        # Rust crate metadata
```

## Swift Side: Full Vision Analysis

The Swift implementation lives in `ios/Sources/VisionPlugin.swift` and provides these analysis capabilities:

### 1. OCR Text Recognition (Accurate)
- `VNRecognizeTextRequest` with `.accurate` recognition level (main app has 300MB+ memory headroom)
- `usesLanguageCorrection = true` for better results
- Returns full text with per-line confidence scores and bounding boxes

### 2. Image Classification
- `VNClassifyImageRequest` for scene/object classification
- Returns top 5 classifications with confidence > 0.3
- Useful for auto-tagging: "outdoor", "food", "document", "screenshot", etc.

### 3. Barcode/QR Detection
- `VNDetectBarcodesRequest` for all symbologies
- Returns payload string, symbology type, and bounding box

### 4. Face Detection
- `VNDetectFaceRectanglesRequest` for face count and positions
- `VNDetectFaceLandmarksRequest` for landmark positions (optional, if needed later)
- Returns face count and bounding rectangles (not face recognition, just detection)

### 5. NLP Entity Extraction
- `NLTagger` with `.nameType` scheme on OCR text
- `NSDataDetector` for dates, URLs, phone numbers, addresses
- Same pipeline as Share Extension but runs on full `.accurate` OCR output

### Swift Function Signatures

```swift
@objc public class VisionPlugin: NSObject {

    /// Full analysis — runs all pipelines
    @objc public static func analyzeImage(
        _ imageData: Data,
        completion: @escaping (String) -> Void  // JSON string result
    )

    /// OCR only — for re-running text extraction
    @objc public static func recognizeText(
        _ imageData: Data,
        accurate: Bool,
        completion: @escaping (String) -> Void
    )

    /// Classification only
    @objc public static func classifyImage(
        _ imageData: Data,
        completion: @escaping (String) -> Void
    )
}
```

Results are serialized to JSON strings for FFI transport. All analysis runs on `DispatchQueue.global(qos: .userInitiated)` with `autoreleasepool` wrapping.

## Rust Side: FFI Bridge and Tauri Commands

### FFI Bridge

The Swift functions are exposed to Rust via C-compatible function signatures. The pattern follows Tauri's existing mobile plugin FFI:

```rust
// src/commands.rs
use tauri::{command, AppHandle, Runtime};
use crate::Result;

#[command]
pub async fn analyze_image<R: Runtime>(
    app: AppHandle<R>,
    item_id: String,
) -> Result<VisionResult> {
    // 1. Load image blob from PeekCore by item_id
    // 2. Call Swift Vision analysis via FFI
    // 3. Parse JSON result
    // 4. Return structured result
}

#[command]
pub async fn recognize_text<R: Runtime>(
    app: AppHandle<R>,
    item_id: String,
    accurate: bool,
) -> Result<OcrResult> { ... }

#[command]
pub async fn classify_image<R: Runtime>(
    app: AppHandle<R>,
    item_id: String,
) -> Result<Vec<Classification>> { ... }
```

### Result Types

```rust
#[derive(Serialize, Deserialize)]
pub struct VisionResult {
    pub ocr_text: Option<String>,
    pub barcodes: Vec<BarcodeResult>,
    pub classifications: Vec<Classification>,
    pub face_count: u32,
    pub entities: Entities,
}

#[derive(Serialize, Deserialize)]
pub struct BarcodeResult {
    pub payload: String,
    pub symbology: String,
}

#[derive(Serialize, Deserialize)]
pub struct Classification {
    pub label: String,
    pub confidence: f64,
}

#[derive(Serialize, Deserialize)]
pub struct Entities {
    pub people: Vec<String>,
    pub places: Vec<String>,
    pub organizations: Vec<String>,
    pub dates: Vec<String>,
    pub urls: Vec<String>,
    pub phones: Vec<String>,
}
```

### Plugin Registration

```rust
// src/lib.rs
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vision")
        .invoke_handler(tauri::generate_handler![
            commands::analyze_image,
            commands::recognize_text,
            commands::classify_image,
        ])
        .build()
}
```

Registered in the main app's `lib.rs`:
```rust
.plugin(tauri_plugin_vision::init())
```

## JS Side: invoke() API

```javascript
// In the main app's frontend (e.g., page.js or a dedicated vision module)
import { invoke } from '@tauri-apps/api/core';

// Full analysis
const result = await invoke('plugin:vision|analyze_image', {
  itemId: 'item-uuid-here'
});
// result: { ocrText, barcodes, classifications, faceCount, entities }

// OCR only
const ocr = await invoke('plugin:vision|recognize_text', {
  itemId: 'item-uuid-here',
  accurate: true
});

// Classification only
const classes = await invoke('plugin:vision|classify_image', {
  itemId: 'item-uuid-here'
});
```

## Integration with Item/Blob Storage

### Reading Image Data

The plugin accesses image blobs through PeekCore's existing storage:

1. Rust command receives `item_id`
2. Calls `PeekCoreFfi::get_blob(item_id)` to retrieve the raw image bytes
3. Passes bytes to Swift Vision via FFI
4. No file I/O needed -- blob storage is already in-memory via the FFI layer

### Writing Analysis Results

After analysis completes:

1. Results are returned to JS as structured JSON
2. JS calls the existing `update_item_metadata` command to merge `_vision` key into the item's metadata
3. This matches the Share Extension pattern: `metadata._vision = { ocrText, barcodes, entities, classifications, faceCount }`

The `_vision` metadata key is the same schema used by the Share Extension, extended with `classifications` and `faceCount` fields.

## Data Flow

```
User taps "Analyze" on an image item in the main app UI
  |
  v
JS: invoke('plugin:vision|analyze_image', { itemId })
  |
  v
Rust: analyze_image command
  |-- Load image blob from PeekCore DB (get_blob)
  |-- Pass image bytes to Swift via FFI channel
  |
  v
Swift: VisionPlugin.analyzeImage(imageData)
  |-- Downscale to max 4096px (main app can handle larger)
  |-- autoreleasepool {
  |     VNRecognizeTextRequest (.accurate)
  |     VNDetectBarcodesRequest
  |     VNClassifyImageRequest
  |     VNDetectFaceRectanglesRequest
  |   }
  |-- NLTagger + NSDataDetector on OCR text
  |-- Serialize to JSON string
  |
  v
Rust: Parse JSON, return VisionResult to JS
  |
  v
JS: Receive result
  |-- Display OCR text, classifications, barcodes in UI
  |-- Auto-suggest tags from entities + classifications
  |-- invoke('update_item_metadata', { itemId, metadata: { _vision: result } })
  |
  v
PeekCore DB: Item metadata updated with _vision key
  |-- Syncs to server on next push cycle
```

## Memory Considerations

| Context | Memory Limit | OCR Level | Max Image Size |
|---------|-------------|-----------|----------------|
| Share Extension | ~120MB | `.fast` | 2048px |
| Main App | ~300MB+ | `.accurate` | 4096px |

The main app plugin uses `.accurate` OCR and allows larger images because the app process has significantly more memory headroom than the Share Extension.

## Future Extensions

- **Batch analysis**: Analyze all images without `_vision` metadata on app launch (background queue)
- **Search by OCR text**: Index `_vision.ocrText` for full-text search across images
- **Smart tags**: Use `classifications` to auto-suggest tags ("food", "document", "screenshot")
- **Face grouping**: Use face detection + position data for grouping photos of the same context
