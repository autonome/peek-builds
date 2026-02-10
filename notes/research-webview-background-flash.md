# Research: Webview Background Flash Fix

## Problem

When opening a web page in the inline WKWebView on mobile, there's a white flash before the page renders. The WKWebView defaults to white background regardless of the app's color scheme, which is jarring in dark mode.

## Goal

Start with the app's background visible behind the page as it loads. Detect the page's actual background as early as possible (DOMContentLoaded at latest). If different, smoothly animate to it.

## Approach Tried: Transparent Webview + CSS Transition Fade-In

### What We Did

**Step 1: Make WKWebView transparent** (works)

```swift
webView.isOpaque = false
webView.backgroundColor = .clear
webView.scrollView.backgroundColor = .clear
```

This successfully makes the WKWebView transparent so the app's Tauri webview background shows through. The white flash is eliminated — the app's dark/light background is visible during load.

**Step 2: Inject document-start script** to manage the transition

Injected via `WKUserScript` at `.atDocumentStart`, `.forMainFrameOnly`:

1. Set `document.documentElement.style.backgroundColor = 'transparent'` immediately
2. Inject `<style id="__peek_bg">body{background-color:transparent!important}</style>` to force body transparent
3. At DOMContentLoaded, read the page's intended body bg (temporarily disable override, read `getComputedStyle`), parse RGB values
4. Set html bg to `rgba(r,g,b,0)`, add `transition: background-color Xs ease`, then set `rgba(r,g,b,1)` to animate the fade-in
5. Clean up injected styles after transition completes

### What Works

- **Transparent WKWebView**: The app background shows through correctly during load. No white flash.
- **Document-start injection**: The script runs and the transparent override is applied.
- **Background color detection**: The `getComputedStyle` read works — we can detect the page's intended background.

### What Doesn't Work

- **CSS transition is ignored**: The background-color transition from `rgba(r,g,b,0)` to `rgba(r,g,b,1)` does not animate. The change appears instant — the page's background just snaps in.

### Variations Tried

1. **`offsetHeight` forced reflow** between setting start/end states — no effect
2. **Double `requestAnimationFrame`** to guarantee paint before setting end state — no effect
3. **3-second transition duration + 2-second delay** before reveal — the delay works (app bg visible longer), but when the transition fires it's still instant, not animated
4. **`transition` on both html element (inline) and body (via stylesheet)** — neither animates

### Theories on Why Transitions Fail

1. **WKWebView compositing**: When `isOpaque = false`, WKWebView may use a different compositing path that doesn't support CSS transitions on the root element's background, or the transparency is handled at a layer level that bypasses CSS animation.

2. **Page stylesheet race**: The page's own stylesheets may be applying background-color to `html` or `body` in a way that overrides our inline transition mid-flight. Many sites set `html { background: #fff }` which would conflict.

3. **Background-color on `<html>` may not be transitionable in WebKit** in the same way as on regular elements — the root element's background has special rendering behavior (it paints the canvas).

4. **`transparent` → `rgba(r,g,b,1)` may not interpolate** in all WebKit versions. Some engines don't interpolate from `transparent` (which is `rgba(0,0,0,0)`) to a colored value smoothly.

## Alternative Approaches to Explore

### A. Native UIView overlay fade

Instead of CSS transitions, use a native UIView with the app's background color overlaid on top of the WKWebView. Fade the overlay out using `UIView.animate()` after `didFinish` navigation delegate fires. This avoids CSS transition issues entirely.

```swift
let overlay = UIView(frame: webView.bounds)
overlay.backgroundColor = .systemBackground
overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
webView.addSubview(overlay)

// In didFinish delegate:
UIView.animate(withDuration: 0.3) {
    overlay.alpha = 0
} completion: { _ in
    overlay.removeFromSuperview()
}
```

**Pros**: Fully native, guaranteed to animate, no CSS hacks.
**Cons**: Overlay hides page content during load (but that's arguably fine — content isn't ready yet anyway). Need to use `didFinish` which fires late (after all resources load), or use `didCommit` for earlier reveal.

### B. WKWebView `underPageBackgroundColor`

iOS 15+ has `webView.underPageBackgroundColor` which sets the color shown behind the page content (for overscroll, etc). Setting this to match the app's background might reduce the flash without needing transparency tricks. However, this requires knowing dark/light mode and doesn't solve the transition.

### C. Opacity animation on the WKWebView itself

Start the WKWebView at `alpha = 0`, then animate to `alpha = 1` after content loads. Simple, but fades in ALL content (not just background), which may look different than desired.

### D. JavaScript `opacity` transition instead of `background-color`

Instead of transitioning background-color, wrap all body content in a div, set the real background immediately, but transition the wrapper's opacity from 0 to 1. This avoids the root-element background transition issue.

## Current State

The code in `WebviewPlugin.swift` has the transparent WKWebView + CSS injection approach implemented with debug timing (2s delay, 3s transition, 3.5s cleanup). The transparent WKWebView part works well. The CSS transition part does not animate — it snaps instantly.

**Recommendation**: Try approach **A (native UIView overlay fade)** next. It sidesteps all CSS/WebKit quirks by using UIKit animation which is reliable and well-understood.
