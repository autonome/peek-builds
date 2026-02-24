# Peek Feature Tour

A comprehensive guide to every feature in Peek, the desktop web user agent. Peek reimagines how you interact with the web -- replacing tabs with floating windows, keyboard shortcuts, and a command palette.

---

## Core

### Command Palette

**Summary:** The central hub for all actions in Peek. Type commands, search history, open URLs, chain operations, and access every feature from one keyboard-driven interface.

**Where in UI:** Global hotkey or local shortcut.

**How to try it:**
1. Press `Option+Space` (global, works from any app) or `Cmd+K` (local, when a Peek window is focused).
2. Start typing a command name (e.g., `note`, `open`, `google`).
3. Commands appear as you type -- press Enter to execute, or add arguments after the command name.
4. The palette also searches your URL history, so typing part of a domain or page title will surface matching pages.

### Open URL

**Summary:** Open any URL in a new floating Peek window. Automatically adds `https://` to bare domains.

**Where in UI:** Command palette.

**How to try it:**
1. Open the command palette (`Option+Space`).
2. Type `open example.com` or `open https://en.wikipedia.org`.
3. Press Enter. A new window appears with the page loaded.

### Modal Window

**Summary:** Open a URL in a transient modal window that auto-hides when it loses focus or you press Escape.

**Where in UI:** Command palette.

**How to try it:**
1. Open the command palette.
2. Type `modal https://example.com`.
3. Press Enter. The page opens in a modal. Click away or press Escape to dismiss it.

### Settings

**Summary:** Central configuration panel for Peek and all its extensions. Covers global preferences (shortcuts, startup behavior, session restore, tray icon, title bars, backup) and per-extension settings.

**Where in UI:** Keyboard shortcut or command palette.

**How to try it:**
1. Press `Cmd+,` to open Settings.
2. The sidebar lists all configurable areas: Core settings, Cmd, Editor, Groups, Peeks, Slides, Web Search, Scripts, etc.
3. Each section has form controls for its preferences. Changes take effect immediately.

### System Tray Icon

**Summary:** An optional system tray icon that provides quick access to Peek. Click to open the most recent window or the command palette.

**Where in UI:** System tray (menu bar on macOS).

**How to try it:**
1. Open Settings (`Cmd+,`).
2. Ensure "Show tray icon" is enabled.
3. Look for the Peek icon in the system tray / menu bar area. Click it.

### Dock Visibility

**Summary:** Control whether Peek always appears in the macOS Dock and app switcher, or only when windows are visible.

**Where in UI:** Settings > Core > "Show in dock".

**How to try it:**
1. Open Settings.
2. Toggle "Show in dock" off. Peek disappears from the Dock when no windows are open, running silently in the background.

### Session Restore

**Summary:** Peek remembers your open windows (URLs, positions, sizes) and can restore them on restart. Includes periodic autosave.

**Where in UI:** Settings > Core.

**How to try it:**
1. Open Settings and ensure "Restore session on startup" is enabled.
2. Open several web pages in Peek, arrange them on screen.
3. Quit and relaunch Peek. Your windows reappear in their previous positions.
4. The "Autosave interval" setting (default: 5 minutes) controls how frequently session state is saved.

### Profiles

**Summary:** Isolated data workspaces with separate SQLite databases, session data, and sync configurations. Development builds automatically use a `dev` profile to keep data separate from production.

**Where in UI:** Settings.

**How to try it:**
1. Open Settings and look for the Profiles section.
2. Create a new profile with a custom name.
3. Switch to the new profile (requires app restart).
4. Each profile has its own history, tags, groups, and sync settings.

### Database Backup

**Summary:** Automatic daily compressed backups of the SQLite database using `VACUUM INTO`. Configurable backup directory and retention count (default: 7 backups).

**Where in UI:** Settings > Core > "Backup directory". Also accessible from the Diagnostic page.

**How to try it:**
1. Open Settings and set "Backup directory" to a folder path (e.g., `~/peek-backups`).
2. Backups occur automatically on startup if more than 24 hours have passed since the last one.
3. To manually trigger a backup, open the Diagnostic page (`peek://app/diagnostic.html`) and click "Backup Now".

### Ad Blocker

**Summary:** Built-in native ad and tracker blocking powered by Ghostery's adblocker-electron. Uses EasyList and EasyPrivacy filter lists.

**Where in UI:** Runs automatically in the background.

