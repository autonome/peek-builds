/**
 * Unit tests for renderer/cmd/open-window-commands.js: commands whose window is
 * already open.
 * Run via: node --test tests/unit/cmd-open-window-commands.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { openWindowForCommand, commandOpenUrls, withSwitchRows, SWITCH_ROW_PREFIX } = await import(
  join(__dirname, '..', '..', 'renderer', 'cmd', 'open-window-commands.js')
);

const URL_A = 'peek://things/home.html';

describe('openWindowForCommand', () => {
  const cmd = { name: 'open things', opensUrl: URL_A };

  it('names the open window', () => {
    assert.deepEqual(openWindowForCommand(cmd, new Map([[URL_A, 4]])), { url: URL_A, id: 4 });
  });

  it('null when the window is not open', () => {
    assert.equal(openWindowForCommand(cmd, new Map([[URL_A, null]])), null);
    assert.equal(openWindowForCommand(cmd, new Map()), null);
    assert.equal(openWindowForCommand(cmd, undefined), null);
  });

  it('null for a command that opens no window', () => {
    assert.equal(openWindowForCommand({ name: 'tags' }, new Map([[URL_A, 4]])), null);
    assert.equal(openWindowForCommand(undefined, new Map([[URL_A, 4]])), null);
  });
});

describe('withSwitchRows', () => {
  const commands = {
    'open things': { opensUrl: URL_A },
    tags: {},
  };
  const open = new Map([[URL_A, 4]]);

  it('adds a switch row right after the command whose window is open', () => {
    const { matches, rows } = withSwitchRows(['tags', 'open things'], commands, open);
    assert.deepEqual(matches, ['tags', 'open things', `${SWITCH_ROW_PREFIX}open things`]);
    assert.deepEqual(rows.get(`${SWITCH_ROW_PREFIX}open things`), { command: 'open things', url: URL_A });
  });

  it('adds a row for a lone match', () => {
    assert.equal(withSwitchRows(['open things'], commands, open).matches.length, 2);
  });

  it('adds nothing when the window is not open', () => {
    const { matches, rows } = withSwitchRows(['open things'], commands, new Map([[URL_A, null]]));
    assert.deepEqual(matches, ['open things']);
    assert.equal(rows.size, 0);
  });

  it('drops rows from an earlier call when applied again', () => {
    const first = withSwitchRows(['open things'], commands, open);
    const again = withSwitchRows(first.matches, commands, new Map(), first.rows);
    assert.deepEqual(again.matches, ['open things']);
    const same = withSwitchRows(first.matches, commands, open, first.rows);
    assert.deepEqual(same.matches, first.matches);
  });
});

describe('commandOpenUrls', () => {
  it('lists the addresses the named commands open, once each', () => {
    const commands = {
      a: { opensUrl: URL_A },
      b: { opensUrl: URL_A },
      c: {},
    };
    assert.deepEqual(commandOpenUrls(commands, ['a', 'b', 'c', 'missing']), [URL_A]);
  });
});
