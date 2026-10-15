// Runs each test file one after another (they share one test database, so
// they must not run in parallel). Works on Node 18 and later.
// Usage: npm test            (all files)
//        npm test -- 02      (only files whose name contains "02")
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js') && f.includes(filter))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
