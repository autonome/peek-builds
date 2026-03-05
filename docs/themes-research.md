# Themes as Extensions: Research & Design

Status: **Research** | Feb 2026

## Current State Analysis

### Existing Theme System

Peek already has a mature theme system with two layers:

**1. Backend Theme Infrastructure** (`backend/electron/`)
- **Discovery**: `main.ts:discoverBuiltinThemes()` scans `themes/` directory for subdirectories with `manifest.json`
- **Protocol**: `peek://theme/variables.css` serves the active theme's CSS; `peek://theme/{id}/...` serves specific themes
- **IPC handlers** in `ipc.ts`: `theme:get`, `theme:setTheme`, `theme:setColorScheme`, `theme:list`, `theme:getAll`, `theme:add`, `theme:remove`, `theme:reload`, `theme:pickFolder`, `theme:validateFolder`
- **Database**: `themes` table stores external themes with fields: `id`, `name`, `description`, `version`, `author`, `path`, `builtin`, `enabled`, `installedAt`, `updatedAt`, `lastError`, `lastErrorAt`, `metadata`
- **Settings storage**: Theme preferences stored in `extension_settings` table under `extensionId='core'`, keys `theme.id` and `theme.colorScheme`

**2. Frontend Theme System** (`app/components/theme.js`)
- JavaScript theme registry with `registerTheme()`, `setTheme()`, `getTheme()`, `ThemeMixin()`
- Token inheritance (themes can extend other themes)
- `injectThemeCSS()` for isolated contexts (shadow DOM, iframes)
- `scopedTheme()` for per-element overrides
- System theme detection and auto-follow

**3. Theme Manifest Format** (current)
```json
{
  "id": "peek",
  "name": "Peek",
  "version": "1.0.0",
  "description": "Monospace theme with iOS-inspired colors",
  "author": "Peek",
  "colorSchemes": ["light", "dark"],
  "defaultScheme": "system",
  "variables": "./variables.css"
}
```

**4. Built-in Themes**
- `basic` — System fonts, neutral GitHub-inspired colors
- `peek` — ServerMono font, iOS-inspired accent colors (the default)

### CSS Custom Property Architecture

Themes define variables via a Base16 color scheme plus semantic aliases. Every CSS file in the app imports from `peek://theme/variables.css`.

**Base16 colors** (16 required):
| Variable | Role |
|----------|------|
| `--base00` | Default background |
| `--base01` | Lighter background (cards, headers) |
| `--base02` | Selection background, borders |
| `--base03` | Comments, muted text |
| `--base04` | Secondary text |
| `--base05` | Default foreground |
| `--base06` | Light foreground |
| `--base07` | Lightest foreground |
| `--base08` | Red — errors, delete, danger |
| `--base09` | Orange |
| `--base0A` | Yellow — warnings |
| `--base0B` | Green — success |
| `--base0C` | Cyan |
| `--base0D` | Blue — primary accent |
| `--base0E` | Purple |
| `--base0F` | Brown |

**Semantic aliases** (mapped to base colors):
| Variable | Maps to |
|----------|---------|
| `--theme-bg` | `--base00` |
| `--theme-bg-secondary` | `--base01` |
| `--theme-bg-tertiary` | `--base02` |
| `--theme-text` | `--base05` |
| `--theme-text-secondary` | `--base04` |
| `--theme-text-muted` | `--base03` |
| `--theme-border` | `--base02` |
| `--theme-accent` | `--base0D` |
| `--theme-success` | `--base0B` |
| `--theme-warning` | `--base0A` |
| `--theme-danger` | `--base08` |

**Surface tokens** (for floating panels on transparent backgrounds):
| Variable | Description |
|----------|-------------|
| `--theme-surface-border` | Border for floating surfaces |
| `--theme-surface-ring` | Outer ring shadow for surfaces |

**Typography**:
| Variable | Description |
|----------|-------------|
| `--theme-font-sans` | Sans-serif font stack |
| `--theme-font-mono` | Monospace font stack |

**Component design tokens** (`app/components/tokens.css`) — not part of theme, but extend it:
| Category | Variables |
|----------|-----------|
| Spacing | `--peek-space-{xs,sm,md,lg,xl,2xl}` |
| Radius | `--peek-radius-{sm,md,lg,xl,full}` |
| Font sizes | `--peek-font-{xs,sm,md,lg,xl,2xl}` |
| Font weights | `--peek-font-{normal,medium,semibold,bold}` |
| Shadows | `--peek-shadow-{sm,md,lg,xl}` |
| Transitions | `--peek-transition-{fast,normal,slow}` |
| Focus | `--peek-focus-ring`, `--peek-focus-ring-offset` |
| Glass | `--peek-glass-*` (blur, bg, border, shadow, text variants) |
| Overlay | `--peek-overlay-bg`, `--peek-overlay-bg-light` |
| Button | `--peek-btn-height-{sm,md,lg}`, padding tokens |
| Card | `--peek-card-{padding,gap,radius}` |
| List | `--peek-list-item-*` |

