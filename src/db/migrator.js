// Applies and rolls back the numbered SQL files in db/migrations.
//
//   NNN_name.sql        the change
//   NNN_name.down.sql   how to undo it (optional; without one, that
//                       migration cannot be rolled back)
//
// Applied versions are recorded in the schema_migrations table, so each
// file runs once. Files may contain "USE factory_system;" (001 and 002
// do): those lines are skipped, so a migration always runs against the
// database the app is configured for and can never switch to another.
//
// Used by scripts/migrate.js (npm run migrate) and by the test suite.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const FILE = /^(\d{3})_([\w-]+)\.sql$/;

function listMigrations(dir = DIR) {
  return fs.readdirSync(dir)
    .filter(f => FILE.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map(f => {
      const [, version, name] = FILE.exec(f);
      const down = path.join(dir, `${version}_${name}.down.sql`);
      return { version, name, upFile: path.join(dir, f), downFile: fs.existsSync(down) ? down : null };
    });
}

// Splits a SQL file into statements on ';', ignoring semicolons inside
// quotes and comments. Comments are dropped.
function splitSql(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') { cur += next || ''; i++; continue; }
      if (c === quote) {
        if (next === quote) { cur += next; i++; } else { quote = null; }
      }
      continue;
    }
    if (c === '-' && next === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\t' || sql[i + 2] === '\n' || sql[i + 2] === '\r' || sql[i + 2] === undefined)) {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      cur += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SKIP = /^(USE\s|CREATE\s+DATABASE\s)/i;
function statementsOf(file) {
  return splitSql(fs.readFileSync(file, 'utf8')).filter(s => !SKIP.test(s));
}

async function prepare(conn) {
  // Strict mode makes the database refuse data-losing changes (for example
  // removing a role that users still have) instead of silently truncating.
  await conn.query("SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')");
  const [[base]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN ('users', 'job_orders', 'machines')`);
  if (base.n < 3) {
    throw new Error('This database has no factory tables yet. Run db/schema.sql first, then npm run migrate.');
  }
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     VARCHAR(16)  PRIMARY KEY,
       name        VARCHAR(200) NOT NULL,
       applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function status(conn, dir) {
  await prepare(conn);
  const [rows] = await conn.query('SELECT version, applied_at FROM schema_migrations');
  const applied = new Map(rows.map(r => [r.version, r.applied_at]));
  const files = listMigrations(dir);
  const known = new Set(files.map(m => m.version));
  const unknown = rows.filter(r => !known.has(r.version)).map(r => r.version);
  return {
    migrations: files.map(m => ({ ...m, applied: applied.has(m.version), appliedAt: applied.get(m.version) || null })),
    unknownApplied: unknown
  };
}

async function run(conn, m, file, log) {
  const statements = statementsOf(file);
  for (let i = 0; i < statements.length; i++) {
    try {
      await conn.query(statements[i]);
    } catch (err) {
      const preview = statements[i].replace(/\s+/g, ' ').slice(0, 140);
      const e = new Error(`${path.basename(file)}, statement ${i + 1} of ${statements.length} failed: ${err.message}\n  -> ${preview}`);
      e.cause = err;
      throw e;
    }
  }
  log(`  ${path.basename(file)}: ${statements.length} statements`);
}

// Applies every pending migration in order. Stops at the first failure;
// earlier migrations stay applied and recorded.
async function up(conn, { dir, log = () => {} } = {}) {
  const { migrations } = await status(conn, dir);
  const pending = migrations.filter(m => !m.applied);
  for (const m of pending) {
    log(`Applying ${m.version}_${m.name}`);
    await run(conn, m, m.upFile, log);
    await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [m.version, m.name]);
  }
  return pending.map(m => m.version);
}

// Rolls back the most recently applied migration (one per call).
async function down(conn, { dir, log = () => {} } = {}) {
  const { migrations } = await status(conn, dir);
  const applied = migrations.filter(m => m.applied);
  const last = applied[applied.length - 1];
  if (!last) throw new Error('Nothing to roll back: no migrations are recorded as applied.');
  if (!last.downFile) {
    throw new Error(`${last.version}_${last.name} has no .down.sql file, so it cannot be rolled back automatically. Restore a backup instead.`);
  }
  log(`Rolling back ${last.version}_${last.name}`);
  await run(conn, last, last.downFile, log);
  await conn.query('DELETE FROM schema_migrations WHERE version = ?', [last.version]);
  return last.version;
}

module.exports = { listMigrations, splitSql, statementsOf, status, up, down, DIR };
