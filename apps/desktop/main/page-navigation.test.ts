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

// ============================================================================
// normalizeUrlForCompare (extracted from app/page/page.js resolveItemId)
// ============================================================================

function normalizeUrlForCompare(u: string): string {
  try {
    const parsed = new URL(u);
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      parsed.search = sortedParams.toString();
    }
    return parsed.toString();
  } catch { return u; }
}

describe('normalizeUrlForCompare — trailing slash handling', () => {
  it('removes trailing slash from paths', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com/path/'),
      'https://example.com/path'
    );
  });

  it('preserves root slash', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com/'),
      'https://example.com/'
    );
  });

  it('does not add trailing slash to bare domain', () => {
    // URL constructor normalizes bare domain to have trailing slash
    const result = normalizeUrlForCompare('https://example.com');
    assert.strictEqual(result, 'https://example.com/');
  });
});

describe('normalizeUrlForCompare — port normalization', () => {
  it('removes default port 443 for HTTPS', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com:443/path'),
      'https://example.com/path'
    );
  });

  it('removes default port 80 for HTTP', () => {
    assert.strictEqual(
      normalizeUrlForCompare('http://example.com:80/path'),
      'http://example.com/path'
    );
  });

  it('preserves non-default port', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com:8080/path'),
      'https://example.com:8080/path'
    );
  });

  it('preserves port 80 on HTTPS (non-default)', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com:80/path'),
      'https://example.com:80/path'
    );
  });

  it('preserves port 443 on HTTP (non-default)', () => {
    assert.strictEqual(
      normalizeUrlForCompare('http://example.com:443/path'),
      'http://example.com:443/path'
    );
  });
});

describe('normalizeUrlForCompare — query param sorting', () => {
  it('sorts query params alphabetically', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com/path?z=1&a=2&m=3'),
      'https://example.com/path?a=2&m=3&z=1'
    );
  });

  it('leaves already-sorted params unchanged', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com/path?a=1&b=2&c=3'),
      'https://example.com/path?a=1&b=2&c=3'
    );
  });

  it('handles single query param', () => {
    assert.strictEqual(
      normalizeUrlForCompare('https://example.com/path?key=val'),
      'https://example.com/path?key=val'
    );
  });
});

describe('normalizeUrlForCompare — already normalized and invalid', () => {
  it('already normalized URL is unchanged', () => {
    const url = 'https://example.com/path?a=1&b=2';
    assert.strictEqual(normalizeUrlForCompare(url), url);
  });

  it('invalid URL returns original string', () => {
    assert.strictEqual(normalizeUrlForCompare('not-a-url'), 'not-a-url');
    assert.strictEqual(normalizeUrlForCompare(''), '');
    assert.strictEqual(normalizeUrlForCompare('://broken'), '://broken');
  });
});

describe('normalizeUrlForCompare — URL matching scenarios for resolveItemId', () => {
  it('trailing slash mismatch resolves to same normalized URL', () => {
    const a = normalizeUrlForCompare('https://example.com/docs/');
    const b = normalizeUrlForCompare('https://example.com/docs');
    assert.strictEqual(a, b);
  });

  it('query param order mismatch resolves to same normalized URL', () => {
    const a = normalizeUrlForCompare('https://example.com/page?b=2&a=1');
    const b = normalizeUrlForCompare('https://example.com/page?a=1&b=2');
    assert.strictEqual(a, b);
  });

  it('different URLs do NOT match after normalization', () => {
    const a = normalizeUrlForCompare('https://example.com/path-a');
    const b = normalizeUrlForCompare('https://example.com/path-b');
    assert.notStrictEqual(a, b);
  });

  it('different domains do NOT match', () => {
    const a = normalizeUrlForCompare('https://example.com/path');
    const b = normalizeUrlForCompare('https://other.com/path');
    assert.notStrictEqual(a, b);
  });

  it('combined normalization: trailing slash + param sort + default port', () => {
    const a = normalizeUrlForCompare('https://example.com:443/docs/?z=1&a=2');
    const b = normalizeUrlForCompare('https://example.com/docs?a=2&z=1');
    assert.strictEqual(a, b);
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
