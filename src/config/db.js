const { utcOffset } = require('./timezone'); // must load first: sets the company time zone
const mysql = require('mysql2/promise');
require('dotenv').config();

// A connection pool, not a single connection - lets several people
// on the LAN (production, maintenance, toolroom, etc.) hit the
// server at the same time without connections blocking each other.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Every connection runs on the company time zone, so NOW(), CURDATE() and
// DEFAULT CURRENT_TIMESTAMP match the app even if the PC clock's zone differs.
pool.pool.on('connection', conn => {
  conn.query('SET time_zone = ?', [utcOffset()]);
});

module.exports = pool;
