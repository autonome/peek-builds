# Example Extension - Image Gallery

This example extension is the **reference template for new Peek extensions**.
It demonstrates the strict (v2 tile) API shape, which is the supported form
for all newly written features.

## Features

1. **Peek API Feature Detection** - Works as both a Peek extension and a standalone website
2. **Command Registration with Mime Types** - Accepts image data from other commands
3. **Data Storage** - Uses Peek datastore when available, falls back to in-memory
4. **Image Gallery UI** - Displays stored images with drag-and-drop support

## Feature Detection Pattern

```javascript
// Check if Peek API is available
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

// Gate functionality based on API availability
if (hasPeekAPI) {
  // Full Peek extension functionality
  api.commands.register({ ... });
  // Access commands via the cmd palette (Option+Space)
} else {
  // Fallback for standalone website mode
  console.log('Running without Peek API');
}
```

## Tile Initialization

Every v2 tile must call `api.initialize()` before using any capability-gated
APIs — this validates the capability token with the main process.
`background.html` does this before calling `extension.init()`; any other
window tile (like `gallery.html`) does the same at the top of its script.

```javascript
if (hasPeekAPI && typeof api.initialize === 'function') {
  await api.initialize();
}
```

## Pubsub (strict form)

Use `api.pubsub.publish` / `api.pubsub.subscribe` directly. The flat
`api.publish` / `api.subscribe` helpers are v1-compat shims and should not be
used in new code.

```javascript
api.pubsub.publish('example:image-added', payload, api.scopes.GLOBAL);

api.pubsub.subscribe('example:image-added', (msg) => {
  renderGallery();
}, api.scopes.GLOBAL);
```

The manifest must declare every topic you publish or subscribe to under
`capabilities.pubsub.topics`, plus the scopes you use under
`capabilities.pubsub.scopes`.

## Command with Mime Type Acceptance

Commands can declare which data types they accept:

```javascript
api.commands.register({
  name: 'example:save-image',
  description: 'Save an image to the gallery',
  accepts: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*'],
  execute: (ctx) => {
    // ctx.input contains: { data: base64, mimeType, name }
    const imageData = ctx.input;
    storeImage(generateId(), imageData);
  }
});
```

The `accepts` array tells Peek which mime types this command can handle. When data matching these types is available, Peek can automatically offer this command.

## Storage Abstraction

```javascript
async function storeImage(id, imageData) {
  if (hasPeekAPI) {
    // Persistent storage via Peek datastore
    await api.datastore.setRow('example_images', id, imageData);
  } else {
    // In-memory fallback for standalone mode
    localStore.set(id, imageData);
  }
}

async function getStoredImages() {
  if (hasPeekAPI) {
    const result = await api.datastore.getTable('example_images');
    return result.success ? result.data : {};
  } else {
    return Object.fromEntries(localStore);
  }
}
```

Every datastore table you access must be listed in
`capabilities.datastore.tables` in the manifest.

## Files

- `manifest.json` - Extension metadata and capability grants
- `background.html` - Entry point: calls `api.initialize()` then `extension.init()`
- `background.js` - Main extension logic
- `gallery.html` - Image gallery UI (a separate window tile)
- `settings-schema.json` - Settings UI schema

## Commands

| Command | Description |
|---------|-------------|
| `example:save-image` | Save an image to the gallery (accepts image/*) |
| `example:gallery` | Open the image gallery window |

Access these commands via the cmd palette (`Option+Space`).

## Running Standalone

This extension can run as a regular website:

```bash
cd extensions/example
python3 -m http.server 8080
# Open http://localhost:8080/background.html
```

In standalone mode:
- Commands and shortcuts are not available (no Peek API)
- Images are stored in memory only (no persistence)
- Gallery drag-and-drop still works
