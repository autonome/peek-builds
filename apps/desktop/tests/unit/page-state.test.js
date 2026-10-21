import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_STATES,
  stateFromTags,
  planPageState,
} from '../../renderer/lib/page-state.js';

describe('PAGE_STATES', () => {
  it('is kept and dropped, in that order', () => {
    assert.deepEqual(PAGE_STATES, ['kept', 'dropped']);
  });
});

describe('stateFromTags', () => {
  it('returns null when neither tag is present', () => {
    assert.equal(stateFromTags([]), null);
    assert.equal(stateFromTags(['research', 'recipes']), null);
  });

  it('returns kept when the page carries kept', () => {
    assert.equal(stateFromTags(['kept']), 'kept');
    assert.equal(stateFromTags(['recipes', 'kept']), 'kept');
  });

  it('returns dropped when the page carries dropped', () => {
    assert.equal(stateFromTags(['dropped']), 'dropped');
    assert.equal(stateFromTags(['dropped', 'recipes']), 'dropped');
  });

  it('returns kept when both tags are somehow present', () => {
    assert.equal(stateFromTags(['dropped', 'kept']), 'kept');
    assert.equal(stateFromTags(['kept', 'dropped']), 'kept');
  });

  it('treats a missing or non-array argument as no tags', () => {
    assert.equal(stateFromTags(undefined), null);
    assert.equal(stateFromTags(null), null);
  });
});

describe('planPageState', () => {
  it('keep from no state adds kept and removes nothing', () => {
    assert.deepEqual(planPageState([], 'keep'), { addTag: 'kept', removeTags: [] });
  });

  it('keep from dropped adds kept and removes dropped', () => {
    assert.deepEqual(planPageState(['dropped'], 'keep'), {
      addTag: 'kept',
      removeTags: ['dropped'],
    });
  });

  it('drop from kept adds dropped and removes kept', () => {
    assert.deepEqual(planPageState(['kept'], 'drop'), {
      addTag: 'dropped',
      removeTags: ['kept'],
    });
  });

  it('drop from no state adds dropped and removes nothing', () => {
    assert.deepEqual(planPageState(['recipes'], 'drop'), {
      addTag: 'dropped',
      removeTags: [],
    });
  });

  it('clear removes whichever state tag is present and leaves the note', () => {
    assert.deepEqual(planPageState(['kept'], 'clear'), { addTag: null, removeTags: ['kept'] });
    assert.deepEqual(planPageState(['dropped'], 'clear'), {
      addTag: null,
      removeTags: ['dropped'],
    });
    assert.deepEqual(planPageState(['recipes'], 'clear'), { addTag: null, removeTags: [] });
  });

  it('clear ignores a note', () => {
    assert.deepEqual(planPageState(['kept'], 'clear', 'too long'), {
      addTag: null,
      removeTags: ['kept'],
    });
  });

  it('keep with a note sets the note', () => {
    assert.deepEqual(planPageState([], 'keep', 'no parking'), {
      addTag: 'kept',
      removeTags: [],
      notes: 'no parking',
    });
  });

  it('keep without a note leaves the note unchanged', () => {
    const plan = planPageState([], 'keep');
    assert.equal('notes' in plan, false);
  });

  it('treats a blank note as no note', () => {
    const plan = planPageState([], 'drop', '   ');
    assert.equal('notes' in plan, false);
  });

  it('trims the note it sets', () => {
    assert.equal(planPageState([], 'drop', '  maybe  ').notes, 'maybe');
  });

  it('keep when already kept changes no tag', () => {
    assert.deepEqual(planPageState(['kept'], 'keep'), { addTag: null, removeTags: [] });
  });

  it('keep when already kept still replaces the note when one is given', () => {
    assert.deepEqual(planPageState(['kept'], 'keep', 'still good'), {
      addTag: null,
      removeTags: [],
      notes: 'still good',
    });
  });

  it('leaves at most one state tag when both are present', () => {
    assert.deepEqual(planPageState(['kept', 'dropped'], 'keep'), {
      addTag: null,
      removeTags: ['dropped'],
    });
    assert.deepEqual(planPageState(['kept', 'dropped'], 'drop'), {
      addTag: null,
      removeTags: ['kept'],
    });
    assert.deepEqual(planPageState(['kept', 'dropped'], 'clear'), {
      addTag: null,
      removeTags: ['kept', 'dropped'],
    });
  });

  it('rejects an unknown action', () => {
    assert.throws(() => planPageState([], 'maybe'), /unknown page-state action/);
  });
});
