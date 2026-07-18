/**
 * Content-area double-click window gesture — end-to-end over a REAL hybrid
 * page-host (peek d8ce0ddf).
 *
 * A double-click over "dead" page content toggles the host window's MAXIMIZE.
 * The gesture is SUPPRESSED when the multi-click lands on an editable/interactive
 * control OR when it lands ON text it selected. The detection lives CONTENT-SIDE
 * in the universal preload (runtime-external-preload.cjs), which is applied to
 * every http(s) page-host content WC (getRuntimeExternalWebPrefsForUrl). So —
 * unlike the `data:`-URL hybrid specs, which get no preload — this spec loads
 * content from a local http server so the REAL capture-phase click listener runs.
 *
 * COORDINATE FIDELITY (why every dispatch carries clientX/clientY): Chromium
 * snaps a double-click in DEAD SPACE to the nearest word and SELECTS it, so
 * "a selection exists" is true after almost every dead-space double-click. The
 * suppression guard therefore does NOT test "is there a selection" — it tests
 * whether the CLICK POINT falls within the selected text's own rects. A faithful
 * test must dispatch a `MouseEvent` whose `clientX/clientY` match the geometry
 * being exercised (inside the selected word vs. out in empty space). The prior
 * version dispatched `new MouseEvent('click',{detail:2})` with the default (0,0)
 * coordinate, which no longer exercises the guard at all — it masked the bug
 * where dead-space clicks were wrongly suppressed by an incidental selection.
 *
 * contextIsolation gives the preload a separate JS realm but the SAME DOM, so the
 * preload's document-level capture listener sees the dispatched event exactly as
 * it sees a native one — including its `clientX/clientY` and `composedPath`.
 *
 * Observable assertion: maximize snaps the host BaseWindow to its display's work
 * area (hostBounds(id) === hostWorkArea(id)) — the SAME assertion the overlay
 * maximize test uses. Because maximize is a strict TOGGLE, the suppression cases
 * are proven sleep-free by PARITY: fire the suppressed click, then a known-good
 * empty-area click. If suppression works, exactly one effective gesture lands and
 * the window ends MAXIMIZED; if the suppressed click had leaked, two toggles fire
 * and the window ends back at its ORIGINAL bounds — so the maximize assertion
 * fails, catching the regression with no timer.
 *
 * Fullscreen is NOT a content gesture — triple-click (detent 3) no longer enters
 * fullscreen. Fullscreen is command-driven and single-owned by main
 * (tile:window:fullscreen → setHybridHostFullScreen); its native-macOS transition
 * is exercised in tests/desktop-disruptive/hybrid-content-window-gesture-fullscreen.spec.ts
 * (excluded from the normal runs — see that file's header for why). The pure
 * detent map (detent 3 → null) is covered by the unit
 * (main/hybrid-window-gesture.test.ts).
 *
 *   yarn test:grep "Hybrid content window gesture"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { hybridBridgePresent } from '../helpers/hybrid-page';
import { setupGestureHost, type GestureHost } from '../helpers/gesture-host';

// A native-style double-click (detail:2) dispatched at the CENTER of `sel`, with
// real clientX/clientY so the content-side guard's click-point ↔ selection-rect
// hit-test is exercised. `clearSelection` wipes any live selection first (the
// "clean empty click" case); when false the caller has set up a selection to
// exercise. Returns `{ fired, selected }` — `selected` reports whether a
// non-collapsed selection was present at dispatch time (for assertions).
function dispatchDoubleClickAtCenterSrc(sel: string, clearSelection: boolean): string {
  return `(function () {
    ${clearSelection ? 'try { window.getSelection().removeAllRanges(); } catch (_) {}' : ''}
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { fired: false };
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var s = window.getSelection();
    var selected = !!(s && !s.isCollapsed && String(s).length > 0);
    el.dispatchEvent(new MouseEvent('click', {
      detail: 2, bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y,
    }));
    return { fired: true, selected: selected };
  })()`;
}

// Select `selSel`'s text, then double-click. Two shapes, chosen by `where`:
//  - 'on-selection'  → click AT the center of the SELECTION's own rect, i.e. ON
//    the selected text (word/line double-click) → guard SUPPRESSES. (Note: we
//    must aim at the selection rect, NOT the container element's box — a block
//    <p> is full-width but its text only fills part of the first line, so the
//    element's center can miss the text entirely.)
//  - a selector string → click at THAT element's center; used to click far away
//    in dead space while an incidental selection exists elsewhere → guard must
//    NOT suppress (the core bug: a dead-space double-click leaves Chromium's
//    nearest-word selection behind, which used to suppress the gesture always).
function selectThenDoubleClickSrc(selSel: string, where: 'on-selection' | string): string {
  // Resolve BOTH the dispatch target and the click point. On-selection: target =
  // the selected element, point = the selection's own rect. Dead-space: target =
  // that element, point = its box center.
  const resolve =
    where === 'on-selection'
      ? `var cTarget = sTarget; var r = s.getRangeAt(0).getClientRects()[0];`
      : `var cTarget = document.querySelector(${JSON.stringify(where)});
         var r = cTarget && cTarget.getBoundingClientRect();`;
  return `(function () {
    var sTarget = document.querySelector(${JSON.stringify(selSel)});
    if (!sTarget) return { fired: false };
    var s = window.getSelection();
    s.removeAllRanges();
    s.selectAllChildren(sTarget);
    var selected = String(s).length > 0;
    ${resolve}
    if (!cTarget || !r) return { fired: false, selected: selected };
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    cTarget.dispatchEvent(new MouseEvent('click', {
      detail: 2, bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y,
    }));
    return { fired: true, selected: selected };
  })()`;
}

// A double-click whose SECOND press lands `dx`/`dy` away from where the
// preceding click's release fires — i.e. the terminating click is really a
// click-drag, not a stationary double-click, even though it still carries
// `detail:2` (Chromium's native multi-click counter doesn't reset on pointer
// travel, only on time/distance from the PREVIOUS click). Dispatches a real
// `mousedown` at the offset point (so the content-side listener records it as
// `_peekDownX/_peekDownY`), then the terminating `click` at the ORIGINAL center
// — mirroring a real click-drag's press-far/release-near shape. Used to prove
// the drag-slop guard suppresses the gesture (peek 63cb6ba6).
function dispatchDraggedDoubleClickAtCenterSrc(sel: string, dx: number, dy: number): string {
  return `(function () {
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { fired: false };
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, composed: true, cancelable: true, clientX: x + ${dx}, clientY: y + ${dy},
    }));
    el.dispatchEvent(new MouseEvent('click', {
      detail: 2, bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y,
    }));
    return { fired: true };
  })()`;
}

test.describe('Hybrid content window gesture @desktop', () => {
  let app: DesktopApp;
  let openGestureWindow: GestureHost['openGestureWindow'];
  let runInContent: GestureHost['runInContent'];
  let hostBoundsOf: GestureHost['hostBoundsOf'];
  let workAreaOf: GestureHost['workAreaOf'];
  let teardown: GestureHost['teardown'];

  test.beforeAll(async () => {
    ({ app, openGestureWindow, runInContent, hostBoundsOf, workAreaOf, teardown } = await setupGestureHost(
      'hybrid-content-window-gesture',
    ));
  });

  test.afterAll(async () => {
    await teardown();
  });

  test('double-click on dead content maximizes the host window', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();

    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(workArea).not.toBeNull();
    expect(before).not.toBeNull();
    // Sanity: the fresh window is NOT already at the work area, so "became the
    // work area" is a meaningful signal (not vacuously true).
    expect(before).not.toEqual(workArea);

    // Dead-space double-click over the empty #dead div → gesture fires → maximize.
    const res = await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#dead', true));
    expect(res.fired).toBe(true);

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('dead-space double-click with an incidental selection elsewhere STILL maximizes', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    // THE core regression for the suppression fix. Chromium leaves a nearest-word
    // selection behind on a dead-space double-click; the old guard suppressed the
    // gesture whenever ANY selection existed, so the feature barely fired in real
    // use. Here we set up a selection over #para, then click far away in #dead —
    // the click point is OUTSIDE the selection rects, so the gesture MUST fire.
    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    const res = await runInContent(wcId, selectThenDoubleClickSrc('#para', '#dead'));
    expect(res.fired).toBe(true);
    expect(res.selected).toBe(true); // a real selection WAS present at click time

    // One effective gesture → maximized. If the incidental selection had
    // (wrongly) suppressed it, the window never leaves `before` and this fails.
    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click on an <input> does NOT maximize (interactive target suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    // Parity proof (sleep-free): suppressed click on the input, THEN a known-good
    // dead-space click. Maximize is a strict toggle — if the input click were
    // (wrongly) NOT suppressed, two effective gestures fire and the window ends
    // back at `before`; the poll for the work area then times out and FAILS.
    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#inp', false));
    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#dead', true));

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click on a <button> does NOT maximize (interactive target suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#btn', false));
    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#dead', true));

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click ON selected text does NOT maximize (selection-hit suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    // Select the paragraph's text, then double-click AT the paragraph (the click
    // point falls INSIDE the selection rects) → "the user is selecting, not
    // gesturing" → suppressed. Then a known-good dead-space click. Same toggle
    // parity: a leak would toggle back to `before` and fail the maximize poll.
    const res = await runInContent(wcId, selectThenDoubleClickSrc('#para', 'on-selection'));
    expect(res.selected).toBe(true);

    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#dead', true));

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('a double-click whose second press drags past slop does NOT maximize (click-drag suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    // The reported regression (peek 63cb6ba6): a click-drag that lands within
    // Chromium's native double-click interval of a prior click still carries
    // `detail:2` on its terminating click, even though the pointer moved between
    // press and release — the old detail-only gate wrongly toggled maximize.
    // Drag well past GESTURE_DRAG_SLOP_PX (5px) on both axes.
    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    // Parity proof (sleep-free), same shape as the interactive-target cases: the
    // dragged double-click MUST be suppressed, then a known-good dead-space click
    // fires the one effective gesture. If the drag had (wrongly) fired too, two
    // toggles land and the window ends back at `before`, failing the poll below.
    // The second dispatch is a BARE click (no mousedown, like every other helper
    // here), so it reads no press point and counts as stationary — the preload
    // consumes the press on each click precisely so it can't inherit the dragged
    // press above and get suppressed too.
    await runInContent(wcId, dispatchDraggedDoubleClickAtCenterSrc('#dead', 40, 40));
    await runInContent(wcId, dispatchDoubleClickAtCenterSrc('#dead', true));

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });
});