### How Theme CSS Reaches Every Window

1. Extension HTML files import theme via CSS: `@import url('peek://theme/variables.css');`
2. App HTML files use `<link>`: `<link rel="stylesheet" href="peek://theme/variables.css">`
3. The `peek://theme/` protocol handler resolves to the active theme's filesystem path
4. On theme change, `preload.js:reloadStylesheets()` cache-busts all `<link>` and `<style>` elements across every window
5. The preload script also manages `data-theme` attribute on `<html>` for light/dark/system switching

### Light/Dark Mode Handling

Three modes, controlled via `data-theme` attribute on `<html>`:
- **System** (default) — no attribute; CSS uses `@media (prefers-color-scheme: dark)` to override `:root` variables
- **Light** — `data-theme="light"` forces light via `[data-theme="light"]` selector
- **Dark** — `data-theme="dark"` forces dark via `[data-theme="dark"]` selector

Per-window color scheme override is supported: `theme:setWindowColorScheme` sends to a specific window without changing global setting.

### Extension System Capabilities

**Extension manifest format** (`features/*/manifest.json`):
```json
{
  "id": "groups",
  "shortname": "groups",
  "name": "Groups",
  "description": "Tag-based grouping of addresses",
  "version": "1.0.0",
  "background": "background.html",
  "builtin": true,
  "settingsSchema": "./settings-schema.json"
}
```

**Extension lifecycle**:
- Discovery: `extensions.ts:discoverExtensions()` scans directories for `manifest.json`
- Loading: Extensions load as iframes in a consolidated hidden window (`main.ts:loadExtensionsConsolidated()`)
- Enable/disable: `ext_disabled` key in `extension_settings` table
- External extensions stored in `extensions` DB table with path reference

**Extension APIs** (`window.app`):
- `api.settings` — per-extension key-value storage
- `api.datastore` — items, tags, addresses CRUD
- `api.pubsub` — cross-extension event publishing/subscribing
- `api.theme` — full theme control (get, set, list, add, remove, reload)
- `api.cmd` — command palette registration
- `api.windows` — window management

**CSS injection**: Extensions cannot currently inject CSS into other windows. Each extension manages its own UI within its iframe or dedicated HTML pages. Theme CSS is loaded via the `peek://theme/` protocol, not via extension injection.

---

## Proposed Architecture: Themes as Extensions

### Core Idea

Themes become a special type of extension with `"type": "theme"` in their manifest. They share the extension install/uninstall/enable/disable lifecycle but have theme-specific behavior: they provide CSS custom properties that get injected into all windows via the existing `peek://theme/` protocol.

### Theme Extension Manifest

```json
{
  "id": "solarized-dark",
  "type": "theme",
  "name": "Solarized Dark",
  "version": "1.0.0",
  "description": "Ethan Schoonover's Solarized color scheme, dark variant",
  "author": "Community",
  "license": "MIT",
  "homepage": "https://example.com/peek-solarized",
  "colorSchemes": ["dark"],
  "defaultScheme": "dark",
  "variables": "./variables.css",
  "preview": "./preview.png",
  "tags": ["dark", "low-contrast", "solarized"],
  "extends": "basic"
}
```

New fields beyond current theme manifest:
- `type: "theme"` — distinguishes from regular extensions
- `preview` — screenshot/image for theme picker UI
- `tags` — categorization for browsing/filtering
- `extends` — base theme to inherit from (unspecified variables fall back to parent)
- `license`, `homepage` — metadata for shared themes

### CSS Custom Property Contract

Theme extensions MUST define all 16 Base16 variables plus semantic aliases and typography for each color scheme they support. The contract is layered:

**Layer 1: Required (Base16 + Semantics)**

Every theme must define these in `:root` for its default scheme, and in the appropriate `@media`/`[data-theme]` blocks for additional schemes:

```css
/* Base16 — all 16 required */
--base00 through --base0F

/* Semantic aliases — all required */
--theme-bg
--theme-bg-secondary
--theme-bg-tertiary
--theme-text
--theme-text-secondary
--theme-text-muted
--theme-border
--theme-accent
--theme-success
--theme-warning
--theme-danger

/* Surface tokens — required */
--theme-surface-border
--theme-surface-ring

/* Typography — required */
--theme-font-sans
--theme-font-mono
```