**How to try it:**
1. Open any web page with ads (e.g., a news site).
2. Ads and trackers are blocked at the network level before the page loads, resulting in cleaner, faster page rendering.

### Quit Shortcut

**Summary:** Configurable keyboard shortcut to quit the application.

**Where in UI:** Settings > Core > "Quit shortcut".

**How to try it:**
1. Press `Cmd+Q` (default) to quit Peek.
2. Change the shortcut in Settings if you prefer a different key combination.

---

## Page / Canvas

### Floating Page Windows

**Summary:** Every web page opens in its own floating, frameless window positioned on a fullscreen transparent canvas. Windows can be freely dragged, resized, and overlapped.

**Where in UI:** Open any URL via the command palette, history, groups, or web search.

**How to try it:**
1. Open a page (`open example.com` in the command palette).
2. The page appears as a floating window. Hold the mouse still on the page body for 1 second (configurable "drag hold delay" in Settings) -- the cursor changes to a hand, then drag to move the window.
3. Use the corner resize handle to change dimensions.

### Navbar

**Summary:** A floating URL bar that appears above the page window. Shows the current URL with back/forward/reload controls. Auto-hides to save space; revealed by hovering the trigger zone above the page or pressing `Cmd+L`.

**Where in UI:** Top of any page window.

**How to try it:**
1. Open a web page.
2. Press `Cmd+L` to show the navbar and focus the URL field.
3. Hover the mouse over the thin strip at the very top of the page to reveal the navbar.
4. Use the back arrow, forward arrow, and reload buttons, or type a new URL.

### Page Navigation Shortcuts

**Summary:** Standard keyboard shortcuts for navigating within a page window.

**Where in UI:** Any page window.

**How to try it:**
- `Cmd+[` or `Cmd+Left` -- go back in page history.
- `Cmd+]` or `Cmd+Right` -- go forward.
- `Cmd+R` -- reload the current page.
- `Escape` -- if the webview has history, go back; otherwise close the window (behavior depends on IZUI state).

### Drag Hold Delay

**Summary:** Configurable delay before a window becomes draggable. Prevents accidental drags when clicking or selecting text. The navbar background provides instant drag (no delay).

**Where in UI:** Settings > Core > "Window drag hold delay".

**How to try it:**
1. Open Settings and set "Window drag hold delay" (default: 1 second).
2. On a page, click and hold without moving. After the delay, the cursor changes to a hand.
3. Now move the mouse to drag the window.
4. On the navbar background, drag is instant with no delay.

### Mode Indicator

**Summary:** A small label on each page window showing the current mode (e.g., "page", "group"). When in group mode, also displays the group name.

**Where in UI:** Bottom-left corner of page windows.

**How to try it:**
1. Open a page -- the mode indicator says "page".
2. Open a group (see Groups section below) -- member windows show "group" plus the group name.

### OAuth Detection

**Summary:** Automatically detects OAuth/authentication flows (Google, Microsoft, Auth0, Apple ID, etc.) and suppresses the navbar auto-show hover behavior so it does not interfere with credential entry.

**Where in UI:** Automatic, invisible to the user.

**How to try it:**
1. Navigate to a login page that uses OAuth (e.g., sign in with Google).
2. Hovering the trigger zone above the page will not reveal the navbar, avoiding interruption.
3. You can still press `Cmd+L` to manually show the navbar.

---

## Editor

### Markdown Editor

**Summary:** A full-featured markdown editor with a three-panel layout: outline sidebar (table of contents generated from headers), CodeMirror editing area, and live preview. Supports focus mode, autosave, and resizable panels.

**Where in UI:** Global hotkey, local shortcut, or command palette.

**How to try it:**
1. Press `Option+E` (global) or `Cmd+E` (local) to open the editor.
2. Or type `open editor` in the command palette.
3. Start typing markdown. The outline updates from your headers; the preview renders live.

### Vim Mode

**Summary:** Optional vim keybindings for the editor, including `:set wrap`/`:set nowrap` for line wrapping, `:set number`/`:set nonumber` for line numbers, and `:q` to close.

**Where in UI:** Settings > Editor > "Vim mode".

**How to try it:**
1. Open Settings, go to the Editor section, and enable "Vim mode".
2. Open the editor. Use vim navigation (`h`, `j`, `k`, `l`), insert mode (`i`), visual mode (`v`), and ex commands (`:w`, `:q`).
3. Type `:set wrap` to enable line wrapping, `:set nowrap` to disable it.
4. Type `:set number` to show line numbers, `:set nonumber` to hide them.

