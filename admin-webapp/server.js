import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8787);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL || '').toLowerCase() === 'disable' ? false : { rejectUnauthorized: false },
});

const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const adminEmail = process.env.ADMIN_EMAIL || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
const httpSmsApiKey = process.env.HTTPSMS_API_KEY || '';
const httpSmsFromNumber = process.env.HTTPSMS_FROM_NUMBER || '';
const botUrl = process.env.BOT_URL || '';

app.use(cors());
app.use(express.json());

function normalizeRoomNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function parseFlexibleNumber(value) {
  const normalizedValue = String(value || '')
    .trim()
    .replace(/,/g, '')
    .replace(/PHP/gi, '')
    .replace(/\u20b1/g, '')
    .trim();

  if (!normalizedValue) {
    return null;
  }

  const parsed = Number(normalizedValue);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseFlexibleDate(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^today('?s date)?$/i.test(normalized)) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseWaterRate(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(fixed|per)\s*:\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const amount = parseFlexibleNumber(match[2]);
  if (amount === null) return null;
  return {
    type: match[1].toLowerCase() === 'fixed' ? 'fixed' : 'per_unit',
    amount,
  };
}

function normalizePhoneNumber(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return null;

  let normalized = rawValue.replace(/[^\d+]/g, '');
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  if (/^09\d{9}$/.test(normalized)) return `+63${normalized.slice(1)}`;
  if (/^9\d{9}$/.test(normalized)) return `+63${normalized}`;
  if (/^63\d{10}$/.test(normalized)) return `+${normalized}`;
  if (/^\+\d{10,15}$/.test(normalized)) return normalized;
  return null;
}

function generateBillFilename(roomNumber, billId) {
  return `bill_${String(roomNumber || '').replace(/\//g, '_')}_${billId}.pdf`;
}

function buildReminderMessage(room, bill) {
  return `Glenda Residences Reminder\nRoom: ${room.room_number}\nAmount Due: PHP ${Number(bill.total_cost || 0).toFixed(2)}\nBilling Period: ${bill.period_start} to ${bill.period_end}\nStatus: UNPAID\nPlease settle your bill. Thank you.`;
}

async function logSmsAttempt(payload) {
  await db.query(
    `INSERT INTO sms_logs (bill_id, room_id, to_number, from_number, content, request_id, provider_message_id, status, error_message, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      payload.billId || null,
      payload.roomId || null,
      payload.toNumber,
      payload.fromNumber,
      payload.content,
      payload.requestId || null,
      payload.providerMessageId || null,
      payload.status || 'pending',
      payload.errorMessage || null,
      payload.sentAt || null,
    ]
  );
}

async function sendHttpSmsMessage({ to, content, requestId }) {
  if (!httpSmsApiKey || !httpSmsFromNumber) {
    throw new Error('HTTPSMS_API_KEY or HTTPSMS_FROM_NUMBER is not configured.');
  }

  const response = await fetch('https://api.httpsms.com/v1/messages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': httpSmsApiKey,
    },
    body: JSON.stringify({
      content,
      from: httpSmsFromNumber,
      to,
      request_id: requestId,
    }),
  });

  const rawBody = await response.text();
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (_error) {
    parsedBody = null;
  }

  if (!response.ok) {
    throw new Error(`httpSMS request failed: ${response.status} ${rawBody}`);
  }

  return {
    providerMessageId: parsedBody?.data?.id || null,
    providerStatus: parsedBody?.data?.status || 'queued',
  };
}

function createToken(payload) {
  return jwt.sign(payload, jwtSecret, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch (_error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!adminEmail || (!adminPassword && !adminPasswordHash)) {
    res.status(500).json({ error: 'Admin credentials are not configured on server.' });
    return;
  }

  if (email !== String(adminEmail).toLowerCase()) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  let validPassword = false;
  if (adminPasswordHash) {
    validPassword = await bcrypt.compare(password, adminPasswordHash);
  } else {
    validPassword = password === adminPassword;
  }

  if (!validPassword) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = createToken({ role: 'admin', email });
  res.json({ token, email });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

app.get('/api/dashboard', authMiddleware, async (_req, res) => {
  try {
    const [roomsResult, unpaidResult, billsResult] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS total FROM rooms'),
      db.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(total_cost), 0)::float AS amount FROM bills WHERE COALESCE(status, 'unpaid') = 'unpaid'"),
      db.query('SELECT COALESCE(SUM(total_cost), 0)::float AS amount FROM bills WHERE created_at >= NOW() - INTERVAL \'30 days\''),
    ]);

    res.json({
      rooms: roomsResult.rows[0].total,
      unpaidCount: unpaidResult.rows[0].total,
      unpaidAmount: unpaidResult.rows[0].amount,
      billedLast30Days: billsResult.rows[0].amount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rooms', authMiddleware, async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT
        r.*,
        b.id AS latest_bill_id,
        b.total_cost AS latest_bill_total,
        b.status AS latest_bill_status,
        b.period_start AS latest_bill_period_start,
        b.period_end AS latest_bill_period_end
       FROM rooms r
       LEFT JOIN LATERAL (
         SELECT *
         FROM bills b1
         WHERE b1.room_id = r.id
         ORDER BY b1.created_at DESC
         LIMIT 1
       ) b ON TRUE
       ORDER BY r.room_number ASC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tenants/register', authMiddleware, async (req, res) => {
  const payload = req.body || {};

  const roomNumber = normalizeRoomNumber(payload.room_number);
  const tenantName = String(payload.tenant_name || '').trim();
  const contactNumber = String(payload.contact_number || '').trim();
  const moveInDate = parseFlexibleDate(payload.move_in_date);
  const roomRate = parseFlexibleNumber(payload.room_rate);
  const electricityRate = parseFlexibleNumber(payload.electricity_rate);
  const electricityReading = parseFlexibleNumber(payload.electricity_reading);
  const waterReading = parseFlexibleNumber(payload.water_reading);
  const waterRate = parseWaterRate(payload.water_rate);

  if (!roomNumber || !tenantName || !moveInDate || roomRate === null || electricityRate === null || electricityReading === null || waterReading === null || !waterRate) {
    res.status(400).json({ error: 'Invalid payload for registration.' });
    return;
  }

  try {
    await db.query(
      `INSERT INTO rooms (room_number, tenant_name, room_rate, contact_number, move_in_date, electricity_rate, electricity_reading, water_rate_type, water_rate, water_reading)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        roomNumber,
        tenantName,
        roomRate,
        contactNumber,
        moveInDate,
        electricityRate,
        electricityReading,
        waterRate.type,
        waterRate.amount,
        waterReading,
      ]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/tenants/:roomId', authMiddleware, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const payload = req.body || {};

  if (!roomId) {
    res.status(400).json({ error: 'Invalid room id' });
    return;
  }

  const updates = [];
  const params = [];

  if (payload.tenant_name !== undefined) {
    updates.push(`tenant_name = $${params.length + 1}`);
    params.push(String(payload.tenant_name || '').trim());
  }
  if (payload.contact_number !== undefined) {
    updates.push(`contact_number = $${params.length + 1}`);
    params.push(String(payload.contact_number || '').trim());
  }
  if (payload.move_in_date !== undefined) {
    const moveInDate = parseFlexibleDate(payload.move_in_date);
    if (!moveInDate) {
      res.status(400).json({ error: 'Invalid move-in date' });
      return;
    }
    updates.push(`move_in_date = $${params.length + 1}`);
    params.push(moveInDate);
  }
  if (payload.room_rate !== undefined) {
    const roomRate = parseFlexibleNumber(payload.room_rate);
    if (roomRate === null) {
      res.status(400).json({ error: 'Invalid room rate' });
      return;
    }
    updates.push(`room_rate = $${params.length + 1}`);
    params.push(roomRate);
  }

  if (!updates.length) {
    res.status(400).json({ error: 'No supported fields provided.' });
    return;
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(roomId);

  try {
    await db.query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tenants/:roomId/clear', authMiddleware, async (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!roomId) {
    res.status(400).json({ error: 'Invalid room id' });
    return;
  }

  try {
    await db.query(
      `UPDATE rooms
       SET tenant_name = 'VACANT', contact_number = NULL, move_in_date = NULL, room_rate = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [roomId]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tenants/transfer', authMiddleware, async (req, res) => {
  const sourceRoomId = Number(req.body?.source_room_id);
  const targetRoomId = Number(req.body?.target_room_id);

  if (!sourceRoomId || !targetRoomId || sourceRoomId === targetRoomId) {
    res.status(400).json({ error: 'Invalid source/target room ids.' });
    return;
  }

  try {
    const sourceResult = await db.query('SELECT * FROM rooms WHERE id = $1', [sourceRoomId]);
    const targetResult = await db.query('SELECT * FROM rooms WHERE id = $1', [targetRoomId]);
    const source = sourceResult.rows[0];
    const target = targetResult.rows[0];

    if (!source || !target) {
      res.status(404).json({ error: 'Source or target room not found.' });
      return;
    }

    if (!source.tenant_name || source.tenant_name.toUpperCase() === 'VACANT') {
      res.status(400).json({ error: 'Source room has no active tenant.' });
      return;
    }

    if (target.tenant_name && target.tenant_name.toUpperCase() !== 'VACANT') {
      res.status(400).json({ error: 'Target room is occupied.' });
      return;
    }

    await db.query(
      `UPDATE rooms
       SET tenant_name = $1, contact_number = $2, move_in_date = $3, room_rate = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [source.tenant_name, source.contact_number, source.move_in_date, source.room_rate, target.id]
    );

    await db.query(
      `UPDATE rooms
       SET tenant_name = 'VACANT', contact_number = NULL, move_in_date = NULL, room_rate = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [source.id]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/readings/input', authMiddleware, async (req, res) => {
  const roomNumber = normalizeRoomNumber(req.body?.room_number);
  const currentElectricity = parseFlexibleNumber(req.body?.electricity_reading);
  const currentWater = parseFlexibleNumber(req.body?.water_reading);

  if (!roomNumber || currentElectricity === null || currentWater === null) {
    res.status(400).json({ error: 'Invalid room or reading values.' });
    return;
  }

  try {
    const roomResult = await db.query('SELECT * FROM rooms WHERE UPPER(room_number) = $1', [roomNumber]);
    const room = roomResult.rows[0];

    if (!room) {
      res.status(404).json({ error: `Room ${roomNumber} not found.` });
      return;
    }

    if (currentElectricity < room.electricity_reading || currentWater < room.water_reading) {
      res.status(400).json({ error: 'New readings cannot be lower than baseline readings.' });
      return;
    }

    const electricityConsumption = currentElectricity - Number(room.electricity_reading);
    const electricityCost = electricityConsumption * Number(room.electricity_rate);

    let waterConsumption = 0;
    let waterCost = 0;
    if (room.water_rate_type === 'fixed') {
      waterCost = Number(room.water_rate || 0);
    } else {
      waterConsumption = currentWater - Number(room.water_reading);
      waterCost = waterConsumption * Number(room.water_rate || 0);
    }

    const roomRate = Number(room.room_rate || 0);
    const totalCost = roomRate + electricityCost + waterCost;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString();
    const periodEnd = now.toLocaleDateString();

    const billResult = await db.query(
      `INSERT INTO bills (room_id, period_start, period_end, room_rate, electricity_consumption, electricity_cost, water_consumption, water_cost, total_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [room.id, periodStart, periodEnd, roomRate, electricityConsumption, electricityCost, room.water_rate_type === 'fixed' ? 0 : waterConsumption, waterCost, totalCost]
    );

    await db.query(
      'UPDATE rooms SET electricity_reading = $1, water_reading = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [currentElectricity, currentWater, room.id]
    );

    res.json({ ok: true, bill_id: billResult.rows[0].id, total_cost: totalCost });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/readings/:roomId/edit-latest', authMiddleware, async (req, res) => {
  const roomId = Number(req.params.roomId);
  const correctedElectricity = parseFlexibleNumber(req.body?.electricity_reading);
  const correctedWater = parseFlexibleNumber(req.body?.water_reading);

  if (!roomId || correctedElectricity === null || correctedWater === null) {
    res.status(400).json({ error: 'Invalid room or corrected readings.' });
    return;
  }

  try {
    const roomResult = await db.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    const room = roomResult.rows[0];
    if (!room) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }

    const billResult = await db.query('SELECT * FROM bills WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1', [roomId]);
    const bill = billResult.rows[0];
    if (!bill) {
      res.status(404).json({ error: 'No bill found for this room.' });
      return;
    }

    const previousElectricityBaseline = Number(room.electricity_reading) - Number(bill.electricity_consumption || 0);
    const previousWaterBaseline = Number(room.water_reading) - Number(bill.water_consumption || 0);

    if (correctedElectricity < previousElectricityBaseline || correctedWater < previousWaterBaseline) {
      res.status(400).json({ error: 'Corrected readings cannot be lower than previous baseline.' });
      return;
    }

    const electricityConsumption = correctedElectricity - previousElectricityBaseline;
    const electricityCost = electricityConsumption * Number(room.electricity_rate);

    let waterConsumption = 0;
    let waterCost = 0;
    if (room.water_rate_type === 'fixed') {
      waterCost = Number(room.water_rate || 0);
    } else {
      waterConsumption = correctedWater - previousWaterBaseline;
      waterCost = waterConsumption * Number(room.water_rate || 0);
    }

    const roomRate = Number(bill.room_rate || room.room_rate || 0);
    const totalCost = roomRate + electricityCost + waterCost;

    await db.query(
      `UPDATE bills
       SET electricity_consumption = $1, electricity_cost = $2, water_consumption = $3, water_cost = $4, total_cost = $5
       WHERE id = $6`,
      [electricityConsumption, electricityCost, waterConsumption, waterCost, totalCost, bill.id]
    );

    await db.query(
      'UPDATE rooms SET electricity_reading = $1, water_reading = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [correctedElectricity, correctedWater, room.id]
    );

    res.json({ ok: true, total_cost: totalCost });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills/:billId/mark-paid', authMiddleware, async (req, res) => {
  const billId = Number(req.params.billId);
  const notes = String(req.body?.notes || '').trim();

  if (!billId) {
    res.status(400).json({ error: 'Invalid bill id.' });
    return;
  }

  try {
    await db.query(
      "UPDATE bills SET status = 'paid', paid_at = CURRENT_TIMESTAMP, payment_notes = $1 WHERE id = $2",
      [notes || null, billId]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills/:billId/mark-unpaid', authMiddleware, async (req, res) => {
  const billId = Number(req.params.billId);
  const notes = String(req.body?.notes || '').trim();

  if (!billId) {
    res.status(400).json({ error: 'Invalid bill id.' });
    return;
  }

  try {
    await db.query(
      "UPDATE bills SET status = 'unpaid', paid_at = NULL, payment_notes = $1 WHERE id = $2",
      [notes || null, billId]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills/:billId/send-reminder', authMiddleware, async (req, res) => {
  const billId = Number(req.params.billId);
  if (!billId) {
    res.status(400).json({ error: 'Invalid bill id.' });
    return;
  }

  try {
    const result = await db.query(
      `SELECT b.*, r.id AS room_id, r.room_number, r.contact_number
       FROM bills b
       INNER JOIN rooms r ON r.id = b.room_id
       WHERE b.id = $1`,
      [billId]
    );

    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: 'Bill not found.' });
      return;
    }

    const toNumber = normalizePhoneNumber(row.contact_number);
    if (!toNumber) {
      res.status(400).json({ error: 'Room contact number is invalid or missing.' });
      return;
    }

    const content = buildReminderMessage(row, row);
    const requestId = `bill-${row.id}-${Date.now()}`;
    const normalizedFromNumber = normalizePhoneNumber(httpSmsFromNumber) || httpSmsFromNumber;

    try {
      const provider = await sendHttpSmsMessage({ to: toNumber, content, requestId });
      await logSmsAttempt({
        billId: row.id,
        roomId: row.room_id,
        toNumber,
        fromNumber: normalizedFromNumber,
        content,
        requestId,
        providerMessageId: provider.providerMessageId,
        status: provider.providerStatus || 'queued',
        sentAt: new Date().toISOString(),
      });
      res.json({ ok: true, provider_message_id: provider.providerMessageId || null });
    } catch (error) {
      await logSmsAttempt({
        billId: row.id,
        roomId: row.room_id,
        toNumber,
        fromNumber: normalizedFromNumber,
        content,
        requestId,
        status: 'failed',
        errorMessage: String(error.message || error),
      });
      res.status(500).json({ error: String(error.message || error) });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills/send-reminder-all', authMiddleware, async (_req, res) => {
  try {
    const unpaid = await db.query(
      `SELECT
         r.id AS room_id,
         r.room_number,
         r.contact_number,
         b.id AS bill_id,
         b.total_cost,
         b.period_start,
         b.period_end
       FROM rooms r
       INNER JOIN bills b ON b.room_id = r.id
       WHERE COALESCE(b.status, 'unpaid') = 'unpaid'
         AND b.created_at = (
           SELECT MAX(b2.created_at)
           FROM bills b2
           WHERE b2.room_id = r.id
             AND COALESCE(b2.status, 'unpaid') = 'unpaid'
         )`
    );

    const summary = { sent: 0, failed: 0, skipped: 0 };
    const normalizedFromNumber = normalizePhoneNumber(httpSmsFromNumber) || httpSmsFromNumber;

    for (const row of unpaid.rows) {
      const toNumber = normalizePhoneNumber(row.contact_number);
      if (!toNumber) {
        summary.skipped += 1;
        continue;
      }

      const content = buildReminderMessage(row, row);
      const requestId = `bulk-${row.bill_id}-${Date.now()}-${row.room_id}`;

      try {
        const provider = await sendHttpSmsMessage({ to: toNumber, content, requestId });
        await logSmsAttempt({
          billId: row.bill_id,
          roomId: row.room_id,
          toNumber,
          fromNumber: normalizedFromNumber,
          content,
          requestId,
          providerMessageId: provider.providerMessageId,
          status: provider.providerStatus || 'queued',
          sentAt: new Date().toISOString(),
        });
        summary.sent += 1;
      } catch (error) {
        await logSmsAttempt({
          billId: row.bill_id,
          roomId: row.room_id,
          toNumber,
          fromNumber: normalizedFromNumber,
          content,
          requestId,
          status: 'failed',
          errorMessage: String(error.message || error),
        });
        summary.failed += 1;
      }
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`Admin webapp listening on port ${port}`);
});
