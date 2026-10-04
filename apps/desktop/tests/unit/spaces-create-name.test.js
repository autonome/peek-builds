/**
 * Unit tests for validateNewSpaceName and spaceNameOptions in
 * features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-create-name.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { validateNewSpaceName, spaceNameOptions } = await import(modulePath);

describe('validateNewSpaceName', () => {
  it('trims the name', () => {
    assert.deepEqual(validateNewSpaceName('  Work ', [], 'default'), { ok: true, name: 'Work' });
  });

  it('refuses an empty name with a usage message', () => {
    for (const name of [undefined, null, '', '   ']) {
      const r = validateNewSpaceName(name, [], 'default');
      assert.equal(r.ok, false);
      assert.match(r.error, /Usage: create space/);
    }
  });

  it('refuses a name that exists, ignoring case', () => {
    const r = validateNewSpaceName('work', ['Work', 'Play'], 'default');
    assert.equal(r.ok, false);
    assert.equal(r.exists, true);
    assert.match(r.error, /already exists/);
  });

  it('refuses the default space name, ignoring case', () => {
    const r = validateNewSpaceName('Default', [], 'default');
    assert.equal(r.ok, false);
    assert.equal(r.exists, true);
  });
});

describe('spaceNameOptions', () => {
  const tag = (name, metadata) => ({ id: name, name, metadata });

  it('lists only space tags, by display name, sorted', () => {
    const opts = spaceNameOptions([
      tag('space:Work'), tag('unrelated'), tag('space:Play'),
      tag('space:internal', { displayName: 'Zed' }),
    ]);
    assert.deepEqual(opts.map((o) => o.value), ['Play', 'Work', 'Zed']);
    assert.ok(opts.every((o) => o.title === o.value));
  });

  it('is empty for no tags', () => {
    assert.deepEqual(spaceNameOptions([]), []);
    assert.deepEqual(spaceNameOptions(null), []);
  });
});
