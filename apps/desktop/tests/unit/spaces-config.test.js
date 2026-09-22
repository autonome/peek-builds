/**
 * Unit tests for the pure color-resolution helpers in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-config.test.js
 * (leaf module — no DOM/electron deps, imported directly.)
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { resolveVividColor, pushVivid, THEME_PALETTES, VIVID_SPACE_COLORS } = await import(modulePath);

describe('resolveVividColor', () => {
  it('keeps a tag color with enough chroma as-is, regardless of theme', () => {
    assert.equal(resolveVividColor('#ff3b30', 'space-1', 'basic'), '#ff3b30');
  });

  it('falls back to the peek palette by default', () => {
    assert.ok(THEME_PALETTES.peek.some((c) => resolveVividColor('#999999', 'space-1') === pushVivid(c)));
  });

  it('picks from the given theme\'s own palette for a grey/low-chroma color', () => {
    const color = resolveVividColor('#999999', 'space-1', 'basic');
    assert.ok(THEME_PALETTES.basic.some((c) => pushVivid(c) === color));
  });

  it('is deterministic for the same spaceId + theme', () => {
    const a = resolveVividColor('#999', 'space-42', 'peek');
    const b = resolveVividColor('#999', 'space-42', 'peek');
    assert.equal(a, b);
  });

  it('falls back to the peek palette for an unrecognized theme id', () => {
    const known = resolveVividColor('#999999', 'space-1', 'peek');
    const unknown = resolveVividColor('#999999', 'space-1', 'some-custom-theme');
    assert.equal(unknown, known);
  });

  it('VIVID_SPACE_COLORS stays an alias of the peek palette (back-compat)', () => {
    assert.deepEqual(VIVID_SPACE_COLORS, THEME_PALETTES.peek);
  });
});

describe('pushVivid', () => {
  it('boosts a muted theme swatch toward higher saturation', () => {
    // apps/desktop/themes/basic/variables.css --base0A (a muted mustard yellow)
    const boosted = pushVivid('#c08b00');
    assert.notEqual(boosted, '#c08b00');
  });

  it('is a no-op on an already-saturated, mid-lightness color', () => {
    assert.equal(pushVivid('#ff9500'), '#ff9500');
  });

  it('always returns a well-formed hex color', () => {
    for (const hex of [...THEME_PALETTES.peek, ...THEME_PALETTES.basic]) {
      assert.match(pushVivid(hex), /^#[0-9a-f]{6}$/);
    }
  });
});
