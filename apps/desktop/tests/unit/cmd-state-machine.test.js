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
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'state-machine.js');

const { createStateMachine, States, Events, resultsListOpen, selectedRow, autoSelectableRow } = await import(modulePath);

// Minimal `data` shape for the pure derivation functions.
function makeData(overrides = {}) {
  return {
    commands: {},
    matches: [],
    matchIndex: 0,
    typed: '',
    urlMatches: [],
    paramSuggestions: [],
    enterRunsInlineSuggestion: true,
    ...overrides,
  };
}

// Helper: create a machine with minimal functional actions and default guards.
// Most actions are no-ops (just logging), but navigation actions need to
// actually modify state to be testable.
function makeMachine(overrideActions = {}, overrideGuards = {}) {
  const actionLog = [];

  // Actions that must actually mutate state for tests to work
  const functionalActions = {
    navigateDown(payload, data) { data.matchIndex++; },
    navigateUp(payload, data) { data.matchIndex--; },
    navigateParamDown(payload, data) {
      const n = data.paramSuggestions.length;
      data.paramIndex = n ? (data.paramIndex + 1) % n : -1;
    },
    navigateParamUp(payload, data) {
      const n = data.paramSuggestions.length;
      data.paramIndex = n ? (data.paramIndex <= 0 ? n - 1 : data.paramIndex - 1) : -1;
    },
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

// ===== Derived list visibility / row selection =====
// One owner for "is the list open" and "which row is selected". These replace the
// old `showResults` boolean, which meant three different things to three readers
// and let Enter disagree with what the user could see.

describe('resultsListOpen', () => {
  it('closed with zero results', () => {
    assert.equal(resultsListOpen(States.TYPING, makeData()), false);
  });

  it('closed with a single result while TYPING (below the auto-open threshold)', () => {
    assert.equal(resultsListOpen(States.TYPING, makeData({ matches: ['tags'] })), false);
  });

  it('open with a single result in RESULTS_OPEN (the user arrowed into it)', () => {
    assert.equal(resultsListOpen(States.RESULTS_OPEN, makeData({ matches: ['tags'] })), true);
  });

  it('auto-opens at 2+ combined results while TYPING', () => {
    assert.equal(resultsListOpen(States.TYPING, makeData({ matches: ['tags', 'tag'] })), true);
  });

  it('counts the url lane toward the auto-open threshold', () => {
    const data = makeData({ matches: ['tags'], urlMatches: [{ content: 'https://x.example' }] });
    assert.equal(resultsListOpen(States.TYPING, data), true);
  });

  it('open in PARAM_MODE only when there are suggestions', () => {
    assert.equal(resultsListOpen(States.PARAM_MODE, makeData({ paramSuggestions: [{ title: 'a' }] })), true);
    assert.equal(resultsListOpen(States.PARAM_MODE, makeData({ paramSuggestions: [] })), false);
  });

  it('open in CHAIN_MODE with a single match, and ignores the url lane', () => {
    const data = makeData({ matches: ['format'], urlMatches: [{ content: 'https://x.example' }] });
    assert.equal(resultsListOpen(States.CHAIN_MODE, data), true);
    assert.equal(resultsListOpen(States.CHAIN_MODE, makeData()), false);
  });

  it('closed in OUTPUT_SELECTION (rendered by its own path)', () => {
    const data = makeData({ matches: ['a', 'b'] });
    assert.equal(resultsListOpen(States.OUTPUT_SELECTION, data), false);
  });
});

describe('selectedRow / autoSelectableRow', () => {
  it('nothing selected when the list is closed', () => {
    assert.equal(selectedRow(States.TYPING, makeData({ matches: ['tags'] })), null);
  });

  it('auto-selects url row 0 when only url results matched', () => {
    const data = makeData({
      typed: 'fast',
      urlMatches: [{ content: 'https://fast.example' }, { content: 'https://example/fast' }],
    });
    assert.equal(selectedRow(States.TYPING, data), 0);
    assert.equal(autoSelectableRow(data), 0);
  });

  // Enter runs the row the ghost suggestion is drawn from — updateCommandUI
  // (panel.js) draws the ghost from state.matches[state.matchIndex]
  // unconditionally, not just for a strict-prefix completion. Was: "does NOT
  // select a substring-only command match".
  it('selects a substring-only command match at the top of the ranked list', () => {
    const data = makeData({ typed: 'ags', matches: ['tags', 'stags'] });
    assert.equal(selectedRow(States.TYPING, data), 0);
    assert.equal(autoSelectableRow(data), 0);
  });

  // Bug repro (peek fd640c7e): typing "ta" ranks the noun-generated "open tags"
  // above the bare noun "tags" (findMatchingCommands' token-prefix tier), so the
  // ghost draws "open [ta]gs" — the row at matchIndex, not a strict prefix of
  // "ta". It must still be the auto-selected row.
  it('selects a noun-generated multi-word command ranked above the bare noun', () => {
    const data = makeData({ typed: 'ta', matches: ['open tags', 'tags'] });
    assert.equal(selectedRow(States.TYPING, data), 0);
    assert.equal(autoSelectableRow(data), 0);
  });

  it('selects a strict-prefix command match', () => {
    const data = makeData({ typed: 'ta', matches: ['tags', 'tag'] });
    assert.equal(selectedRow(States.TYPING, data), 0);
  });

  it('does NOT select a strict-prefix match when the pref is off', () => {
    const data = makeData({ typed: 'ta', matches: ['tags', 'tag'], enterRunsInlineSuggestion: false });
    assert.equal(selectedRow(States.TYPING, data), null);
  });

  it('selects a fully-typed command regardless of the pref', () => {
    const data = makeData({ typed: 'tags', matches: ['tags', 'tag'], enterRunsInlineSuggestion: false });
    assert.equal(selectedRow(States.TYPING, data), 0);
  });

  it('selects a fully-typed command carrying params', () => {
    const data = makeData({ typed: 'open http://x', matches: ['open', 'opener'] });
    assert.equal(selectedRow(States.TYPING, data), 0);
  });

  it('follows matchIndex in RESULTS_OPEN (the arrowed row)', () => {
    const data = makeData({ typed: 'ags', matches: ['tags', 'stags'], matchIndex: 1 });
    assert.equal(selectedRow(States.RESULTS_OPEN, data), 1);
  });

  it('follows matchIndex in CHAIN_MODE', () => {
    const data = makeData({ typed: '', matches: ['format', 'save'], matchIndex: 1 });
    assert.equal(selectedRow(States.CHAIN_MODE, data), 1);
  });

  it('follows a Tab-cycled matchIndex in TYPING', () => {
    // tabCompleteCommand moves matchIndex off 0 and sets typed to that row's name.
    const data = makeData({ typed: 'stags ', matches: ['tags', 'stags'], matchIndex: 1 });
    assert.equal(selectedRow(States.TYPING, data), 1);
  });
});

// ===== Regression: openSelectedUrlResult must agree with selectedRow =====
// Peek bug (introduced by 8b602148): the TYPING + ENTER guard (selectedRowIsUrl)
// derives the row via selectedRow(), but panel.js's openSelectedUrlResult resolved
// its row from raw `state.matchIndex - state.matches.length` instead — the two
// readers only agreed while matchIndex happened to be 0. RESULTS_OPEN --Escape-->
// TYPING does not reset matchIndex (computeMatches only resets it on INPUT), so a
// stale non-zero matchIndex disagreed with the row TYPING re-highlights (always
// row 0 for a pure url lane — see autoSelectableRow). Escape now also dismisses
// the list, so the stale index is carried past it by a following INPUT — which
// reopens the list without resetting matchIndex under the stubbed computeMatches.
// This test mirrors panel.js's openSelectedUrlResult action to pin that both
// readers resolve the SAME row.
describe('Regression: openSelectedUrlResult resolves through selectedRow, not raw matchIndex', () => {
  it('after Escape leaves matchIndex stale, Enter opens the row selectedRow highlights', () => {
    let resolvedRow = null;
    const machine = makeMachine({
      openSelectedUrlResult(payload, data) {
        // Mirrors apps/desktop/renderer/cmd/panel.js openSelectedUrlResult(): resolve
        // through the SAME owner the selectedRowIsUrl guard uses.
        resolvedRow = selectedRow(machine.getState(), data);
      },
    });

    machine.setState(States.RESULTS_OPEN);
    const data = machine.getMutableData();
    data.matches = []; // pure url lane, 2 matches, 0 command matches
    data.urlMatches = [{ content: 'https://a.example' }, { content: 'https://b.example' }];

    // ArrowDown twice (bounded at the last row) -> matchIndex settles at 1.
    machine.dispatch(Events.ARROW_DOWN);
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(data.matchIndex, 1);

    // Escape back to TYPING. matchIndex is NOT reset by this transition, and the
    // list is dismissed on the way (staged Escape).
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
    assert.equal(data.matchIndex, 1, 'matchIndex is stale at 1 -- this is the bug setup');
    assert.equal(resultsListOpen(machine.getState(), data), false, 'Escape dismissed the list');

    // Typing again reopens the list. The stubbed computeMatches does no work, so
    // matchIndex stays stale at 1 while TYPING re-highlights row 0.
    machine.dispatch(Events.INPUT, { value: 'x' });
    assert.equal(data.matchIndex, 1, 'matchIndex is still stale after the reopen');

    const highlighted = selectedRow(machine.getState(), data);
    assert.equal(highlighted, 0, 'row 0 is what actually renders as selected after Escape');

    machine.dispatch(Events.ENTER, { value: 'x', isURL: false });

    assert.equal(resolvedRow, highlighted,
      'the row Enter opens must be the SAME row selectedRow reports as highlighted');
  });
});

// ===== Regression: a url-row CLICK opens the clicked row, not the selected one =====
// Peek bug (introduced by 1b6a62be): 1b6a62be routed the click path through the
// same openSelectedUrlResult -> selectedRow() as ENTER. But in TYPING, selectedRow
// goes through autoSelectableRow, which IGNORES matchIndex and returns the
// auto-selected row 0 for a pure url lane. So clicking the 2nd url row (payload
// index 1) opened the 1st (row 0). Enter and click legitimately choose different
// rows — the highlighted one vs. the clicked one — so the click path now has its
// own action (openClickedUrlResult) that reads the row from its OWN payload and
// never consults selectedRow. This test mirrors panel.js's openClickedUrlResult.
describe('Regression: url-row click opens the clicked row, not selectedRow', () => {
  it('clicking the 2nd url row in TYPING opens the 2nd, though selectedRow reports the 1st', () => {
    let clickedRow = null;
    const machine = makeMachine({
      openClickedUrlResult(payload, data) {
        // Mirrors apps/desktop/renderer/cmd/panel.js openClickedUrlResult(): resolve
        // the row from the payload index, NOT through selectedRow.
        if (payload?.index !== undefined) clickedRow = payload.index;
      },
    });

    machine.setState(States.TYPING);
    const data = machine.getMutableData();
    data.matches = []; // pure url lane, 2 matches, 0 command matches
    data.urlMatches = [{ content: 'https://a.example' }, { content: 'https://b.example' }];

    // selectedRow reports the auto-selected row 0 here (autoSelectableRow ignores
    // matchIndex) -- the WRONG answer for a click on the 2nd row. This is what the
    // old (openSelectedUrlResult-based) click path resolved.
    assert.equal(selectedRow(machine.getState(), data), 0,
      'selectedRow reports row 0 -- the row the buggy click path would have opened');

    // Click the 2nd url row. globalIndex = matches.length + 1 = 1.
    machine.dispatch(Events.CLICK_URL_RESULT, { index: 1 });

    assert.equal(clickedRow, 1,
      'the click must open the clicked row (1), not the selected row (0)');
  });
});

// ===== Regression: actions observe the state they transition INTO =====
// Peek bug (introduced by 8b602148's FSM-derived visibility): dispatch() ran the
// transition's actions BEFORE flipping currentState, so a render action reading
// machine.getState() saw the state being LEFT. renderResults derives #results
// visibility from resultsListOpen(getState(), ...); on a single-match ArrowDown
// (TYPING -> RESULTS_OPEN, total === 1) it evaluated the TYPING auto-open rule
// (total > 1 -> false) and hid the list it was opening (desktop-serial
// cmd-state-machine.spec.ts "TYPING -> RESULTS_OPEN on ArrowDown"). The state now
// flips before the actions run, so getState() inside an action is the target.
describe('Regression: an action observes the post-transition (target) state', () => {
  it('renderResults on a single-match TYPING->RESULTS_OPEN ArrowDown sees RESULTS_OPEN', () => {
    let stateSeenByAction = null;
    const machine = makeMachine({
      renderResults(payload, data) {
        stateSeenByAction = machine.getState();
      },
    });

    machine.setState(States.TYPING);
    machine.getMutableData().matches = ['settings']; // a SINGLE match (total === 1)

    machine.dispatch(Events.ARROW_DOWN);

    assert.equal(machine.getState(), States.RESULTS_OPEN);
    assert.equal(stateSeenByAction, States.RESULTS_OPEN,
      'the render action must run AFTER the state flips, or single-match visibility is computed against the stale TYPING rule');
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
    });
    assert.equal(machine.getState(), States.CLOSING);
  });

  // The typed text fully names the command ⇒ the FSM selects that row itself.
  // No `committed` payload flag: the machine decides, the panel just reports text.
  it('TYPING + Enter on a fully-typed command -> EXECUTING', () => {
    machine.getMutableData().typed = 'tags';
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    const result = machine.dispatch(Events.ENTER, {
      value: 'tags',
      isURL: false,
      commandName: 'tags'
    });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  // Strict-prefix inline suggestion, pref on, no params → Enter runs it.
  it('TYPING + Enter on a strict-prefix suggestion -> EXECUTING', () => {
    machine.getMutableData().typed = 'tag';
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    machine.dispatch(Events.ENTER, { value: 'tag', isURL: false });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  // Enter runs the row the ghost is drawn from — a substring-only (fuzzy) match
  // at the top of the ranked list is auto-selected and Enter executes it. Was:
  // "TYPING + Enter on a substring-only match -> TYPING (no-op)".
  it('TYPING + Enter on a substring-only match -> EXECUTING', () => {
    machine.getMutableData().typed = 'ags';
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    const result = machine.dispatch(Events.ENTER, { value: 'ags', isURL: false });
    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.EXECUTING);
  });

  // Bug repro (peek fd640c7e): typed "ta" draws the ghost "open tags" (a
  // noun-generated command ranked above the bare noun "tags" for this input,
  // see findMatchingCommands' token-prefix tier). Enter must run the row the
  // ghost is drawn from, not fail silently.
  it('TYPING + Enter on a noun-generated multi-word suggestion -> EXECUTING "open tags"', () => {
    // executeCommand (panel.js) reads state.matches[state.matchIndex] at the
    // moment it runs, before clearInput resets it — mirror that here rather
    // than reading data back afterward.
    let executedName = null;
    const localMachine = makeMachine({
      executeCommand(payload, data) {
        executedName = payload?.commandName || data.matches[data.matchIndex];
      },
    });
    localMachine.setState(States.TYPING);
    localMachine.getMutableData().typed = 'ta';
    localMachine.getMutableData().matches = ['open tags', 'tags'];
    localMachine.getMutableData().commands = {
      'open tags': { name: 'open tags' },
      tags: { name: 'tags' },
    };
    const result = localMachine.dispatch(Events.ENTER, { value: 'ta', isURL: false });
    assert.equal(result.handled, true);
    assert.equal(localMachine.getState(), States.EXECUTING);
    assert.equal(executedName, 'open tags');
  });

  // Pref off ⇒ a strict-prefix suggestion is not auto-run.
  it('TYPING + Enter on a strict-prefix suggestion with pref off -> TYPING (no-op)', () => {
    machine.getMutableData().typed = 'tag';
    machine.getMutableData().matches = ['tags'];
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    machine.getMutableData().enterRunsInlineSuggestion = false;
    const result = machine.dispatch(Events.ENTER, { value: 'tag', isURL: false });
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.TYPING);
  });

  // Suggested command that takes params → complete + param mode, not execute-with-empty-params.
  // Previously the panel faked this by dispatching a TAB; it is now an FSM branch.
  it('TYPING + Enter on a suggested command with params -> PARAM_MODE', () => {
    machine.getMutableData().typed = 'ope';
    machine.getMutableData().matches = ['open'];
    machine.getMutableData().commands = { open: { name: 'open', params: [{ name: 'url' }] } };
    machine.dispatch(Events.ENTER, { value: 'ope', isURL: false });
    assert.equal(machine.getState(), States.PARAM_MODE);
  });

  // The reported bug's URL half: the list auto-opened on 2 url rows, row 0 is
  // visibly selected, and Enter with no ArrowDown must open it (was a silent no-op).
  it('TYPING + Enter with an auto-selected url row -> CLOSING (opens the url)', () => {
    machine.getMutableData().typed = 'fast';
    machine.getMutableData().matches = [];
    machine.getMutableData().urlMatches = [
      { content: 'https://fast.example.com' },
      { content: 'https://example.com/fast' },
    ];
    machine._actionLog.length = 0;
    machine.dispatch(Events.ENTER, { value: 'fast', isURL: false });
    assert.equal(machine.getState(), States.CLOSING);
    assert.ok(machine._actionLog.includes('openSelectedUrlResult'),
      'the visibly-selected url row must be opened');
  });

  it('TYPING + Enter no match -> TYPING (no-op, search is explicit)', () => {
    const result = machine.dispatch(Events.ENTER, {
      value: 'xyzzy',
      isURL: false,
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
      commandName: 'tags'
    });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  it('RESULTS_OPEN + click result -> EXECUTING', () => {
    machine.getMutableData().commands = { tags: { name: 'tags' } };
    machine.dispatch(Events.CLICK_RESULT, { index: 0, commandName: 'tags' });
    assert.equal(machine.getState(), States.EXECUTING);
  });

  // Regression (peek item 5): after arrowing to a non-first command suggestion,
  // Enter must act on the HIGHLIGHTED match (state.matchIndex), not on the first
  // row or the raw typed text. The Enter target and the visual highlight share a
  // single source of truth (state.matchIndex), so this locks that they agree.
  it('RESULTS_OPEN + Enter after arrowing executes the highlighted match', () => {
    machine.getMutableData().commands = {
      tags: { name: 'tags' }, tag: { name: 'tag' }, settings: { name: 'settings' },
    };
    // Arrow down twice: matchIndex 0 -> 1 -> 2 ("settings"). The Enter target is
    // state.matches[state.matchIndex], so this is the row Enter must act on.
    machine.dispatch(Events.ARROW_DOWN);
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getData().matchIndex, 2);

    machine._actionLog.length = 0;
    machine.dispatch(Events.ENTER, { value: 'set', isURL: false });

    assert.equal(machine.getState(), States.EXECUTING);
    assert.ok(machine._actionLog.includes('executeCommand'),
      'executeCommand must run for the highlighted match');
    // executeCommand (reading state.matches[state.matchIndex]) runs BEFORE
    // clearInput in the ENTER action list, so it targets the arrowed row.
    assert.ok(machine._actionLog.indexOf('executeCommand') < machine._actionLog.indexOf('clearInput'),
      'executeCommand must run before clearInput resets matchIndex');
  });

  // Regression (peek item 5, guard-ordering): when the user has arrowed to an
  // explicit command selection, a URL-ish typed string (payload.isURL === true,
  // derived from the raw input rather than from matchIndex) must NOT preempt the
  // selection. Before the fix the RESULTS_OPEN isURL guard fired ahead of the
  // command-execute transition, opening the URL and IGNORING the highlighted row.
  it('RESULTS_OPEN + Enter honors arrowed command over a URL-ish typed string', () => {
    machine.getMutableData().commands = { tags: { name: 'tags' }, settings: { name: 'settings' } };
    machine.getMutableData().matches = ['tags', 'settings'];
    machine.getMutableData().matchIndex = 1; // arrowed to "settings"

    machine._actionLog.length = 0;
    // Typed text looks like a URL, so the panel would pass isURL: true.
    machine.dispatch(Events.ENTER, { value: 'settings.io', isURL: true });

    assert.equal(machine.getState(), States.EXECUTING,
      'arrowed command selection must execute, not open the typed URL');
    assert.ok(machine._actionLog.includes('executeCommand'),
      'executeCommand must run for the highlighted command');
    assert.ok(!machine._actionLog.includes('openURL'),
      'the typed-text isURL guard must NOT preempt an arrowed command selection');
  });

  it('RESULTS_OPEN + Escape -> TYPING', () => {
    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
  });

  // ArrowDown must cross from the last command row into the url-history
  // (Visited) lane — the combined command+url selection is one contiguous
  // index space (peek dbaa172d). The visual half of that bug (scrolling the
  // selected row into view) is covered by the cmd-url-ghost Playwright spec.
  it('ArrowDown crosses the last command row into the Visited url lane', () => {
    machine.getMutableData().matches = ['data', 'datastore'];
    machine.getMutableData().urlMatches = [{ content: 'https://data.example.com/a' }, { content: 'https://data.example.com/b' }];
    machine.getMutableData().matchIndex = 1; // last command selected
    const r = machine.dispatch(Events.ARROW_DOWN);
    assert.equal(r.handled, true, 'ArrowDown at last command should be handled (cross into url lane)');
    assert.equal(machine.getData().matchIndex, 2, 'matchIndex should advance into the first url row');
    // one more into the second url row
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getData().matchIndex, 3, 'matchIndex should advance to the second url row');
  });

  it('RESULTS_OPEN + Shift+Tab -> RESULTS_OPEN (cycles in place, never param mode)', () => {
    machine.getMutableData().commands = {
      tags: { name: 'tags' }, tag: { name: 'tag' }, settings: { name: 'settings', params: [{ type: 'text' }] },
    };
    machine.getMutableData().typed = 'settings';
    machine.getMutableData().matchIndex = 2;

    machine._actionLog.length = 0;
    const result = machine.dispatch(Events.SHIFT_TAB);

    assert.equal(result.handled, true);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
    assert.ok(machine._actionLog.includes('shiftTabCycleInResults'));
    assert.ok(machine._actionLog.includes('renderResults'));
  });

  it('RESULTS_OPEN + Shift+Tab with no matches -> not handled', () => {
    machine.getMutableData().matches = [];
    const result = machine.dispatch(Events.SHIFT_TAB);
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
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

  it('PARAM_MODE + ArrowDown on the last suggestion wraps to the first', () => {
    machine.getMutableData().paramSuggestions = [{ title: 'a' }, { title: 'b' }];
    machine.getMutableData().paramIndex = 1;
    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getState(), States.PARAM_MODE);
    assert.equal(machine.getData().paramIndex, 0);
  });

  it('PARAM_MODE + ArrowUp on the first suggestion wraps to the last', () => {
    machine.getMutableData().paramSuggestions = [{ title: 'a' }, { title: 'b' }];
    machine.getMutableData().paramIndex = 0;
    machine.dispatch(Events.ARROW_UP);
    assert.equal(machine.getState(), States.PARAM_MODE);
    assert.equal(machine.getData().paramIndex, 1);
  });

  it('PARAM_MODE + arrows with no suggestions do nothing', () => {
    machine.getMutableData().paramSuggestions = [];
    machine.getMutableData().paramIndex = -1;
    machine._actionLog.length = 0;
    machine.dispatch(Events.ARROW_DOWN);
    machine.dispatch(Events.ARROW_UP);
    assert.ok(!machine._actionLog.includes('navigateParamDown'));
    assert.ok(!machine._actionLog.includes('navigateParamUp'));
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

  describe('tag query row', () => {
    beforeEach(() => {
      const data = machine.getMutableData();
      data.typed = 'edit #todo';
      data.paramSuggestions = [
        { title: 'All items tagged #todo (12)', runTypedText: true },
        { title: 'Test Note', value: 'test-note', _item: { id: '123' } },
      ];
      data.paramIndex = 0;
    });

    it('Enter on the highlighted row executes with the typed text', () => {
      machine._actionLog.length = 0;
      machine.dispatch(Events.ENTER);
      assert.equal(machine.getState(), States.EXECUTING);
      assert.ok(!machine._actionLog.includes('acceptParamItem'));
      assert.ok(!machine._actionLog.includes('fillHighlightedParam'));
      assert.ok(machine._actionLog.includes('executeCommandWithParams'));
    });

    it('clicking the row executes with the typed text', () => {
      machine._actionLog.length = 0;
      machine.dispatch(Events.CLICK_PARAM, { index: 0 });
      assert.equal(machine.getState(), States.EXECUTING);
      assert.ok(!machine._actionLog.includes('acceptParamItem'));
      assert.ok(machine._actionLog.includes('executeCommandWithParams'));
    });

    it('Enter on a note arrowed down to accepts the note', () => {
      machine.dispatch(Events.ARROW_DOWN);
      machine._actionLog.length = 0;
      machine.dispatch(Events.ENTER);
      assert.equal(machine.getState(), States.EXECUTING);
      assert.ok(machine._actionLog.includes('acceptParamItem'));
      assert.ok(!machine._actionLog.includes('executeCommandWithParams'));
    });

    it('clicking a note accepts the note', () => {
      machine._actionLog.length = 0;
      machine.dispatch(Events.CLICK_PARAM, { index: 1 });
      assert.ok(machine._actionLog.includes('acceptParamItem'));
      assert.ok(!machine._actionLog.includes('executeCommandWithParams'));
    });

    it('plain text with no tag row accepts the first note', () => {
      const data = machine.getMutableData();
      data.typed = 'edit test';
      data.paramSuggestions = [{ title: 'Test Note', value: 'test-note', _item: { id: '123' } }];
      data.paramIndex = 0;
      machine._actionLog.length = 0;
      machine.dispatch(Events.ENTER);
      assert.ok(machine._actionLog.includes('acceptParamItem'));
      assert.ok(!machine._actionLog.includes('executeCommandWithParams'));
    });
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
    const result = machine.dispatch(Events.ENTER, { value: 'test' });
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

  it('EXECUTING + command_complete (output with publish entries) -> CLOSING', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: {
        data: { id: '123' },
        mimeType: 'item',
        publish: [{ topic: 'editor:open', payload: { itemId: '123' } }]
      } },
      name: 'edit'
    });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('EXECUTING + command_complete (publish with object data) -> CLOSING, skipping output selection', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: {
        data: { tags: ['todo'] },
        mimeType: 'tag-query',
        publish: [{ topic: 'editor:open', payload: { tags: ['todo'] } }]
      } },
      name: 'edit'
    });
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('EXECUTING + command_complete (item output without publish) does not close', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: { id: '123' }, mimeType: 'item' } },
      name: 'edit'
    });
    assert.notEqual(machine.getState(), States.CLOSING);
  });

  it('EXECUTING + command_complete (empty publish list) does not close', () => {
    machine.dispatch(Events.COMMAND_COMPLETE, {
      result: { output: { data: { tags: ['todo'] }, mimeType: 'tag-query', publish: [] } },
      name: 'edit'
    });
    assert.notEqual(machine.getState(), States.CLOSING);
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
    machine.dispatch(Events.ENTER, { value: 'format' });
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

  it('handleEscape tells the shutdown action the kernel will close the window', () => {
    const shutdownCalls = [];
    const machine = makeMachine({
      shutdown(payload) { shutdownCalls.push(payload); },
    });
    machine.setState(States.IDLE);

    const result = machine.handleEscape();
    assert.equal(result.handled, false);
    assert.equal(machine.getState(), States.CLOSING);
    assert.equal(shutdownCalls.length, 1);
    assert.equal(shutdownCalls[0]?.kernelCloses, true);
  });

  it('a direct ESCAPE dispatch (the keydown path) does not claim the kernel will close', () => {
    const shutdownCalls = [];
    const machine = makeMachine({
      shutdown(payload) { shutdownCalls.push(payload); },
    });
    machine.setState(States.IDLE);

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CLOSING);
    assert.equal(shutdownCalls.length, 1);
    assert.equal(shutdownCalls[0]?.kernelCloses, undefined);
  });

  // One press peels one layer. A visible dropdown is its own layer above the
  // typed text: the press that hides it must leave the text alone.
  it('staged Escape: dropdown, then text, then close', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    const data = machine.getMutableData();
    data.typed = 'ta';
    data.matches = ['tags', 'tag'];

    assert.equal(resultsListOpen(States.TYPING, data), true, 'two matches auto-open the list in TYPING');

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
    assert.equal(resultsListOpen(machine.getState(), machine.getData()), false, 'first Escape dismisses the list');
    assert.equal(data.typed, 'ta', 'the typed text survives the first Escape');
    assert.ok(machine._actionLog.includes('dropInlineGhost'), 'the inline ghost is taken away with the list');
    assert.ok(!machine._actionLog.includes('clearInput'), 'the first Escape must not clear the input');

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
    assert.equal(data.typed, '');

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CLOSING);
  });

  it('staged Escape from RESULTS_OPEN keeps the list closed in TYPING', () => {
    const machine = makeMachine();
    machine.setState(States.RESULTS_OPEN);
    const data = machine.getMutableData();
    data.typed = 'ta';
    data.matches = ['tags', 'tag', 'settings'];

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.TYPING);
    assert.equal(resultsListOpen(machine.getState(), machine.getData()), false,
      'TYPING must not re-derive the list as open just because the total is above 1');
    assert.equal(data.typed, 'ta');

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);
  });

  it('dismissed list reopens on new input and on ArrowDown', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    const data = machine.getMutableData();
    data.typed = 'ta';
    data.matches = ['tags', 'tag'];

    machine.dispatch(Events.ESCAPE);
    assert.equal(resultsListOpen(machine.getState(), machine.getData()), false);

    machine.dispatch(Events.INPUT, { value: 'tag' });
    assert.equal(resultsListOpen(machine.getState(), machine.getData()), true, 'new text reopens the list');

    machine.dispatch(Events.ESCAPE);
    assert.equal(resultsListOpen(machine.getState(), machine.getData()), false);

    machine.dispatch(Events.ARROW_DOWN);
    assert.equal(machine.getState(), States.RESULTS_OPEN);
    assert.equal(machine.getData().resultsDismissed, false, 'ArrowDown is the explicit reopen gesture');
  });

  it('no dropdown: Escape clears, then closes', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    const data = machine.getMutableData();
    data.typed = 'tags';
    data.matches = ['tags']; // total 1 — below the auto-open threshold

    assert.equal(resultsListOpen(States.TYPING, data), false);

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.IDLE);

    machine.dispatch(Events.ESCAPE);
    assert.equal(machine.getState(), States.CLOSING);
  });

  // The empty-input degenerate case (one Escape closes) is covered by
  // 'IDLE + Escape -> CLOSING' in the IDLE transitions describe.
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
    machine.getMutableData().resultsDismissed = true;

    machine.reset();

    assert.equal(machine.getState(), States.IDLE);
    assert.equal(machine.getData().resultsDismissed, false);
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

