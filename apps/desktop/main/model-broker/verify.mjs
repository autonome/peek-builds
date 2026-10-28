// Offline implementation-slice gate; deliberately NOT deployment/full milestone acceptance.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
mkdirSync(join(root, '.tmp'), { recursive: true });
const output = mkdtempSync(join(root, '.tmp', 'folknet-verify-'));
const modulePath = 'apps/desktop/main/model-broker/';
function run(args) {
  console.log(`\n> node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['node_modules/typescript/bin/tsc', '-p', 'apps/desktop/tsconfig.json', '--noEmit']);
const suites = ['policy', 'broker', 'store', 'openai-text', 'profile-panel', 'selection-harness'];
run(['node_modules/typescript/bin/tsc', '--target', 'ES2022', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop',
  '--allowJs', '--rootDir', '.', '--outDir', relative(root, output),
  ...suites.map(name => `${modulePath}${name}.test.ts`), 'packages/capabilities/index.js']);
run(['--test', ...suites.map(name => join(output, modulePath, `${name}.test.js`))]);
// This suite evaluates the real preload source in a VM, so keep its source URL.
run(['--experimental-strip-types', '--test', `${modulePath}ipc.test.ts`]);
run(['--test', 'packages/capabilities/test.js']);
run(['packages/capabilities/check-freshness.js']);
run(['scripts/lint-test-honesty.mjs', modulePath]);
const diff = spawnSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
if (diff.status !== 0) process.exit(diff.status ?? 1);
console.log('\nOffline slice gate PASS. Production host/facade/panel integration remains blocked; no deployment conformance claimed.');
