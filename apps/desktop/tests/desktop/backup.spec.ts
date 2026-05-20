import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import fs from 'fs';
import os from 'os';
import path from 'path';

test.describe('Backup @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('backup'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('backup-get-config returns config object', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.backup.getConfig();
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data.enabled).toBe('boolean');
    expect(typeof result.data.backupDir).toBe('string');
    expect(typeof result.data.retentionCount).toBe('number');
    expect(typeof result.data.lastBackupTime).toBe('number');
  });

  test('backup is disabled when backupDir is not configured', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.backup.getConfig();
    });

    expect(result.success).toBe(true);
    // By default, backupDir should be empty and backups disabled
    expect(result.data.backupDir).toBe('');
    expect(result.data.enabled).toBe(false);
  });

  test('backup-create returns error when not configured', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.backup.create();
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('backup-list returns empty when not configured', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.backup.list();
    });

    expect(result.success).toBe(true);
    expect(result.data.backups).toEqual([]);
    expect(result.data.backupDir).toBe('');
  });

  test('backup works when backupDir is configured', async () => {
    // Create temp directory for test backups
    const tempBackupDir = path.join(os.tmpdir(), `peek-backup-test-${Date.now()}`);
    fs.mkdirSync(tempBackupDir, { recursive: true });

    try {
      // Store the current prefs and configure backup
      const setupResult = await bgWindow.evaluate(async (backupDir: string) => {
        const api = (window as any).app;

        // Get current prefs
        const prefsResult = await api.datastore.getTable('feature_settings');
        const corePrefsRow = Object.values(prefsResult.data || {}).find(
          (r: any) => r.featureId === 'core' && r.key === 'prefs'
        ) as any;
        const originalPrefs = corePrefsRow ? JSON.parse(corePrefsRow.value) : {};

        // Set backupDir in core prefs
        const newPrefs = { ...originalPrefs, backupDir };
        await api.datastore.setRow('feature_settings', 'core:prefs', {
          featureId: 'core',
          key: 'prefs',
          value: JSON.stringify(newPrefs),
          updatedAt: Date.now()
        });

        return { originalPrefs };
      }, tempBackupDir);

      // Verify config reflects the change
      const configResult = await bgWindow.evaluate(async () => {
        return await (window as any).app.backup.getConfig();
      });
      expect(configResult.success).toBe(true);
      expect(configResult.data.backupDir).toBe(tempBackupDir);
      expect(configResult.data.enabled).toBe(true);

      // Create a backup
      const backupResult = await bgWindow.evaluate(async () => {
        return await (window as any).app.backup.create();
      });
      expect(backupResult.success).toBe(true);
      expect(backupResult.path).toBeTruthy();
      expect(backupResult.path.endsWith('.zip')).toBe(true);

      // Verify the file exists
      expect(fs.existsSync(backupResult.path)).toBe(true);

      // List backups - should have one
      const listResult = await bgWindow.evaluate(async () => {
        return await (window as any).app.backup.list();
      });
      expect(listResult.success).toBe(true);
      expect(listResult.data.backups.length).toBe(1);

      // Restore original prefs
      await bgWindow.evaluate(async (originalPrefs: Record<string, unknown>) => {
        const api = (window as any).app;
        await api.datastore.setRow('feature_settings', 'core:prefs', {
          featureId: 'core',
          key: 'prefs',
          value: JSON.stringify(originalPrefs),
          updatedAt: Date.now()
        });
      }, setupResult.originalPrefs);
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tempBackupDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});
