import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_TIMED_OUT_CODE,
  buildErrorPageUrl,
  contentReportsFirstFrame,
  describeLoadError,
  failedUrlFromErrorPage,
  isErrorPageUrl,
  nextLoadPhase,
  savedWindowUrl,
} from './page-load-error.js';

describe('contentReportsFirstFrame', () => {
  it('is true for a web page with the preload attached', () => {
    assert.equal(contentReportsFirstFrame(true, 'https://example.com/'), true);
    assert.equal(contentReportsFirstFrame(true, 'data:text/html,hi'), true);
  });
  it('is false for any content without the preload', () => {
    assert.equal(contentReportsFirstFrame(false, 'https://example.com/'), false);
    assert.equal(contentReportsFirstFrame(false, 'peek://app/new-tab/index.html'), false);
  });
  it('is false for internal peek:// pages even with the preload', () => {
    assert.equal(contentReportsFirstFrame(true, 'peek://app/new-tab/index.html'), false);
    assert.equal(contentReportsFirstFrame(true, buildErrorPageUrl('http://x/', -7, 'timed out')), false);
  });
  it('depends on the preload alone when there is no url', () => {
    assert.equal(contentReportsFirstFrame(true, ''), true);
    assert.equal(contentReportsFirstFrame(false, undefined), false);
  });
});

describe('savedWindowUrl', () => {
  it('saves the failed address for a window showing the load-error page', () => {
    const failed = 'http://127.0.0.1:9/hang';
    assert.equal(savedWindowUrl(buildErrorPageUrl(failed, LOAD_TIMED_OUT_CODE, 'timed out')), failed);
  });
  it('saves any other address unchanged', () => {
    assert.equal(savedWindowUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(savedWindowUrl(''), '');
  });
  it('keeps the error page URL when it carries no failed address', () => {
    const bare = 'peek://app/page-error/index.html';
    assert.equal(savedWindowUrl(bare), bare);
  });
});

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
