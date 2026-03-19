/**
 * Unit tests for page maximize layout math.
 *
 * Tests the pure computation functions from app/page/page.js:
 * - computeWindowBounds() in normal vs maximized mode
 * - positionPanelsMaximized() panel position clamping
 * - updatePositionsMaximized() element positions
 *
 * Functions are duplicated here since page.js depends on DOM and IPC.
 *
 * Run via: node --test tests/unit/page-maximize-layout.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// ---------------------------------------------------------------------------
// Constants from page.js
// ---------------------------------------------------------------------------
const NAVBAR_HEIGHT = 36;
const NAVBAR_GAP = 0;
const MARGIN = 8;
const TRIGGER_ZONE_HEIGHT = 8;
const PANEL_WIDTH = 280;
const PANEL_OVERLAP = PANEL_WIDTH * 0.25; // 70
const PANEL_OVERHANG = PANEL_WIDTH - PANEL_OVERLAP; // 210

// ---------------------------------------------------------------------------
// Pure functions extracted from page.js
// ---------------------------------------------------------------------------

function computeWindowBounds(sb, isMaximized, preMaximizeBounds, extraWidth) {
  if (isMaximized && preMaximizeBounds) {
    return {
      x: Math.round(sb.x),
      y: Math.round(sb.y),
      width: Math.round(sb.width),
      height: Math.round(sb.height),
    };
  }
  const winX = sb.x - MARGIN - extraWidth / 2;
  const winY = sb.y - TRIGGER_ZONE_HEIGHT - (NAVBAR_HEIGHT + NAVBAR_GAP);
  const winW = sb.width + MARGIN * 2 + extraWidth;
  const winH = sb.height + TRIGGER_ZONE_HEIGHT + MARGIN + (NAVBAR_HEIGHT + NAVBAR_GAP);

  return { x: Math.round(winX), y: Math.round(winY), width: Math.round(winW), height: Math.round(winH) };
}

/**
 * Compute maximized element positions (webview, navbar, panels).
 * Returns a plain object describing where each element would be placed.
 */
function computeMaximizedPositions(winW, winH, navVisible) {
  const webview = { left: 0, top: 0, width: winW, height: winH };
  const navbar = { left: MARGIN, top: MARGIN, width: winW - MARGIN * 2 };
  const triggerZone = {
    left: 0,
    top: 0,
    width: winW,
    height: navVisible ? NAVBAR_HEIGHT + MARGIN + TRIGGER_ZONE_HEIGHT : TRIGGER_ZONE_HEIGHT + MARGIN,
  };
  return { webview, navbar, triggerZone };
}

/**
 * Compute panel positions in maximized mode.
 * Left panels clamped to MARGIN from left, right panels clamped to MARGIN from right.
 */
function computePanelPositionsMaximized(winW, winH, navVisible) {
  const panelTopOffset = (navVisible ? NAVBAR_HEIGHT + MARGIN : 0) + TRIGGER_ZONE_HEIGHT + 40;

  const leftPanelLeft = MARGIN;
  const rightPanelLeft = winW - MARGIN - PANEL_WIDTH;

  return { panelTopOffset, leftPanelLeft, rightPanelLeft };
}

/**
 * Compute panel positions in normal (non-maximized) mode.
 * Left panels overhang to the left, right panels overhang to the right.
 */
function computePanelPositionsNormal(webviewLeft, webviewWidth) {
  const leftPanelLeft = webviewLeft - PANEL_WIDTH + PANEL_OVERLAP;
  const rightPanelLeft = webviewLeft + webviewWidth - PANEL_OVERLAP;
  return { leftPanelLeft, rightPanelLeft };
}

// ===========================================================================
// Tests: computeWindowBounds
// ===========================================================================