### Autosave

**Summary:** When editing a datastore item (note or other text), changes are automatically saved 1.5 seconds after you stop typing. The status line shows "saved", "saving", or "unsaved".

**Where in UI:** Automatic in the editor when editing an existing item.

**How to try it:**
1. Open an existing note in the editor (use `edit` command or click a note in Tags view).
2. Make changes. The status line updates to "unsaved", then "saving", then "saved".

---

## Organization

### Tags

**Summary:** A flexible tagging system for organizing saved items (URLs, notes, tagsets). Tags are ranked by frecency (frequency + recency). Browse all items filtered by tags, add/remove tags from the active window, and create tagsets (items that are just collections of tags).

**Where in UI:** Global hotkey, local shortcut, or command palette.

**How to try it:**
1. Press `Option+T` (global) or `Cmd+T` (local) to open the Tags browser.
2. Browse all saved items. Click tag buttons to filter by tag.
3. To tag the current page: open the command palette and type `tag design, inspiration` (comma-separated tags).
4. To view tags on the current page: type `tags` in the command palette.
5. To remove a tag: type `untag design` in the command palette.
6. To create a tagset: type `tagset #project, #active, #frontend` in the command palette.

### Groups

**Summary:** Save your current window layout as a named group. All open page URLs are tagged with the group name. Reopen the group later to restore all windows, including their saved screen positions and z-ordering.

**Where in UI:** Global hotkey, local shortcut, or command palette.

**How to try it:**
1. Open several web pages and arrange them on screen.
2. Open the command palette and type `new group research` to save all open pages to a group called "research".
3. Close all windows.
4. Type `open group research` in the command palette. All pages reopen in their saved positions.
5. Press `Option+G` (global) or `Cmd+G` (local) to open the Groups browser for a visual overview.

### Notes

**Summary:** Quick note creation from the command palette with smart type detection. If the input is a URL, it is saved as a URL item. If it is hashtags (`#foo #bar`), it is saved as a tagset. Otherwise it is saved as a text note tagged with `note` and `from:cmd`.

**Where in UI:** Command palette.

**How to try it:**
1. Open the command palette and type `note Remember to review the API docs`.
2. The text is saved as a note.
3. Type `note https://example.com` -- saved as a URL item.
4. Type `note #project #done` -- saved as a tagset.
5. Type `notes` to list recent notes.
6. Type `list notes #todo` to filter notes by tag.
7. Type `note` with no arguments to open a blank editor.

### Edit Note

**Summary:** Search for existing notes and open them in the editor.

**Where in UI:** Command palette.

**How to try it:**
1. Open the command palette and type `edit API`.
2. Matching notes appear in the dropdown. Select one to open it in the editor.

### URL Save

**Summary:** Explicitly save a URL to the datastore.

**Where in UI:** Command palette.

**How to try it:**
1. Type `url https://example.com/interesting-article` in the command palette.
2. The URL is saved and available in history, tags browser, and groups.

### History Search

**Summary:** Search and open pages from your saved URL history. URLs are ranked by frecency. Every saved URL also appears as a searchable entry in the command palette.

**Where in UI:** Command palette.

**How to try it:**
1. Type `history wikipedia` in the command palette.
2. The best frecency-ranked match opens in a new window.
3. Or just start typing a URL or page title in the command palette -- history entries surface automatically.

---

## Search

### Web Search

**Summary:** Search the web directly from the command palette. Supports multiple engines (Google, DuckDuckGo, Bing, Wikipedia, Kagi) with per-engine shortcut commands. Includes search suggestions with debounce and caching.

**Where in UI:** Command palette.

**How to try it:**
1. Type `web search electron framework` in the command palette. Results open in a new window using your default engine.
2. Use engine-specific shortcuts: `google something`, `ddg privacy tools`, `wiki quantum physics`, `bing news`, `kagi best IDE`.
3. Type `open web search` to open a dedicated search window.

### OpenSearch Discovery

**Summary:** Automatically discovers search engines from visited websites via their OpenSearch description documents. Discovered engines are saved and become usable from the command palette.

**Where in UI:** Automatic (configurable in Settings > Web Search > "Auto-discover search engines").

