---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/App.css]
depends-on: [mobile-search-and-tags]
---

# Mobile header: tap to scroll to top, pinned search/add row, Enter saves a photo, notch clearance

Peek items `aeca2169` (tap the header to scroll to top), `6797587e` (option to pin the search/add bar), `4f22e74e` (Enter does not save an image), `1ab0c352` (iOS: top of app sits under the notch).

## Problems

1. The only way back to the top of a long list is the title tap or repeated flicking. Tapping any non-button part of the header should scroll to the top.
2. The search/add row scrolls away. There should be a setting to pin it under the header.
3. In the photo save view, pressing Enter does not save and close.
4. On iPhones with a notch or Dynamic Island, the top of the app sits slightly under the cutout, hiding UI such as the editor cursor and selection handles.

## What the code does now

- `App.tsx`: the main-view `<header>` contains an `<h1>` whose `onClick` calls `showAll()` if any filter, search or tag is active and `scrollToTop()` otherwise. `scrollToTop()` scrolls `mainRef` (the `main.saved-view` scroller, a sibling after the header). The other header children are buttons (`.filter-btn`, `.sort-btn`, settings). The header is not inside `main`; it is a flex sibling, so it always stays visible.
- The search/add `div.input-row` is the first child inside `main.saved-view`, so it scrolls with the list. `main.saved-view` has `overflow-y: auto` in `App.css`. The add panel is the `EditorLayout` overlay, separate from the row.
- The "Save Photo" view (the `if (capturedImage)` early return in `App()`) is opened by the camera button through `handleCameraCapture`. It has a tag `<input>` whose `onKeyDown` handles only Enter, by calling `addCapturedImageTag()`. It saves only through the Save button (`saveCapturedImage`), which already includes pending text from the tag input. The add panel's textarea and its tag field never save on Enter either.
- Safe area: an effect in `App()` runs once on mount. If `--safe-area-top` is not already set on `document.documentElement` it measures a hidden `position:fixed; top:0; height:env(safe-area-inset-top)` probe with `offsetHeight` (an integer) and writes the pixel value. Android's `MainActivity.kt` writes the same variable with the real insets. `App.css` uses `calc(var(--safe-area-top, env(safe-area-inset-top, 0px)) + 0.4rem)` for `header` padding-top, and exactly `var(--safe-area-top, ...)` with no extra padding for `.edit-overlay` and `.image-fullscreen-overlay`. The viewport meta has `viewport-fit=cover`. The inset is measured once, so a rotation does not re-measure.

## Decisions

- Header tap: add one `onClick` on the `<header>` element that ignores any target inside a `button`, `a`, `input` or `.filter-icons`. It calls `scrollToTop()` only. The `<h1>` keeps its existing behaviour (reset filters, or scroll if none) and stops propagation so the header handler does not also fire.
- Pinned row: new boolean setting `pinInputRow`, default false, stored in localStorage and shown as a checkbox in settings. When on, add class `input-row-pinned` to `div.input-row`: `position: sticky; top: 0; z-index` below the header's 100, with an opaque background matching `main.saved-view` in light and dark. Because the header is above `main` and already carries the safe-area padding, the pinned row (top: 0 inside the scroller) sits right under it and needs no extra safe-area handling. Check it does not overlap the first list item (add bottom margin or padding if needed).
- Photo Enter: Enter in the tag field of the photo save view saves the image and closes the view (calls `saveCapturedImage`, which already includes any pending tag text). A comma still adds a tag, and the Add button still adds a tag. This replaces Enter-adds-tag in that view only. Enter in the add panel, the editors and `TagsSection` is unchanged.
- Notch: re-measure on `resize` and `orientationchange`, and measure with `getBoundingClientRect().height` rounded up. Write `--safe-area-top` from the probe only when the measured value is above 0, or when the previous value was written by this code. Mark the writer with a `data-safe-area-source="env"` attribute on the root, so Android's Kotlin value (the probe returns 0 there) is never overwritten. Add a small cushion (0.25rem) to `.edit-overlay` padding-top through a second variable `--safe-area-top-extra`, set to `0.25rem` only on the env path and `0px` otherwise, so Android layout is unchanged. If the manual check still shows clipping on iOS, check the Tauri iOS webview inset settings in `src-tauri/gen/apple` and the `src-tauri` config, and record the finding.

## What changes

`App.tsx` (header click handler, h1 stop-propagation, the `pinInputRow` state, effect and settings checkbox, photo-view Enter handler, safe-area effect) and `App.css` (`.input-row-pinned`, dark variant, `--safe-area-top-extra` use in `.edit-overlay`).

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `node --test apps/mobile/tests/*.test.js` shows no new failure.

No pure logic is worth a unit test here. The safe-area change cannot be seen without iOS hardware or a simulator.

Manual check (no automated UI test). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder. Step 8 needs iOS specifically, on a simulator or iPhone with a notch or Dynamic Island.
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`), with enough saved items that the list pages in more than once.
2. Scroll down until several pages have loaded. Tap an empty part of the header. Expected: the list returns to the top. Then tap each header button in turn. Expected: each does its own action without also scrolling.
3. With the pin setting off, scroll down. Expected: the search/add row scrolls away, as today.
4. Turn the pin setting on and scroll down. Expected: the row stays visible under the header and does not cover list content. Tap into the add input. Expected: the add panel expands normally.
5. Force-quit and relaunch. Expected: the setting survives.
6. Tap the camera button and attach or capture a photo. Add a tag in the tag field. Press Enter on the on-screen keyboard. Expected: the view closes and the image item appears at the top of the list with its tag.
7. Add a plain text item and confirm that path is unchanged.
8. On iOS with a cutout: the header sits fully below the cutout and status bar in portrait and landscape, and the editor's text cursor and selection handles near the top are fully visible.
9. On Android, confirm the top of the app is unchanged.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