// ===== Input claimed by a command =====

describe('TYPING + Enter on input a command claims', () => {
  it('runs the claiming command and closes', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    machine._actionLog.length = 0;

    machine.dispatch(Events.ENTER, { value: '#todo', claimedBy: 'search' });

    assert.equal(machine.getState(), States.CLOSING);
    assert.ok(machine._actionLog.includes('executeClaimingCommand'));
    assert.ok(machine._actionLog.indexOf('executeClaimingCommand') < machine._actionLog.indexOf('clearInput'));
    assert.ok(!machine._actionLog.includes('executeCommand'));
  });

  it('does nothing when no command claims the text', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    machine._actionLog.length = 0;

    machine.dispatch(Events.ENTER, { value: '#todo', claimedBy: null });

    assert.equal(machine.getState(), States.TYPING);
    assert.ok(!machine._actionLog.includes('executeClaimingCommand'));
  });

  it('a URL still opens as a URL ahead of a claim', () => {
    const machine = makeMachine();
    machine.setState(States.TYPING);
    machine._actionLog.length = 0;

    machine.dispatch(Events.ENTER, { value: 'a.io', isURL: true, claimedBy: 'search' });

    assert.ok(machine._actionLog.includes('openURL'));
    assert.ok(!machine._actionLog.includes('executeClaimingCommand'));
  });
});

