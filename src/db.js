const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

function convertQuestionMarksToPgParams(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function createPostgresAdapter() {
  const sslDisabled = String(process.env.PGSSL || '').toLowerCase() === 'disable';

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  });

  async function initializeSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_number TEXT UNIQUE NOT NULL,
        tenant_name TEXT NOT NULL,
        room_rate REAL NOT NULL DEFAULT 0,
        contact_number TEXT,
        facebook_link TEXT,
        move_in_date TEXT,
        electricity_rate REAL NOT NULL,
        electricity_reading REAL NOT NULL,
        water_rate_type TEXT NOT NULL,
        water_rate REAL,
        water_reading REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS readings (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        electricity_reading REAL NOT NULL,
        water_reading REAL NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        room_rate REAL NOT NULL DEFAULT 0,
        electricity_consumption REAL NOT NULL,
        electricity_cost REAL NOT NULL,
        water_consumption REAL,
        water_cost REAL NOT NULL,
        total_cost REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'unpaid',
        paid_at TIMESTAMP NULL,
        payment_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS contact_number TEXT');
    await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS move_in_date TEXT');
    await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_rate REAL NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE bills ADD COLUMN IF NOT EXISTS room_rate REAL NOT NULL DEFAULT 0');
    await pool.query("ALTER TABLE bills ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unpaid'");
    await pool.query('ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP NULL');
    await pool.query('ALTER TABLE bills ADD COLUMN IF NOT EXISTS payment_notes TEXT');
    await pool.query("UPDATE bills SET status = 'unpaid' WHERE status IS NULL OR status = ''");
  }

  initializeSchema()
    .then(() => {
      console.log('Connected to PostgreSQL database');
    })
    .catch((err) => {
      console.error('PostgreSQL initialization error:', err);
    });

  return {
    run(sql, params = [], callback) {
      const parsedSql = convertQuestionMarksToPgParams(sql);
      const isInsert = /^\s*insert\s+/i.test(parsedSql);
      const sqlWithReturning = isInsert && !/\sreturning\s+/i.test(parsedSql)
        ? `${parsedSql} RETURNING id`
        : parsedSql;

      pool.query(sqlWithReturning, params)
        .then((result) => {
          const context = {
            lastID: result.rows && result.rows[0] ? result.rows[0].id : null,
            changes: result.rowCount || 0,
          };
          callback.call(context, null);
        })
        .catch((err) => {
          callback.call({ lastID: null, changes: 0 }, err);
        });
    },

    get(sql, params = [], callback) {
      const parsedSql = convertQuestionMarksToPgParams(sql);
      pool.query(parsedSql, params)
        .then((result) => {
          callback(null, result.rows[0]);
        })
        .catch((err) => {
          callback(err);
        });
    },

    all(sql, params = [], callback) {
      const parsedSql = convertQuestionMarksToPgParams(sql);
      pool.query(parsedSql, params)
        .then((result) => {
          callback(null, result.rows);
        })
        .catch((err) => {
          callback(err);
        });
    },
  };
}

function createSqliteAdapter() {
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
          room_rate REAL NOT NULL DEFAULT 0,
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
          room_rate REAL NOT NULL DEFAULT 0,
          electricity_consumption REAL NOT NULL,
          electricity_cost REAL NOT NULL,
          water_consumption REAL,
          water_cost REAL NOT NULL,
          total_cost REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'unpaid',
          paid_at DATETIME,
          payment_notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (room_id) REFERENCES rooms(id)
        )
      `);

      migrateSqliteTables();
    });
  }

  function migrateSqliteTables() {
    db.all('PRAGMA table_info(rooms)', (err, columns) => {
      if (err) {
        console.error('Schema migration error (rooms):', err);
        return;
      }

      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has('contact_number')) {
        db.run('ALTER TABLE rooms ADD COLUMN contact_number TEXT');
      }

      if (!columnNames.has('move_in_date')) {
        db.run('ALTER TABLE rooms ADD COLUMN move_in_date TEXT');
      }

      if (!columnNames.has('room_rate')) {
        db.run('ALTER TABLE rooms ADD COLUMN room_rate REAL NOT NULL DEFAULT 0');
      }

      db.all('PRAGMA table_info(bills)', (billsErr, billColumns) => {
        if (billsErr) {
          console.error('Schema migration error (bills):', billsErr);
          return;
        }

        const billColumnNames = new Set(billColumns.map((col) => col.name));

        if (!billColumnNames.has('room_rate')) {
          db.run('ALTER TABLE bills ADD COLUMN room_rate REAL NOT NULL DEFAULT 0');
        }

        if (!billColumnNames.has('status')) {
          db.run("ALTER TABLE bills ADD COLUMN status TEXT NOT NULL DEFAULT 'unpaid'");
        }

        if (!billColumnNames.has('paid_at')) {
          db.run('ALTER TABLE bills ADD COLUMN paid_at DATETIME');
        }

        if (!billColumnNames.has('payment_notes')) {
          db.run('ALTER TABLE bills ADD COLUMN payment_notes TEXT');
        }

        db.run("UPDATE bills SET status = 'unpaid' WHERE status IS NULL OR status = ''");
      });
    });
  }

  return db;
}

module.exports = databaseUrl ? createPostgresAdapter() : createSqliteAdapter();
