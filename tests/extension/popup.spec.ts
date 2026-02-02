/**
 * Browser Extension Popup Tests
 *
 * Tests for the command bar popup (popup.html/popup.js).
 * Run with: BROWSER=chrome yarn test:extension:browser
 */

import { test, expect } from '@playwright/test';
import { getSharedExtension, closeSharedExtension, ExtensionApp } from '../fixtures/extension-app';
import {
  waitForCommandInput,
  typeCommand,
  tabComplete,
  executeCommand,
  getTypedText,
  getDisplayText,
  isPlaceholderShown,
  getTypedPortion,
} from '../helpers/extension-utils';
import { Page } from '@playwright/test';

let ext: ExtensionApp;
let popup: Page;

test.beforeAll(async () => {
  ext = await getSharedExtension();
});

test.afterAll(async () => {
  await closeSharedExtension();
});

test.beforeEach(async () => {
  // Open a fresh popup for each test
  popup = await ext.openPopup();
  await waitForCommandInput(popup);
});

test.afterEach(async () => {
  // Close the popup page
  if (popup && !popup.isClosed()) {
    await popup.close();
  }
});

test.describe('Popup Command Bar', () => {
  test('shows placeholder text when empty', async () => {
    const placeholder = await isPlaceholderShown(popup);
    expect(placeholder).toBe(true);

    const displayText = await getDisplayText(popup);
    expect(displayText).toBe('tag, note, or search...');
  });

  test('hides placeholder when typing', async () => {
    await typeCommand(popup, 't');

    const placeholder = await isPlaceholderShown(popup);
    expect(placeholder).toBe(false);
  });

  test('autocompletes "t" to show "tag" suggestion', async () => {
    await typeCommand(popup, 't');

    const displayText = await getDisplayText(popup);
    // Should show typed 't' plus autocomplete suggestion 'ag'
    expect(displayText).toBe('tag');

    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('t');
  });

  test('autocompletes "n" to show "note" suggestion', async () => {
    await typeCommand(popup, 'n');

    const displayText = await getDisplayText(popup);
    expect(displayText).toBe('note');

    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('n');
  });

  test('autocompletes "s" to show "search" suggestion', async () => {
    await typeCommand(popup, 's');

    const displayText = await getDisplayText(popup);
    expect(displayText).toBe('search');

    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('s');
  });

  test('Tab completes the command', async () => {
    await typeCommand(popup, 't');
    await tabComplete(popup);

    const inputValue = await getTypedText(popup);
    expect(inputValue).toBe('tag ');
  });

  test('Tab completes "no" to "note "', async () => {
    await typeCommand(popup, 'no');
    await tabComplete(popup);

    const inputValue = await getTypedText(popup);
    expect(inputValue).toBe('note ');
  });

  test('Tab completes "se" to "search "', async () => {
    await typeCommand(popup, 'se');
    await tabComplete(popup);

    const inputValue = await getTypedText(popup);
    expect(inputValue).toBe('search ');
  });

  test('Enter with partial command completes it', async () => {
    await typeCommand(popup, 't');
    await executeCommand(popup);

    // Should autocomplete to "tag " since no args provided
    const inputValue = await getTypedText(popup);
    expect(inputValue).toBe('tag ');
  });

  test('no autocomplete for non-matching input', async () => {
    await typeCommand(popup, 'x');

    const displayText = await getDisplayText(popup);
    // Should only show what was typed, no suggestion
    expect(displayText).toBe('x');

    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('x');
  });

  test('preserves case in typed text display', async () => {
    await typeCommand(popup, 'TAG');

    // Typed text should be preserved as-is in display
    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('TAG');

    // But autocomplete still shows (matching is case-insensitive)
    const displayText = await getDisplayText(popup);
    // Display shows typed portion + rest of suggestion
    expect(displayText).toContain('TAG');
  });

  test('no suggestion shown after space (args mode)', async () => {
    await typeCommand(popup, 'tag ');

    // After space, should just show what's typed
    const displayText = await getDisplayText(popup);
    expect(displayText).toBe('tag ');
  });

  test('shows typed text with args', async () => {
    await typeCommand(popup, 'tag foo, bar');

    const displayText = await getDisplayText(popup);
    expect(displayText).toBe('tag foo, bar');

    const typedPortion = await getTypedPortion(popup);
    expect(typedPortion).toBe('tag foo, bar');
  });

  test('input is focused on popup open', async () => {
    const isFocused = await popup.evaluate(() => {
      return document.activeElement?.id === 'command-input';
    });
    expect(isFocused).toBe(true);
  });

  test('input accepts text input', async () => {
    // Type using keyboard instead of fill
    await popup.keyboard.type('tag test');

    const inputValue = await getTypedText(popup);
    expect(inputValue).toBe('tag test');
  });
});
