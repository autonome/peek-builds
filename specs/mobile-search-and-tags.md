---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src-tauri/gen/apple/Peek/ShareViewController.swift, apps/mobile/ShareViewController-full-ui.swift.example]
depends-on: [mobile-list-sort]
---

# Mobile tags: clear search on tag select, consistent tag field label, keep focus in the text input

Peek items `a9776fcc` (clear search after selecting a tag), `ac81ac5a` (relabel the share-sheet tag field), `e2da5fca` (keep focus in the text input after tapping a tag button). Item `425c3446` (typing in search no longer filters the tag list) is already fixed in code; see below.

## 425c3446: already fixed, no work

In `App.tsx`, `filteredTags` is a `useMemo` over `allTags` filtered by `deferredSearch` (the `useDeferredValue` of `searchText`), and the header tag list renders `filteredTags`, with "No matching tags" when empty. Do not change it. The manual check below includes it as a regression guard.

## Problems

1. Tapping a tag in the header tag list leaves the typed search text in place, so the tag filter and leftover text both narrow the list. After selecting a tag the search box should be empty and the tag stay selected.
2. The tag field reads "Add new tag..." (or "Add tag..."), but the field also filters existing tags. It should say "Search or add tag...", with the same wording everywhere.
3. In the editor and the add panel, tapping a tag chip moves the caret out of the text being typed and the keyboard behaves badly. Focus should stay where it was.

## What the code does now

- `toggleFilterTag(tagName)` in `App.tsx` only changes `selectedFilterTags`. It does not touch `searchText`. The header chip calls it from its `onClick`.
- Tag-field placeholders: `TagsSection` default `placeholder = "Add tag..."`; the quick-add `tags` prop passes `placeholder: "Add new tag..."`; the captured-image ("Save Photo") view has its own tag `<input>` with `placeholder="Add tag..."`. The iOS share extension has `newTagTextField` with `placeholder = "Add new tag..."` and an `attributedPlaceholder` string "Add new tag..." in `src-tauri/gen/apple/Peek/ShareViewController.swift`, and `newTagTextField.placeholder = "Add new tag..."` in `ShareViewController-full-ui.swift.example`. The extension field already filters existing tags (`tagTextFieldChanged` sets `tagFilterText`). Android's share has no tag UI. The other editors use `TagsSection` with its default.
- `TagsSection`: chips and the x/Add buttons already prevent focus loss with `preventFocusLoss` on touchstart and mousedown, so tapping them leaves focus where it was. But each handler then calls `refocusInput()`, which focuses the tag field's own input (`tagInputRef`). That is what pulls the caret away from the main text input. The captured-image view does the same with `capturedImageTagInputRef`.

## Decisions

- Selecting a tag in the header list calls `setSearchText('')` in the same handler (only when selecting, not when deselecting).
- One shared string constant, `"Search or add tag..."`, is used by `TagsSection`'s default, the quick-add `tags` prop, the captured-image input, and both Swift files. The `.example` file is kept in step so the wording does not drift.
- Focus: in `TagsSection` and the captured-image view, refocus the tag input only when it was the focused element when the tap began (for example Enter or comma in the tag input, or the x button while typing there). When a chip is tapped while another input has focus, do nothing, since `preventFocusLoss` has already kept focus there. Do not add a new focus call. Implement it by checking `document.activeElement === tagInputRef.current` before calling `refocusInput()`.

## What changes

- `App.tsx`: `toggleFilterTag` handler; the placeholder constant and its four uses; the conditional refocus in `TagsSection` and in the captured-image tag handlers.
- `ShareViewController.swift` and `ShareViewController-full-ui.swift.example`: the placeholder strings.

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `node --test apps/mobile/tests/*.test.js` shows no new failure.

No pure logic is worth extracting, so no new unit test. The Swift change cannot be built on Linux. Record "share extension not built; needs `yarn build:share-ext` on macOS" under `**Result**`.

Manual check (no automated UI test). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder. Steps 3 and 4 need a physical device for honest keyboard behaviour. Step 5 needs iOS (a simulator or device with a Mac build).
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`).
2. With several tags, type a few characters into Search. Expected: the tag list narrows. Tap one remaining tag. Expected: the search box empties, the tag shows selected, and the item list reflects the tag filter only. (This also guards `425c3446`.)
3. `yarn mobile:ios:device:run` on a physical iPhone, or `yarn mobile:android:dev` on a physical Android device. Open the add panel, type a few words, then tap three tag buttons in a row. Expected: the keyboard stays up and all three tags apply.
4. Keep typing without tapping the input. Expected: text lands at the original caret position. Repeat in the editor on an existing item.
5. Share a link into Peek from another app (iOS share sheet). Expected: the tag field placeholder reads "Search or add tag...". Check the add panel, the editor and the photo save view show the same wording. The field must still filter existing tags and create a new tag when typed text matches nothing.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. The iOS share extension is built separately (`yarn build:share-ext`, macOS only). Run one command per Bash call.
