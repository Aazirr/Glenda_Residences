const http = require('http');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('./db');

const port = process.env.PORT || 3000;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const ownerTelegramId = parseInt(process.env.OWNER_TELEGRAM_ID || '0');
const httpSmsApiKey = process.env.HTTPSMS_API_KEY;
const httpSmsFromNumber = process.env.HTTPSMS_FROM_NUMBER;

const conversationState = {};

async function sendTelegramMessage(chatId, text, parseMode = 'HTML') {
  if (!telegramBotToken) {
    console.log('TELEGRAM_BOT_TOKEN is not set, skipping reply');
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.log(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(rawBody || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function normalizeRoomNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function isVacantTenantName(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return !normalized || normalized === 'VACANT';
}

function parseWaterRate(value) {
  const normalizedValue = String(value || '').trim();
  const match = normalizedValue.match(/^(fixed|per)\s*:\s*(\d+(?:\.\d+)?)$/i);

  if (!match) {
    return null;
  }

  const parsedAmount = parseFlexibleNumber(match[2]);
  if (parsedAmount === null) {
    return null;
  }

  return {
    type: match[1].toLowerCase() === 'fixed' ? 'fixed' : 'per_unit',
    amount: parsedAmount,
  };
}

function parseFlexibleNumber(value) {
  const normalizedValue = String(value || '')
    .trim()
    .replace(/,/g, '')
    .replace(/₱/g, '')
    .replace(/php/gi, '')
    .trim();

  if (!normalizedValue) {
    return null;
  }

  const parsedValue = Number(normalizedValue);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseFlexibleDate(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return null;
  }

  if (/^today('?s date)?$/i.test(normalizedValue)) {
    return new Date().toISOString().slice(0, 10);
  }

  const parsedDate = new Date(normalizedValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate.toISOString().slice(0, 10);
}

function normalizePhoneNumber(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  let normalized = rawValue.replace(/[^\d+]/g, '');

  if (normalized.startsWith('00')) {
    normalized = `+${normalized.slice(2)}`;
  }

  if (/^09\d{9}$/.test(normalized)) {
    return `+63${normalized.slice(1)}`;
  }

  if (/^9\d{9}$/.test(normalized)) {
    return `+63${normalized}`;
  }

  if (/^63\d{10}$/.test(normalized)) {
    return `+${normalized}`;
  }

  if (/^\+\d{10,15}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function buildReminderMessage(room, bill) {
  const filename = generateBillFilename(room.room_number, bill.id);
  const baseUrl = process.env.BOT_URL || 'https://glenda-residences-production.up.railway.app';
  const pdfUrl = `${baseUrl}/bills/${encodeURIComponent(filename)}`;

  return `Glenda Residences Reminder\nRoom: ${room.room_number}\nAmount Due: PHP ${Number(bill.total_cost || 0).toFixed(2)}\nBilling Period: ${bill.period_start} to ${bill.period_end}\nStatus: UNPAID\nBill PDF: ${pdfUrl}\nPlease settle your bill. Thank you.`;
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
  } catch (error) {
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

async function logSmsAttempt(payload) {
  await dbRun(
    `INSERT INTO sms_logs (bill_id, room_id, to_number, from_number, content, request_id, provider_message_id, status, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

async function getRoomsListText() {
  const rooms = await dbAll('SELECT room_number FROM rooms ORDER BY room_number ASC');
  if (!rooms.length) {
    return null;
  }
  return rooms.map((room) => `- ${room.room_number}`).join('\n');
}

function generateBillFilename(roomNumber, billId) {
  return `bill_${roomNumber.replace(/\//g, '_')}_${billId}.pdf`;
}

async function generateBillPDF(room, bill) {
  const doc = new PDFDocument({ margin: 50 });
  const filename = generateBillFilename(room.room_number, bill.id);
  const filepath = path.join(__dirname, '../public', filename);

  // Ensure public directory exists
  if (!fs.existsSync(path.join(__dirname, '../public'))) {
    fs.mkdirSync(path.join(__dirname, '../public'), { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filepath);
    
    doc.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', () => resolve(filename));

    doc.pipe(stream);

    // Header with logo
    const logoPath = path.join(__dirname, '../public/logo.jpg');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 50, 20, { width: 100 });
    }

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text('Glenda Residences', 200, 30);
    doc.fontSize(10).font('Helvetica').text('Billing Statement', 200, 55);

    // Divider
    doc.moveTo(50, 80).lineTo(545, 80).stroke();

    // Tenant & Room Info
    doc.fontSize(10).font('Helvetica-Bold').text('BILLING INFORMATION', 50, 100);
    doc.fontSize(9).font('Helvetica');
    doc.text(`Room: ${room.room_number}`, 50, 120);
    doc.text(`Tenant: ${room.tenant_name}`, 50, 135);
    doc.text(`Contact: ${room.contact_number || 'N/A'}`, 50, 150);
    doc.text(`Move-in Date: ${room.move_in_date || 'N/A'}`, 50, 165);

    // Bill Period
    doc.fontSize(10).font('Helvetica-Bold').text('BILLING PERIOD', 300, 100);
    doc.fontSize(9).font('Helvetica');
    doc.text(`From: ${bill.period_start}`, 300, 120);
    doc.text(`To: ${bill.period_end}`, 300, 135);
    doc.text(`Date Issued: ${new Date(bill.created_at).toLocaleDateString()}`, 300, 150);

    // Divider
    doc.moveTo(50, 190).lineTo(545, 190).stroke();

    // Charges Section
    doc.fontSize(12).font('Helvetica-Bold').text('CHARGES', 50, 210);

    // Room Rate
    doc.fontSize(10).font('Helvetica-Bold').text('Room Rate', 50, 235);
    doc.fontSize(9).font('Helvetica');
    doc.text(`Monthly Rent: PHP ${Number(bill.room_rate || room.room_rate || 0).toFixed(2)}`, 70, 255);
    doc.text(`Amount: PHP ${Number(bill.room_rate || room.room_rate || 0).toFixed(2)}`, 70, 270, { align: 'right', width: 425 });

    // Electricity
    doc.fontSize(10).font('Helvetica-Bold').text('Electricity', 50, 300);
    doc.fontSize(9).font('Helvetica');
    doc.text(`Consumption: ${bill.electricity_consumption.toFixed(2)} kWh @ PHP ${room.electricity_rate}/kWh`, 70, 320);
    doc.text(`Amount: PHP ${bill.electricity_cost.toFixed(2)}`, 70, 335, { align: 'right', width: 425 });

    // Water
    doc.fontSize(10).font('Helvetica-Bold').text('Water', 50, 360);
    doc.fontSize(9).font('Helvetica');
    if (bill.water_consumption > 0) {
      doc.text(`Consumption: ${bill.water_consumption.toFixed(2)} units @ PHP ${room.water_rate}/unit`, 70, 380);
    } else {
      doc.text(`Fixed Monthly Rate`, 70, 380);
    }
    doc.text(`Amount: PHP ${bill.water_cost.toFixed(2)}`, 70, 395, { align: 'right', width: 425 });

    // Divider
    doc.moveTo(50, 420).lineTo(545, 420).stroke();

    // Total
    doc.fontSize(14).font('Helvetica-Bold').text('TOTAL AMOUNT DUE', 50, 440);
    doc.fontSize(14).font('Helvetica-Bold').text(`PHP ${bill.total_cost.toFixed(2)}`, 450, 440, { align: 'right' });

    // Footer
    doc.fontSize(8).font('Helvetica').text('Thank you for your payment.', 50, 520, { align: 'center' });

    doc.end();
  });
}

async function handleRegisterTenant(chatId, userText) {
  if (!conversationState[chatId]) {
    conversationState[chatId] = { command: 'register_tenant', step: 1, data: {} };
    await sendTelegramMessage(chatId, 'Starting tenant registration.\n\nWhat is the tenant name?');
    return;
  }

  const state = conversationState[chatId];
  if (state.command !== 'register_tenant') {
    conversationState[chatId] = { command: 'register_tenant', step: 1, data: {} };
    await sendTelegramMessage(chatId, 'Starting tenant registration.\n\nWhat is the tenant name?');
    return;
  }

  const steps = [
    { field: 'name', prompt: 'Tenant name received.\n\nWhat is the room number? (e.g., 4C)' },
    { field: 'room_number', prompt: 'Room recorded.\n\nWhat is the contact number?' },
    { field: 'contact_number', prompt: 'Contact number saved.\n\nWhat is the move-in date? (examples: 2026-04-09, April 9, 2026, today)' },
    { field: 'move_in_date', prompt: 'Move-in date recorded.\n\nWhat is the monthly room rate? (examples: 3500, 3,500, ₱3,500)' },
    { field: 'room_rate', prompt: 'Room rate saved.\n\nWhat is the electricity rate? (examples: 12, 12.5, ₱12)' },
    { field: 'electricity_rate', prompt: 'Electricity rate saved.\n\nWhat is the current electricity meter reading? (examples: 250, 2,500)' },
    { field: 'electricity_reading', prompt: 'Electricity meter saved.\n\nWhat is the water rate? (format: fixed:100 or per:15, commas allowed)' },
    { field: 'water_rate', prompt: 'Water rate saved.\n\nWhat is the current water meter reading? (just the number, e.g., 130)' },
    { field: 'water_reading', prompt: 'Registering tenant...' },
  ];
  
  if (state.step <= steps.length) {
    const currentStep = steps[state.step - 1];
    const nextPrompt = currentStep.prompt;
    if (currentStep.field === 'room_number') {
      state.data[currentStep.field] = normalizeRoomNumber(userText);
    } else {
      state.data[currentStep.field] = userText;
    }
    state.step++;

    if (state.step <= steps.length) {
      await sendTelegramMessage(chatId, nextPrompt);
    }

    if (state.step > steps.length) {
      const waterRate = parseWaterRate(state.data.water_rate);

      // Validate all critical values
      const roomRate = parseFlexibleNumber(state.data.room_rate);
      const elec_reading = parseFlexibleNumber(state.data.electricity_reading);
      const elec_rate = parseFlexibleNumber(state.data.electricity_rate);
      const water_reading = parseFlexibleNumber(state.data.water_reading);
      const moveInDate = parseFlexibleDate(state.data.move_in_date);
      const contactNumber = String(state.data.contact_number || '').trim();

      if (roomRate === null || elec_reading === null || elec_rate === null || water_reading === null || !waterRate || !moveInDate) {
        console.error('Tenant registration validation error:', { roomRate, elec_reading, elec_rate, water_reading, water_rate: state.data.water_rate, moveInDate });
        await sendTelegramMessage(chatId, `Error: invalid input format. Please try again.`);
        delete conversationState[chatId];
        return;
      }

      try {
        await dbRun(
          `INSERT INTO rooms (room_number, tenant_name, room_rate, contact_number, move_in_date, electricity_rate, electricity_reading, water_rate_type, water_rate, water_reading)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            state.data.room_number,
            state.data.name,
            roomRate,
            contactNumber,
            moveInDate,
            elec_rate,
            elec_reading,
            waterRate.type,
            waterRate.amount,
            water_reading,
          ]
        );

        await sendTelegramMessage(
          chatId,
          `✓ Tenant <b>${state.data.name}</b> registered for room <b>${state.data.room_number}</b>`
        );
      } catch (err) {
        console.error('Register error:', err);
        await sendTelegramMessage(chatId, 'Error registering tenant. Try again.');
      }

      delete conversationState[chatId];
    }
  }
}

async function handleInputReading(chatId, userText) {
  if (!conversationState[chatId]) {
    conversationState[chatId] = { command: 'input_reading', step: 1, data: {} };
    await sendTelegramMessage(chatId, 'Which room? (e.g., 4C)');
    return;
  }

  const state = conversationState[chatId];
  if (state.command !== 'input_reading') {
    conversationState[chatId] = { command: 'input_reading', step: 1, data: {} };
    await sendTelegramMessage(chatId, 'Which room? (e.g., 4C)');
    return;
  }

  if (state.step === 1) {
    state.data.room_number = normalizeRoomNumber(userText);
    state.step++;
    await sendTelegramMessage(chatId, 'Enter current electricity meter reading (examples: 280, 2,800):');
  } else if (state.step === 2) {
    const value = parseFlexibleNumber(userText);
    if (value === null) {
      await sendTelegramMessage(chatId, 'Invalid electricity reading. Please enter a numeric value (e.g., 280).');
      return;
    }
    state.data.electricity_reading = value;
    state.step++;
    await sendTelegramMessage(chatId, 'Enter current water meter reading (examples: 180, 1,800):');
  } else if (state.step === 3) {
    const value = parseFlexibleNumber(userText);
    if (value === null) {
      await sendTelegramMessage(chatId, 'Invalid water reading. Please enter a numeric value (e.g., 180).');
      return;
    }
    state.data.water_reading = value;

    try {
      const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [state.data.room_number]);
      if (!room) {
        await sendTelegramMessage(chatId, `Room ${state.data.room_number} not found.`);
        delete conversationState[chatId];
        return;
      }

      if (state.data.electricity_reading < room.electricity_reading) {
        await sendTelegramMessage(
          chatId,
          `Invalid electricity reading. New reading (${state.data.electricity_reading}) cannot be lower than current baseline (${room.electricity_reading}).`
        );
        delete conversationState[chatId];
        return;
      }

      if (state.data.water_reading < room.water_reading) {
        await sendTelegramMessage(
          chatId,
          `Invalid water reading. New reading (${state.data.water_reading}) cannot be lower than current baseline (${room.water_reading}).`
        );
        delete conversationState[chatId];
        return;
      }

      const electricityConsumption = state.data.electricity_reading - room.electricity_reading;
      const electricityCost = electricityConsumption * room.electricity_rate;
      let waterCost = 0;
      let waterConsumption = 0;

      if (room.water_rate_type === 'fixed') {
        waterCost = room.water_rate;
      } else {
        waterConsumption = state.data.water_reading - room.water_reading;
        waterCost = waterConsumption * room.water_rate;
      }

      const totalCost = electricityCost + waterCost;
      const roomMonthlyRate = Number(room.room_rate || 0);
      const grandTotal = totalCost + roomMonthlyRate;
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString();
      const periodEnd = now.toLocaleDateString();

      const insertedBill = await dbRun(
        `INSERT INTO bills (room_id, period_start, period_end, room_rate, electricity_consumption, electricity_cost, water_consumption, water_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          room.id,
          periodStart,
          periodEnd,
          roomMonthlyRate,
          electricityConsumption,
          electricityCost,
          room.water_rate_type === 'fixed' ? 0 : waterConsumption,
          waterCost,
          grandTotal,
        ]
      );

      await dbRun(
        `UPDATE rooms
         SET electricity_reading = ?, water_reading = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [state.data.electricity_reading, state.data.water_reading, room.id]
      );

      const savedBill = await dbGet('SELECT * FROM bills WHERE id = ?', [insertedBill.id]);
      const filename = await generateBillPDF(room, savedBill);
      const pdfUrl = `${process.env.BOT_URL || 'https://glenda-residences-production.up.railway.app'}/bills/${filename}`;

      const billText = `
<b>BILL STATEMENT</b>
Room: ${room.room_number}
Tenant: ${room.tenant_name}

Period: ${periodStart} to ${periodEnd}

<b>Room Rate:</b>
₱${roomMonthlyRate.toFixed(2)}

<b>Electricity:</b>
Consumption: ${electricityConsumption.toFixed(2)} kWh
Rate: ₱${room.electricity_rate} per kWh
Cost: ₱${electricityCost.toFixed(2)}

<b>Water:</b>
${room.water_rate_type === 'fixed' ? `Fixed Rate: ₱${waterCost.toFixed(2)}` : `Consumption: ${waterConsumption.toFixed(2)} units\nRate: ₱${room.water_rate} per unit\nCost: ₱${waterCost.toFixed(2)}`}

<b>Total: ₱${grandTotal.toFixed(2)}</b>

<a href="${pdfUrl}">View Full Bill (PDF)</a>
      `;

      await sendTelegramMessage(chatId, billText);
    } catch (err) {
      console.error('Input reading error:', err);
      await sendTelegramMessage(chatId, 'Error processing reading. Try again.');
    }

    delete conversationState[chatId];
  }
}

async function handleViewBill(chatId, userText) {
  const normalizedRoomNumber = normalizeRoomNumber(userText);

  try {
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      return;
    }

    const bill = await dbGet(
      'SELECT * FROM bills WHERE room_id = ? ORDER BY created_at DESC LIMIT 1',
      [room.id]
    );

    if (!bill) {
      await sendTelegramMessage(chatId, `No bill found for room ${normalizedRoomNumber}.`);
      return;
    }

    const roomMonthlyRate = Number(bill.room_rate || room.room_rate || 0);
    const paymentStatus = (bill.status || 'unpaid').toUpperCase();
    const paidAtText = bill.paid_at ? new Date(bill.paid_at).toLocaleString() : 'Not yet paid';

    // Generate PDF
    try {
      const filename = await generateBillPDF(room, bill);
      const pdfUrl = `${process.env.BOT_URL || 'https://glenda-residences-production.up.railway.app'}/bills/${filename}`;
      
      const billText = `
<b>BILL STATEMENT</b>
Room: ${room.room_number}
Tenant: ${room.tenant_name}

Period: ${bill.period_start} to ${bill.period_end}

<b>Room Rate:</b>
₱${roomMonthlyRate.toFixed(2)}

<b>Electricity:</b>
Consumption: ${bill.electricity_consumption.toFixed(2)} kWh
Cost: ₱${bill.electricity_cost.toFixed(2)}

<b>Water:</b>
${bill.water_consumption > 0 ? `Consumption: ${bill.water_consumption.toFixed(2)} units` : 'Fixed Rate'}
Cost: ₱${bill.water_cost.toFixed(2)}

<b>Total: ₱${bill.total_cost.toFixed(2)}</b>

<b>Payment Status:</b> ${paymentStatus}
<b>Paid At:</b> ${paidAtText}

<a href="${pdfUrl}">📄 View Full Bill (PDF)</a>
      `;

      await sendTelegramMessage(chatId, billText);
    } catch (pdfErr) {
      console.error('PDF generation error:', pdfErr);
      // Fallback to text-only if PDF fails
      const billText = `
<b>BILL STATEMENT</b>
Room: ${room.room_number}
Tenant: ${room.tenant_name}

Period: ${bill.period_start} to ${bill.period_end}

<b>Electricity:</b>
Consumption: ${bill.electricity_consumption.toFixed(2)} kWh
Cost: ₱${bill.electricity_cost.toFixed(2)}

<b>Water:</b>
${bill.water_consumption > 0 ? `Consumption: ${bill.water_consumption.toFixed(2)} units` : 'Fixed Rate'}
Cost: ₱${bill.water_cost.toFixed(2)}

<b>Total: ₱${bill.total_cost.toFixed(2)}</b>

<b>Payment Status:</b> ${paymentStatus}
<b>Paid At:</b> ${paidAtText}
      `;
      await sendTelegramMessage(chatId, billText);
    }
  } catch (err) {
    console.error('View bill error:', err);
    await sendTelegramMessage(chatId, 'Error retrieving bill. Try again.');
  }
}

async function handlePaymentStatus(chatId, userText) {
  const normalizedRoomNumber = normalizeRoomNumber(userText);

  try {
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      return;
    }

    const bill = await dbGet(
      'SELECT * FROM bills WHERE room_id = ? ORDER BY created_at DESC LIMIT 1',
      [room.id]
    );

    if (!bill) {
      await sendTelegramMessage(chatId, `No bill found for room ${normalizedRoomNumber}.`);
      return;
    }

    const paymentStatus = (bill.status || 'unpaid').toUpperCase();
    const paidAtText = bill.paid_at ? new Date(bill.paid_at).toLocaleString() : 'Not yet paid';
    const notesText = bill.payment_notes ? bill.payment_notes : 'None';

    await sendTelegramMessage(
      chatId,
      `<b>PAYMENT STATUS</b>\nRoom: ${room.room_number}\nTenant: ${room.tenant_name}\n\nLatest Bill Total: ₱${bill.total_cost.toFixed(2)}\nStatus: <b>${paymentStatus}</b>\nPaid At: ${paidAtText}\nNotes: ${notesText}`
    );
  } catch (err) {
    console.error('Payment status error:', err);
    await sendTelegramMessage(chatId, 'Error retrieving payment status. Try again.');
  }
}

async function handleMarkPaid(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'mark_paid') {
    conversationState[chatId] = { command: 'mark_paid', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }
    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room do you want to mark as paid?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    const unpaidBill = await dbGet(
      "SELECT * FROM bills WHERE room_id = ? AND COALESCE(status, 'unpaid') = 'unpaid' ORDER BY created_at DESC LIMIT 1",
      [room.id]
    );

    if (!unpaidBill) {
      await sendTelegramMessage(chatId, `No unpaid bill found for room ${room.room_number}.`);
      delete conversationState[chatId];
      return;
    }

    state.data.room = room;
    state.data.bill = unpaidBill;
    state.step = 2;
    await sendTelegramMessage(chatId, `Unpaid bill found for room ${room.room_number} (₱${unpaidBill.total_cost.toFixed(2)}).\n\nEnter payment notes, or type '-' to skip.`);
    return;
  }

  if (state.step === 2) {
    const notes = String(userText || '').trim();
    const paymentNotes = notes === '-' ? null : notes;

    await dbRun(
      "UPDATE bills SET status = 'paid', paid_at = CURRENT_TIMESTAMP, payment_notes = ? WHERE id = ?",
      [paymentNotes, state.data.bill.id]
    );

    await sendTelegramMessage(
      chatId,
      `✅ Bill marked as PAID.\nRoom: ${state.data.room.room_number}\nAmount: ₱${state.data.bill.total_cost.toFixed(2)}\n${paymentNotes ? `Notes: ${paymentNotes}` : ''}`
    );

    delete conversationState[chatId];
  }
}

async function handleMarkUnpaid(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'mark_unpaid') {
    conversationState[chatId] = { command: 'mark_unpaid', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }
    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room do you want to mark as unpaid?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    const paidBill = await dbGet(
      "SELECT * FROM bills WHERE room_id = ? AND COALESCE(status, 'unpaid') = 'paid' ORDER BY created_at DESC LIMIT 1",
      [room.id]
    );

    if (!paidBill) {
      await sendTelegramMessage(chatId, `No paid bill found for room ${room.room_number}.`);
      delete conversationState[chatId];
      return;
    }

    state.data.room = room;
    state.data.bill = paidBill;
    state.step = 2;
    await sendTelegramMessage(chatId, `Paid bill found for room ${room.room_number} (₱${paidBill.total_cost.toFixed(2)}).\n\nEnter undo notes, or type '-' to skip.`);
    return;
  }

  if (state.step === 2) {
    const notes = String(userText || '').trim();
    const undoNotes = notes === '-' ? null : notes;

    await dbRun(
      "UPDATE bills SET status = 'unpaid', paid_at = NULL, payment_notes = ? WHERE id = ?",
      [undoNotes, state.data.bill.id]
    );

    await sendTelegramMessage(
      chatId,
      `↩️ Bill marked as UNPAID.\nRoom: ${state.data.room.room_number}\nAmount: ₱${state.data.bill.total_cost.toFixed(2)}\n${undoNotes ? `Notes: ${undoNotes}` : ''}`
    );

    delete conversationState[chatId];
  }
}

async function handleSendReminder(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'send_reminder') {
    conversationState[chatId] = { command: 'send_reminder', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room do you want to send a bill reminder to?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);

    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    const bill = await dbGet(
      "SELECT * FROM bills WHERE room_id = ? AND COALESCE(status, 'unpaid') = 'unpaid' ORDER BY created_at DESC LIMIT 1",
      [room.id]
    );

    if (!bill) {
      await sendTelegramMessage(chatId, `No unpaid bill found for room ${room.room_number}.`);
      delete conversationState[chatId];
      return;
    }

    const normalizedRecipient = normalizePhoneNumber(room.contact_number);
    if (!normalizedRecipient) {
      await sendTelegramMessage(chatId, `Room ${room.room_number} has no valid contact number. Update it first using /updatetenant.`);
      delete conversationState[chatId];
      return;
    }

    const messageContent = buildReminderMessage(room, bill);

    state.data.room = room;
    state.data.bill = bill;
    state.data.toNumber = normalizedRecipient;
    state.data.content = messageContent;
    state.step = 2;

    await sendTelegramMessage(
      chatId,
      `<b>Reminder preview</b>\nTo: ${normalizedRecipient}\nRoom: ${room.room_number}\nAmount Due: PHP ${Number(bill.total_cost).toFixed(2)}\n\n${messageContent}\n\nType SEND to continue.`
    );
    return;
  }

  if (state.step === 2) {
    const confirmation = String(userText || '').trim().toUpperCase();
    if (confirmation !== 'SEND') {
      await sendTelegramMessage(chatId, 'Reminder send cancelled. No SMS was sent.');
      delete conversationState[chatId];
      return;
    }

    const requestId = `bill-${state.data.bill.id}-${Date.now()}`;
    const normalizedFromNumber = normalizePhoneNumber(httpSmsFromNumber || '');

    try {
      const result = await sendHttpSmsMessage({
        to: state.data.toNumber,
        content: state.data.content,
        requestId,
      });

      await logSmsAttempt({
        billId: state.data.bill.id,
        roomId: state.data.room.id,
        toNumber: state.data.toNumber,
        fromNumber: normalizedFromNumber || String(httpSmsFromNumber || ''),
        content: state.data.content,
        requestId,
        providerMessageId: result.providerMessageId,
        status: result.providerStatus || 'queued',
        sentAt: new Date().toISOString(),
      });

      await sendTelegramMessage(
        chatId,
        `✅ SMS reminder queued successfully.\nRoom: ${state.data.room.room_number}\nTo: ${state.data.toNumber}\nMessage ID: ${result.providerMessageId || 'N/A'}`
      );
    } catch (error) {
      console.error('Send reminder error:', error);

      try {
        await logSmsAttempt({
          billId: state.data.bill.id,
          roomId: state.data.room.id,
          toNumber: state.data.toNumber,
          fromNumber: normalizedFromNumber || String(httpSmsFromNumber || ''),
          content: state.data.content,
          requestId,
          status: 'failed',
          errorMessage: String(error.message || error),
        });
      } catch (logError) {
        console.error('SMS log save error:', logError);
      }

      await sendTelegramMessage(chatId, `Failed to send SMS reminder. ${String(error.message || error)}`);
    }

    delete conversationState[chatId];
  }
}

async function handleSendReminderAll(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'send_reminder_all') {
    const unpaidRows = await dbAll(
      `SELECT
        r.id AS room_id,
        r.room_number,
        r.tenant_name,
        r.contact_number,
        b.id AS bill_id,
        b.period_start,
        b.period_end,
        b.total_cost
       FROM rooms r
       INNER JOIN bills b ON b.room_id = r.id
       WHERE COALESCE(b.status, 'unpaid') = 'unpaid'
         AND b.created_at = (
           SELECT MAX(b2.created_at)
           FROM bills b2
           WHERE b2.room_id = r.id
             AND COALESCE(b2.status, 'unpaid') = 'unpaid'
         )
       ORDER BY r.room_number ASC`
    );

    if (!unpaidRows.length) {
      await sendTelegramMessage(chatId, 'No unpaid bills found.');
      delete conversationState[chatId];
      return;
    }

    const validCandidates = [];
    const skippedRooms = [];

    for (const row of unpaidRows) {
      const toNumber = normalizePhoneNumber(row.contact_number);
      if (!toNumber) {
        skippedRooms.push(`${row.room_number} (invalid/missing contact)`);
        continue;
      }

      validCandidates.push({
        roomId: row.room_id,
        roomNumber: row.room_number,
        tenantName: row.tenant_name,
        billId: row.bill_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        totalCost: Number(row.total_cost || 0),
        toNumber,
      });
    }

    if (!validCandidates.length) {
      const skippedText = skippedRooms.length ? `\nSkipped: ${skippedRooms.join(', ')}` : '';
      await sendTelegramMessage(chatId, `No valid recipients found for unpaid bills.${skippedText}`);
      delete conversationState[chatId];
      return;
    }

    conversationState[chatId] = {
      command: 'send_reminder_all',
      step: 1,
      data: {
        validCandidates,
        skippedRooms,
      },
    };

    await sendTelegramMessage(
      chatId,
      `<b>Bulk reminder preview</b>\nRecipients: ${validCandidates.length}\n${skippedRooms.length ? `Skipped: ${skippedRooms.length}\n` : ''}Type SENDALL to send reminders now.`
    );
    return;
  }

  const state = conversationState[chatId];
  if (state.step !== 1) {
    delete conversationState[chatId];
    await sendTelegramMessage(chatId, 'Bulk reminder flow reset. Please run /sendremainderall again.');
    return;
  }

  const confirmation = String(userText || '').trim().toUpperCase();
  if (confirmation !== 'SENDALL') {
    await sendTelegramMessage(chatId, 'Bulk reminder send cancelled. No SMS was sent.');
    delete conversationState[chatId];
    return;
  }

  const normalizedFromNumber = normalizePhoneNumber(httpSmsFromNumber || '') || String(httpSmsFromNumber || '');
  const sendResults = {
    sent: 0,
    failed: 0,
  };
  const failedRooms = [];

  for (const candidate of state.data.validCandidates) {
    const messageContent = buildReminderMessage(
      { room_number: candidate.roomNumber },
      {
        id: candidate.billId,
        total_cost: candidate.totalCost,
        period_start: candidate.periodStart,
        period_end: candidate.periodEnd,
      }
    );
    const requestId = `bulk-bill-${candidate.billId}-${Date.now()}-${candidate.roomId}`;

    try {
      const result = await sendHttpSmsMessage({
        to: candidate.toNumber,
        content: messageContent,
        requestId,
      });

      await logSmsAttempt({
        billId: candidate.billId,
        roomId: candidate.roomId,
        toNumber: candidate.toNumber,
        fromNumber: normalizedFromNumber,
        content: messageContent,
        requestId,
        providerMessageId: result.providerMessageId,
        status: result.providerStatus || 'queued',
        sentAt: new Date().toISOString(),
      });

      sendResults.sent += 1;
    } catch (error) {
      sendResults.failed += 1;
      failedRooms.push(candidate.roomNumber);

      try {
        await logSmsAttempt({
          billId: candidate.billId,
          roomId: candidate.roomId,
          toNumber: candidate.toNumber,
          fromNumber: normalizedFromNumber,
          content: messageContent,
          requestId,
          status: 'failed',
          errorMessage: String(error.message || error),
        });
      } catch (logError) {
        console.error('Bulk SMS log save error:', logError);
      }
    }
  }

  const skippedRooms = state.data.skippedRooms || [];
  await sendTelegramMessage(
    chatId,
    `✅ Bulk reminder run completed.\nSent: ${sendResults.sent}\nFailed: ${sendResults.failed}\nSkipped (invalid contact): ${skippedRooms.length}${failedRooms.length ? `\nFailed rooms: ${failedRooms.join(', ')}` : ''}${skippedRooms.length ? `\nSkipped rooms: ${skippedRooms.join(', ')}` : ''}`
  );

  delete conversationState[chatId];
}

async function handleUpdateTenant(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'update_tenant') {
    conversationState[chatId] = { command: 'update_tenant', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room do you want to update?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    state.data.room = room;
    state.step = 2;
    await sendTelegramMessage(
      chatId,
      `<b>Room ${room.room_number}</b> selected.\n\nWhat do you want to update?\n- name\n- contact\n- movein\n- roomrate\n- electricityrate\n- waterrate\n\nType one option exactly.`
    );
    return;
  }

  if (state.step === 2) {
    const fieldInput = String(userText || '').trim().toLowerCase();
    const supportedFields = {
      name: {
        prompt: 'Enter new tenant name:',
        sql: 'UPDATE rooms SET tenant_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => ({ ok: true, value: String(value || '').trim(), label: 'Tenant name' }),
      },
      contact: {
        prompt: 'Enter new contact number:',
        sql: 'UPDATE rooms SET contact_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => ({ ok: true, value: String(value || '').trim(), label: 'Contact number' }),
      },
      movein: {
        prompt: 'Enter new move-in date (examples: 2026-04-09, April 9, 2026, today):',
        sql: 'UPDATE rooms SET move_in_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => {
          const parsed = parseFlexibleDate(value);
          return parsed ? { ok: true, value: parsed, label: 'Move-in date' } : { ok: false, error: 'Invalid date format.' };
        },
      },
      roomrate: {
        prompt: 'Enter new monthly room rate (examples: 3500, 3,500, ₱3,500):',
        sql: 'UPDATE rooms SET room_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => {
          const parsed = parseFlexibleNumber(value);
          return parsed !== null ? { ok: true, value: parsed, label: 'Room rate' } : { ok: false, error: 'Invalid room rate format.' };
        },
      },
      electricityrate: {
        prompt: 'Enter new electricity rate (examples: 12, 12.5, ₱12):',
        sql: 'UPDATE rooms SET electricity_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => {
          const parsed = parseFlexibleNumber(value);
          return parsed !== null ? { ok: true, value: parsed, label: 'Electricity rate' } : { ok: false, error: 'Invalid electricity rate format.' };
        },
      },
      waterrate: {
        prompt: 'Enter new water rate (format: fixed:100 or per:15, commas allowed):',
        sql: 'UPDATE rooms SET water_rate_type = ?, water_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        formatter: (value) => {
          const parsed = parseWaterRate(value);
          return parsed
            ? { ok: true, value: parsed, label: 'Water rate' }
            : { ok: false, error: 'Invalid water rate format. Use fixed:100 or per:15.' };
        },
      },
    };

    const selectedField = supportedFields[fieldInput];
    if (!selectedField) {
      await sendTelegramMessage(chatId, 'Invalid option. Type one of: name, contact, movein, roomrate, electricityrate, waterrate.');
      return;
    }

    state.data.fieldKey = fieldInput;
    state.step = 3;
    await sendTelegramMessage(chatId, selectedField.prompt);
    return;
  }

  if (state.step === 3) {
    const fieldKey = state.data.fieldKey;
    const room = state.data.room;
    const fieldConfig = {
      name: {
        sql: 'UPDATE rooms SET tenant_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value, room.id],
      },
      contact: {
        sql: 'UPDATE rooms SET contact_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value, room.id],
      },
      movein: {
        sql: 'UPDATE rooms SET move_in_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value, room.id],
      },
      roomrate: {
        sql: 'UPDATE rooms SET room_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value, room.id],
      },
      electricityrate: {
        sql: 'UPDATE rooms SET electricity_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value, room.id],
      },
      waterrate: {
        sql: 'UPDATE rooms SET water_rate_type = ?, water_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        buildParams: (value) => [value.type, value.amount, room.id],
      },
    };

    const parseInput = {
      name: (value) => {
        const normalized = String(value || '').trim();
        if (!normalized) return { ok: false, error: 'Tenant name cannot be empty.' };
        return { ok: true, value: normalized, label: 'Tenant name', rendered: normalized };
      },
      contact: (value) => {
        const normalized = String(value || '').trim();
        if (!normalized) return { ok: false, error: 'Contact number cannot be empty.' };
        return { ok: true, value: normalized, label: 'Contact number', rendered: normalized };
      },
      movein: (value) => {
        const parsed = parseFlexibleDate(value);
        if (!parsed) return { ok: false, error: 'Invalid date format.' };
        return { ok: true, value: parsed, label: 'Move-in date', rendered: parsed };
      },
      roomrate: (value) => {
        const parsed = parseFlexibleNumber(value);
        if (parsed === null) return { ok: false, error: 'Invalid room rate format.' };
        return { ok: true, value: parsed, label: 'Room rate', rendered: `₱${Number(parsed).toFixed(2)}` };
      },
      electricityrate: (value) => {
        const parsed = parseFlexibleNumber(value);
        if (parsed === null) return { ok: false, error: 'Invalid electricity rate format.' };
        return { ok: true, value: parsed, label: 'Electricity rate', rendered: `₱${Number(parsed).toFixed(2)}` };
      },
      waterrate: (value) => {
        const parsed = parseWaterRate(value);
        if (!parsed) return { ok: false, error: 'Invalid water rate format. Use fixed:100 or per:15.' };
        const rendered = parsed.type === 'fixed' ? `fixed:₱${Number(parsed.amount).toFixed(2)}` : `per:₱${Number(parsed.amount).toFixed(2)}`;
        return { ok: true, value: parsed, label: 'Water rate', rendered };
      },
    };

    const parser = parseInput[fieldKey];
    const config = fieldConfig[fieldKey];

    if (!parser || !config) {
      await sendTelegramMessage(chatId, 'Could not process update request. Please start again with /updatetenant.');
      delete conversationState[chatId];
      return;
    }

    const parsed = parser(userText);
    if (!parsed.ok) {
      await sendTelegramMessage(chatId, parsed.error);
      return;
    }

    try {
      await dbRun(config.sql, config.buildParams(parsed.value));
      await sendTelegramMessage(
        chatId,
        `✅ ${parsed.label} updated for room ${room.room_number}.\nNew value: ${parsed.rendered}`
      );
    } catch (err) {
      console.error('Update tenant error:', err);
      await sendTelegramMessage(chatId, 'Error updating tenant. Try again.');
    }

    delete conversationState[chatId];
  }
}

async function handleDeleteTenant(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'delete_tenant') {
    conversationState[chatId] = { command: 'delete_tenant', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room tenant assignment do you want to clear?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    if (isVacantTenantName(room.tenant_name)) {
      await sendTelegramMessage(chatId, `Room ${room.room_number} is already vacant.`);
      delete conversationState[chatId];
      return;
    }

    state.data.room = room;
    state.step = 2;
    await sendTelegramMessage(
      chatId,
      `You are about to clear tenant assignment for room ${room.room_number} (${room.tenant_name}).\nBilling history will be kept.\n\nType YES to confirm.`
    );
    return;
  }

  if (state.step === 2) {
    const confirmation = String(userText || '').trim().toUpperCase();
    if (confirmation !== 'YES') {
      await sendTelegramMessage(chatId, 'Delete cancelled. No changes were made.');
      delete conversationState[chatId];
      return;
    }

    try {
      await dbRun(
        `UPDATE rooms
         SET tenant_name = ?, contact_number = NULL, move_in_date = NULL, room_rate = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        ['VACANT', state.data.room.id]
      );

      await sendTelegramMessage(
        chatId,
        `✅ Tenant assignment cleared for room ${state.data.room.room_number}.\nHistorical bills were preserved.`
      );
    } catch (err) {
      console.error('Delete tenant error:', err);
      await sendTelegramMessage(chatId, 'Error clearing tenant assignment. Try again.');
    }

    delete conversationState[chatId];
  }
}

async function handleTransferTenant(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'transfer_tenant') {
    conversationState[chatId] = { command: 'transfer_tenant', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nEnter source room (current tenant room):`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const sourceRoomNumber = normalizeRoomNumber(userText);
    const sourceRoom = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [sourceRoomNumber]);
    if (!sourceRoom) {
      await sendTelegramMessage(chatId, `Room ${sourceRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    if (isVacantTenantName(sourceRoom.tenant_name)) {
      await sendTelegramMessage(chatId, `Room ${sourceRoom.room_number} has no active tenant to transfer.`);
      delete conversationState[chatId];
      return;
    }

    state.data.sourceRoom = sourceRoom;
    state.step = 2;
    await sendTelegramMessage(chatId, `Source room ${sourceRoom.room_number} selected (${sourceRoom.tenant_name}).\n\nEnter target room:`);
    return;
  }

  if (state.step === 2) {
    const targetRoomNumber = normalizeRoomNumber(userText);
    const sourceRoom = state.data.sourceRoom;

    if (targetRoomNumber === normalizeRoomNumber(sourceRoom.room_number)) {
      await sendTelegramMessage(chatId, 'Target room must be different from source room.');
      return;
    }

    const targetRoom = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [targetRoomNumber]);
    if (!targetRoom) {
      await sendTelegramMessage(chatId, `Room ${targetRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    if (!isVacantTenantName(targetRoom.tenant_name)) {
      await sendTelegramMessage(chatId, `Room ${targetRoom.room_number} is occupied by ${targetRoom.tenant_name}. Target room must be vacant.`);
      delete conversationState[chatId];
      return;
    }

    state.data.targetRoom = targetRoom;
    state.step = 3;
    await sendTelegramMessage(
      chatId,
      `Transfer tenant ${sourceRoom.tenant_name} from ${sourceRoom.room_number} to ${targetRoom.room_number}?\n\nType YES to confirm.`
    );
    return;
  }

  if (state.step === 3) {
    const confirmation = String(userText || '').trim().toUpperCase();
    if (confirmation !== 'YES') {
      await sendTelegramMessage(chatId, 'Transfer cancelled. No changes were made.');
      delete conversationState[chatId];
      return;
    }

    const sourceRoom = state.data.sourceRoom;
    const targetRoom = state.data.targetRoom;

    try {
      await dbRun(
        `UPDATE rooms
         SET tenant_name = ?, contact_number = ?, move_in_date = ?, room_rate = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [sourceRoom.tenant_name, sourceRoom.contact_number, sourceRoom.move_in_date, sourceRoom.room_rate, targetRoom.id]
      );

      await dbRun(
        `UPDATE rooms
         SET tenant_name = ?, contact_number = NULL, move_in_date = NULL, room_rate = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        ['VACANT', sourceRoom.id]
      );

      await sendTelegramMessage(
        chatId,
        `✅ Tenant transferred successfully.\nFrom: ${sourceRoom.room_number}\nTo: ${targetRoom.room_number}\nTenant: ${sourceRoom.tenant_name}`
      );
    } catch (err) {
      console.error('Transfer tenant error:', err);
      await sendTelegramMessage(chatId, 'Error transferring tenant. Try again.');
    }

    delete conversationState[chatId];
  }
}

async function handleEditReading(chatId, userText) {
  if (!conversationState[chatId] || conversationState[chatId].command !== 'edit_reading') {
    conversationState[chatId] = { command: 'edit_reading', step: 1, data: {} };
    const roomsText = await getRoomsListText();
    if (!roomsText) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      delete conversationState[chatId];
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomsText}\n\nWhich room bill reading do you want to edit?`);
    return;
  }

  const state = conversationState[chatId];

  if (state.step === 1) {
    const normalizedRoomNumber = normalizeRoomNumber(userText);
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [normalizedRoomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${normalizedRoomNumber} not found.`);
      delete conversationState[chatId];
      return;
    }

    const bill = await dbGet(
      'SELECT * FROM bills WHERE room_id = ? ORDER BY created_at DESC LIMIT 1',
      [room.id]
    );

    if (!bill) {
      await sendTelegramMessage(chatId, `No bill found for room ${room.room_number}.`);
      delete conversationState[chatId];
      return;
    }

    const previousElectricityBaseline = Number(room.electricity_reading) - Number(bill.electricity_consumption || 0);
    const previousWaterBaseline = Number(room.water_reading) - Number(bill.water_consumption || 0);

    if (previousElectricityBaseline < 0 || previousWaterBaseline < 0) {
      await sendTelegramMessage(chatId, 'Cannot safely compute previous baseline for this room. Please check existing bill/readings data first.');
      delete conversationState[chatId];
      return;
    }

    state.data.room = room;
    state.data.bill = bill;
    state.data.previousElectricityBaseline = previousElectricityBaseline;
    state.data.previousWaterBaseline = previousWaterBaseline;
    state.step = 2;

    await sendTelegramMessage(
      chatId,
      `Latest bill found for room ${room.room_number}.\nCurrent billed totals: ₱${Number(bill.total_cost).toFixed(2)}\n\nPrevious electricity baseline: ${previousElectricityBaseline.toFixed(2)}\nEnter corrected current electricity reading:`
    );
    return;
  }

  if (state.step === 2) {
    const electricityReading = parseFlexibleNumber(userText);
    if (electricityReading === null) {
      await sendTelegramMessage(chatId, 'Invalid electricity reading. Please enter a numeric value.');
      return;
    }

    if (electricityReading < state.data.previousElectricityBaseline) {
      await sendTelegramMessage(
        chatId,
        `Invalid electricity reading. It cannot be lower than previous baseline (${state.data.previousElectricityBaseline.toFixed(2)}).`
      );
      return;
    }

    state.data.correctedElectricityReading = electricityReading;
    state.step = 3;

    await sendTelegramMessage(
      chatId,
      `Previous water baseline: ${state.data.previousWaterBaseline.toFixed(2)}\nEnter corrected current water reading:`
    );
    return;
  }

  if (state.step === 3) {
    const waterReading = parseFlexibleNumber(userText);
    if (waterReading === null) {
      await sendTelegramMessage(chatId, 'Invalid water reading. Please enter a numeric value.');
      return;
    }

    if (waterReading < state.data.previousWaterBaseline) {
      await sendTelegramMessage(
        chatId,
        `Invalid water reading. It cannot be lower than previous baseline (${state.data.previousWaterBaseline.toFixed(2)}).`
      );
      return;
    }

    const room = state.data.room;
    const bill = state.data.bill;
    const previousElectricityBaseline = state.data.previousElectricityBaseline;
    const previousWaterBaseline = state.data.previousWaterBaseline;
    const correctedElectricityReading = state.data.correctedElectricityReading;
    const correctedWaterReading = waterReading;

    const electricityConsumption = correctedElectricityReading - previousElectricityBaseline;
    const electricityCost = electricityConsumption * Number(room.electricity_rate);

    let waterConsumption = 0;
    let waterCost = 0;

    if (room.water_rate_type === 'fixed') {
      waterCost = Number(room.water_rate || 0);
    } else {
      waterConsumption = correctedWaterReading - previousWaterBaseline;
      waterCost = waterConsumption * Number(room.water_rate || 0);
    }

    const roomMonthlyRate = Number(bill.room_rate || room.room_rate || 0);
    const totalCost = roomMonthlyRate + electricityCost + waterCost;

    try {
      await dbRun(
        `UPDATE bills
         SET electricity_consumption = ?, electricity_cost = ?, water_consumption = ?, water_cost = ?, total_cost = ?
         WHERE id = ?`,
        [electricityConsumption, electricityCost, waterConsumption, waterCost, totalCost, bill.id]
      );

      await dbRun(
        `UPDATE rooms
         SET electricity_reading = ?, water_reading = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [correctedElectricityReading, correctedWaterReading, room.id]
      );

      await sendTelegramMessage(
        chatId,
        `✅ Latest reading updated for room ${room.room_number}.\nOld total: ₱${Number(bill.total_cost).toFixed(2)}\nNew total: ₱${totalCost.toFixed(2)}\nElectricity consumption: ${electricityConsumption.toFixed(2)}\n${room.water_rate_type === 'fixed' ? `Water cost (fixed): ₱${waterCost.toFixed(2)}` : `Water consumption: ${waterConsumption.toFixed(2)}`}`
      );
    } catch (err) {
      console.error('Edit reading error:', err);
      await sendTelegramMessage(chatId, 'Error editing reading. Try again.');
    }

    delete conversationState[chatId];
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message;

  if (!message || !message.chat || !message.chat.id) {
    return;
  }

  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (!text) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Message from ${chatId}: ${text}`);

  if (chatId !== ownerTelegramId) {
    await sendTelegramMessage(chatId, 'Not authorized.');
    return;
  }

  if (text === '/cancel') {
    if (conversationState[chatId]) {
      delete conversationState[chatId];
      await sendTelegramMessage(chatId, 'Current operation cancelled.');
    } else {
      await sendTelegramMessage(chatId, 'No active operation to cancel.');
    }
    return;
  }

  if (text === '/start') {
    await sendTelegramMessage(chatId, 'Glenda Residences bot online.\n\nCommands: /registertenant, /updatetenant, /deletetenant, /transfertenant, /inputreading, /editreading, /viewbill, /paymentstatus, /markpaid, /markunpaid, /sendremainder, /sendremainderall, /cancel');
    return;
  }

  if (text === '/registertenant') {
    await handleRegisterTenant(chatId, null);
    return;
  }

  if (text === '/inputreading') {
    await handleInputReading(chatId, null);
    return;
  }

  if (text === '/updatetenant') {
    await handleUpdateTenant(chatId, null);
    return;
  }

  if (text === '/deletetenant') {
    await handleDeleteTenant(chatId, null);
    return;
  }

  if (text === '/transfertenant') {
    await handleTransferTenant(chatId, null);
    return;
  }

  if (text === '/viewbill') {
    const roomList = await getRoomsListText();
    if (!roomList) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomList}\n\nWhich room?`);
    conversationState[chatId] = { command: 'view_bill', step: 1 };
    return;
  }

  if (text === '/paymentstatus') {
    const roomList = await getRoomsListText();
    if (!roomList) {
      await sendTelegramMessage(chatId, 'No rooms found yet. Register a tenant first using /registertenant.');
      return;
    }

    await sendTelegramMessage(chatId, `<b>Available rooms:</b>\n${roomList}\n\nWhich room do you want to check?`);
    conversationState[chatId] = { command: 'payment_status', step: 1 };
    return;
  }

  if (text === '/markpaid') {
    await handleMarkPaid(chatId, null);
    return;
  }

  if (text === '/markunpaid') {
    await handleMarkUnpaid(chatId, null);
    return;
  }

  if (text === '/sendremainder') {
    await handleSendReminder(chatId, null);
    return;
  }

  if (text === '/sendremainderall') {
    await handleSendReminderAll(chatId, null);
    return;
  }

  if (text === '/editreading') {
    await handleEditReading(chatId, null);
    return;
  }

  if (conversationState[chatId]?.command === 'register_tenant') {
    await handleRegisterTenant(chatId, text);
  } else if (conversationState[chatId]?.command === 'input_reading') {
    await handleInputReading(chatId, text);
  } else if (conversationState[chatId]?.command === 'view_bill') {
    await handleViewBill(chatId, text);
    delete conversationState[chatId];
  } else if (conversationState[chatId]?.command === 'payment_status') {
    await handlePaymentStatus(chatId, text);
    delete conversationState[chatId];
  } else if (conversationState[chatId]?.command === 'mark_paid') {
    await handleMarkPaid(chatId, text);
  } else if (conversationState[chatId]?.command === 'mark_unpaid') {
    await handleMarkUnpaid(chatId, text);
  } else if (conversationState[chatId]?.command === 'update_tenant') {
    await handleUpdateTenant(chatId, text);
  } else if (conversationState[chatId]?.command === 'send_reminder') {
    await handleSendReminder(chatId, text);
  } else if (conversationState[chatId]?.command === 'send_reminder_all') {
    await handleSendReminderAll(chatId, text);
  } else if (conversationState[chatId]?.command === 'delete_tenant') {
    await handleDeleteTenant(chatId, text);
  } else if (conversationState[chatId]?.command === 'transfer_tenant') {
    await handleTransferTenant(chatId, text);
  } else if (conversationState[chatId]?.command === 'edit_reading') {
    await handleEditReading(chatId, text);
  } else {
    await sendTelegramMessage(chatId, 'Command not recognized. Use /start for help.');
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[${new Date().toISOString()}] ${req.method} ${requestUrl.pathname}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'glenda-bh-telegram-bot', status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/telegram/webhook') {
    const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (telegramWebhookSecret && incomingSecret !== telegramWebhookSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Telegram webhook secret' }));
      return;
    }

    readRequestBody(req)
      .then(async (update) => {
        await handleTelegramUpdate(update);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      });

    return;
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/bills/')) {
    const filename = requestUrl.pathname.replace('/bills/', '');
    // Sanitize filename to prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }

    const filepath = path.join(__dirname, '../public', filename);
    
    fs.readFile(filepath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bill not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': data.length
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
