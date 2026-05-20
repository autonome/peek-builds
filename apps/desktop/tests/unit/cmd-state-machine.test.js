/**
 * Unit tests for the cmd panel state machine module.
 *
 * Tests the transition table and dispatch logic without DOM/IPC dependencies.
 * Run via: node --test tests/unit/cmd-state-machine.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'app', 'cmd', 'state-machine.js');

const { createStateMachine, States, Events } = await import(modulePath);

// Helper: create a machine with minimal functional actions and default guards.
// Most actions are no-ops (just logging), but navigation actions need to
// actually modify state to be testable.
function makeMachine(overrideActions = {}, overrideGuards = {}) {
  const actionLog = [];

  // Actions that must actually mutate state for tests to work
  const functionalActions = {
    navigateDown(payload, data) { data.matchIndex++; },
    navigateUp(payload, data) { data.matchIndex--; },
    navigateParamDown(payload, data) { data.paramIndex++; },
    navigateParamUp(payload, data) { data.paramIndex--; },
    navigateOutputDown(payload, data) { data.outputItemIndex++; },
    navigateOutputUp(payload, data) { data.outputItemIndex--; },
    setMatchIndexFromClick(payload, data) {
      if (payload?.index !== undefined) data.matchIndex = payload.index;
    },
    setParamIndexFromClick(payload, data) {
      if (payload?.index !== undefined) data.paramIndex = payload.index;
    },
    setOutputIndexFromClick(payload, data) {
      if (payload?.index !== undefined) data.outputItemIndex = payload.index;
    },
    setTyped(payload, data) {
      if (payload?.value !== undefined) data.typed = payload.value;
    },
    clearInput(payload, data) {
      data.typed = '';
      data.matches = [];
      data.matchIndex = 0;
    },
    clearMatches(payload, data) {
      data.matches = [];
      data.matchIndex = 0;
    },
    showResults(payload, data) {
      data.showResults = true;
    },
    hideResults(payload, data) {
      data.showResults = false;
    },
    exitParamMode(payload, data) {
      data.paramCommand = null;
      data.paramSuggestions = [];
      data.paramIndex = -1;
    },
    enterParamMode(payload, data) {
      const cmdName = payload?.paramCommandName || (data.matches.length > 0 ? data.matches[data.matchIndex] : null);
      if (cmdName) {
        data.paramCommand = cmdName;
        data.paramSuggestions = [];
        data.paramIndex = -1;
      }
    },
  };

  const actions = new Proxy({ ...functionalActions, ...overrideActions }, {
    get(target, prop) {
      if (prop in target) return (...args) => {
        actionLog.push(prop);
        return target[prop](...args);
      };
      return (payload, data) => {
        actionLog.push(prop);
      };
    }
  });
  const machine = createStateMachine(actions, overrideGuards);
  machine._actionLog = actionLog;
  return machine;
}

// ===== State Enum Tests =====

describe('States enum', () => {
  it('has all expected states', () => {
    assert.ok(States.IDLE);
    assert.ok(States.TYPING);
    assert.ok(States.RESULTS_OPEN);
    assert.ok(States.PARAM_MODE);
    assert.ok(States.EXECUTING);
    assert.ok(States.OUTPUT_SELECTION);
    assert.ok(States.CHAIN_MODE);
    assert.ok(States.CHAIN_POPUP);
    assert.ok(States.ERROR);
    assert.ok(States.CLOSING);
  });

  it('states are frozen', () => {
    assert.throws(() => { States.NEW_STATE = 'NEW'; }, TypeError);
  });
});

// ===== Initial State =====

describe('Initial state', () => {
  it('starts in IDLE', () => {
    const machine = makeMachine();
    assert.equal(machine.getState(), States.IDLE);
  });

  it('has empty data', () => {
    const machine = makeMachine();
    const data = machine.getData();
    assert.equal(data.typed, '');
    assert.equal(data.matches.length, 0);
    assert.equal(data.matchIndex, 0);
  });
});

// ===== IDLE Transitions =====

describe('IDLE transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
  });

  it('IDLE + non-empty input -> TYPING', () => {
    const result = machine.dispatch(Events.INPUT, { value: 'tags' });
    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.TYPING);
  });

  it('IDLE + empty input -> stays IDLE (no transition)', () => {
    const result = machine.dispatch(Events.INPUT, { value: '' });
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('IDLE + ArrowDown with matches -> RESULTS_OPEN', () => {
    machine.getMutableData().matches = ['test'];
    const result = machine.dispatch(Events.ARROW_DOWN);
    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
  });

  it('IDLE + ArrowDown without matches -> stays IDLE', () => {
    const result = machine.dispatch(Events.ARROW_DOWN);
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('IDLE + Escape -> CLOSING', () => {
    const result = machine.dispatch(Events.ESCAPE);
    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('IDLE + Enter -> stays IDLE (no-op)', () => {
    const result = machine.dispatch(Events.ENTER);
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('IDLE + visibility:hidden -> CLOSING', () => {
    const result = machine.dispatch(Events.VISIBILITY_HIDDEN);
    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.CLOSING);
  });
});

// ===== TYPING Transitions =====

describe('TYPING transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.TYPING);
    machine.getMutableData().typed = 'test';
  });

  it('TYPING + non-empty input -> TYPING', () => {
    const result = machine.dispatch(Events.INPUT, { value: 'testing' });
    assert.equal(machine.getState(), States.TYPING);
    assert.equal(result.handled, true);
  });

  it('TYPING + empty input -> IDLE', () => {
    const result = machine.dispatch(Events.INPUT, { value: '' });
    assert.equal(machine.getState(), States.IDLE);
  });

  it('TYPING + input with enterParamMode -> PARAM_MODE', () => {
    const result = machine.dispatch(Events.INPUT, {
      value: 'edit test',
      enterParamMode: true,
      paramCommandName: 'edit'
    });
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  it('TYPING + ArrowDown with matches -> RESULTS_OPEN', () => {
    machine.getMutableData().matches = ['test'];
    const result = machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
  });

  it('TYPING + Tab with params and text fully matches -> PARAM_MODE', () => {
    machine.getMutableData().matches = ['edit'];
    machine.getMutableData().typed = 'edit';
    machine.getMutableData().commands = {
      edit: { name: 'edit', params: [{ type: 'item' }] }
    };
    const result = machine.dispatch(Events.TAB, {
      commandName: 'edit',
      hasParams: true
    });
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  it('TYPING + Tab with params on partial text -> PARAM_MODE (complete name and enter params)', () => {
    machine.getMutableData().matches = ['kagi'];
    machine.getMutableData().typed = 'ka';
    machine.getMutableData().commands = {
      kagi: { name: 'kagi', params: [{ name: 'query', type: 'string' }] }
    };
    const result = machine.dispatch(Events.TAB, {
      commandName: 'kagi',
      hasParams: true
    });
    // Should enter PARAM_MODE — Tab both completes the name AND enters param mode in one action
    assert.equal(machine.getState(), States.PARAM_MODE);
    assert.equal(result.handled, true);
  });

  it('TYPING + Tab with params and text matches with trailing space -> PARAM_MODE', () => {
    machine.getMutableData().matches = ['kagi'];
    machine.getMutableData().typed = 'kagi ';
    machine.getMutableData().commands = {
      kagi: { name: 'kagi', params: [{ name: 'query', type: 'string' }] }
    };
    const result = machine.dispatch(Events.TAB, {
      commandName: 'kagi',
      hasParams: true
    });
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  it('TYPING + Tab without params -> TYPING', () => {
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    const result = machine.dispatch(Events.TAB, {
      commandName: 'tags',
      hasParams: false
    });
    assert.equal(machine.getState(), States.TYPING);
  });

  it('TYPING + Enter with URL -> CLOSING', () => {
    const result = machine.dispatch(Events.ENTER, {
      value: 'https://example.com',
      isURL: true,
      committed: false
    });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('TYPING + Enter committed to command -> EXECUTING', () => {
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    const result = machine.dispatch(Events.ENTER, {
      value: 'tags',
      isURL: false,
      committed: true,
      commandName: 'tags'
    });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('TYPING + Enter no match -> TYPING (no-op, search is explicit)', () => {
    const result = machine.dispatch(Events.ENTER, {
      value: 'xyzzy',
      isURL: false,
      committed: false
    });
    assert.equal(machine.getState(), States.TYPING);
  });

  it('TYPING + Escape with text -> IDLE', () => {
    machine.getMutableData().typed = 'something';
    const result = machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('TYPING + Escape with empty text -> CLOSING', () => {
    machine.getMutableData().typed = '';
    const result = machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CLOSING);
  });
});

// ===== RESULTS_OPEN Transitions =====

describe('RESULTS_OPEN transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.RESULTS_OPEN);
    machine.getMutableData().matches = ['tags', 'tag', 'settings'];
    machine.getMutableData().matchIndex = 0;
    machine.getMutableData().showResults = true;
  });

  it('RESULTS_OPEN + input -> TYPING', () => {
    machine.dispatch(Events.INPUT, { value: 'x' });
    assert.equal(machine.getState(), States.TYPING);
  });

  it('RESULTS_OPEN + ArrowDown -> RESULTS_OPEN (index incremented)', () => {
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
    assert.equal(machine.getData().matchIndex, 1);
  });

  it('RESULTS_OPEN + ArrowDown at end -> stays (no change)', () => {
    machine.getMutableData().matchIndex = 2;
    const result = machine.dispatch(Events.ARROW_DOWN);
    assert.equal(result.handled, false);
    assert.equal(machine.getData().matchIndex, 2);
  });

  it('RESULTS_OPEN + ArrowUp -> RESULTS_OPEN (index decremented)', () => {
    machine.getMutableData().matchIndex = 1;
    machine.dispatch(Events.ARROW_UP);
    assert.equal(machine.getData().matchIndex, 0);
  });

  it('RESULTS_OPEN + Enter -> EXECUTING', () => {
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    machine.dispatch(Events.ENTER, {
      value: 'tags',
      isURL: false,
      committed: true,
      commandName: 'tags'
    });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('RESULTS_OPEN + click result -> EXECUTING', () => {
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    machine.dispatch(Events.CLICK_RESULT, { index: 0, commandName: 'tags' });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('RESULTS_OPEN + Escape -> TYPING', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
  });
});

// ===== PARAM_MODE Transitions =====

describe('PARAM_MODE transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.PARAM_MODE);
    machine.getMutableData().typed = 'edit test';
    machine.getMutableData().paramCommand = 'edit';
    machine.getMutableData().paramSuggestions = [
      { title: 'Test Note', value: 'test-note', _item: { id: '123' } }
    ];
    machine.getMutableData().paramIndex = 0;
    machine.getMutableData().commands = {
      edit: { name: 'edit', params: [{ type: 'item' }] }
    };
  });

  it('PARAM_MODE + input still matches -> PARAM_MODE', () => {
    machine.dispatch(Events.INPUT, {
      value: 'edit test note',
      paramStillMatches: true
    });
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  it('PARAM_MODE + input no longer matches -> TYPING', () => {
    machine.dispatch(Events.INPUT, {
      value: 'something else',
      paramStillMatches: false
    });
    assert.equal(machine.getState(), States.TYPING);
  });

  it('PARAM_MODE + empty input -> IDLE', () => {
    machine.dispatch(Events.INPUT, { value: '' });
    assert.equal(machine.getState(), States.IDLE);
  });

  it('PARAM_MODE + ArrowDown -> navigates param suggestions', () => {
    machine.getMutableData().paramSuggestions = [{ title: 'a' }, { title: 'b' }];
    machine.getMutableData().paramIndex = 0;
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getState(), States.PARAM_MODE);
    // Invariant enforcement bounds the index
    assert.ok(machine.getData().paramIndex >= 0);
  });

  it('PARAM_MODE + Tab -> fills suggestion (stays in PARAM_MODE)', () => {
    machine.dispatch(Events.TAB);
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  it('PARAM_MODE + Enter with item-type param -> EXECUTING', () => {
    machine.dispatch(Events.ENTER);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('PARAM_MODE + Enter with non-item param -> EXECUTING', () => {
    machine.getMutableData().commands = {
      tag: { name: 'tag', params: [{ type: 'tag' }] }
    };
    machine.getMutableData().paramCommand = 'tag';
    machine.getMutableData().paramSuggestions = [{ title: 'todo', value: 'todo' }];
    machine.dispatch(Events.ENTER);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('PARAM_MODE + Escape -> TYPING', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
  });

  it('PARAM_MODE + click param -> EXECUTING', () => {
    machine.dispatch(Events.CLICK_PARAM, { index: 0 });
    assert.equal(machine.getState(), States.EXECUTING);
  });
});

// ===== EXECUTING Transitions =====

describe('EXECUTING transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.EXECUTING);
  });

  it('EXECUTING blocks input events', () => {
    const result = machine.dispatch(Events.INPUT, { value: 'test' });
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('EXECUTING blocks Enter (double-Enter guard)', () => {
    const result = machine.dispatch(Events.ENTER, { value: 'test', committed: true });
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('EXECUTING blocks Tab', () => {
    const result = machine.dispatch(Events.TAB);
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('EXECUTING + command_complete (no output) -> CLOSING', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, { result: {}, name: 'test' });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('EXECUTING + command_complete (item output, single) -> CLOSING', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: { id: '123' }, mimeType: 'item' } },
      name: 'edit'
    });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('EXECUTING + command_complete (item output, array) -> OUTPUT_SELECTION', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: [{ id: '1' }, { id: '2' }], mimeType: 'item' } },
      name: 'list'
    });
    assert.equal(machine.getState(), States.OUTPUT_SELECTION);
  });

  it('EXECUTING + command_complete (array output, has downstream) -> OUTPUT_SELECTION', () => {
    // Array outputs always go to OUTPUT_SELECTION first even when downstream
    // commands exist; the chain branch is taken on row selection. See the
    // guard rationale in app/cmd/state-machine.js EXECUTING.COMMAND_COMPLETE.
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: [{ id: '1' }], mimeType: 'application/json' } },
      name: 'list',
      hasDownstream: true
    });
    assert.equal(machine.getState(), States.OUTPUT_SELECTION);
  });

  it('EXECUTING + command_complete (array, no downstream) -> OUTPUT_SELECTION', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: [{ id: '1' }], mimeType: 'application/json' } },
      name: 'list',
      hasDownstream: false
    });
    assert.equal(machine.getState(), States.OUTPUT_SELECTION);
  });

  it('EXECUTING + command_complete (single chainable) -> CHAIN_MODE', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: 'some text', mimeType: 'text/plain' } },
      name: 'export',
      hasDownstream: true
    });
    assert.equal(machine.getState(), States.CHAIN_MODE);
  });

  it('EXECUTING + command_complete (action=prompt) -> IDLE', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { action: 'prompt' },
      name: 'test'
    });
    assert.equal(machine.getState(), States.IDLE);
  });

  it('EXECUTING + command_error -> ERROR', () => {
    machine.dispatch(Events.COMMAND_ERROR, { name: 'test', error: 'fail' });
    assert.equal(machine.getState(), States.ERROR);
  });

  it('EXECUTING + command_timeout -> ERROR', () => {
    machine.dispatch(Events.COMMAND_TIMEOUT, { name: 'test', error: 'timeout' });
    assert.equal(machine.getState(), States.ERROR);
  });

  it('EXECUTING + cancel_click -> IDLE', () => {
    machine.dispatch(Events.CLICK_CANCEL);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('EXECUTING + Escape -> IDLE', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });
});

// ===== OUTPUT_SELECTION Transitions =====

describe('OUTPUT_SELECTION transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.OUTPUT_SELECTION);
    machine.getMutableData().outputItems = [{ id: '1' }, { id: '2' }, { id: '3' }];
    machine.getMutableData().outputItemIndex = 0;
    machine.getMutableData().outputMimeType = 'item';
  });

  it('OUTPUT_SELECTION + ArrowDown -> navigates down', () => {
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getData().outputItemIndex, 1);
  });

  it('OUTPUT_SELECTION + ArrowUp at 0 -> no change', () => {
    const result = machine.dispatch(Events.ARROW_UP);
    assert.equal(result.handled, false);
  });

  it('OUTPUT_SELECTION + Escape -> IDLE', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });
});

// ===== CHAIN_MODE Transitions =====

describe('CHAIN_MODE transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.CHAIN_MODE);
    machine.getMutableData().chainContext = {
      data: 'test',
      mimeType: 'text/plain',
      title: 'Test',
      sourceCommand: 'export'
    };
    machine.getMutableData().chainStack = [
      { data: 'test', mimeType: 'text/plain', title: 'Test', sourceCommand: 'export' }
    ];
    machine.getMutableData().matches = ['format'];
    machine.getMutableData().matchIndex = 0;
  });

  it('CHAIN_MODE + input -> stays CHAIN_MODE', () => {
    machine.dispatch(Events.INPUT, { value: 'form' });
    assert.equal(machine.getState(), States.CHAIN_MODE);
  });

  it('CHAIN_MODE + Enter with matches -> EXECUTING', () => {
    machine.dispatch(Events.ENTER, { value: 'format', committed: true });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('CHAIN_MODE + Escape with shallow stack -> IDLE', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('CHAIN_MODE + Escape with deep stack -> CHAIN_MODE (undo)', () => {
    machine.getMutableData().chainStack.push({
      data: 'more',
      mimeType: 'text/plain',
      title: 'More',
      sourceCommand: 'format'
    });
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CHAIN_MODE);
  });

  it('CHAIN_MODE + chain_cancel_click -> IDLE', () => {
    machine.dispatch(Events.CLICK_CHAIN_CANCEL);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('CHAIN_MODE + popup_result (done) -> CLOSING', () => {
    machine.dispatch(Events.POPUP_RESULT, { done: true });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('CHAIN_MODE + popup_result (data) -> CHAIN_MODE', () => {
    machine.dispatch(Events.POPUP_RESULT, { done: false, data: 'edited' });
    assert.equal(machine.getState(), States.CHAIN_MODE);
  });
});

// ===== ERROR Transitions =====

describe('ERROR transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.ERROR);
  });

  it('ERROR + error_timeout -> IDLE', () => {
    machine.dispatch(Events.ERROR_TIMEOUT);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('ERROR + input -> TYPING', () => {
    machine.dispatch(Events.INPUT, { value: 'test' });
    assert.equal(machine.getState(), States.TYPING);
  });

  it('ERROR + Escape -> IDLE', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });
});

// ===== CLOSING Transitions =====

describe('CLOSING transitions', () => {
  let machine;

  beforeEach(() => {
    machine = makeMachine();
    machine.setState(States.CLOSING);
  });

  it('CLOSING + visibility:shown -> IDLE (reset)', () => {
    machine.dispatch(Events.VISIBILITY_SHOWN);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('CLOSING absorbs other events', () => {
    const result = machine.dispatch(Events.INPUT, { value: 'test' });
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.CLOSING);
  });
});

// ===== Escape Layering =====

describe('Escape layering', () => {
  it('full escape sequence: param -> typing -> idle -> closing', () => {
    const machine = makeMachine();
    machine.setState(States.PARAM_MODE);
    machine.getMutableData().typed = 'edit test';
    machine.getMutableData().paramCommand = 'edit';

    // Escape 1: exit param mode -> TYPING
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);

    // Escape 2: clear text -> IDLE (text is non-empty)
    machine.getMutableData().typed = 'edit test';
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);

    // Escape 3: close panel -> CLOSING (text is empty in IDLE)
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('IZUI handleEscape returns handled correctly', () => {
    const machine = makeMachine();
    machine.setState(States.PARAM_MODE);
    machine.getMutableData().typed = 'edit test';
    machine.getMutableData().paramCommand = 'edit';

    // Should be handled (exits param mode)
    const r1 = machine.handleEscape();
    assert.equal(r1.handled, true);
    assert.equal(machine.getState(), States.TYPING);

    // Should be handled (clears text)
    machine.getMutableData().typed = 'edit test';
    const r2 = machine.handleEscape();
    assert.equal(r2.handled, true);
    assert.equal(machine.getState(), States.IDLE);

    // Should NOT be handled (closing — let backend close window)
    const r3 = machine.handleEscape();
    assert.equal(r3.handled, false);
    assert.equal(machine.getState(), States.CLOSING);
  });
});

// ===== Invariant Enforcement =====

describe('Invariant enforcement', () => {
  it('matchIndex stays in bounds after transition', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    machine.getMutableData().matches = ['a', 'b'];
    machine.getMutableData().matchIndex = 5; // Out of bounds
    machine.getMutableData().typed = 'test';

    // Dispatch anything to trigger invariant enforcement
    machine.dispatch(Events.INPUT, { value: 'x' });
    assert.ok(machine.getData().matchIndex >= 0);
    assert.ok(machine.getData().matchIndex < machine.getData().matches.length || machine.getData().matches.length === 0);
  });

  it('paramIndex resets when leaving PARAM_MODE', () => {
    const machine = makeMachine();
    machine.setState(States.PARAM_MODE);
    machine.getMutableData().paramCommand = 'edit';
    machine.getMutableData().paramSuggestions = [{ title: 'a' }];
    machine.getMutableData().paramIndex = 0;
    machine.getMutableData().typed = 'edit test';

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
    // After invariant enforcement, param data is cleared
    assert.equal(machine.getData().paramCommand, null);
    assert.equal(machine.getData().paramIndex, -1);
  });
});

// ===== Reset =====

describe('Machine reset', () => {
  it('reset() clears all state to defaults', () => {
    const machine = makeMachine();
    machine.setState(States.CHAIN_MODE);
    machine.getMutableData().typed = 'test';
    machine.getMutableData().chainContext = { data: 'x' };
    machine.getMutableData().chainStack = [{ data: 'x' }];
    machine.getMutableData().outputItems = [1, 2, 3];

    machine.reset();

    assert.equal(machine.getState(), States.IDLE);
    assert.equal(machine.getData().typed, '');
    assert.equal(machine.getData().chainContext, null);
    assert.equal(machine.getData().chainStack.length, 0);
    assert.equal(machine.getData().outputItems.length, 0);
    assert.equal(machine.getData().paramCommand, null);
  });
});

// ===== Edge Cases =====

describe('Edge cases', () => {
  it('dispatching unknown event is not handled', () => {
    const machine = makeMachine();
    const result = machine.dispatch('nonexistent_event');
    assert.equal(result.handled, false);
  });

  it('rapid typing does not break state', () => {
    const machine = makeMachine();

    // Rapid input events
    machine.dispatch(Events.INPUT, { value: 't' });
    assert.equal(machine.getState(), States.TYPING);

    machine.dispatch(Events.INPUT, { value: 'ta' });
    assert.equal(machine.getState(), States.TYPING);

    machine.dispatch(Events.INPUT, { value: 'tag' });
    assert.equal(machine.getState(), States.TYPING);

    machine.dispatch(Events.INPUT, { value: 'tags' });
    assert.equal(machine.getState(), States.TYPING);

    // Clear
    machine.dispatch(Events.INPUT, { value: '' });
    assert.equal(machine.getState(), States.IDLE);
  });

  it('panel re-show resets state from any state', () => {
    const machine = makeMachine();

    // Go to executing state
    machine.setState(States.EXECUTING);
    machine.getMutableData().typed = 'test';

    // Panel hidden + shown cycle
    machine.setState(States.CLOSING);
    machine.dispatch(Events.VISIBILITY_SHOWN);

    assert.equal(machine.getState(), States.IDLE);
  });

  it('is() helper works correctly', () => {
    const machine = makeMachine();
    assert.equal(machine.is(States.IDLE), true);
    assert.equal(machine.is(States.TYPING), false);

    machine.setState(States.TYPING);
    assert.equal(machine.is(States.TYPING), true);
    assert.equal(machine.is(States.IDLE), false);
  });
});
