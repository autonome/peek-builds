// NOTE: Tests in this describe have intra-test ordering dependencies:
//   validate → add → list → update (enable/disable) → remove
// They must run in declared order. Under fullyParallel: false this is
// guaranteed. If you ever enable per-test parallelism for this file,
// refactor each test to be self-contained first.

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../..');

test.describe('Extension Lifecycle @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  const EXAMPLE_EXT_PATH = path.join(ROOT, 'features', 'example');

  test.beforeAll(async () => {
    app = await launchDesktopApp('test-ext-lifecycle');
    bgWindow = await app.getBackgroundWindow();
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('validate extension folder', async () => {
    const result = await bgWindow.evaluate(async (extPath: string) => {
      return await (window as any).app.extensions.validateFolder(extPath);
    }, EXAMPLE_EXT_PATH);

    expect(result.success).toBe(true);
    expect(result.data).toBeTruthy();
    expect(result.data.manifest).toBeTruthy();
    expect(result.data.manifest.id || result.data.manifest.shortname || result.data.manifest.name).toBeTruthy();
  });

  test('add extension', async () => {
    // First validate to get manifest
    const validateResult = await bgWindow.evaluate(async (extPath: string) => {
      return await (window as any).app.extensions.validateFolder(extPath);
    }, EXAMPLE_EXT_PATH);

    const manifest = validateResult.data.manifest;

    // Add the extension
    const addResult = await bgWindow.evaluate(async ({ extPath, manifest }) => {
      return await (window as any).app.extensions.add(extPath, manifest, false);
    }, { extPath: EXAMPLE_EXT_PATH, manifest });

    expect(addResult.success).toBe(true);
    expect(addResult.data).toBeTruthy();
    expect(addResult.data.id).toBeTruthy();
  });

  test('list extensions includes added extension', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.getAll();
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);

    // Find the example extension
    const exampleExt = result.data.find((ext: any) =>
      ext.id === 'example' || ext.path?.includes('example')
    );
    expect(exampleExt).toBeTruthy();
  });

  test('update extension (enable/disable)', async () => {
    // Enable the extension
    const enableResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.update('example', { enabled: true });
    });
    expect(enableResult.success).toBe(true);

    // Verify it's enabled (accept both boolean true and integer 1)
    const getResult1 = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.get('example');
    });
    expect(getResult1.success).toBe(true);
    expect(getResult1.data.enabled === true || getResult1.data.enabled === 1).toBe(true);

    // Disable it
    const disableResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.update('example', { enabled: false });
    });
    expect(disableResult.success).toBe(true);

    // Verify it's disabled
    const getResult2 = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.get('example');
    });
    expect(getResult2.success).toBe(true);
    expect(getResult2.data.enabled === false || getResult2.data.enabled === 0).toBe(true);
  });

  test('remove extension', async () => {
    const removeResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.remove('example');
    });
    expect(removeResult.success).toBe(true);

    // Verify it's removed
    const getResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.get('example');
    });
    expect(getResult.success).toBe(false);

    // Verify it's not in list
    const listResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.extensions.getAll();
    });
    expect(listResult.success).toBe(true);
    const exampleExt = listResult.data.find((ext: any) => ext.id === 'example');
    expect(exampleExt).toBeFalsy();
  });
});
