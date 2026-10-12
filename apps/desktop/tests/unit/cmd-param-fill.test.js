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
const { commandTextWithSuggestion, paramFilterText } = await import(modulePath);

describe('paramFilterText', () => {
  it('filters a single-value enum on everything typed after the command', () => {
    assert.equal(paramFilterText({ type: 'enum' }, ['Work'], 'Pr'), 'Work Pr');
    assert.equal(paramFilterText({ type: 'enum' }, ['Work'], ''), 'Work ');
    assert.equal(paramFilterText({ type: 'enum' }, [], 'Wo'), 'Wo');
    assert.equal(paramFilterText({ type: 'enum' }, [], ''), '');
  });

  it('filters a multi-value parameter on the last word only', () => {
    assert.equal(paramFilterText({ type: 'tag', multiple: true }, ['a', 'b'], 'c'), 'c');
  });

  it('filters an item parameter on the whole text without a trailing space', () => {
    assert.equal(paramFilterText({ type: 'item' }, ['my'], ''), 'my');
  });
});

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
      commandTextWithSuggestion('switch space', 'Switch Space ', enumDef, { value: 'two' }),
      'switch space two'
    );
  });

  it('leaves multi-select and item parameters to their own handling', () => {
    assert.equal(commandTextWithSuggestion('tag', 'tag a ', { type: 'tag', multiple: true }, { value: 'b' }), 'tag a ');
    assert.equal(commandTextWithSuggestion('note', 'note x', { type: 'item' }, { value: 'y' }), 'note x');
  });

  it('leaves the text alone when there is no suggestion', () => {
    assert.equal(commandTextWithSuggestion('switch space', 'switch space zz', enumDef, null), 'switch space zz');
  });
});
