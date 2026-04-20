/**
 * Unit tests for space mode scoping, machine tags, and visual indicators
 *
 * Tests extracted pure functions from:
 * - features/spaces/config.js: isSpaceTag, getSpaceDisplayName, toSpaceTagName
 * - backend/electron/datastore.ts: updateModeForNavigation (space preservation)
 * - backend/electron/ipc.ts: auto-tagging decision logic
 * - Screen border visibility for space mode
 *
 * These are logic-only tests — no DOM, no Electron, no IPC runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// Machine tag utilities (from features/spaces/config.js)
// ============================================================================

const SPACE_TAG_PREFIX = 'space:';

const isSpaceTag = (name: unknown): boolean => {
  return typeof name === 'string' && name.startsWith(SPACE_TAG_PREFIX);
};

const getSpaceDisplayName = (tag: { name: string; metadata?: unknown }): string => {
  if (tag.metadata) {
    const meta = typeof tag.metadata === 'object' ? tag.metadata as Record<string, unknown> : (() => { try { return JSON.parse(tag.metadata as string); } catch { return {}; } })();
    if (meta && (meta as Record<string, unknown>).displayName) return (meta as Record<string, unknown>).displayName as string;
  }
  if (isSpaceTag(tag.name)) {
    return tag.name.slice(SPACE_TAG_PREFIX.length);
  }
  return tag.name;
};

const toSpaceTagName = (name: string): string => {
  if (name.startsWith(SPACE_TAG_PREFIX)) return name;
  return SPACE_TAG_PREFIX + name;
};

// ============================================================================
// Auto-tagging decision logic (extracted from spaces/background.js)
// ============================================================================

function shouldAutoTagForSpace(context: {
  windowMode: string | null;
  windowSpaceId: string | null;
  hasWindowId: boolean;
}): { tag: boolean; spaceId?: string } {
  // No window ID → can't determine context
  if (!context.hasWindowId) return { tag: false };
  // Only tag when window is in space mode with a valid spaceId
  if (context.windowMode === 'space' && context.windowSpaceId) {
    return { tag: true, spaceId: context.windowSpaceId };
  }
  return { tag: false };
}

// ============================================================================
// Mode preservation logic (extracted from updateModeForNavigation in datastore.ts)
// ============================================================================

type MajorModeId = 'page' | 'space' | 'default';

function detectModeFromUrl(url: string): MajorModeId {
  if (!url) return 'default';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'page';
  return 'default';
}

function shouldPreserveMode(currentMode: string, detectedMode: string): boolean {
  // Space mode persists through navigation — don't override with page or default
  return currentMode === 'space' && (detectedMode === 'page' || detectedMode === 'default');
}

// ============================================================================
// Screen border visibility (space mode variant of group-mode.test.ts)
// ============================================================================

const VIVID_SPACE_COLORS = [
  '#ff3b30', '#ff9500', '#34c759', '#007aff',
  '#af52de', '#5ac8fa', '#ff2d55', '#ff9f0a',
];

function resolveSpaceBorderColor(color: string | undefined, spaceId: string | undefined): string {
  if (color && color !== '#999' && color !== '#999999') {
    const hex = color.replace('#', '');
    if (hex.length >= 6) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 40) return color;
    }
  }
  if (spaceId) {
    let hash = 0;
    for (let i = 0; i < spaceId.length; i++) {
      hash = ((hash << 5) - hash + spaceId.charCodeAt(i)) | 0;
    }
    return VIVID_SPACE_COLORS[Math.abs(hash) % VIVID_SPACE_COLORS.length];
  }
  return '#007aff';
}

function shouldShowSpaceBorder(context: {
  focusedWindowId: number | null;
  appFocused: boolean;
  focusedWindowMode: string | null;
  focusedWindowMetadata: Record<string, unknown> | null;
}): { show: boolean; color?: string; name?: string } {
  if (!context.focusedWindowId) return { show: false };
  if (!context.appFocused) return { show: false };
  if (
    context.focusedWindowMode === 'space' &&
    context.focusedWindowMetadata?.spaceId
  ) {
    const rawColor = context.focusedWindowMetadata.color as string | undefined;
    const spaceId = context.focusedWindowMetadata.spaceId as string | undefined;
    const color = resolveSpaceBorderColor(rawColor, spaceId);
    const name = (context.focusedWindowMetadata.spaceName as string) || 'Space';
    return { show: true, color, name };
  }
  return { show: false };
}

// ============================================================================
// Tests
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Machine tag utilities
// ---------------------------------------------------------------------------

describe('isSpaceTag', () => {
  it('returns true for "space:research"', () => {
    assert.strictEqual(isSpaceTag('space:research'), true);
  });

  it('returns true for "space:work"', () => {
    assert.strictEqual(isSpaceTag('space:work'), true);
  });

  it('returns true for "space:" (empty name edge case)', () => {
    assert.strictEqual(isSpaceTag('space:'), true);
  });

  it('returns false for "research" (no prefix)', () => {
    assert.strictEqual(isSpaceTag('research'), false);
  });

  it('returns false for "spaceship" (not a prefix match)', () => {
    assert.strictEqual(isSpaceTag('spaceship'), false);
  });

  it('returns false for "myspace:foo" (wrong prefix)', () => {
    assert.strictEqual(isSpaceTag('myspace:foo'), false);
  });

  it('returns false for empty string', () => {
    assert.strictEqual(isSpaceTag(''), false);
  });

  it('returns false for null', () => {
    assert.strictEqual(isSpaceTag(null), false);
  });

  it('returns false for undefined', () => {
    assert.strictEqual(isSpaceTag(undefined), false);
  });
});

describe('getSpaceDisplayName', () => {
  it('uses displayName from metadata object', () => {
    const tag = { name: 'space:work', metadata: { displayName: 'Work' } };
    assert.strictEqual(getSpaceDisplayName(tag), 'Work');
  });

  it('strips prefix when no displayName, name is "space:research"', () => {
    const tag = { name: 'space:research' };
    assert.strictEqual(getSpaceDisplayName(tag), 'research');
  });

  it('strips prefix when displayName is empty string', () => {
    const tag = { name: 'space:projects', metadata: { displayName: '' } };
    assert.strictEqual(getSpaceDisplayName(tag), 'projects');
  });

  it('parses metadata from JSON string', () => {
    const tag = { name: 'space:dev', metadata: '{"displayName":"Development"}' };
    assert.strictEqual(getSpaceDisplayName(tag), 'Development');
  });

  it('handles invalid JSON metadata gracefully', () => {
    const tag = { name: 'space:broken', metadata: '{invalid' };
    assert.strictEqual(getSpaceDisplayName(tag), 'broken');
  });

  it('returns tag name as-is for non-space tags with no displayName', () => {
    const tag = { name: 'regular-tag', metadata: {} };
    assert.strictEqual(getSpaceDisplayName(tag), 'regular-tag');
  });

  it('returns tag name when metadata is null', () => {
    const tag = { name: 'space:test', metadata: null };
    assert.strictEqual(getSpaceDisplayName(tag), 'test');
  });
});

describe('toSpaceTagName', () => {
  it('adds prefix to plain name', () => {
    assert.strictEqual(toSpaceTagName('research'), 'space:research');
  });

  it('is idempotent — does not double-prefix', () => {
    assert.strictEqual(toSpaceTagName('space:research'), 'space:research');
  });

  it('handles names with spaces', () => {
    assert.strictEqual(toSpaceTagName('Work Projects'), 'space:Work Projects');
  });
});

// ---------------------------------------------------------------------------
// 2. Auto-tagging decision logic
// ---------------------------------------------------------------------------

describe('shouldAutoTagForSpace', () => {
  it('tags when window is in space mode with spaceId', () => {
    const result = shouldAutoTagForSpace({
      windowMode: 'space',
      windowSpaceId: 'tag-123',
      hasWindowId: true,
    });
    assert.strictEqual(result.tag, true);
    assert.strictEqual(result.spaceId, 'tag-123');
  });

  it('does not tag when window is in page mode', () => {
    const result = shouldAutoTagForSpace({
      windowMode: 'page',
      windowSpaceId: null,
      hasWindowId: true,
    });
    assert.strictEqual(result.tag, false);
  });

  it('does not tag when window is in default mode', () => {
    const result = shouldAutoTagForSpace({
      windowMode: 'default',
      windowSpaceId: null,
      hasWindowId: true,
    });
    assert.strictEqual(result.tag, false);
  });

  it('does not tag when no windowId (null)', () => {
    const result = shouldAutoTagForSpace({
      windowMode: 'space',
      windowSpaceId: 'tag-123',
      hasWindowId: false,
    });
    assert.strictEqual(result.tag, false);
  });

  it('does not tag when window is in space mode but no spaceId', () => {
    const result = shouldAutoTagForSpace({
      windowMode: 'space',
      windowSpaceId: null,
      hasWindowId: true,
    });
    assert.strictEqual(result.tag, false);
  });
});

// ---------------------------------------------------------------------------
// 3. updateModeForNavigation preserves space mode
// ---------------------------------------------------------------------------

describe('shouldPreserveMode (space mode navigation preservation)', () => {
  it('preserves when current is "space" and detected is "page"', () => {
    assert.strictEqual(shouldPreserveMode('space', 'page'), true);
  });

  it('preserves when current is "space" and detected is "default"', () => {
    assert.strictEqual(shouldPreserveMode('space', 'default'), true);
  });

  it('does not preserve when current is "page" and detected is "default"', () => {
    assert.strictEqual(shouldPreserveMode('page', 'default'), false);
  });

  it('does not preserve when current is "default" and detected is "page"', () => {
    assert.strictEqual(shouldPreserveMode('default', 'page'), false);
  });

  it('no change needed when both are "space"', () => {
    // space → space is not a preservation case (no override happening)
    assert.strictEqual(shouldPreserveMode('space', 'space'), false);
  });
});

describe('detectModeFromUrl (used by updateModeForNavigation)', () => {
  it('detects "page" for http URLs', () => {
    assert.strictEqual(detectModeFromUrl('http://example.com'), 'page');
  });

  it('detects "page" for https URLs', () => {
    assert.strictEqual(detectModeFromUrl('https://example.com'), 'page');
  });

  it('detects "default" for peek:// URLs', () => {
    assert.strictEqual(detectModeFromUrl('peek://spaces/home.html'), 'default');
  });

  it('detects "default" for empty string', () => {
    assert.strictEqual(detectModeFromUrl(''), 'default');
  });
});

// ---------------------------------------------------------------------------
// 4. Screen border visibility for space mode
// ---------------------------------------------------------------------------

describe('shouldShowSpaceBorder', () => {
  it('shows border when focused window is in space mode with spaceId', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'space',
      focusedWindowMetadata: { spaceId: 'tag-123', spaceName: 'Research', color: '#ff3b30' },
    });
    assert.strictEqual(result.show, true);
    assert.strictEqual(result.color, '#ff3b30');
    assert.strictEqual(result.name, 'Research');
  });

  it('hides border when app is not focused', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: false,
      focusedWindowMode: 'space',
      focusedWindowMetadata: { spaceId: 'tag-123', spaceName: 'Research' },
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when no focused window', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: null,
      appFocused: true,
      focusedWindowMode: null,
      focusedWindowMetadata: null,
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is in default mode', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is in page mode', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'page',
      focusedWindowMetadata: { url: 'https://example.com' },
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when space mode but no spaceId in metadata', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'space',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(result.show, false);
  });

  it('defaults name to "Space" when spaceName missing from metadata', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'space',
      focusedWindowMetadata: { spaceId: 'tag-abc' },
    });
    assert.strictEqual(result.show, true);
    assert.strictEqual(result.name, 'Space');
  });

  it('resolves vivid color when space color is too pale', () => {
    const result = shouldShowSpaceBorder({
      focusedWindowId: 1,
      appFocused: true,
      focusedWindowMode: 'space',
      focusedWindowMetadata: { spaceId: 'tag-abc', spaceName: 'Grey Space', color: '#999999' },
    });
    assert.strictEqual(result.show, true);
    assert.ok(VIVID_SPACE_COLORS.includes(result.color!), `Expected vivid color, got ${result.color}`);
  });

  it('modal window unchanged (transparent) — border only for space windows', () => {
    // A modal window won't have space mode, so border stays hidden
    const result = shouldShowSpaceBorder({
      focusedWindowId: 99,
      appFocused: true,
      focusedWindowMode: null,
      focusedWindowMetadata: null,
    });
    assert.strictEqual(result.show, false);
  });
});