// ===== Command whose window is already open =====

describe('a "Switch to window" row after a command whose window is open', () => {
  const ROW = 'Switch to window: open things';

  // The command row followed by its switch row, as the panel builds them.
  function windowMachine(state, matches = ['open things', ROW]) {
    const machine = makeMachine();
    machine.setState(state);
    const data = machine.getMutableData();
    data.commands = { 'open things': { name: 'open things', opensUrl: 'peek://things/home.html' }, tags: { name: 'tags' } };
    data.matches = matches;
    data.typed = 'open things';
    data.switchRows = new Map([[ROW, { command: 'open things', url: 'peek://things/home.html' }]]);
    machine._actionLog.length = 0;
    return machine;
  }

  it('Enter in TYPING runs the command, not the switch', () => {
    const machine = windowMachine(States.TYPING);
    machine.dispatch(Events.ENTER, { value: 'open things', commandName: 'open things' });

    assert.equal(machine.getState(), States.EXECUTING);
    assert.ok(machine._actionLog.includes('executeCommand'));
    assert.ok(!machine._actionLog.includes('switchToRowWindow'));
  });

  it('Enter on the command row in RESULTS_OPEN runs the command', () => {
    const machine = windowMachine(States.RESULTS_OPEN);
    machine.dispatch(Events.ENTER, { value: 'open things', commandName: 'open things' });

    assert.equal(machine.getState(), States.EXECUTING);
    assert.ok(machine._actionLog.includes('executeCommand'));
    assert.ok(!machine._actionLog.includes('switchToRowWindow'));
  });

  it('the command row is highlighted first and the list shows for a lone match', () => {
    const machine = windowMachine(States.TYPING);
    const data = machine.getData();
    assert.equal(resultsListOpen(States.TYPING, data), true);
    assert.equal(selectedRow(States.TYPING, data), 0);
  });

  it('Enter on the highlighted switch row switches to the window', () => {
    const machine = windowMachine(States.RESULTS_OPEN);
    machine.getMutableData().matchIndex = 1;
    machine.dispatch(Events.ENTER, { value: 'open things' });

    assert.equal(machine.getState(), States.CLOSING);
    assert.ok(machine._actionLog.includes('switchToRowWindow'));
    assert.ok(!machine._actionLog.includes('executeCommand'));
  });

  it('a click on the switch row switches to the window', () => {
    const machine = windowMachine(States.TYPING);
    machine.dispatch(Events.CLICK_RESULT, { index: 1, commandName: ROW });

    assert.equal(machine.getState(), States.CLOSING);
    assert.ok(machine._actionLog.includes('switchToRowWindow'));
    assert.ok(!machine._actionLog.includes('executeCommand'));
  });

  it('a click on the command row runs the command', () => {
    const machine = windowMachine(States.TYPING);
    machine.dispatch(Events.CLICK_RESULT, { index: 0, commandName: 'open things' });

    assert.equal(machine.getState(), States.EXECUTING);
    assert.ok(machine._actionLog.includes('executeCommand'));
    assert.ok(!machine._actionLog.includes('switchToRowWindow'));
  });

  it('without a switch row the lone command keeps the list closed', () => {
    const machine = windowMachine(States.TYPING, ['open things']);
    assert.equal(resultsListOpen(States.TYPING, machine.getData()), false);
  });
});