describe('computeWindowBounds', () => {
  describe('normal mode', () => {
    it('computes correct window position from screen bounds', () => {
      const sb = { x: 100, y: 100, width: 800, height: 600 };
      const bounds = computeWindowBounds(sb, false, null, 0);
      // winX = 100 - 8 - 0 = 92
      // winY = 100 - 8 - 36 = 56
      // winW = 800 + 16 + 0 = 816
      // winH = 600 + 8 + 8 + 36 = 652
      assert.equal(bounds.x, 92);
      assert.equal(bounds.y, 56);
      assert.equal(bounds.width, 816);
      assert.equal(bounds.height, 652);
    });

    it('adds extra width symmetrically', () => {
      const sb = { x: 100, y: 100, width: 800, height: 600 };
      const bounds = computeWindowBounds(sb, false, null, 420);
      // winX = 100 - 8 - 210 = -118
      // winW = 800 + 16 + 420 = 1236
      assert.equal(bounds.x, -118);
      assert.equal(bounds.width, 1236);
      // Height unaffected by extraWidth
      assert.equal(bounds.height, 652);
    });

    it('rounds fractional values', () => {
      const sb = { x: 100.3, y: 200.7, width: 800.5, height: 600.1 };
      const bounds = computeWindowBounds(sb, false, null, 0);
      assert.equal(bounds.x, Math.round(100.3 - 8));
      assert.equal(bounds.y, Math.round(200.7 - 8 - 36));
      assert.equal(bounds.width, Math.round(800.5 + 16));
      assert.equal(bounds.height, Math.round(600.1 + 8 + 8 + 36));
    });

    it('height includes navbar, trigger zone, and bottom margin', () => {
      const sb = { x: 0, y: 0, width: 1000, height: 500 };
      const bounds = computeWindowBounds(sb, false, null, 0);
      // winH = 500 + TRIGGER_ZONE_HEIGHT(8) + MARGIN(8) + NAVBAR_HEIGHT(36) + NAVBAR_GAP(0)
      assert.equal(bounds.height, 500 + 8 + 8 + 36);
    });
  });

  describe('maximized mode', () => {
    it('returns screen bounds directly when maximized', () => {
      const sb = { x: 0, y: 25, width: 1440, height: 875 };
      const preMaxBounds = { x: 100, y: 100, width: 800, height: 600 };
      const bounds = computeWindowBounds(sb, true, preMaxBounds, 0);
      assert.equal(bounds.x, 0);
      assert.equal(bounds.y, 25);
      assert.equal(bounds.width, 1440);
      assert.equal(bounds.height, 875);
    });

    it('ignores extraWidth when maximized', () => {
      const sb = { x: 0, y: 25, width: 1440, height: 875 };
      const preMaxBounds = { x: 100, y: 100, width: 800, height: 600 };
      const bounds = computeWindowBounds(sb, true, preMaxBounds, 420);
      // Should still be exactly the screen bounds
      assert.equal(bounds.width, 1440);
      assert.equal(bounds.height, 875);
    });

    it('falls back to normal mode when preMaximizeBounds is null', () => {
      const sb = { x: 100, y: 100, width: 800, height: 600 };
      // isMaximized=true but preMaximizeBounds=null -> normal computation
      const bounds = computeWindowBounds(sb, true, null, 0);
      assert.equal(bounds.x, 92);
      assert.equal(bounds.y, 56);
    });

    it('rounds screen bounds values', () => {
      const sb = { x: 0.4, y: 24.8, width: 1440.3, height: 875.6 };
      const preMaxBounds = { x: 100, y: 100, width: 800, height: 600 };
      const bounds = computeWindowBounds(sb, true, preMaxBounds, 0);
      assert.equal(bounds.x, 0);
      assert.equal(bounds.y, 25);
      assert.equal(bounds.width, 1440);
      assert.equal(bounds.height, 876);
    });
  });
});

// ===========================================================================
// Tests: maximized element positions
// ===========================================================================

describe('computeMaximizedPositions', () => {
  it('webview fills entire window', () => {
    const { webview } = computeMaximizedPositions(1440, 875, false);
    assert.equal(webview.left, 0);
    assert.equal(webview.top, 0);
    assert.equal(webview.width, 1440);
    assert.equal(webview.height, 875);
  });

  it('navbar floats with margin when maximized', () => {
    const { navbar } = computeMaximizedPositions(1440, 875, true);
    assert.equal(navbar.left, MARGIN);
    assert.equal(navbar.top, MARGIN);
    assert.equal(navbar.width, 1440 - MARGIN * 2);
  });

  it('trigger zone spans full width', () => {
    const { triggerZone } = computeMaximizedPositions(1440, 875, false);
    assert.equal(triggerZone.left, 0);
    assert.equal(triggerZone.top, 0);
    assert.equal(triggerZone.width, 1440);
  });

  it('trigger zone taller when navbar visible', () => {
    const navHidden = computeMaximizedPositions(1440, 875, false);
    const navVisible = computeMaximizedPositions(1440, 875, true);
    assert.ok(navVisible.triggerZone.height > navHidden.triggerZone.height);
    assert.equal(navVisible.triggerZone.height, NAVBAR_HEIGHT + MARGIN + TRIGGER_ZONE_HEIGHT);
    assert.equal(navHidden.triggerZone.height, TRIGGER_ZONE_HEIGHT + MARGIN);
  });
});

// ===========================================================================
// Tests: panel positions — maximized vs normal
// ===========================================================================