**Layer 2: Optional (Component Tokens)**

Themes MAY override component design tokens for deeper customization. These have sensible defaults in `tokens.css` so omitting them is safe:

```css
/* Spacing, radius, shadows, transitions, glass, overlay */
--peek-space-*
--peek-radius-*
--peek-shadow-*
--peek-glass-*
--peek-overlay-*
```

**Layer 3: Extension-Specific**

Individual extensions may define their own tokens (e.g., `--peek-btn-group-border`). Themes can override these but they are not part of the core contract.

### How Theme CSS Gets Injected

No change needed to the injection mechanism. The existing system already works:

1. Theme extensions install to a directory (like external extensions today)
2. Their path gets registered via `registerThemePath(id, fsPath)`
3. `peek://theme/variables.css` serves the active theme's CSS
4. `reloadStylesheets()` in preload.js cache-busts on theme switch

The only change: theme discovery should also scan the extensions directory (or the themes table should be unified with extensions).

### Unifying Themes and Extensions

Two approaches:

**Option A: Themes in Extensions Table (recommended)**

Add `type` column to `extensions` table. Theme extensions get `type='theme'`. The extension manager handles install/uninstall. Theme-specific logic (active theme tracking, protocol serving) stays in the theme subsystem but reads from the same table.

Pros: Single install/uninstall flow, single enable/disable mechanism, single discovery path for external add-ons.

Cons: Extensions table gets a type discriminator.

**Option B: Keep Separate Tables, Shared UI**

Keep the `themes` table as-is. Add a unified "Add-ons" UI that manages both tables. Theme manifests use `"type": "theme"` to route to the correct table during install.

Pros: No schema changes, clean separation of concerns.

Cons: Two parallel install flows to maintain, two discovery mechanisms.

### Default Theme as Built-in Extension

The `basic` theme becomes a built-in theme extension at `features/theme-basic/`. The `peek` theme becomes `features/theme-peek/`. They have `"builtin": true` in their manifests and cannot be uninstalled (only disabled if another theme is active — at least one theme must always be enabled).

Migration path: Move `themes/basic/` to `features/theme-basic/`, `themes/peek/` to `features/theme-peek/`. Update `discoverBuiltinThemes` to use the features directory.

### Theme Switching via Cmd Palette

Register commands in the `cmd` extension:

- `theme` — open theme picker (list all installed themes with preview)
- `theme <name>` — switch directly to named theme
- `theme dark` / `theme light` / `theme system` — switch color scheme
- `theme dark here` — per-window color scheme (already supported)

The existing `theme:setTheme` IPC handler already broadcasts to all windows and triggers `reloadStylesheets()`.

### Preview Before Applying

Two levels of preview:

**1. Static preview** — Show `preview.png` from theme manifest in the theme picker UI. Theme authors include a screenshot.

**2. Live preview** — Temporarily apply theme CSS without persisting the choice. Implementation:

```
User hovers/focuses theme in picker
  → Main process calls setActiveThemeId(previewId) without saving to DB
  → Broadcasts theme:themeChanged to all windows
  → reloadStylesheets() runs everywhere
  → Preview appears live

User confirms selection
  → Persist to DB via setThemeSetting()

User cancels
  → Restore previous activeThemeId
  → Broadcast again to revert
```

This is lightweight because the existing `peek://theme/` protocol already serves whatever `activeThemeId` points to, and `reloadStylesheets()` already reloads everything. No new infrastructure needed.

### Per-Group Themes

Groups roadmap item 9 mentions group-specific settings. Per-group themes would work as:

1. Store `theme.id` per group in `extension_settings` with `extensionId=groups_{groupTag}`
2. When entering a group context, apply the group's theme to all group windows
3. When leaving group context, revert to global theme
4. Use the existing `theme:setWindowColorScheme` pattern — extend it to `theme:setWindowTheme` for per-window theme override

This is a future addition that builds on the base themes-as-extensions work.

---

## Prior Art

### VS Code Themes

- Themes are extensions with `"contributes": { "themes": [...] }` in `package.json`
- Color tokens defined in JSON: `"colors": { "editor.background": "#1e1e1e" }`
- ~600+ token names in the color contract
- Syntax highlighting tokens separate from UI tokens
- Themes can be "color theme" (UI + syntax) or "icon theme"
- Marketplace distribution with preview images and star ratings
- Live preview on hover in theme picker

**Relevant takeaway**: JSON color tokens are simpler for non-developers to create than CSS files. However, Peek's existing CSS-based approach is more flexible and already working. Could offer a JSON-to-CSS converter tool for theme creators.

