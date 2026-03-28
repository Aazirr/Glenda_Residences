const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../data/glenda.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database open error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeSchema();
  }
});

function initializeSchema() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_number TEXT UNIQUE NOT NULL,
        tenant_name TEXT NOT NULL,
        facebook_link TEXT,
        move_in_date TEXT,
        electricity_rate REAL NOT NULL,
        electricity_reading REAL NOT NULL,
        water_rate_type TEXT NOT NULL,
        water_rate REAL,
        water_reading REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        electricity_reading REAL NOT NULL,
        water_reading REAL NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        electricity_consumption REAL NOT NULL,
        electricity_cost REAL NOT NULL,
        water_consumption REAL,
        water_cost REAL NOT NULL,
        total_cost REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms(id)
      )
    `);
  });
}

module.exports = db;