**How to try it:**
1. Visit a website that provides an OpenSearch description (many do, such as GitHub, Stack Overflow).
2. Peek detects the OpenSearch link and registers the site as a search engine.
3. The new engine appears in the command palette as a shortcut command.

### Search Suggestions

**Summary:** As you type a search query, suggestions from the selected engine appear in real time. Suggestions are cached for 5 minutes.

**Where in UI:** Command palette when using web search commands.

**How to try it:**
1. Type `google how to` in the command palette.
2. Suggestions appear below the input as you type. Select one to search for it.
3. Toggle suggestions on/off in Settings > Web Search > "Enable search suggestions".

### Local Search

**Summary:** Search across all local items (URLs, notes, tags, history) in a dedicated search window.

**Where in UI:** Global hotkey or command palette.

**How to try it:**
1. Press `Option+F` (global) to open the local search window.
2. Or type `localsearch` in the command palette.
3. Type a query to search across all stored items.

---

## Feeds

### RSS/Atom Feed Reader

**Summary:** Subscribe to RSS and Atom feeds. Feeds are polled every 15 minutes for new entries. View entries in a dedicated reader UI, sorted by date.

**Where in UI:** Global hotkey or command palette.

**How to try it:**
1. Press `Option+Shift+F` (global) to open the Feed Reader.
2. Or type `new feed https://example.com/rss.xml` in the command palette to subscribe.
3. Type `feeds` in the command palette to browse subscribed feeds.
4. Type `refresh feeds` to manually poll all feeds for updates.

---

## Entity Recognition

### Automatic Entity Extraction

**Summary:** Automatically extracts people, places, organizations, events, emails, phone numbers, and dates from visited web pages using regex, microformat, and JSON-LD extractors. Entities are stored and searchable.

**Where in UI:** Automatic (runs on page load) or manual via command palette.

**How to try it:**
1. Visit a web page with structured content (news articles, business pages, event listings).
2. After a 2-second delay, entities are extracted and stored.
3. Type `extract entities` in the command palette to manually trigger extraction on the current page.
4. Type `open entities` or `list entities` to browse extracted entities.

### URL Item Enrichment

**Summary:** When entities are extracted, Peek also reads OpenGraph metadata (title, description, image, site name) from the page and enriches the stored URL item. This improves display in the Tags browser and other views.

**Where in UI:** Automatic, invisible to the user.

**How to try it:**
1. Save a URL and visit it. The entity extraction pipeline enriches the stored item with OG metadata.
2. Open the Tags browser to see enriched titles and descriptions for URL items.

---

## Scripts

### Userscripts / Content Scripts

**Summary:** Create, edit, and manage custom JavaScript scripts that run on web pages matching URL patterns. Scripts support match/exclude patterns, multiple injection timings (`document-end`, etc.), and can be enabled/disabled individually.

**Where in UI:** Local shortcut or command palette.

**How to try it:**
1. Press `Cmd+Shift+S` to open the Scripts Manager.
2. Or type `scripts` or `new script My Script` in the command palette.
3. In the manager, create a new script. Set match patterns (e.g., `*://*.example.com/*`), write JavaScript code, and enable it.
4. Visit a matching page. The script executes automatically.

---

## Window Management

### Window Switcher

**Summary:** A fullscreen transparent overlay that shows all open Peek windows, allowing quick switching between them.

**Where in UI:** Global hotkey or command palette.

**How to try it:**
1. Open several pages in Peek.
2. Press the Windows shortcut (configurable, check Settings > Windows) to open the overlay.
3. Or type `windows` in the command palette.
4. Click a window to switch to it.

### Reopen Last Closed Window

**Summary:** Reopen the most recently closed window, restoring its URL. Works like the familiar browser shortcut.

**Where in UI:** Keyboard shortcut or command palette.

**How to try it:**
1. Close a page window.
2. Press `Cmd+Shift+T` to reopen it.
3. Or type `reopen closed window` in the command palette.

### Center Window / Center All Windows

**Summary:** Center the active window (or all windows) on their respective displays.

**Where in UI:** Command palette.

**How to try it:**
1. Type `center window` in the command palette to center the currently active window.
2. Type `center all windows` to center every open window.

### Peeks (Quick Access Modals)

**Summary:** Assign up to 10 web pages to `Option+0` through `Option+9` hotkeys. Each one opens as a modal popup that disappears when you switch away. Optionally keep the window alive in the background and persist its state.

**Where in UI:** Settings > Peeks, then use assigned hotkeys.

