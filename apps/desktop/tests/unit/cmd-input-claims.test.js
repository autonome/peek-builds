/**
 * Unit tests for renderer/cmd/input-claims.js: commands that take typed text
 * which is not a command name.
 * Run via: node --test tests/unit/cmd-input-claims.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { commandClaimsInput, findClaimingCommand } = await import(
  join(__dirname, '..', '..', 'renderer', 'cmd', 'input-claims.js')
);

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'features', 'search', 'manifest.json'), 'utf8'));
const searchClaim = manifest.commands.find(c => c.name === 'search').claimsInput;

describe('commandClaimsInput', () => {
  it('false for a command with no claim', () => {
    assert.equal(commandClaimsInput({ name: 'tags' }, '#todo'), false);
  });

  it('function claim receives the text', () => {
    assert.equal(commandClaimsInput({ claimsInput: t => t === 'abc' }, 'abc'), true);
    assert.equal(commandClaimsInput({ claimsInput: t => t === 'abc' }, 'abd'), false);
  });

  it('a throwing function claim does not claim', () => {
    assert.equal(commandClaimsInput({ claimsInput: () => { throw new Error('x'); } }, 'a'), false);
  });

  it('search declares the all-hashtag shape', () => {
    const cmd = { claimsInput: searchClaim };
    assert.equal(commandClaimsInput(cmd, '#todo'), true);
    assert.equal(commandClaimsInput(cmd, '#todo   #today'), true);
    assert.equal(commandClaimsInput(cmd, '#todo foo'), false);
    assert.equal(commandClaimsInput(cmd, '#'), false);
    assert.equal(commandClaimsInput(cmd, '##a'), false);
    assert.equal(commandClaimsInput(cmd, ''), false);
    assert.equal(commandClaimsInput(cmd, 'foo'), false);
  });

  it('an invalid pattern does not claim', () => {
    assert.equal(commandClaimsInput({ claimsInput: { tokenPattern: '(' } }, 'a'), false);
  });
});

describe('findClaimingCommand', () => {
  const commands = { tags: { name: 'tags' }, search: { name: 'search', claimsInput: searchClaim } };

  it('names the claiming command', () => {
    assert.equal(findClaimingCommand(commands, '#todo'), 'search');
  });

  it('null when nothing claims the text', () => {
    assert.equal(findClaimingCommand(commands, 'hello'), null);
    assert.equal(findClaimingCommand({}, '#todo'), null);
  });
});
