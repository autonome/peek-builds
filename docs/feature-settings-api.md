# Extension Settings API: Global Settings Access

## Current State

Extensions and core UI code access global settings through seven different mechanisms, with no uniform API:

| Mechanism | Used by | Problem |
|-----------|---------|---------|
| `apps/desktop/renderer/config.js` | Settings UI | Renderer-side schema + defaults; not accessible to extensions |
| `apps/desktop/main/config.ts` | Backend only | Node-side constants, inaccessible from `peek://` pages |
| `ipcRenderer.invoke('get-app-prefs')` | `preload.js` drag logic | Raw IPC, bypasses API layer, unavailable on Tauri |
| `api.invoke('get-app-prefs')` | the canvas page host, removed 2026-07 | Same handler, different call site; dumps entire prefs blob |
| `api.settings.*` (preload) | Extensions | Scoped to extension-owned settings only; no global read |
| `api.settings.getExtKey('editor', 'prefs')` | `apps/desktop/features/tags/home.js` | Cross-extension reads with no access control |
| `topic:core:prefs` pubsub | `entry.ts`, `ipc.ts` | Broadcasts full prefs at SYSTEM scope, unfiltered |

**Core problem:** Extensions that need to read a global setting (e.g., `dragHoldDelay`, `hideTitleBar`) must either use raw IPC calls that only work on Electron, or subscribe to a SYSTEM-scope pubsub topic that exposes every setting.

## Proposed API

Add a `global` namespace to the existing `api.settings`:

```js
// Read specific global settings (returns only public keys)
const { data } = await api.settings.global.get(['dragHoldDelay', 'hideTitleBar']);
// => { dragHoldDelay: 1, hideTitleBar: true }

// Read all public global settings
const { data } = await api.settings.global.get();
// => { dragHoldDelay: 1, hideTitleBar: true, ... }

// Subscribe to changes (receives diffs, filtered to requested keys)
const unsub = api.settings.global.subscribe(['dragHoldDelay'], (changes) => {
  // changes = { dragHoldDelay: { old: 1, new: 0.5 } }
});

// Unsubscribe
unsub();
```

**Write access** is restricted to core (`peek://app/`) contexts:

```js
// Only available in core context (peek://app/*)
await api.settings.global.set({ dragHoldDelay: 0.5 });
// Throws from extension context
```

### TypeScript Contract

```ts
interface IGlobalSettingsApi {
  get(keys?: string[]): Promise<ApiResult<Record<string, unknown>>>;
  set(settings: Record<string, unknown>): Promise<ApiResult<void>>; // core only
  subscribe(keys: string[], callback: (changes: SettingsDiff) => void): () => void;
}

interface SettingsDiff {
  [key: string]: { old: unknown; new: unknown };
}

// Extend existing ISettingsApi
interface ISettingsApi {
  get(): Promise<ApiResult<Record<string, unknown>>>;
  set(settings: Record<string, unknown>): Promise<ApiResult<void>>;
  getKey(key: string): Promise<ApiResult<unknown>>;
  setKey(key: string, value: unknown): Promise<ApiResult<void>>;
  global: IGlobalSettingsApi; // NEW
}
```

## Settings Registry

Create `apps/desktop/renderer/settings-registry.js` as the single source of truth for setting metadata:

```js
// app/settings-registry.js
export const settingsRegistry = {
  dragHoldDelay: {
    scope: 'public',        // visible to extensions
    type: 'number',
    default: 1,
    label: 'Window drag hold delay',
  },
  hideTitleBar: {
    scope: 'public',
    type: 'boolean',
    default: true,
    label: 'Hide title bars',
  },
  restoreSession: {
    scope: 'public',
    type: 'boolean',
    default: true,
    label: 'Restore session on startup',
  },
  showTrayIcon: {
    scope: 'public',
    type: 'boolean',
    default: true,
    label: 'Show tray icon',
  },
  showInDockAndSwitcher: {
    scope: 'public',
    type: 'boolean',
    default: true,
    label: 'Show in dock',
  },
  sessionAutosaveInterval: {
    scope: 'public',
    type: 'integer',
    default: 5,
    label: 'Autosave interval (minutes)',
  },
  // Internal: not exposed to extensions
  shortcutKey: {
    scope: 'internal',
    type: 'string',
    default: 'CommandOrControl+,',
    label: 'Settings shortcut',
  },
  quitShortcut: {
    scope: 'internal',
    type: 'string',
    default: 'CommandOrControl+Q',
    label: 'Quit shortcut',
  },
  startupFeature: {
    scope: 'internal',
    type: 'string',
    default: 'peek://app/settings/settings.html',
    label: 'Startup feature',
  },
  backupDir: {
    scope: 'internal',
    type: 'string',
    default: '',
    label: 'Backup directory',
  },
};

export function getPublicKeys() {
  return Object.entries(settingsRegistry)
    .filter(([, v]) => v.scope === 'public')
    .map(([k]) => k);
}

export function getDefaults() {
  return Object.fromEntries(
    Object.entries(settingsRegistry).map(([k, v]) => [k, v.default])
  );
}

export function isPublic(key) {
  return settingsRegistry[key]?.scope === 'public';
}
```

This replaces the defaults in `apps/desktop/renderer/config.js` and the schema definitions. The existing `prefsSchema` JSON Schema in `config.js` can be generated from the registry if needed for validation.

## Reactive Updates

### Pubsub Topic

A new topic `settings:global:changed` carries diffs:

```js
// Published by backend when any global setting changes
api.publish('settings:global:changed', {
  changes: {
    dragHoldDelay: { old: 1, new: 0.5 }
  }
}, api.scopes.SYSTEM);
```

### Preload-side Filtering

The `subscribe()` method in preload registers a pubsub listener and filters to only the requested keys before invoking the callback:

```js
// In preload.js, inside api.settings.global
subscribe: (keys, callback) => {
  const handler = (msg) => {
    const filtered = {};
    let hasRelevant = false;
    for (const k of keys) {
      if (msg.changes[k]) {
        filtered[k] = msg.changes[k];
        hasRelevant = true;
      }
    }
    if (hasRelevant) callback(filtered);
  };

  ipcRenderer.on('settings:global:changed', (_ev, msg) => handler(msg));

  return () => {
    ipcRenderer.removeListener('settings:global:changed', handler);
  };
}
```

For extension contexts, the preload additionally strips any `internal`-scoped keys from the diff before filtering.

## Backend Abstraction

Three IPC operations, each implemented per backend:

### `global-settings-get`

**Request:** `{ keys?: string[] }` (optional filter)
**Response:** `{ success: true, data: Record<string, unknown> }`

| Backend | Implementation |
|---------|---------------|
| Electron | Read from `_prefs` in-memory cache (already populated by `topic:core:prefs`). Filter by registry scope based on caller origin. |
| Tauri | Read from `app_settings` table in SQLite. Same scope filtering. |
| Web | Read from `localStorage` or IndexedDB with scope check. |

### `global-settings-set`

**Request:** `{ settings: Record<string, unknown> }`
**Response:** `{ success: true }`

| Backend | Implementation |
|---------|---------------|
| Electron | Validate keys against registry. Update `_prefs` cache. Persist via existing storage. Broadcast `settings:global:changed` to all windows. |
| Tauri | Validate + write to SQLite. Emit tauri event. |
| Web | Validate + write to storage. Post to BroadcastChannel. |

Enforcement: all three backends reject writes from non-core origins. The Electron backend checks `event.senderFrame.url`; Tauri checks the command source; web backend checks calling origin.

### `settings:global:changed`

Not an IPC handler per se -- this is the notification pushed to renderers after a successful `global-settings-set`. On Electron, sent via `webContents.send()` to all windows. On Tauri, emitted as a Tauri event. On web, posted to a BroadcastChannel.

## Migration Path

### Phase 1: Add API (non-breaking)

1. Create `apps/desktop/renderer/settings-registry.js` with scope declarations and defaults.
2. Add `global-settings-get` IPC handler to `apps/desktop/main/ipc.ts`, reading from existing `_prefs` cache.
3. Add `api.settings.global.get()` and `api.settings.global.subscribe()` to `preload.js`.
4. Add stubs returning defaults to `apps/tauri-desktop/preload.js`.

No existing code changes. The old mechanisms continue to work.

### Phase 2: Migrate consumers

Replace direct IPC calls with the new API:

- `preload.js` L2485: `ipcRenderer.invoke('get-app-prefs')` -> use internal `_prefs` or registry default (preload is itself the implementation layer, so it reads directly)
- the canvas page host (removed 2026-07): `api.invoke('get-app-prefs')` -> `api.settings.global.get(['dragHoldDelay'])`
- `apps/desktop/features/tags/home.js`: `api.settings.getExtKey('editor', 'prefs')` -> if reading global, use `api.settings.global.get()`; if truly cross-extension, keep as-is (separate concern)

### Phase 3: Consolidate config sources

- Move defaults from `apps/desktop/renderer/config.js` `defaults.prefs` to `settings-registry.js`.
- Import registry into `apps/desktop/renderer/config.js` for backward compat (or deprecate `config.js` prefs entirely).
- Remove `APP_DEF_WIDTH`/`APP_DEF_HEIGHT` from `apps/desktop/main/config.ts` if they become registry entries.

### Phase 4: Deprecate `topic:core:prefs`

- Replace `topic:core:prefs` publishers (settings.js) with `api.settings.global.set()`.
- Replace `topic:core:prefs` subscribers (`entry.ts`, `ipc.ts`) with `settings:global:changed` listeners.
- Remove `get-app-prefs` IPC handler once all callers are migrated.
- Remove `_prefs` in-memory cache from `entry.ts` (backend reads from storage directly, or maintains its own cache behind `global-settings-get`).

## Security

### Two-tier Scope Model

**`public`** -- Extensions can read. Covers UI behavior settings that extensions legitimately need (drag delay, title bar visibility, session restore, etc.).

**`internal`** -- Core-only. Covers settings that could enable privilege escalation or expose sensitive paths (keyboard shortcuts that map to privileged actions, backup directory paths, startup feature URL).

### Enforcement Points

1. **Preload layer** (`preload.js`): `api.settings.global.set()` throws immediately if `!isCore`. `api.settings.global.get()` filters to public keys if `isExtension`.

2. **Backend layer** (`ipc.ts`): `global-settings-get` handler checks `event.senderFrame.url` origin. Returns only public-scoped keys for extension origins. `global-settings-set` rejects non-core callers.

3. **Pubsub layer**: `settings:global:changed` messages sent to extension windows have internal keys stripped by the backend before dispatch (not relying on preload filtering alone).

This double-filtering (backend + preload) ensures that even if an extension bypasses the preload API, the backend never leaks internal settings.