**How to try it:**
1. Open Settings and go to the Peeks section.
2. Add a URL (e.g., `https://calendar.google.com`) and assign it to key 1.
3. Enable the item. Press `Option+1` from anywhere. The page pops up instantly.
4. Press Escape or switch to another app to dismiss it.

### Slides (Edge-Anchored Panels)

**Summary:** Assign web pages to slide in from screen edges (Up, Down, Left, Right) via `Option+Arrow` hotkeys. Great for dashboards, chat, or reference material that you want always accessible from a screen edge.

**Where in UI:** Settings > Slides, then use assigned hotkeys.

**How to try it:**
1. Open Settings and go to the Slides section.
2. Add a URL and assign it to the "Right" edge.
3. Enable the item. Press `Option+Right` from anywhere. The page slides in from the right edge.

### Pagestream (Browsing History Stream)

**Summary:** A vertical, chat-like navigational interface showing your browsing history as a scrollable stream. Provides a visual timeline of pages visited.

**Where in UI:** Global hotkey or command palette.

**How to try it:**
1. Press the Pagestream shortcut (configurable in Settings) to open the stream.
2. Or type `pagestream` or `open pagestream` in the command palette.
3. Scroll through your browsing history. Click an entry to reopen the page.

---

## Command Chaining

### Pipe Commands Together

**Summary:** Commands can produce output that feeds into other commands, forming pipelines. Commands declare what MIME types they accept and produce. The command palette shows compatible next-step commands after a producing command runs.

**Where in UI:** Command palette.

**How to try it:**
1. Type `list notes #todo` in the command palette. This produces JSON output.
2. Compatible commands appear: `csv` (convert to CSV), `save` (save to file), `markdown` (format as markdown), `save as note` (save as a new note).
3. Select `csv` to convert the JSON to CSV format.
4. Then select `save` to write the CSV to a file on disk.

### CSV Export

**Summary:** Convert JSON data to CSV format. Designed to be used in a chain after commands that produce JSON output (like `list notes`, `list tags`, `list groups`).

**Where in UI:** Command palette (chain step).

**How to try it:**
1. Run `list notes` in the command palette.
2. Select `csv` from the suggested chain commands.
3. The data is converted to comma-separated values.

### Markdown Export

**Summary:** Format JSON items as a readable markdown document with headers, tags, metadata, and content sections. Opens an interactive editor for reviewing and editing the result.

**Where in UI:** Command palette (chain step).

**How to try it:**
1. Run `list notes #project` in the command palette.
2. Select `markdown` from the chain commands.
3. A formatted markdown document appears in an editor window.

### Save to File

**Summary:** Save any chain output to a file on disk using a native save dialog. Accepts any MIME type. Automatically generates a filename with date and appropriate extension.

**Where in UI:** Command palette (chain step).

**How to try it:**
1. Run any chain that produces output (e.g., `list groups | csv`).
2. Select `save` from the chain commands.
3. A native file picker appears. Choose a location and filename.

### Save as Note

**Summary:** Save text chain output as a new note in the datastore, tagged with `note` and `from:cmd`.

**Where in UI:** Command palette (chain step).

**How to try it:**
1. Run a chain that produces text output (e.g., `list notes #draft | markdown`).
2. Select `save as note` from the chain commands.
3. The content is saved as a new note item.

### Open File

**Summary:** Open a text file from disk using the native file picker. The file content enters the chain as output, which can then be piped to `save as note`, `csv`, or other commands.

**Where in UI:** Command palette.

**How to try it:**
1. Type `open file` in the command palette.
2. A native file picker opens. Select a text file (markdown, JSON, CSV, etc.).
3. The file content is loaded and available for chaining to downstream commands.

### Chain Editor

**Summary:** When a chain produces text output (especially via `markdown`), an interactive editor window opens where you can review, edit, and then save or close the result. Uses CodeMirror with optional vim mode.

**Where in UI:** Automatic after certain chain steps.

**How to try it:**
1. Run `list notes | markdown` in the command palette.
2. The Chain Editor opens with the formatted markdown. Edit as needed.
3. Press Escape (or `:q` in vim mode) to close.

---

## Sync

### Sync Now

**Summary:** Manually trigger a full bidirectional sync with the server. Pulls new items from the server and pushes local changes. Reports counts of pulled, pushed, and conflicting items.

**Where in UI:** Command palette.

