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
const {
  openWindowForCommand, commandOpenUrls, addressKey, openWindowIdFor,
  withOpenWindowAnswers, inputTargetAddress, hasOpenWindowAnswer,
} = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'open-window-commands.js'));

const URL_A = 'peek://things/home.html';

describe('addressKey', () => {
  it('maps every spelling of one web page to one key', () => {
    const keys = [
      'https://wikipedia.org',
      'https://wikipedia.org/',
      'http://wikipedia.org',
      'https://www.Wikipedia.org/',
      'https://wikipedia.org:443/',
      'https://wikipedia.org/?#',
    ].map(addressKey);
    assert.equal(new Set(keys).size, 1);
    assert.notEqual(keys[0], null);
  });

  it('keeps path, port and query distinct', () => {
    assert.notEqual(addressKey('https://a.com/x'), addressKey('https://a.com/'));
    assert.notEqual(addressKey('https://a.com:8080/'), addressKey('https://a.com/'));
    assert.notEqual(addressKey('https://a.com/?q=1'), addressKey('https://a.com/'));
    assert.equal(addressKey('https://a.com/x/'), addressKey('https://a.com/x'));
    assert.equal(addressKey('https://a.com/?b=2&a=1'), addressKey('https://a.com/?a=1&b=2'));
  });

  it('ignores a trailing slash on peek addresses', () => {
    assert.equal(addressKey('peek://spaces'), addressKey('peek://spaces/'));
    assert.notEqual(addressKey('peek://spaces'), addressKey('peek://things'));
  });

  it('null for what cannot be open in a window', () => {
    assert.equal(addressKey('wikipedia.org'), null);
    assert.equal(addressKey(null), null);
    assert.equal(addressKey('file:///x'), null);
  });
});

describe('open window answers', () => {
  it('one answer serves every spelling of the page', () => {
    const ids = withOpenWindowAnswers(new Map(), ['https://www.wikipedia.org/', 'https://wikipedia.org'], {
      'https://www.wikipedia.org/': 7,
      'https://wikipedia.org': null,
    });
    assert.equal(openWindowIdFor('https://wikipedia.org', ids), 7);
    assert.equal(openWindowIdFor('wikipedia.org', ids), null);
    assert.equal(hasOpenWindowAnswer('https://wikipedia.org/', ids), true);
    assert.equal(hasOpenWindowAnswer('https://other.com', ids), false);
  });

  it('a later answer replaces an earlier one', () => {
    const before = withOpenWindowAnswers(new Map(), ['peek://a'], { 'peek://a': 3 });
    const after = withOpenWindowAnswers(before, ['peek://a'], { 'peek://a': null });
    assert.equal(openWindowIdFor('peek://a', after), null);
    assert.equal(openWindowIdFor('peek://a', before), 3);
  });
});

describe('inputTargetAddress', () => {
  it('a highlighted row is decisive, even without an address', () => {
    const t = { highlighted: { active: true, address: null }, completion: 'https://x.com', typed: 'https://y.com' };
    assert.equal(inputTargetAddress(t), null);
    assert.equal(inputTargetAddress({ ...t, highlighted: { active: true, address: 'peek://a' } }), 'peek://a');
  });

  it('otherwise completion, typed, selected row, command in that order', () => {
    const none = { highlighted: { active: false } };
    assert.equal(inputTargetAddress({ ...none, completion: 'c', typed: 't', selectedRow: 's', command: 'm' }), 'c');
    assert.equal(inputTargetAddress({ ...none, typed: 't', selectedRow: 's', command: 'm' }), 't');
    assert.equal(inputTargetAddress({ ...none, selectedRow: 's', command: 'm' }), 's');
    assert.equal(inputTargetAddress({ ...none, command: 'm' }), 'm');
    assert.equal(inputTargetAddress(none), null);
  });
});

describe('openWindowForCommand', () => {
  const cmd = { name: 'open things', opensUrl: URL_A };
  const open = (url, id) => new Map([[addressKey(url), id]]);

  it('names the open window', () => {
    assert.deepEqual(openWindowForCommand(cmd, open(URL_A, 4)), { url: URL_A, id: 4 });
  });

  it('null when the window is not open', () => {
    assert.equal(openWindowForCommand(cmd, open(URL_A, null)), null);
    assert.equal(openWindowForCommand(cmd, new Map()), null);
    assert.equal(openWindowForCommand(cmd, undefined), null);
  });

  it('null for a command that opens no window', () => {
    assert.equal(openWindowForCommand({ name: 'tags' }, open(URL_A, 4)), null);
    assert.equal(openWindowForCommand(undefined, open(URL_A, 4)), null);
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
