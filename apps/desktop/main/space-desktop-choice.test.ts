// The desktop-choice rule for opening a space
// (docs/design/space-desktop-return-plan.md, section 1.4), against the real
// implementation — the module is electron-free, so no mirroring.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { chooseSpaceDesktopTarget } from './space-desktop-choice.js';

describe('chooseSpaceDesktopTarget (the desktop a space opening takes the user to)', () => {
  it('no switch when any recorded window is on the current desktop', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['3', '3', '1'], '1', ['1', '2', '3']), null);
  });

  it('the recorded desktop with the most windows wins', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['3', '3', '5'], '1', ['1', '3', '5']), '3');
    assert.strictEqual(chooseSpaceDesktopTarget(['5', '5', '3'], '1', ['1', '3', '5']), '5');
  });

  it('a tie breaks to the desktop nearest the current one in swipe order', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['3', '5'], '1', ['1', '3', '5']), '3');
    assert.strictEqual(chooseSpaceDesktopTarget(['1', '5'], '3', ['1', '3', '5']), '1');
  });

  it('nothing recorded yields no target', () => {
    assert.strictEqual(chooseSpaceDesktopTarget([], '1', ['1', '3']), null);
  });

  it('an unknown current desktop yields no target', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['3'], null, ['1', '3']), null);
  });

  it('recorded desktops that no longer exist in the layout are ignored', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['9'], '1', ['1', '3']), null);
    assert.strictEqual(chooseSpaceDesktopTarget(['9', '3'], '1', ['1', '3']), '3');
  });

  it('windows recorded off-layout do not defeat the already-here rule', () => {
    assert.strictEqual(chooseSpaceDesktopTarget(['9', '1'], '1', ['1', '3']), null);
  });
});