**How to try it:**
1. Ensure sync is configured in Settings (server URL and API key).
2. Type `Sync now` in the command palette.
3. The command runs and reports results (e.g., "Sync completed: 3 pulled, 2 pushed").

---

## HUD (Heads-Up Display)

### Always-On-Top Status Overlay

**Summary:** A small, always-on-top overlay showing the current IZUI state (Transient/Active), mode, and window information. Automatically hides when Peek loses focus and reappears when focused.

**Where in UI:** Global hotkey, local shortcut, or command palette.

**How to try it:**
1. Press `Option+H` (global) or `Cmd+H` (local) to toggle the HUD.
2. Or type `hud` in the command palette.
3. A small translucent panel appears in the top-left corner showing state information.
4. Toggle again to dismiss.

---

## IZUI (Invocable Zoom User Interface)

### Transient vs Active State

**Summary:** Peek tracks whether you invoked it from another app (transient) or are actively working in it (active). This controls Escape key behavior: in transient mode, Escape closes immediately; in active mode, Escape navigates internally and never closes.

**Where in UI:** Automatic, reflected in the HUD overlay.

**How to try it:**
1. While in another app, press `Option+Space` to invoke the command palette (transient mode).
2. Press Escape -- the palette closes and focus returns to the previous app.
3. While working in Peek, press `Cmd+K` to open the palette (active mode).
4. Press Escape -- the palette closes but you remain in Peek.

---

## DevTools / Debugging

### DevTools Command

**Summary:** Open Chrome DevTools for the most recently active content window. Useful for inspecting web pages loaded in Peek.

**Where in UI:** Command palette.

**How to try it:**
1. Open a web page in Peek.
2. Type `devtools` in the command palette.
3. DevTools opens in a detached window for the active page.

### Debug Command

**Summary:** Open a URL in a new window with DevTools automatically enabled and detached.

**Where in UI:** Command palette.

**How to try it:**
1. Type `debug https://example.com` in the command palette.
2. The page opens alongside a detached DevTools window.

### Diagnostic Page

**Summary:** An internal tool for inspecting localStorage, datastore contents, and managing backups. Useful for troubleshooting.

**Where in UI:** Navigate to `peek://app/diagnostic.html`.

**How to try it:**
1. Open the command palette and type `open peek://app/diagnostic.html`.
2. Use the buttons to dump localStorage, dump datastore extension settings, create backups, or list existing backups.

---

## Extensions

### Lexicon Studio (AT Protocol Identity)

**Summary:** Connect your Bluesky/AT Protocol account via OAuth (PKCE + DPoP). Browse your repo's collections with record counts, explore the full lexicon directory from the network, and create records with auto-generated forms or raw JSON. Recently used lexicon types appear as sidebar shortcuts.

**Where in UI:** Command palette (`lexicon studio`) or the Lexicon Studio panel window.

**How to try it:**
1. Type `lexicon studio` in the command palette. The Lexicon Studio panel opens with a login screen.
2. Start typing your Bluesky handle (e.g., `alice.bsky.social`). Typeahead search results appear from the public API.
3. Select your account and click "Connect". A browser window opens for OAuth authorization.
4. After authorizing, the panel shows your profile (avatar, display name, DID) with a sidebar navigation.
5. **My Lexicons** (default view) -- lists every collection in your AT Protocol repo with record counts. Use the filter box to narrow by NSID.
6. **Explore Lexicons** -- browse the full directory of known lexicons from lexidex.bsky.dev plus standard.site extras. Cached locally with 24-hour background refresh.
7. **Create Record** -- search for a lexicon, select it, and fill in an auto-generated form based on the schema. Toggle to "Raw JSON" mode for full control. Supports blob uploads for image fields.
8. Successfully created record types appear as sidebar shortcuts under the navigation. Click to jump back, or [x] to remove.

### Help Docs (Easter Egg)

**Summary:** A hidden documentation overlay that shows animated help hints from screen edges. Disguised as "Help docs" in the extension system. Disabled by default.

**Where in UI:** Command palette.

**How to try it:**
1. Type `help docs` in the command palette.
2. A fullscreen transparent, click-through overlay appears with animated documentation hints.
3. Type `help docs` again to toggle it off.

### Example Gallery

**Summary:** A demonstration extension showcasing the Peek API -- feature detection, image handling, and storage patterns. Useful for developers building extensions.

**Where in UI:** Listed in Settings as an extension.

