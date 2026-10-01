import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_TIMED_OUT_CODE,
  buildErrorPageUrl,
  describeLoadError,
  failedUrlFromErrorPage,
  isErrorPageUrl,
  nextLoadPhase,
} from './page-load-error.js';

describe('nextLoadPhase', () => {
  it('arms the timer when a load starts', () => {
    assert.deepEqual(nextLoadPhase('idle', { type: 'started' }), { phase: 'loading', effect: 'arm-timer' });
  });
  it('clears the timer when a load stops', () => {
    assert.deepEqual(nextLoadPhase('loading', { type: 'stopped' }), { phase: 'idle', effect: 'clear-timer' });
  });
  it('shows the error page when the timeout fires during a load', () => {
    assert.deepEqual(nextLoadPhase('loading', { type: 'timeout' }), { phase: 'failed', effect: 'show-error' });
  });
  it('ignores a timeout that fires after the load already ended', () => {
    assert.deepEqual(nextLoadPhase('idle', { type: 'timeout' }), { phase: 'idle', effect: null });
  });
  it('shows the error page for a real failure', () => {
    assert.deepEqual(nextLoadPhase('loading', { type: 'failed', code: -102 }), { phase: 'failed', effect: 'show-error' });
  });
  it('treats an aborted load as no change', () => {
    assert.deepEqual(nextLoadPhase('loading', { type: 'failed', code: -3 }), { phase: 'loading', effect: null });
  });
  it('keeps the failed state through the stop that follows the failure', () => {
    assert.deepEqual(nextLoadPhase('failed', { type: 'stopped' }), { phase: 'failed', effect: null });
  });
  it('does not time out the error page itself', () => {
    assert.deepEqual(nextLoadPhase('loading', { type: 'error-page-started' }), { phase: 'failed', effect: 'clear-timer' });
  });
});

describe('describeLoadError', () => {
  it('names each case in plain language', () => {
    assert.match(describeLoadError(-102).title, /refused/i);
    assert.match(describeLoadError(-105).title, /not found/i);
    assert.match(describeLoadError(-300).reason, /not a valid address/i);
    assert.match(describeLoadError(LOAD_TIMED_OUT_CODE).reason, /not answering/i);
    assert.match(describeLoadError(-106).title, /cannot reach/i);
  });
});

describe('error page url', () => {
  it('round-trips the failed address, including a garbage one', () => {
    const bad = 'asdl;fkadlflk;asd;lfdlk;jadf';
    const u = buildErrorPageUrl(bad, -300, 'ERR_INVALID_URL');
    assert.equal(isErrorPageUrl(u), true);
    assert.equal(failedUrlFromErrorPage(u), bad);
  });
  it('is null for other urls', () => {
    assert.equal(failedUrlFromErrorPage('https://example.com/'), null);
    assert.equal(isErrorPageUrl(undefined), false);
  });
});
