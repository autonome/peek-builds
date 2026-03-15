/**
 * Unit tests for group mode scoping and visual indicator
 *
 * Tests extracted pure functions from backend/electron/ipc.ts:
 * - resolveGroupBorderColor: vivid color selection for screen border
 * - shouldAutoTagForGroup: group mode detection (no lastFocusedVisible fallback)
 * - shouldInheritGroupMode: window lineage-based group mode inheritance
 *
 * These are logic-only tests — no DOM, no Electron, no IPC runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// resolveGroupBorderColor (from backend/electron/ipc.ts)
// ============================================================================

const VIVID_GROUP_COLORS = [
  '#ff3b30', // red
  '#ff9500', // orange
  '#34c759', // green
  '#007aff', // blue
  '#af52de', // purple
  '#5ac8fa', // cyan
  '#ff2d55', // pink
  '#ff9f0a', // amber
];

function resolveGroupBorderColor(color: string | undefined, groupId: string | undefined): string {
  if (color && color !== '#999' && color !== '#999999') {
    const hex = color.replace('#', '');
    if (hex.length >= 6) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const chroma = max - min;
      if (chroma > 40) return color;
    }
  }
  if (groupId) {
    let hash = 0;
    for (let i = 0; i < groupId.length; i++) {
      hash = ((hash << 5) - hash + groupId.charCodeAt(i)) | 0;
    }
    return VIVID_GROUP_COLORS[Math.abs(hash) % VIVID_GROUP_COLORS.length];
  }
  return '#007aff';
}

// ============================================================================
// shouldAutoTagForGroup (extracted from autoTagIfGroupMode in ipc.ts)
// ============================================================================
// Pure logic: only the calling window's own mode determines tagging.
// No fallback to lastFocusedVisibleWindowId.

interface ContextEntry {
  value: string;
  metadata?: Record<string, unknown>;
}

function shouldAutoTagForGroup(
  callerMode: ContextEntry | null,
  _lastFocusedVisibleMode: ContextEntry | null, // intentionally ignored
): { tag: boolean; groupId?: string } {
  if (callerMode && callerMode.value === 'group' && callerMode.metadata?.groupId) {
    return { tag: true, groupId: callerMode.metadata.groupId as string };
  }
  // No fallback — lastFocusedVisibleMode is ignored to prevent group leakage
  return { tag: false };
}

// ============================================================================
// shouldInheritGroupMode (extracted from window-open handler in ipc.ts)
// ============================================================================
// Pure logic: group mode inherits only through explicit option or opener lineage.
// No fallback to lastFocusedVisibleWindowId.

interface GroupModeOption {
  groupId: string;
  groupName: string;
  color: string;
}

interface InheritResult {
  mode: string;
  metadata: Record<string, unknown>;
}

function shouldInheritGroupMode(
  explicitGroupMode: GroupModeOption | undefined,
  openerMode: ContextEntry | null,
  _lastFocusedVisibleMode: ContextEntry | null, // intentionally ignored
  detectedModeFromUrl: string,
  url: string,
): InheritResult {
  if (explicitGroupMode) {
    return {
      mode: 'group',
      metadata: { ...explicitGroupMode, url },
    };
  }
  if (openerMode && openerMode.value === 'group' && openerMode.metadata) {
    return {
      mode: 'group',
      metadata: { ...openerMode.metadata, url, inheritedFrom: 'opener' },
    };
  }
  // No lastFocusedVisibleWindowId fallback
  return {
    mode: detectedModeFromUrl,
    metadata: { url },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveGroupBorderColor', () => {
  it('uses vivid group color directly when saturated', () => {
    assert.strictEqual(resolveGroupBorderColor('#ff3b30', 'group-1'), '#ff3b30');
    assert.strictEqual(resolveGroupBorderColor('#007aff', 'group-1'), '#007aff');
    assert.strictEqual(resolveGroupBorderColor('#34c759', 'group-1'), '#34c759');
    assert.strictEqual(resolveGroupBorderColor('#af52de', 'group-1'), '#af52de');
  });

  it('rejects grey #999 and picks vivid fallback', () => {
    const result = resolveGroupBorderColor('#999', 'group-1');
    assert.ok(VIVID_GROUP_COLORS.includes(result), `Expected vivid color, got ${result}`);
  });

  it('rejects grey #999999 and picks vivid fallback', () => {
    const result = resolveGroupBorderColor('#999999', 'group-1');
    assert.ok(VIVID_GROUP_COLORS.includes(result), `Expected vivid color, got ${result}`);
  });

  it('rejects low-chroma colors (near-white, near-grey)', () => {
    // #cccccc has chroma 0
    const result1 = resolveGroupBorderColor('#cccccc', 'group-1');
    assert.ok(VIVID_GROUP_COLORS.includes(result1), `#cccccc should be rejected, got ${result1}`);

    // #808080 has chroma 0
    const result2 = resolveGroupBorderColor('#808080', 'group-2');
    assert.ok(VIVID_GROUP_COLORS.includes(result2), `#808080 should be rejected, got ${result2}`);

    // #c0b8b0 has chroma 16 (below 40 threshold)
    const result3 = resolveGroupBorderColor('#c0b8b0', 'group-3');
    assert.ok(VIVID_GROUP_COLORS.includes(result3), `#c0b8b0 should be rejected, got ${result3}`);
  });

  it('accepts colors with sufficient chroma (> 40)', () => {
    // #ff0000 red — chroma 255
    assert.strictEqual(resolveGroupBorderColor('#ff0000', 'g'), '#ff0000');
    // #3366cc — chroma = 0xcc - 0x33 = 153
    assert.strictEqual(resolveGroupBorderColor('#3366cc', 'g'), '#3366cc');
    // Borderline: chroma exactly 41 (e.g. #50793c → max=0x79=121, min=0x3c=60, chroma=61)
    assert.strictEqual(resolveGroupBorderColor('#50793c', 'g'), '#50793c');
  });

  it('returns deterministic color for same groupId', () => {
    const color1 = resolveGroupBorderColor(undefined, 'my-project');
    const color2 = resolveGroupBorderColor(undefined, 'my-project');
    assert.strictEqual(color1, color2);
  });

  it('returns different colors for different groupIds (usually)', () => {
    const results = new Set<string>();
    for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      results.add(resolveGroupBorderColor(undefined, id));
    }
    // With 6 IDs and 8 colors, we should get at least 2 distinct colors
    assert.ok(results.size >= 2, `Expected variety, got ${results.size} unique colors`);
  });

  it('all fallback colors are from VIVID_GROUP_COLORS palette', () => {
    for (const id of ['a', 'b', 'c', 'test', 'work', 'research', 'project-x', 'foo-bar-baz']) {
      const color = resolveGroupBorderColor(undefined, id);
      assert.ok(VIVID_GROUP_COLORS.includes(color), `${id} → ${color} not in palette`);
    }
  });

  it('returns default blue when no color and no groupId', () => {
    assert.strictEqual(resolveGroupBorderColor(undefined, undefined), '#007aff');
  });

  it('handles short hex strings gracefully', () => {
    // 3-char hex can't be parsed as 6-char, falls through to groupId hash
    const result = resolveGroupBorderColor('#f00', 'group-1');
    assert.ok(VIVID_GROUP_COLORS.includes(result), `Short hex should fall back, got ${result}`);
  });
});

describe('shouldAutoTagForGroup (group leakage prevention)', () => {
  const groupMode: ContextEntry = {
    value: 'group',
    metadata: { groupId: 'tag-123', groupName: 'Research' },
  };
  const defaultMode: ContextEntry = { value: 'default', metadata: {} };
  const pageMode: ContextEntry = { value: 'page', metadata: {} };

  it('tags when calling window is in group mode', () => {
    const result = shouldAutoTagForGroup(groupMode, null);
    assert.strictEqual(result.tag, true);
    assert.strictEqual(result.groupId, 'tag-123');
  });

  it('does NOT tag when calling window is in default mode', () => {
    const result = shouldAutoTagForGroup(defaultMode, null);
    assert.strictEqual(result.tag, false);
  });

  it('does NOT tag when calling window is in page mode', () => {
    const result = shouldAutoTagForGroup(pageMode, null);
    assert.strictEqual(result.tag, false);
  });

  it('does NOT tag when calling window has no context', () => {
    const result = shouldAutoTagForGroup(null, null);
    assert.strictEqual(result.tag, false);
  });

  // Critical: group leakage prevention tests
  it('does NOT fall back to lastFocusedVisible even if it has group mode', () => {
    const result = shouldAutoTagForGroup(null, groupMode);
    assert.strictEqual(result.tag, false, 'Should NOT tag via lastFocusedVisible fallback');
  });

  it('does NOT fall back to lastFocusedVisible when caller is in default mode', () => {
    const result = shouldAutoTagForGroup(defaultMode, groupMode);
    assert.strictEqual(result.tag, false, 'Should NOT tag via lastFocusedVisible fallback');
  });

  it('does NOT fall back to lastFocusedVisible when caller is in page mode', () => {
    const result = shouldAutoTagForGroup(pageMode, groupMode);
    assert.strictEqual(result.tag, false, 'Should NOT tag via lastFocusedVisible fallback');
  });

  it('does NOT tag when group mode has no groupId', () => {
    const broken: ContextEntry = { value: 'group', metadata: {} };
    const result = shouldAutoTagForGroup(broken, null);
    assert.strictEqual(result.tag, false);
  });
});

describe('shouldInheritGroupMode (window lineage scoping)', () => {
  const explicitGroup: GroupModeOption = {
    groupId: 'tag-abc',
    groupName: 'Work',
    color: '#ff3b30',
  };
  const openerGroupContext: ContextEntry = {
    value: 'group',
    metadata: { groupId: 'tag-abc', groupName: 'Work', color: '#ff3b30' },
  };
  const lastFocusedGroupContext: ContextEntry = {
    value: 'group',
    metadata: { groupId: 'tag-xyz', groupName: 'Side Project', color: '#007aff' },
  };
  const openerDefaultContext: ContextEntry = { value: 'default', metadata: {} };

  it('inherits group mode from explicit option', () => {
    const result = shouldInheritGroupMode(explicitGroup, null, null, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'group');
    assert.strictEqual(result.metadata.groupId, 'tag-abc');
    assert.strictEqual(result.metadata.groupName, 'Work');
  });

  it('inherits group mode from opener window lineage', () => {
    const result = shouldInheritGroupMode(undefined, openerGroupContext, null, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'group');
    assert.strictEqual(result.metadata.groupId, 'tag-abc');
    assert.strictEqual(result.metadata.inheritedFrom, 'opener');
  });

  it('explicit option takes precedence over opener', () => {
    const differentGroup: GroupModeOption = {
      groupId: 'tag-other',
      groupName: 'Other',
      color: '#34c759',
    };
    const result = shouldInheritGroupMode(differentGroup, openerGroupContext, null, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'group');
    assert.strictEqual(result.metadata.groupId, 'tag-other');
  });

  // Critical: no lastFocusedVisible fallback
  it('does NOT inherit from lastFocusedVisible when no opener', () => {
    const result = shouldInheritGroupMode(undefined, null, lastFocusedGroupContext, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'page', 'Should NOT inherit group from lastFocusedVisible');
    assert.strictEqual(result.metadata.groupId, undefined);
  });

  it('does NOT inherit from lastFocusedVisible when opener is in default mode', () => {
    const result = shouldInheritGroupMode(undefined, openerDefaultContext, lastFocusedGroupContext, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'page', 'Should NOT inherit group from lastFocusedVisible');
  });

  it('uses detected mode from URL when no group inheritance', () => {
    const result = shouldInheritGroupMode(undefined, null, null, 'page', 'https://example.com');
    assert.strictEqual(result.mode, 'page');
    assert.deepStrictEqual(result.metadata, { url: 'https://example.com' });
  });

  it('uses detected mode from URL when opener has no context', () => {
    const result = shouldInheritGroupMode(undefined, null, null, 'default', 'peek://app/settings.html');
    assert.strictEqual(result.mode, 'default');
  });

  it('preserves URL in metadata for all inheritance paths', () => {
    const url = 'https://example.com/page';

    const r1 = shouldInheritGroupMode(explicitGroup, null, null, 'page', url);
    assert.strictEqual(r1.metadata.url, url);

    const r2 = shouldInheritGroupMode(undefined, openerGroupContext, null, 'page', url);
    assert.strictEqual(r2.metadata.url, url);

    const r3 = shouldInheritGroupMode(undefined, null, null, 'page', url);
    assert.strictEqual(r3.metadata.url, url);
  });
});

describe('group screen border visibility (debounced hide)', () => {
  // Tests the logic of the debounced hide behavior.
  // The screen border should remain visible during navigation transitions
  // where group mode is briefly absent.

  interface WindowState {
    id: number;
    mode: string;
    destroyed: boolean;
  }

  function computeBorderAction(
    windows: WindowState[],
  ): 'show' | 'debounce-hide' {
    const liveGroupWindows = windows.filter(w => !w.destroyed && w.mode === 'group');
    return liveGroupWindows.length > 0 ? 'show' : 'debounce-hide';
  }

  it('shows border when any window is in group mode', () => {
    const windows: WindowState[] = [
      { id: 1, mode: 'group', destroyed: false },
      { id: 2, mode: 'default', destroyed: false },
    ];
    assert.strictEqual(computeBorderAction(windows), 'show');
  });

  it('debounce-hides when no windows are in group mode', () => {
    const windows: WindowState[] = [
      { id: 1, mode: 'default', destroyed: false },
      { id: 2, mode: 'page', destroyed: false },
    ];
    assert.strictEqual(computeBorderAction(windows), 'debounce-hide');
  });

  it('ignores destroyed windows when checking group mode', () => {
    const windows: WindowState[] = [
      { id: 1, mode: 'group', destroyed: true },
      { id: 2, mode: 'default', destroyed: false },
    ];
    assert.strictEqual(computeBorderAction(windows), 'debounce-hide');
  });

  it('debounce-hides when no windows exist', () => {
    assert.strictEqual(computeBorderAction([]), 'debounce-hide');
  });

  it('shows when multiple group windows exist', () => {
    const windows: WindowState[] = [
      { id: 1, mode: 'group', destroyed: false },
      { id: 2, mode: 'group', destroyed: false },
    ];
    assert.strictEqual(computeBorderAction(windows), 'show');
  });

  it('shows as long as one live group window remains', () => {
    const windows: WindowState[] = [
      { id: 1, mode: 'group', destroyed: true },
      { id: 2, mode: 'group', destroyed: false },
      { id: 3, mode: 'default', destroyed: false },
    ];
    assert.strictEqual(computeBorderAction(windows), 'show');
  });
});