### Firefox Themes

- Lightweight themes: `manifest.json` with `"theme": { "colors": { ... } }` — about 30 color properties
- Full themes: CSS-based (deprecated in favor of lightweight)
- AMO (addons.mozilla.org) for distribution
- `theme_experiment` API for additional CSS properties beyond the standard set

**Relevant takeaway**: Firefox's lightweight theme model (small color property set) maps well to Peek's Base16 approach. The 16 base colors + semantic aliases is similarly constrained and approachable.

### Obsidian Themes

- CSS snippet files dropped into a folder
- Community themes via a JSON registry on GitHub
- Themes override CSS custom properties defined by the app
- "Style Settings" plugin lets themes expose toggleable options

**Relevant takeaway**: The "drop CSS file in a folder" model is exactly what Peek already supports. The registry/discovery pattern could be relevant for future community theme sharing.

---

## Implementation Phases

### Phase 1: Unify Theme and Extension Lifecycle

**Goal**: Themes install/uninstall/enable/disable like extensions, using the same UI and mechanisms.

Tasks:
- Add `type` field to extension manifest interface (`"theme"` | `"extension"` | undefined)
- Move built-in themes from `themes/` to `features/theme-basic/` and `features/theme-peek/`
- Update `discoverBuiltinThemes` to scan `features/` for `type: "theme"` manifests
- Update Settings UI "Themes" section to use the extensions install/remove flow
- Add theme validation on install (check all required variables present)
- Ensure at least one theme is always enabled (prevent disabling last active theme)

### Phase 2: Cmd Palette Theme Switching

**Goal**: Fast theme switching from keyboard.

Tasks:
- Register `theme` command showing installed themes as options
- Register `theme <name>` for direct switching
- Ensure existing `theme dark/light/system` commands work
- Add theme name to command search index

### Phase 3: Live Preview

**Goal**: Preview themes before committing.

Tasks:
- Add `preview` field to theme manifest
- Show preview image in theme picker (Settings + cmd palette)
- Implement live preview on hover/focus using temporary `activeThemeId` switch
- Add revert-on-cancel behavior
- Add 3-second timeout to auto-revert if no confirmation (prevents stuck preview state)

### Phase 4: Theme Creator Tools

**Goal**: Make it easy to create new themes.

Tasks:
- Theme scaffold command: generate `manifest.json` + `variables.css` template
- Theme validator: check all required variables are defined for all declared color schemes
- Color palette generator: given a primary color, suggest a full Base16 palette
- Hot-reload during development: watch theme CSS file for changes and auto-reload

### Phase 5: Community Sharing (Future)

**Goal**: Share themes beyond manual folder installation.

Tasks:
- Theme registry format (JSON file listing themes with URLs)
- Install from URL in cmd palette or Settings
- Theme export (zip theme directory)
- Optional: tangled.sh integration for theme publishing

---

## Open Questions

1. **Should component tokens (Layer 2) be part of the theme contract?** Currently `tokens.css` is loaded separately from theme variables. If themes can override spacing/radius/shadows, it blurs the line between "color theme" and "UI theme." The Base16 approach suggests keeping themes focused on color + typography, but some themes may want rounder corners or different spacing.

2. **How to handle theme + extension CSS conflicts?** If an extension hardcodes colors instead of using theme variables, theme changes won't affect it. Should there be a linting/validation step for extensions to ensure they use theme variables? Or is this just a best-practice guideline?

3. **Should themes be able to include JavaScript?** Current theme manifest only references CSS. A theme extension with a `background.html` could run code (e.g., auto-switch between light/dark based on time of day). This adds power but also attack surface. Recommendation: keep themes CSS-only for now; if a theme needs logic, it should be a regular extension that happens to register a theme.

4. **Per-group themes — scope of change?** Applying different themes per group means the protocol handler needs to know which group context is requesting `peek://theme/variables.css`. This might require per-session or per-window protocol handling rather than the current global `activeThemeId`. Alternatively, per-group theming could work at the `data-theme` attribute level (light/dark only) rather than full theme switching.

5. **Migration path for existing `themes/` directory?** Users who have added custom themes to `themes/` need a migration. Options: (a) continue scanning `themes/` as a legacy path, (b) auto-migrate to extensions on first run, (c) document the move and let users relocate manually.

6. **JSON theme format as alternative to CSS?** VS Code and Firefox use JSON for theme colors. A JSON format would be simpler for non-developers and could be converted to CSS at load time. Worth supporting both, or keep CSS-only for consistency with the existing system?
