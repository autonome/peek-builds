/**
 * Unit tests for noMatchRow in renderer/cmd/no-match.js: the single row shown
 * when a command's parameter suggestions match nothing the user typed.
 *
 * Run via: node --test tests/unit/cmd-no-match.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { noMatchRow } = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'no-match.js'));

describe('noMatchRow', () => {
  it('offers to create the typed name when the parameter names a create command', () => {
    const row = noMatchRow({ type: 'enum', createCommand: 'create space' }, 'myweirdspacename');
    assert.deepEqual(row, {
      title: 'Create "myweirdspacename"',
      subtitle: 'create space',
      run: 'create space myweirdspacename',
    });
  });

  it('shows a non-selectable no-match row when there is no create command', () => {
    const row = noMatchRow({ type: 'enum' }, 'zzz');
    assert.deepEqual(row, { title: 'No match for "zzz"', run: null });
  });

  it('shows no row while nothing is typed', () => {
    assert.equal(noMatchRow({ type: 'enum', createCommand: 'create space' }, ''), null);
    assert.equal(noMatchRow({ type: 'enum' }, '   '), null);
  });

  it('shows no row without a parameter definition', () => {
    assert.equal(noMatchRow(null, 'abc'), null);
    assert.equal(noMatchRow(undefined, 'abc'), null);
  });

  it('trims the typed text', () => {
    const row = noMatchRow({ createCommand: 'create space' }, '  my space ');
    assert.equal(row.run, 'create space my space');
    assert.equal(row.title, 'Create "my space"');
  });
});
