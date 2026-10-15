// Dumps the whole database to backups/factory_system_<timestamp>.sql
// using the mysqldump command-line tool (comes bundled with MySQL).
//
// Run manually with:   npm run backup
// Or schedule it to run automatically - see the "Backups" section in
// the README for Windows Task Scheduler / cron instructions.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP_LAST_N = 30; // don't let the backups folder grow forever

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(BACKUP_DIR, `factory_system_${stamp}.sql`);

const args = [
  `-h${process.env.DB_HOST || 'localhost'}`,
  `-u${process.env.DB_USER || 'root'}`,
];
if (process.env.DB_PASSWORD) {
  args.push(`-p${process.env.DB_PASSWORD}`);
}
args.push(process.env.DB_NAME || 'factory_system');

const out = fs.createWriteStream(outFile);
const dump = spawn('mysqldump', args);

dump.stdout.pipe(out);

let stderrOutput = '';
dump.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

dump.on('error', (err) => {
  console.error('Could not run mysqldump. Is MySQL installed and on your PATH?');
  console.error(err.message);
  process.exit(1);
});

dump.on('close', (code) => {
  if (code !== 0) {
    console.error('Backup failed:', stderrOutput || `mysqldump exited with code ${code}`);
    fs.unlink(outFile, () => {});
    process.exit(1);
  }

  console.log(`Backup saved: ${outFile}`);
  cleanupOldBackups();
});

function cleanupOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('factory_system_') && f.endsWith('.sql'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  files.slice(KEEP_LAST_N).forEach(f => {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    console.log(`Removed old backup: ${f.name}`);
  });
}
