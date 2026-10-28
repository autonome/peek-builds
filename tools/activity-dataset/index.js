// Entry point for `node --test tools/activity-dataset/`: on Node 24 a bare directory argument is run as a
// module rather than searched for test files, so this loads every test file in one process.
// `node --test tools/activity-dataset/*.test.mjs` runs the same tests, one process per file.
import './load-snapshot.test.mjs';
import './normalize.test.mjs';
import './probes.test.mjs';
import './run.test.mjs';
