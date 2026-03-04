#!/usr/bin/env node

/**
 * browser-import CLI
 *
 * Indexes browser profiles on disk and imports their data
 * into a Peek datastore database.
 *
 * Usage:
 *   browser-import discover                          List all found browser profiles
 *   browser-import inspect <profile>                 Show what data is available
 *   browser-import import <profile> [options]        Import data into Peek DB
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { discoverAllProfiles, findProfile } from './profiles.js';
import { firefoxReader } from './browsers/firefox.js';
import { chromeReader } from './browsers/chrome.js';
import { importHistory, importBookmarks, importSessions } from './importers/index.js';
import { openDatabase, closeDatabase } from './datastore.js';
import type { BrowserProfile, BrowserName, ImportType } from './types.js';
import type { BrowserReader } from './browsers/types.js';

const program = new Command();

program
  .name('browser-import')
  .description('Import browser history, bookmarks, and sessions into a Peek datastore')
  .version('1.0.0');

// ==================== discover ====================

program
  .command('discover')
  .description('List all browser profiles found on this system')
  .action(() => {
    const profiles = discoverAllProfiles();

    if (profiles.length === 0) {
      console.log(chalk.yellow('No browser profiles found.'));
      return;
    }

    console.log(chalk.bold(`\nFound ${profiles.length} browser profile(s):\n`));

    for (const profile of profiles) {
      const browserLabel = formatBrowserName(profile.browser);
      const dataTypes = profile.dataFiles
        .filter(d => d.exists)
        .map(d => d.type)
        .join(', ');

      console.log(
        `  ${chalk.cyan(browserLabel)} / ${chalk.white(profile.profileName)}`
      );
      console.log(
        `    Path: ${chalk.dim(profile.profilePath)}`
      );
      console.log(
        `    Data: ${dataTypes ? chalk.green(dataTypes) : chalk.dim('none found')}`
      );
      console.log();
    }

    console.log(chalk.dim('Use "browser-import inspect <profile>" to see details.'));
    console.log(chalk.dim('Profile can be a path or "browser/name" (e.g., "firefox/default-release").'));
  });

// ==================== inspect ====================

program
  .command('inspect')
  .description('Show what data is available in a browser profile')
  .argument('<profile>', 'Profile path or "browser/name"')
  .action((profileQuery: string) => {
    const profiles = discoverAllProfiles();
    const profile = findProfile(profileQuery, profiles);

    if (!profile) {
      console.log(chalk.red(`Profile not found: ${profileQuery}`));
      console.log(chalk.dim('\nAvailable profiles:'));
      for (const p of profiles) {
        console.log(chalk.dim(`  ${p.browser}/${p.profileName}`));
      }
      process.exit(1);
    }

    const reader = getReader(profile.browser);
    const inspections = reader.inspect(profile.profilePath);

    console.log(
      chalk.bold(`\nProfile: ${formatBrowserName(profile.browser)} / ${profile.profileName}`)
    );
    console.log(chalk.dim(`  Path: ${profile.profilePath}\n`));

    if (inspections.length === 0) {
      console.log(chalk.yellow('  No data files found.'));
      return;
    }

    for (const item of inspections) {
      const icon = item.importable ? chalk.green('\u2713') : chalk.dim('\u25CB');
      const count = chalk.white(item.count.toLocaleString());
      const status = item.importable
        ? chalk.green('(importable)')
        : chalk.dim('(not yet supported)');

      console.log(`  ${icon} ${item.label}: ${count} entries ${status}`);
    }

    console.log();
    console.log(chalk.dim('Use "browser-import import <profile>" to import data.'));
  });

// ==================== import ====================

program
  .command('import')
  .description('Import browser data into a Peek datastore')
  .argument('<profile>', 'Profile path or "browser/name"')
  .option('--db <path>', 'Path to Peek database file', './peek.db')
  .option('--types <types>', 'Comma-separated import types: history,bookmarks,sessions', 'history,bookmarks,sessions')
  .option('--tag-folders', 'Create tags from bookmark folder hierarchy (default: true)', true)
  .option('--no-tag-folders', 'Skip creating tags from bookmark folder hierarchy')
  .option('--dry-run', 'Show what would be imported without writing', false)
  .action((profileQuery: string, options: {
    db: string;
    types: string;
    dryRun: boolean;
    tagFolders: boolean;
  }) => {
    const profiles = discoverAllProfiles();
    const profile = findProfile(profileQuery, profiles);

    if (!profile) {
      console.log(chalk.red(`Profile not found: ${profileQuery}`));
      console.log(chalk.dim('\nAvailable profiles:'));
      for (const p of profiles) {
        console.log(chalk.dim(`  ${p.browser}/${p.profileName}`));
      }
      process.exit(1);
    }

    const importTypes = options.types.split(',').map(t => t.trim()) as ImportType[];
    const reader = getReader(profile.browser);
    const dbPath = resolve(options.db);

    console.log(
      chalk.bold(`\nImporting from: ${formatBrowserName(profile.browser)} / ${profile.profileName}`)
    );
    console.log(chalk.dim(`  Source: ${profile.profilePath}`));
    console.log(chalk.dim(`  Target: ${dbPath}`));
    console.log(chalk.dim(`  Types:  ${importTypes.join(', ')}`));
    if (importTypes.includes('bookmarks')) {
      console.log(chalk.dim(`  Tag folders: ${options.tagFolders ? 'yes' : 'no'}`));
    }
    console.log();

    if (options.dryRun) {
      console.log(chalk.yellow('DRY RUN - no data will be written.\n'));
      dryRun(reader, profile, importTypes);
      return;
    }

    // Open the target database
    openDatabase(dbPath);

    let totalImported = 0;
    let totalTags = 0;
    let totalDuplicates = 0;
    let totalErrors = 0;

    try {
      // Import history
      if (importTypes.includes('history')) {
        console.log(chalk.cyan('Reading history...'));
        const entries = reader.readHistory(profile.profilePath);
        console.log(chalk.dim(`  Found ${entries.length.toLocaleString()} entries`));

        const totalVisits = entries.reduce((sum, e) => sum + (e.visits?.length || 0), 0);
        if (totalVisits > 0) {
          console.log(chalk.dim(`  Including ${totalVisits.toLocaleString()} individual visit records`));
        }

        if (entries.length > 0) {
          console.log(chalk.cyan('Importing history...'));
          const result = importHistory(entries, profile.browser, profile.profileName);
          totalImported += result.itemsImported;
          totalTags += result.tagsCreated;
          totalDuplicates += result.duplicatesSkipped;
          totalErrors += result.errors.length;

          console.log(chalk.green(`  Imported: ${result.itemsImported.toLocaleString()}`));
          if (result.duplicatesSkipped > 0) {
            console.log(chalk.yellow(`  Skipped (duplicates): ${result.duplicatesSkipped.toLocaleString()}`));
          }
          if (result.errors.length > 0) {
            console.log(chalk.red(`  Errors: ${result.errors.length}`));
            for (const err of result.errors.slice(0, 5)) {
              console.log(chalk.red(`    ${err}`));
            }
            if (result.errors.length > 5) {
              console.log(chalk.dim(`    ... and ${result.errors.length - 5} more`));
            }
          }
        }
        console.log();
      }

      // Import bookmarks
      if (importTypes.includes('bookmarks')) {
        console.log(chalk.cyan('Reading bookmarks...'));
        const entries = reader.readBookmarks(profile.profilePath);
        console.log(chalk.dim(`  Found ${entries.length.toLocaleString()} entries`));

        if (entries.length > 0) {
          console.log(chalk.cyan('Importing bookmarks...'));
          const result = importBookmarks(entries, profile.browser, profile.profileName, {
            tagFolders: options.tagFolders,
          });
          totalImported += result.itemsImported;
          totalTags += result.tagsCreated;
          totalDuplicates += result.duplicatesSkipped;
          totalErrors += result.errors.length;

          console.log(chalk.green(`  Imported: ${result.itemsImported.toLocaleString()}`));
          if (result.duplicatesSkipped > 0) {
            console.log(chalk.yellow(`  Skipped (duplicates): ${result.duplicatesSkipped.toLocaleString()}`));
          }
          if (result.errors.length > 0) {
            console.log(chalk.red(`  Errors: ${result.errors.length}`));
            for (const err of result.errors.slice(0, 5)) {
              console.log(chalk.red(`    ${err}`));
            }
          }
        }
        console.log();
      }

      // Import sessions
      if (importTypes.includes('sessions')) {
        console.log(chalk.cyan('Reading session tabs...'));
        const tabs = reader.readSessions(profile.profilePath);
        console.log(chalk.dim(`  Found ${tabs.length.toLocaleString()} tabs`));

        if (tabs.length > 0) {
          const pinnedCount = tabs.filter(t => t.pinned).length;
          const groupedCount = tabs.filter(t => t.tabGroup).length;
          const windowCount = new Set(tabs.map(t => t.windowIndex)).size;

          if (pinnedCount > 0) console.log(chalk.dim(`  Pinned: ${pinnedCount}`));
          if (groupedCount > 0) console.log(chalk.dim(`  In tab groups: ${groupedCount}`));
          if (windowCount > 1) console.log(chalk.dim(`  Across ${windowCount} windows`));

          console.log(chalk.cyan('Importing session tabs...'));
          const result = importSessions(tabs, profile.browser, profile.profileName);
          totalImported += result.itemsImported;
          totalTags += result.tagsCreated;
          totalDuplicates += result.duplicatesSkipped;
          totalErrors += result.errors.length;

          console.log(chalk.green(`  Imported: ${result.itemsImported.toLocaleString()}`));
          if (result.duplicatesSkipped > 0) {
            console.log(chalk.yellow(`  Skipped (duplicates): ${result.duplicatesSkipped.toLocaleString()}`));
          }
          if (result.errors.length > 0) {
            console.log(chalk.red(`  Errors: ${result.errors.length}`));
            for (const err of result.errors.slice(0, 5)) {
              console.log(chalk.red(`    ${err}`));
            }
          }
        }
        console.log();
      }

      // Summary
      console.log(chalk.bold('Summary:'));
      console.log(`  Items imported:     ${chalk.green(totalImported.toLocaleString())}`);
      console.log(`  Tags created:       ${chalk.green(totalTags.toLocaleString())}`);
      console.log(`  Duplicates skipped: ${chalk.yellow(totalDuplicates.toLocaleString())}`);
      if (totalErrors > 0) {
        console.log(`  Errors:             ${chalk.red(totalErrors.toLocaleString())}`);
      }
      console.log(`\n  Database: ${chalk.cyan(dbPath)}`);
    } finally {
      closeDatabase();
    }
  });

// ==================== Helpers ====================

function formatBrowserName(name: BrowserName): string {
  const names: Record<BrowserName, string> = {
    firefox: 'Firefox',
    chrome: 'Chrome',
    brave: 'Brave',
  };
  return names[name] || name;
}

function getReader(browser: BrowserName): BrowserReader {
  switch (browser) {
    case 'firefox':
      return firefoxReader;
    case 'chrome':
    case 'brave':
      return chromeReader;
    default:
      throw new Error(`Unsupported browser: ${browser}`);
  }
}

function dryRun(
  reader: BrowserReader,
  profile: BrowserProfile,
  importTypes: ImportType[],
): void {
  if (importTypes.includes('history')) {
    const entries = reader.readHistory(profile.profilePath);
    console.log(`  History: ${chalk.white(entries.length.toLocaleString())} entries would be imported`);
    if (entries.length > 0) {
      const totalVisits = entries.reduce((sum, e) => sum + (e.visits?.length || 0), 0);
      if (totalVisits > 0) {
        console.log(chalk.dim(`    Including ${totalVisits.toLocaleString()} individual visit records`));
      }
      console.log(chalk.dim('  Sample entries:'));
      for (const entry of entries.slice(0, 5)) {
        console.log(chalk.dim(`    ${entry.title || entry.url} (${entry.visitCount} visits)`));
      }
    }
  }

  if (importTypes.includes('bookmarks')) {
    const entries = reader.readBookmarks(profile.profilePath);
    console.log(`  Bookmarks: ${chalk.white(entries.length.toLocaleString())} entries would be imported`);
    if (entries.length > 0) {
      console.log(chalk.dim('  Sample entries:'));
      for (const entry of entries.slice(0, 5)) {
        const folder = entry.folderPath ? ` [${entry.folderPath}]` : '';
        console.log(chalk.dim(`    ${entry.title || entry.url}${folder}`));
      }
    }
  }

  if (importTypes.includes('sessions')) {
    const tabs = reader.readSessions(profile.profilePath);
    console.log(`  Sessions: ${chalk.white(tabs.length.toLocaleString())} tabs would be imported`);
    if (tabs.length > 0) {
      const pinnedCount = tabs.filter(t => t.pinned).length;
      const groupedCount = tabs.filter(t => t.tabGroup).length;
      const windowCount = new Set(tabs.map(t => t.windowIndex)).size;

      if (pinnedCount > 0) console.log(chalk.dim(`    Pinned: ${pinnedCount}`));
      if (groupedCount > 0) console.log(chalk.dim(`    In tab groups: ${groupedCount}`));
      if (windowCount > 1) console.log(chalk.dim(`    Across ${windowCount} windows`));

      console.log(chalk.dim('  Sample tabs:'));
      for (const tab of tabs.slice(0, 5)) {
        const flags = [
          tab.pinned ? 'pinned' : '',
          tab.tabGroup ? `group:${tab.tabGroup}` : '',
        ].filter(Boolean).join(', ');
        const flagStr = flags ? ` (${flags})` : '';
        console.log(chalk.dim(`    ${tab.title || tab.url}${flagStr}`));
      }
    }
  }
}

program.parse();
