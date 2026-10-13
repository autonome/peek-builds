---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/App.css, apps/mobile/src/zoom-math.js, apps/mobile/src/zoom-math.d.ts, apps/mobile/tests/zoom-math.test.js]
depends-on: [mobile-share]
---

# Mobile: pinch-to-zoom in the full-screen image viewer, and keep the left-edge swipe correct

Peek items `188667d3` (pinch-to-zoom in the full-screen viewer) and `51639b79` (swipe from the left edge to go back).

## 51639b79: mostly already shipped

`App()` already implements the left-edge swipe: an effect with `EDGE_ZONE = 20` px and `MIN_SWIPE_DIST = 80` px (horizontal and larger than vertical) on document `touchstart` and `touchend`, calling `edgeSwipeBackRef.current?.()`. The ref is kept in sync each render, in the dismiss-topmost-overlay order: fullscreen image, expanded webview, URL/text/tagset/image editor, add panel, text reader mode, photo save view, settings, otherwise none. The only work left is the zoom interaction below. Do not rewrite the swipe. Its manual check stays in Verify as a confirmation.

## Problem (188667d3)

Tap-to-view exists. The viewer is `fullscreenImageData` rendered as `.image-fullscreen-overlay` with `.image-fullscreen-img` (styles in `App.css`), dismissed by tapping the overlay (`onClick={() => setFullscreenImageData(null)}`). It has no zoom: the image stays at a fixed fit.

## Done looks like

A pinch zooms the image and a drag pans it while zoomed. Double-tap toggles between fit and zoomed. Releasing below fit snaps back to fit. A tap at fit dismisses the viewer. A tap that ends a pan while zoomed does not dismiss it. A left-edge swipe does not fire while the image is zoomed.

## Decisions

- Implement with touch events on the viewer plus CSS transform, with `touch-action: none` on the overlay, and no new dependency. Maximum scale 4. Double-tap zooms to 2 at the tap point and a second double-tap returns to fit.
- The geometry (clamp scale, clamp pan so the image cannot leave the view, double-tap toggle, snap back below fit) goes into a new `apps/mobile/src/zoom-math.js` (with a `.d.ts`), so it is unit tested.
- Dismiss rule: a touch sequence dismisses only if the scale is 1 and total movement is under 10 px. The existing `onClick` on the overlay is replaced by this check.
- The edge swipe is suppressed while zoomed: keep a ref (`imageZoomedRef`) set by the viewer, and have the edge-swipe `onTouchStart` return early when it is true. At fit, the existing behaviour (the swipe dismisses the viewer) is kept.
- Reset zoom state when `fullscreenImageData` changes or closes.

## What changes

`App.tsx` (viewer touch handling, the ref, the dismiss rule), `App.css` (overlay `touch-action`, image transform origin, transitions only for the snap back), `zoom-math.js` and its `.d.ts`.

## Tests to change

New `apps/mobile/tests/zoom-math.test.js` (`node:test`, import from `../src/zoom-math.js`): scale clamps to [1, max]. Releasing below 1 returns scale 1 with pan 0. Pan clamps to the scaled image bounds. Double-tap from fit gives scale 2 centred on the point, and from zoomed returns to fit. A pinch's new scale is computed from the ratio of finger distances.

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `node --test apps/mobile/tests/zoom-math.test.js` reports `fail 0`, and `node --test apps/mobile/tests/*.test.js` shows no new failure.

Manual check (no automated UI test). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder. A physical device is much better than a simulator, because pinches and edge swipes are what is being tested.
1. `yarn mobile:ios:device:run` on an iPhone, or `yarn mobile:android:dev` on an Android device.
2. Tap an image item to open the full-screen viewer. Pinch out, pan around, pinch back in, and double-tap twice. Expected: zoom and pan track the fingers smoothly, the image snaps to fit when pinched below it, and double-tap toggles fit and zoomed.
3. With the image at fit, tap once. Expected: the viewer dismisses. While zoomed, a tap that ends a pan does not dismiss.
4. While zoomed, swipe in from the left edge. Expected: nothing happens. At fit, the same swipe dismisses the viewer.
5. Confirmation of the existing swipe. Open the editor on an item and swipe in from the left edge: it closes one layer. On the plain list the swipe does nothing disruptive. On Android, the system back button behaves as before.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
