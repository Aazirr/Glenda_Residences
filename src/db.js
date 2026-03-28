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
        contact_number TEXT,
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

    migrateRoomsTable();
  });
}

function migrateRoomsTable() {
  db.all('PRAGMA table_info(rooms)', (err, columns) => {
    if (err) {
      console.error('Schema migration error (rooms):', err);
      return;
    }

    const columnNames = new Set(columns.map((col) => col.name));

    if (!columnNames.has('contact_number')) {
      db.run('ALTER TABLE rooms ADD COLUMN contact_number TEXT', (alterErr) => {
        if (alterErr) {
          console.error('Failed to add contact_number column:', alterErr);
        } else {
          console.log('Migration applied: added rooms.contact_number');
        }
      });
    }

    if (!columnNames.has('move_in_date')) {
      db.run('ALTER TABLE rooms ADD COLUMN move_in_date TEXT', (alterErr) => {
        if (alterErr) {
          console.error('Failed to add move_in_date column:', alterErr);
        } else {
          console.log('Migration applied: added rooms.move_in_date');
        }
      });
    }
  });
}

module.exports = db;
