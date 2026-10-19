# Extension Modes — Research Note

*Historical: a research note proposing a mode API for context-scoped shortcuts; `api.modes` was later removed as unused and `api.context.*` took its place; not current guidance.*

## Problem

Extensions sometimes need global keyboard shortcuts that are only active during a specific interaction context. For example:

- **Pagestream**: When a page host window is open from the card stream, Cmd+J/K/Up/Down should navigate between cards and change the page being viewed — without the user switching back to the pagestream window.
- **Groups**: When viewing a group's pages, similar navigation could flip between pages within the group.

Currently, each extension manages this ad-hoc: registering global shortcuts when entering the interaction, unregistering when leaving. This works but has issues:

1. **No collision detection** — two extensions could register the same global shortcut
2. **No central visibility** — nothing tracks which "mode" is active or what shortcuts are bound
3. **Cleanup risk** — if an extension crashes or fails to unregister, shortcuts leak
4. **No composability** — modes can't layer (e.g., pagestream browsing + tag filtering)

## Current Implementation (Pagestream, Feb 2026)

Pagestream uses the simple ad-hoc approach:

```javascript
// On page host open:
api.shortcuts.register('CommandOrControl+J', () => moveSelection('down'), { global: true });
// ... more shortcuts

// On page host close:
api.shortcuts.unregister('CommandOrControl+J', { global: true });
// ... more shortcuts
```

Cross-window communication uses pubsub:
```javascript
// Pagestream publishes:
api.publish('page:navigate', { windowId, url }, api.scopes.GLOBAL);

// Page host subscribes:
api.subscribe('page:navigate', (msg) => {
  if (msg.windowId !== myWindowId) return;
  webview.loadURL(msg.url);
});
```

This is fine for one extension. Problems emerge with multiple.

## Proposed: Extension Mode API

### Concept

An extension declares a **mode** — a named interaction context with associated global shortcuts. The system manages activation, deactivation, collision detection, and cleanup.

```javascript
// Extension declares a mode
const browsingMode = api.mode.create('pagestream:browsing', {
  shortcuts: {
    'CommandOrControl+J': () => moveSelection('down'),
    'CommandOrControl+K': () => moveSelection('up'),
    'CommandOrControl+Up': () => moveSelection('up'),
    'CommandOrControl+Down': () => moveSelection('down'),
    'CommandOrControl+Shift+G': () => moveSelection('first'),
  }
});

// Enter/exit mode
browsingMode.enter();   // registers all shortcuts
browsingMode.exit();    // unregisters all shortcuts

// Auto-cleanup if extension window closes
// System tracks active modes and cleans up on window:closed
```

### Benefits

- **Collision detection**: System warns or rejects if two modes claim the same shortcut
- **Automatic cleanup**: Mode exits when its owning window closes
- **Visibility**: `api.mode.active()` returns current mode stack — useful for UI indicators
- **Composability**: Modes could stack (enter multiple modes, exit in order)
- **Discoverability**: Users could see "Pagestream browsing mode active: Cmd+J/K to navigate"

### Open Questions

1. **Should modes be exclusive or stackable?** Exclusive is simpler but less flexible.
2. **Should the mode indicator be system-level UI?** A subtle badge showing "Browsing Mode" etc.
3. **Should modes affect non-shortcut behavior?** E.g., change what Escape does globally.
4. **Where does IZUI fit?** IZUI manages invocation context (transient vs active). Modes manage interaction context within an already-active extension. They're orthogonal but could interact — e.g., a transient invocation might skip mode activation.

### When to Build

Build this when a second extension needs the pattern. Groups is the likely candidate — navigating between group pages while one is open would use the exact same register/navigate/unregister flow. At that point, extract the pattern from pagestream into the extension API.
