#!/usr/bin/env node
/**
 * Quick manual test for Groups extension migration to peek-components
 * Run with: node test-groups-migration.js
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('Starting Electron app to test Groups extension...');
console.log('1. Open groups extension (Cmd+Shift+G or via command bar)');
console.log('2. Verify cards render correctly');
console.log('3. Click a group to see addresses');
console.log('4. Press Escape to go back');
console.log('5. Test keyboard navigation (hjkl or arrows)');
console.log('6. Test search functionality');
console.log('\nClose the app when done testing.\n');

const electron = spawn('yarn', ['start'], {
  cwd: path.join(__dirname),
  stdio: 'inherit',
  shell: true
});

electron.on('close', (code) => {
  console.log(`\nElectron app exited with code ${code}`);
  process.exit(code);
});
