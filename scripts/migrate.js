// Database migrations.
//
//   npm run migrate                    back up, then apply every pending migration
//   npm run migrate -- status          list migrations and whether each is applied
//   npm run migrate -- down            back up, then undo the most recent migration
//
// Add --no-backup only if you have just taken a backup yourself
// (for example when mysqldump is not on this PC's PATH).
const path = require('path');
const { spawnSync } = require('child_process');
const { utcOffset } = require('../src/config/timezone'); // loads .env and the company time zone
const mysql = require('mysql2/promise');
const migrator = require('../src/db/migrator');

const args = process.argv.slice(2);
const command = (args.find(a => !a.startsWith('--')) || 'up').toLowerCase();
const skipBackup = args.includes('--no-backup');

function backup() {
  if (skipBackup) { console.log('Skipping backup (--no-backup).'); return; }
  console.log('Taking a backup first (npm run backup)...');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'backup.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nThe backup failed, so nothing was changed.');
    console.error('Fix the backup (see "Backups" in the README), or take one yourself and run again with --no-backup.');
    process.exit(1);
  }
}

(async () => {
  if (!['up', 'down', 'status'].includes(command)) {
    console.error(`Unknown command "${command}". Use: npm run migrate, npm run migrate -- status, npm run migrate -- down`);
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });
  await conn.query('SET time_zone = ?', [utcOffset()]);
  try {
    const st = await migrator.status(conn);
    if (command === 'status') {
      console.log(`Database: ${process.env.DB_NAME}`);
      for (const m of st.migrations) {
        console.log(`  ${m.applied ? '[applied]' : '[pending]'} ${m.version}_${m.name}${m.downFile ? '' : '  (no rollback file)'}`);
      }
      if (st.unknownApplied.length) console.log(`  Recorded but no file here: ${st.unknownApplied.join(', ')}`);
      return;
    }
    if (command === 'up') {
      const pending = st.migrations.filter(m => !m.applied);
      if (!pending.length) { console.log('Database is up to date. Nothing to do.'); return; }
      console.log(`${pending.length} migration(s) to apply to "${process.env.DB_NAME}": ${pending.map(m => m.version).join(', ')}`);
      backup();
      const done = await migrator.up(conn, { log: console.log });
      console.log(`\nDone. Applied: ${done.join(', ')}`);
      return;
    }
    backup();
    const v = await migrator.down(conn, { log: console.log });
    console.log(`\nDone. Rolled back: ${v}`);
  } catch (err) {
    console.error(`\nMigration stopped: ${err.message}`);
    console.error('Migrations that finished before the failure stay applied. Fix the cause and run the same command again: every statement is safe to re-run.');
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
