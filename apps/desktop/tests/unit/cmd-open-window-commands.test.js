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
const { openWindowForCommand, commandOpenUrls } = await import(
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
