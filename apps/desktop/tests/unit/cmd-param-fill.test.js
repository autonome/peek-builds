/**
 * Unit tests for commandTextWithSuggestion in renderer/cmd/param-fill.js.
 *
 * Run via: node --test tests/unit/cmd-param-fill.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'param-fill.js');
const { commandTextWithSuggestion } = await import(modulePath);

describe('commandTextWithSuggestion', () => {
  const enumDef = { type: 'enum' };

  it('replaces the typed argument with the clicked suggestion', () => {
    assert.equal(
      commandTextWithSuggestion('move to space', 'move to space tw', enumDef, { value: 'two' }),
      'move to space two'
    );
  });

  it('adds the suggestion when nothing was typed after the command', () => {
    assert.equal(
      commandTextWithSuggestion('move to space', 'move to space ', enumDef, { value: 'two' }),
      'move to space two'
    );
    assert.equal(
      commandTextWithSuggestion('move to space', 'move to space', enumDef, { value: 'My Space' }),
      'move to space My Space'
    );
  });

  it('matches the command name case-insensitively', () => {
    assert.equal(
      commandTextWithSuggestion('open space', 'Open Space ', enumDef, { value: 'two' }),
      'open space two'
    );
  });

  it('leaves multi-select and item parameters to their own handling', () => {
    assert.equal(commandTextWithSuggestion('tag', 'tag a ', { type: 'tag', multiple: true }, { value: 'b' }), 'tag a ');
    assert.equal(commandTextWithSuggestion('note', 'note x', { type: 'item' }, { value: 'y' }), 'note x');
  });

  it('leaves the text alone when there is no suggestion', () => {
    assert.equal(commandTextWithSuggestion('open space', 'open space zz', enumDef, null), 'open space zz');
  });
});