describe('computePanelPositionsMaximized', () => {
  it('left panels clamped at MARGIN from left edge', () => {
    const { leftPanelLeft } = computePanelPositionsMaximized(1440, 875, true);
    assert.equal(leftPanelLeft, MARGIN);
  });

  it('right panels clamped so right edge is MARGIN from window right', () => {
    const { rightPanelLeft } = computePanelPositionsMaximized(1440, 875, true);
    assert.equal(rightPanelLeft, 1440 - MARGIN - PANEL_WIDTH);
    // Verify right edge
    assert.equal(rightPanelLeft + PANEL_WIDTH, 1440 - MARGIN);
  });

  it('panel top offset accounts for navbar when visible', () => {
    const visible = computePanelPositionsMaximized(1440, 875, true);
    const hidden = computePanelPositionsMaximized(1440, 875, false);
    assert.equal(visible.panelTopOffset, NAVBAR_HEIGHT + MARGIN + TRIGGER_ZONE_HEIGHT + 40);
    assert.equal(hidden.panelTopOffset, TRIGGER_ZONE_HEIGHT + 40);
  });

  it('works for different window sizes', () => {
    const small = computePanelPositionsMaximized(800, 600, true);
    const large = computePanelPositionsMaximized(2560, 1440, true);
    // Left panels always at MARGIN
    assert.equal(small.leftPanelLeft, MARGIN);
    assert.equal(large.leftPanelLeft, MARGIN);
    // Right panels scale with window width
    assert.equal(small.rightPanelLeft, 800 - MARGIN - PANEL_WIDTH);
    assert.equal(large.rightPanelLeft, 2560 - MARGIN - PANEL_WIDTH);
  });
});

describe('computePanelPositionsNormal vs maximized', () => {
  it('normal left panels overhang beyond window edge', () => {
    const webviewLeft = MARGIN;
    const { leftPanelLeft } = computePanelPositionsNormal(webviewLeft, 800);
    // MARGIN(8) - PANEL_WIDTH(280) + PANEL_OVERLAP(70) = -202
    assert.equal(leftPanelLeft, -202);
    assert.ok(leftPanelLeft < 0, 'left panel extends past window left edge in normal mode');
  });

  it('maximized left panels stay within window', () => {
    const { leftPanelLeft } = computePanelPositionsMaximized(1440, 875, true);
    assert.ok(leftPanelLeft >= 0, 'left panel stays within window in maximized mode');
  });

  it('normal right panels overhang beyond window right edge', () => {
    const webviewLeft = MARGIN;
    const webviewWidth = 800;
    const { rightPanelLeft } = computePanelPositionsNormal(webviewLeft, webviewWidth);
    // MARGIN(8) + 800 - PANEL_OVERLAP(70) = 738
    assert.equal(rightPanelLeft, 738);
    // Panel right edge = 738 + 280 = 1018, but window width = 800 + 16 = 816
    assert.ok(rightPanelLeft + PANEL_WIDTH > webviewWidth + MARGIN * 2, 'right panel extends past window right edge in normal mode');
  });

  it('maximized right panels stay within window', () => {
    const winW = 1440;
    const { rightPanelLeft } = computePanelPositionsMaximized(winW, 875, true);
    assert.ok(rightPanelLeft + PANEL_WIDTH <= winW, 'right panel stays within window in maximized mode');
  });
});

// ===========================================================================
// Tests: maximize toggle state transitions
// ===========================================================================

describe('maximize state transitions', () => {
  it('pre-maximize bounds are preserved for restore', () => {
    const originalBounds = { x: 100, y: 100, width: 800, height: 600 };
    const workArea = { x: 0, y: 25, width: 1440, height: 875 };

    // Simulate maximize
    const preMaximizeBounds = { ...originalBounds };
    const maximizedScreenBounds = { ...workArea };
    const windowBounds = computeWindowBounds(maximizedScreenBounds, true, preMaximizeBounds, 0);

    assert.equal(windowBounds.width, workArea.width);
    assert.equal(windowBounds.height, workArea.height);

    // Simulate restore
    const restoredBounds = computeWindowBounds(originalBounds, false, null, 0);
    assert.equal(restoredBounds.width, originalBounds.width + MARGIN * 2);
    assert.equal(restoredBounds.height, originalBounds.height + TRIGGER_ZONE_HEIGHT + MARGIN + NAVBAR_HEIGHT);
  });

  it('drag-out restore centers on cursor position', () => {
    const preMaxBounds = { x: 100, y: 100, width: 800, height: 600 };
    const cursorScreenX = 500;
    const cursorScreenY = 300;

    // Simulate drag-out restore (from startDrag in page.js)
    const restoredScreenBounds = {
      x: cursorScreenX - preMaxBounds.width / 2,
      y: cursorScreenY,
      width: preMaxBounds.width,
      height: preMaxBounds.height,
    };

    assert.equal(restoredScreenBounds.x, 100); // 500 - 400
    assert.equal(restoredScreenBounds.y, 300);
    assert.equal(restoredScreenBounds.width, 800);
    assert.equal(restoredScreenBounds.height, 600);

    // Window bounds from restored screen bounds
    const windowBounds = computeWindowBounds(restoredScreenBounds, false, null, 0);
    assert.equal(windowBounds.x, 100 - MARGIN);
    assert.equal(windowBounds.y, 300 - TRIGGER_ZONE_HEIGHT - NAVBAR_HEIGHT);
  });
});
