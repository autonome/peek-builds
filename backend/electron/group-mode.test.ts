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

describe('group screen border visibility (focus-based)', () => {
  // Tests the focus-based border visibility logic.
  // The border is a per-focused-window indicator:
  //   visible IFF the focused visible window has context.mode = 'group'
  // See features/groups/group-screen-border-spec.md

  /**
   * Pure decision function extracted from updateGroupScreenBorder() in ipc.ts.
   * Determines whether the group screen border should be shown based on
   * the currently focused window's state.
   */
  function shouldShowGroupBorder(context: {
    focusedWindowId: number | null;
    focusedWindowDestroyed: boolean;
    focusedWindowMode: string | null;
    focusedWindowMetadata: Record<string, unknown> | null;
    isModal?: boolean;
  }): { show: boolean; unchanged?: boolean; color?: string; name?: string } {
    // No focused window → hide
    if (!context.focusedWindowId) {
      return { show: false };
    }
    // Focused window destroyed → hide
    if (context.focusedWindowDestroyed) {
      return { show: false };
    }
    // Modal/transient windows (cmd palette, etc.) are "transparent" to border state —
    // focusing a modal does not change the border, preventing constant flicker during group work
    if (context.isModal) {
      return { show: false, unchanged: true };
    }
    // Focused window in group mode with valid groupId → show
    if (
      context.focusedWindowMode === 'group' &&
      context.focusedWindowMetadata?.groupId
    ) {
      const rawColor = context.focusedWindowMetadata.color as string | undefined;
      const groupId = context.focusedWindowMetadata.groupId as string | undefined;
      const color = resolveGroupBorderColor(rawColor, groupId);
      const name = (context.focusedWindowMetadata.groupName as string) || 'group';
      return { show: true, color, name };
    }
    // Otherwise → hide
    return { show: false };
  }

  it('shows border when focused window is in group mode with valid groupId', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123', groupName: 'Research', color: '#ff3b30' },
    });
    assert.strictEqual(result.show, true);
    assert.strictEqual(result.color, '#ff3b30');
    assert.strictEqual(result.name, 'Research');
  });

  it('hides border when focused window is in default mode', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is in page mode', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'page',
      focusedWindowMetadata: { url: 'https://example.com' },
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when no focused window exists', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: null,
      focusedWindowDestroyed: false,
      focusedWindowMode: null,
      focusedWindowMetadata: null,
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is destroyed', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: true,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123' },
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is group mode but no groupId in metadata', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(result.show, false);
  });

  it('hides border when focused window is group mode with null metadata', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: null,
    });
    assert.strictEqual(result.show, false);
  });

  it('uses group name from metadata', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-abc', groupName: 'Work', color: '#007aff' },
    });
    assert.strictEqual(result.show, true);
    assert.strictEqual(result.name, 'Work');
  });

  it('defaults group name to "group" when not in metadata', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-abc' },
    });
    assert.strictEqual(result.show, true);
    assert.strictEqual(result.name, 'group');
  });

  it('resolves vivid color when group color is too pale', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-abc', groupName: 'Grey Group', color: '#999999' },
    });
    assert.strictEqual(result.show, true);
    assert.ok(VIVID_GROUP_COLORS.includes(result.color!), `Expected vivid color, got ${result.color}`);
  });

  // Scenario tests simulating focus transitions
  it('focus changes from group window to non-group window → hide', () => {
    // First: group window focused → show
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123', groupName: 'Research' },
    });
    assert.strictEqual(r1.show, true);

    // Then: non-group window focused → hide
    const r2 = shouldShowGroupBorder({
      focusedWindowId: 2,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(r2.show, false);
  });

  it('focus changes from non-group window to group window → show', () => {
    // First: non-group window focused → hide
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'page',
      focusedWindowMetadata: { url: 'https://example.com' },
    });
    assert.strictEqual(r1.show, false);

    // Then: group window focused → show
    const r2 = shouldShowGroupBorder({
      focusedWindowId: 2,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-456', groupName: 'Work', color: '#34c759' },
    });
    assert.strictEqual(r2.show, true);
    assert.strictEqual(r2.color, '#34c759');
  });

  it('mode changes on focused window from group → default → hide', () => {
    // Initially in group mode
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123', groupName: 'Research' },
    });
    assert.strictEqual(r1.show, true);

    // Mode changed to default (e.g., navigated back to groups list)
    const r2 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(r2.show, false);
  });

  it('mode changes on focused window from default → group → show', () => {
    // Initially in default mode
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(r1.show, false);

    // Mode changed to group (e.g., opened a group address)
    const r2 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-789', groupName: 'Project', color: '#af52de' },
    });
    assert.strictEqual(r2.show, true);
    assert.strictEqual(r2.name, 'Project');
  });

  // Modal window exemption — cmd palette and other modals are "transparent" to border state
  it('modal window (cmd palette) does not change border state', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 99,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
      isModal: true,
    });
    assert.strictEqual(result.unchanged, true);
  });

  it('modal window in group mode still treated as transparent', () => {
    const result = shouldShowGroupBorder({
      focusedWindowId: 99,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123' },
      isModal: true,
    });
    assert.strictEqual(result.unchanged, true);
  });

  it('border stays visible through group → modal → group focus sequence', () => {
    // Group window focused → show
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123', groupName: 'Work', color: '#ff3b30' },
    });
    assert.strictEqual(r1.show, true);

    // Cmd palette opens → unchanged (border stays visible)
    const r2 = shouldShowGroupBorder({
      focusedWindowId: 99,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
      isModal: true,
    });
    assert.strictEqual(r2.unchanged, true);

    // Cmd palette closes, group window regains focus → show
    const r3 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-123', groupName: 'Work', color: '#ff3b30' },
    });
    assert.strictEqual(r3.show, true);
  });

  it('switching between two different groups updates color and name', () => {
    const r1 = shouldShowGroupBorder({
      focusedWindowId: 1,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-a', groupName: 'Alpha', color: '#ff3b30' },
    });
    assert.strictEqual(r1.show, true);
    assert.strictEqual(r1.color, '#ff3b30');
    assert.strictEqual(r1.name, 'Alpha');

    const r2 = shouldShowGroupBorder({
      focusedWindowId: 2,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'group',
      focusedWindowMetadata: { groupId: 'tag-b', groupName: 'Beta', color: '#007aff' },
    });
    assert.strictEqual(r2.show, true);
    assert.strictEqual(r2.color, '#007aff');
    assert.strictEqual(r2.name, 'Beta');
  });

  it('non-group windows do NOT cause border to show even if other group windows exist', () => {
    // The decision is purely about the FOCUSED window, not about what other windows exist
    const result = shouldShowGroupBorder({
      focusedWindowId: 3,
      focusedWindowDestroyed: false,
      focusedWindowMode: 'default',
      focusedWindowMetadata: {},
    });
    assert.strictEqual(result.show, false);
  });
});