**How to try it:**
1. Open Settings. Look for the Example Gallery extension.
2. Enable it if needed. The extension demonstrates Peek API capabilities.

---

## Keyboard Shortcut Reference

### Global Shortcuts (work from any app)

| Shortcut | Action |
|----------|--------|
| `Option+Space` | Open command palette |
| `Option+E` | Open editor |
| `Option+T` | Open tags browser |
| `Option+G` | Open groups browser |
| `Option+F` | Open local search |
| `Option+Shift+F` | Open feed reader |
| `Option+H` | Toggle HUD overlay |
| `Option+0` through `Option+9` | Open assigned Peek (configurable) |
| `Option+Arrow` | Open assigned Slide from screen edge (configurable) |
| Windows shortcut | Open window switcher (configurable) |
| Pagestream shortcut | Open pagestream (configurable) |

### Local Shortcuts (work when a Peek window is focused)

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open command palette |
| `Cmd+E` | Open editor |
| `Cmd+T` | Open tags browser |
| `Cmd+G` | Open groups browser |
| `Cmd+H` | Toggle HUD overlay |
| `Cmd+,` | Open settings |
| `Cmd+Shift+T` | Reopen last closed window |
| `Cmd+Shift+S` | Open scripts manager |
| `Cmd+Q` | Quit (configurable) |

### Page Window Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+L` | Show navbar and focus URL field |
| `Cmd+R` | Reload page |
| `Cmd+[` or `Cmd+Left` | Go back |
| `Cmd+]` or `Cmd+Right` | Go forward |
| `Escape` | Go back (if history) or close window |

### Editor Shortcuts (Vim Mode)

| Command | Action |
|---------|--------|
| `:set wrap` | Enable line wrapping |
| `:set nowrap` | Disable line wrapping |
| `:set number` | Show line numbers |
| `:set nonumber` | Hide line numbers |
| `:q` | Close editor |

---

## Command Palette Command Reference

All commands accessible from `Option+Space` or `Cmd+K`:

| Command | Description |
|---------|-------------|
| `open <url>` | Open URL in a new window |
| `modal <url>` | Open URL in a transient modal |
| `note <text or url>` | Save a note (auto-detects URL, tagset, or text) |
| `notes` | List recent notes |
| `list notes [#tag ...]` | List notes filtered by tags |
| `edit [search]` | Search notes and open in editor |
| `url <url>` | Save a URL to datastore |
| `history [search]` | Search and open from URL history |
| `tag [tags]` | Add tags to the active window URL |
| `tags [search]` | Show tags for active window or search all tags |
| `untag <tags>` | Remove tags from the active window URL |
| `tagset <#tag1,#tag2,...>` | Create a tagset item |
| `groups` | Browse saved groups |
| `list groups` | List groups with item counts |
| `open group <name>` | Open all URLs in a group |
| `new group <name>` | Save current windows to a named group |
| `web search <query>` | Search using default engine |
| `google <query>` | Search Google |
| `ddg <query>` | Search DuckDuckGo |
| `bing <query>` | Search Bing |
| `wiki <query>` | Search Wikipedia |
| `kagi <query>` | Search Kagi |
| `localsearch` | Open local search window |
| `feeds` | Browse subscribed feeds |
| `new feed <url>` | Subscribe to an RSS/Atom feed |
| `refresh feeds` | Poll all feeds for updates |
| `open editor` | Open the markdown editor |
| `scripts` | Open scripts manager |
| `new script [name]` | Create a new userscript |
| `extract entities` | Extract entities from current page |
| `open entities` | Open entity browser |
| `list entities` | List extracted entities |
| `windows` | Open window switcher overlay |
| `center window` | Center active window on display |
| `center all windows` | Center all windows |
| `pagestream` | Open browsing history stream |
| `Sync now` | Trigger manual sync |
| `hud` | Toggle HUD overlay |
| `help docs` | Toggle help docs overlay |
| `devtools` | Open DevTools for active window |
| `debug <url>` | Open URL with DevTools enabled |
| `open file` | Open a text file from disk |
| `csv` | Convert JSON to CSV (chain) |
| `markdown` | Convert JSON to markdown (chain) |
| `save [filename]` | Save chain output to file |
| `save as note` | Save chain output as a note |
| `reopen closed window` | Reopen last closed window |
| `lexicon studio` | Open AT Protocol identity extension |
| `lists` | Produce sample list data (chain demo) |
