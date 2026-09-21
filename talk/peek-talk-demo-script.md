# Peek — Demo Run-Sheet

Condensed, ordered steps for demoing Peek live. Companion to `peek-talk-overview.md`
(section refs point back to it). Each step: **do → audience sees → the point**. Caveats
marked ⚠ are things that are real-but-rough — demo them, don't lean on them.

---

## Pre-flight (have these ready before you start)

- Peek running on the `default` profile, packaged build (not a dev build — MCP config + panels behave).
- Another app in the foreground (Safari) with a couple of tabs — you need a "not-Peek" app to peek *over*.
- A content-rich page open or bookmarked for entities (one with real JSON-LD / an article, org, or product page).
- A handful of saved URLs in the store (so `list urls` returns rows for the chain demo).
- Only **Opt+0** (peek) and **Opt+Up** (slide) are bound by default — to use other digits or directions, set them in the Features Manager options for Peeks and Slides first.
- Claude Code installed and a throwaway project dir for the MCP beat.
- Optional: iPhone / simulator with the share extension installed for the mobile beat.
- Optional: Activity Monitor open to a filtered "Peek" view for the perf beat.

---

## The demo, in order

### 1. The hook — peek without losing your place  (overview §2 / §6.9)
- **Do:** From Safari, press **Opt+Space** → cmd bar appears on top → act → press **ESC**.
- **See:** A pill drops in over Safari; on ESC it vanishes and you're back in Safari, same tab, same Space.
- ⚠ Pick an action that doesn't open a page. A URL opened here appears over Safari without activating Peek; ESC sets it aside and it reappears the next time Peek activates — narrate that if you show it.
- **Point:** Zero context-switch. Your active app and macOS Space never change — the signature "peek, don't switch" bet (IZUI).

### 2. Peeks & slides — any page, one keystroke  (§6.10)
- **Do:** **Opt+0** → a page peeks in centered. **ESC**. **Opt+Up** → a page slides in from the top edge. **ESC**.
- **See:** A real web page as a transient centered window; then one anchored to a screen edge.
- **Point:** Same transient model, two shapes — bound to a key, gone on ESC, focus returns to where you were.

### 3. The windows switcher — Exposé for Peek  (§6.11)
- **Do:** **Cmd+Tab** to Peek with a page focused, press **ESC** (or **Cmd+Shift+W** from anywhere in Peek) → switcher zooms out over everything → **hjkl** (or arrows) to a card → **Enter**.
- **See:** Every open window as a card (favicon, title, live thumbnail); vim-navigable; Enter jumps to it.
- **Point:** ESC on a focused page zooms out to a full-screen switcher — one key, two jobs. The Escape grab is armed only while Peek is the active app, so it never takes ESC from another app; a page you reached from another app closes on ESC instead.

### 4. Cmd → anything — one entry point, many surfaces  (§6.12)
- **Do:** **Opt+Space**, type `note buy milk` → **Enter** (saves, and drops you into the editor on the new note). Reopen, run `groups` → a full window opens.
- **See:** Same bar; one command saves and opens the editor, another opens a whole tile window. (A tagset is the case that closes silently.)
- **Point:** A command's output decides the surface — silent save, a window, an in-panel list, the editor, or a data pipeline. One keystroke fans out to N surface *shapes*.
- ⚠ **Say the honest bit:** there's no success toast on a silent save yet (`result.message` is discarded) — a known, still-open UX gap, not a bug to hide.

### 5. The editor — markdown, three panes, highlights  (§6.14)
- **Do:** **Cmd+E** → editor opens. Show the outline (left) / editor / preview (right). Select a sentence → **Cmd+Shift+L** → it highlights → add a note in the right-edge **Notes** pane. **Cmd/Ctrl+click** a URL in the text to open it.
- **See:** CodeMirror 6 editor, live preview, a colored highlight with an inline note, click-to-open links.
- **Point:** A real markdown workspace (vim mode + focus mode available), with persistent highlights + annotations that shipped recently.
- ⚠ Highlights persist to renderer `localStorage` keyed by item — they **don't sync** and are profile-bound. Clickable links work but are **untested** — fine to show, don't build a beat that depends on them.

### 6. Cmd chaining — pipe data between commands  (§6.15)
- **Do:** **Opt+Space** → `list urls` → arrow to a row → **Enter** → `csv` → `save` → native save dialog.
- **See:** An array of URLs → pick one → transformed to CSV → saved to disk, all inside the bar.
- **Point:** Commands declare `accepts`/`produces` MIME types and pipe together — producer → transformer → consumer. It **works live** today.
- ⚠ **Don't oversell it:** discoverability is the open gap — nothing really signals output is chainable. It works; the UX for *finding* it doesn't. Say so.

### 7. The perf story — why the page-host was rebuilt  (§6.16)  *(tell, optionally show)*
- **Do:** Pull up the before/after table (or Activity Monitor if you kept a real session running).
- **Say:** Old transparent-canvas host → new opaque `WebContentsView` + one shared chrome overlay. On a real 46-page session: renderer processes −41%, RSS −32%, and **idle CPU essentially eliminated** (Electron ~118% → ~1–3%, GPU ~33% → ~0%).
- **Point:** Transparent canvases repainted forever even at idle; opaque static content has nothing to repaint. The idle-CPU collapse is the standout number.

### 8. Entities — the web classifies itself  (§6.17 / §4)
- **Do:** Visit a content-rich page, let extraction run (~2s debounce), then open the entities browser.
- **See:** People / orgs / places / products extracted automatically, per-page and in a browsable window.
- **Point:** Three parallel extractors (structured-data, microformats, regex) + a local name DB — client-side, no ML, no remote service. Passive browsing becomes a typed, queryable knowledge store.
- ⚠ The correlation *graph* and Wikidata validation are design-only — don't present them as live.

### 9. Mobile — save from anywhere, no app launch  (§5)  *(optional, if demoing mobile)*
- **Do:** In Safari on iOS: **Share → "Peek Save"** → the custom share-ext UI appears → pick/create frecency-sorted tags → **Save**.
- **See:** Save-with-tags without ever launching the Peek app; dup detection merges tags if already saved.
- **Point:** Same local-first datastore, capture at the OS share sheet.

### 10. MCP — agent and human on one live datastore  (§6.19)
- **Do:** In a project dir run `/Applications/Peek.app/Contents/Resources/peek-mcp-init <scope> --writes`, restart Claude Code, then ask it to list/search/tag items → reopen the view in Peek to see the change.
- **See:** Claude Code reading your saved pages and tagging items in the **same SQLite** the Peek window is showing, right now.
- **Point:** Peek becomes an agent-writable personal knowledge + task backend — scoped per project (an agent can't poison a sibling project's tags). The peek repo dogfoods this with its own `peek:*` task queue.

---

## Closing line
One store, local-first; a hotkey that peeks without stealing focus; features all the way down;
and the same datastore readable by you *and* your agent. Everything shown ran live — the honest
gaps (chaining discoverability, no save toast) are called out, not hidden.

## Backup / fallbacks if something misbehaves
- Cmd bar won't summon over another app (Wayland/Linux) → use the CLI verb bound to your DE hotkey (§6.9).
- Switcher via ESC not firing → run the `windows` command (**Cmd+Shift+W**) instead.
- Editor lazy-load hiccup → run `editor` from the cmd bar once to wake the tile, then re-trigger.
