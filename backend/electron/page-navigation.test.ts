/**
 * Unit tests for pagestream keyboard navigation guard logic
 *
 * Tests extracted pure function from app/page/page.js:
 * - shouldHandleNavKey: determines whether j/k/g/G/Arrow/Home/End keys
 *   should be intercepted for pagestream navigation, or passed through
 *   when the user is typing in an input field, navbar, or widget container.
 *
 * These are logic-only tests -- no DOM, no Electron, no IPC runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// shouldHandleNavKey (extracted from app/page/page.js keydown listener)
// ============================================================================

const NAV_MAP: Record<string, string> = {
  'j': 'down', 'ArrowDown': 'down',
  'k': 'up', 'ArrowUp': 'up',
  'g': 'first', 'Home': 'first',
  'G': 'last', 'End': 'last',
};

interface NavKeyContext {
  activeElement: { tagName: string; isContentEditable: boolean } | null;
  isInNavbar: boolean;
  isInWidgetContainer: boolean;
}

function shouldHandleNavKey(key: string, context: NavKeyContext): { handled: boolean; action?: string } {
  // Don't intercept if typing in navbar
  if (context.isInNavbar) return { handled: false };

  // Don't intercept if typing in any input, textarea, or contenteditable element
  const active = context.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
    return { handled: false };
  }
  if (active && context.isInWidgetContainer) return { handled: false };

  const action = NAV_MAP[key];
  if (action) {
    return { handled: true, action };
  }

  return { handled: false };
}

// ============================================================================
// Tests
// ============================================================================

const defaultContext: NavKeyContext = {
  activeElement: { tagName: 'DIV', isContentEditable: false },
  isInNavbar: false,
  isInWidgetContainer: false,
};

const nullActiveContext: NavKeyContext = {
  activeElement: null,
  isInNavbar: false,
  isInWidgetContainer: false,
};

describe('shouldHandleNavKey — basic key mapping', () => {
  it('k maps to up when no input is focused', () => {
    const result = shouldHandleNavKey('k', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'up');
  });

  it('j maps to down when no input is focused', () => {
    const result = shouldHandleNavKey('j', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'down');
  });

  it('g maps to first', () => {
    const result = shouldHandleNavKey('g', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'first');
  });

  it('G maps to last', () => {
    const result = shouldHandleNavKey('G', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'last');
  });

  it('ArrowDown maps to down', () => {
    const result = shouldHandleNavKey('ArrowDown', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'down');
  });

  it('ArrowUp maps to up', () => {
    const result = shouldHandleNavKey('ArrowUp', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'up');
  });

  it('Home maps to first', () => {
    const result = shouldHandleNavKey('Home', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'first');
  });

  it('End maps to last', () => {
    const result = shouldHandleNavKey('End', defaultContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'last');
  });

  it('works when activeElement is null', () => {
    const result = shouldHandleNavKey('j', nullActiveContext);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.action, 'down');
  });
});

describe('shouldHandleNavKey — non-nav keys are never handled', () => {
  for (const key of ['a', 'b', 'Enter', 'Escape', ' ', 'Tab', '1', 'Shift']) {
    it(`"${key}" is not handled`, () => {
      const result = shouldHandleNavKey(key, defaultContext);
      assert.strictEqual(result.handled, false);
      assert.strictEqual(result.action, undefined);
    });
  }
});

describe('shouldHandleNavKey — INPUT guard', () => {
  const inputContext: NavKeyContext = {
    activeElement: { tagName: 'INPUT', isContentEditable: false },
    isInNavbar: false,
    isInWidgetContainer: false,
  };

  it('k is NOT handled when activeElement is INPUT', () => {
    assert.strictEqual(shouldHandleNavKey('k', inputContext).handled, false);
  });

  it('j is NOT handled when activeElement is INPUT', () => {
    assert.strictEqual(shouldHandleNavKey('j', inputContext).handled, false);
  });

  it('ArrowDown is NOT handled when activeElement is INPUT', () => {
    assert.strictEqual(shouldHandleNavKey('ArrowDown', inputContext).handled, false);
  });
});

describe('shouldHandleNavKey — TEXTAREA guard', () => {
  const textareaContext: NavKeyContext = {
    activeElement: { tagName: 'TEXTAREA', isContentEditable: false },
    isInNavbar: false,
    isInWidgetContainer: false,
  };

  it('j is NOT handled when activeElement is TEXTAREA', () => {
    assert.strictEqual(shouldHandleNavKey('j', textareaContext).handled, false);
  });

  it('G is NOT handled when activeElement is TEXTAREA', () => {
    assert.strictEqual(shouldHandleNavKey('G', textareaContext).handled, false);
  });
});

describe('shouldHandleNavKey — contentEditable guard', () => {
  const editableContext: NavKeyContext = {
    activeElement: { tagName: 'DIV', isContentEditable: true },
    isInNavbar: false,
    isInWidgetContainer: false,
  };

  it('g is NOT handled when activeElement is contentEditable', () => {
    assert.strictEqual(shouldHandleNavKey('g', editableContext).handled, false);
  });

  it('k is NOT handled when activeElement is contentEditable', () => {
    assert.strictEqual(shouldHandleNavKey('k', editableContext).handled, false);
  });
});

describe('shouldHandleNavKey — navbar guard', () => {
  const navbarContext: NavKeyContext = {
    activeElement: { tagName: 'DIV', isContentEditable: false },
    isInNavbar: true,
    isInWidgetContainer: false,
  };

  it('j is NOT handled when focus is in navbar', () => {
    assert.strictEqual(shouldHandleNavKey('j', navbarContext).handled, false);
  });

  it('ArrowUp is NOT handled when focus is in navbar', () => {
    assert.strictEqual(shouldHandleNavKey('ArrowUp', navbarContext).handled, false);
  });

  it('G is NOT handled when focus is in navbar', () => {
    assert.strictEqual(shouldHandleNavKey('G', navbarContext).handled, false);
  });
});

describe('shouldHandleNavKey — widget container guard', () => {
  const widgetContext: NavKeyContext = {
    activeElement: { tagName: 'SPAN', isContentEditable: false },
    isInNavbar: false,
    isInWidgetContainer: true,
  };

  it('j is NOT handled when focus is in widget container', () => {
    assert.strictEqual(shouldHandleNavKey('j', widgetContext).handled, false);
  });

  it('k is NOT handled when focus is in widget container', () => {
    assert.strictEqual(shouldHandleNavKey('k', widgetContext).handled, false);
  });

  it('Home is NOT handled when focus is in widget container', () => {
    assert.strictEqual(shouldHandleNavKey('Home', widgetContext).handled, false);
  });
});

describe('shouldHandleNavKey — all nav keys pass through in input contexts', () => {
  const navKeys = ['j', 'k', 'g', 'G', 'ArrowDown', 'ArrowUp', 'Home', 'End'];

  const inputContexts: { name: string; ctx: NavKeyContext }[] = [
    {
      name: 'INPUT element',
      ctx: { activeElement: { tagName: 'INPUT', isContentEditable: false }, isInNavbar: false, isInWidgetContainer: false },
    },
    {
      name: 'TEXTAREA element',
      ctx: { activeElement: { tagName: 'TEXTAREA', isContentEditable: false }, isInNavbar: false, isInWidgetContainer: false },
    },
    {
      name: 'contentEditable element',
      ctx: { activeElement: { tagName: 'DIV', isContentEditable: true }, isInNavbar: false, isInWidgetContainer: false },
    },
    {
      name: 'navbar',
      ctx: { activeElement: { tagName: 'DIV', isContentEditable: false }, isInNavbar: true, isInWidgetContainer: false },
    },
    {
      name: 'widget container',
      ctx: { activeElement: { tagName: 'DIV', isContentEditable: false }, isInNavbar: false, isInWidgetContainer: true },
    },
  ];

  for (const { name, ctx } of inputContexts) {
    for (const key of navKeys) {
      it(`"${key}" passes through when in ${name}`, () => {
        assert.strictEqual(shouldHandleNavKey(key, ctx).handled, false);
      });
    }
  }
});
