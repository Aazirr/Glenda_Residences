const http = require('http');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const db = require('./db');

const port = process.env.PORT || 3000;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const ownerTelegramId = parseInt(process.env.OWNER_TELEGRAM_ID || '0');

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

    // Electricity
    doc.fontSize(10).font('Helvetica-Bold').text('Electricity', 50, 235);
    doc.fontSize(9).font('Helvetica');
    doc.text(`Consumption: ${bill.electricity_consumption.toFixed(2)} kWh @ ₱${room.electricity_rate}/kWh`, 70, 255);
    doc.text(`Amount: ₱${bill.electricity_cost.toFixed(2)}`, 70, 270, { align: 'right', width: 425 });

    // Water
    doc.fontSize(10).font('Helvetica-Bold').text('Water', 50, 295);
    doc.fontSize(9).font('Helvetica');
    if (bill.water_consumption > 0) {
      doc.text(`Consumption: ${bill.water_consumption.toFixed(2)} units @ ₱${room.water_rate}/unit`, 70, 315);
    } else {
      doc.text(`Fixed Monthly Rate`, 70, 315);
    }
    doc.text(`Amount: ₱${bill.water_cost.toFixed(2)}`, 70, 330, { align: 'right', width: 425 });

    // Divider
    doc.moveTo(50, 355).lineTo(545, 355).stroke();

    // Total
    doc.fontSize(14).font('Helvetica-Bold').text('TOTAL AMOUNT DUE', 50, 375);
    doc.fontSize(14).font('Helvetica-Bold').text(`₱${bill.total_cost.toFixed(2)}`, 450, 375, { align: 'right' });

    // Footer
    doc.fontSize(8).font('Helvetica').text('Thank you for your payment.', 50, 500, { align: 'center' });

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
    { field: 'contact_number', prompt: 'Contact number saved.\n\nWhat is the move-in date? (format: YYYY-MM-DD or today\'s date)' },
    { field: 'move_in_date', prompt: 'Move-in date recorded.\n\nWhat is the electricity rate? (just the number, e.g., 12 for PHP 12/kWh)' },
    { field: 'electricity_rate', prompt: 'Electricity rate saved.\n\nWhat is the current electricity meter reading? (just the number, e.g., 250)' },
    { field: 'electricity_reading', prompt: 'Electricity meter saved.\n\nWhat is the water rate? (format: fixed:100 or per:15)' },
    { field: 'water_rate', prompt: 'Water rate saved.\n\nWhat is the current water meter reading? (just the number, e.g., 130)' },
    { field: 'water_reading', prompt: 'Registering tenant...' },
  ];
  
  if (state.step <= steps.length) {
    const currentStep = steps[state.step - 1];
    const nextPrompt = currentStep.prompt;
    state.data[currentStep.field] = userText;
    state.step++;

    if (state.step <= steps.length) {
      await sendTelegramMessage(chatId, nextPrompt);
    }

    if (state.step > steps.length) {
      const waterType = state.data.water_rate.startsWith('fixed:') ? 'fixed' : 'per_unit';
      const waterValue = parseFloat(state.data.water_rate.split(':')[1]);

      // Validate all critical values
      const elec_reading = parseFloat(state.data.electricity_reading);
      const elec_rate = parseFloat(state.data.electricity_rate);
      const water_reading = parseFloat(state.data.water_reading);

      if (isNaN(elec_reading) || isNaN(elec_rate) || isNaN(water_reading) || isNaN(waterValue)) {
        console.error('Tenant registration validation error:', { elec_reading, elec_rate, water_reading, waterValue });
        await sendTelegramMessage(chatId, `Error: invalid input format. Please try again.`);
        delete conversationState[chatId];
        return;
      }

      try {
        await dbRun(
          `INSERT INTO rooms (room_number, tenant_name, contact_number, move_in_date, electricity_rate, electricity_reading, water_rate_type, water_rate, water_reading)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            state.data.room_number,
            state.data.name,
            state.data.contact_number,
            state.data.move_in_date,
            elec_rate,
            elec_reading,
            waterType,
            waterValue,
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
    state.data.room_number = userText;
    state.step++;
    await sendTelegramMessage(chatId, 'Enter current electricity meter reading:');
  } else if (state.step === 2) {
    state.data.electricity_reading = parseFloat(userText);
    state.step++;
    await sendTelegramMessage(chatId, 'Enter current water meter reading:');
  } else if (state.step === 3) {
    state.data.water_reading = parseFloat(userText);

    try {
      const room = await dbGet('SELECT * FROM rooms WHERE room_number = ?', [state.data.room_number]);
      if (!room) {
        await sendTelegramMessage(chatId, `Room ${state.data.room_number} not found.`);
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
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString();
      const periodEnd = now.toLocaleDateString();

      await dbRun(
        `INSERT INTO bills (room_id, period_start, period_end, electricity_consumption, electricity_cost, water_consumption, water_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          room.id,
          periodStart,
          periodEnd,
          electricityConsumption,
          electricityCost,
          room.water_rate_type === 'fixed' ? 0 : waterConsumption,
          waterCost,
          totalCost,
        ]
      );

      const billText = `
<b>BILL STATEMENT</b>
Room: ${room.room_number}
Tenant: ${room.tenant_name}

Period: ${periodStart} to ${periodEnd}

<b>Electricity:</b>
Consumption: ${electricityConsumption.toFixed(2)} kWh
Rate: ₱${room.electricity_rate} per kWh
Cost: ₱${electricityCost.toFixed(2)}

<b>Water:</b>
${room.water_rate_type === 'fixed' ? `Fixed Rate: ₱${waterCost.toFixed(2)}` : `Consumption: ${waterConsumption.toFixed(2)} units\nRate: ₱${room.water_rate} per unit\nCost: ₱${waterCost.toFixed(2)}`}

<b>Total: ₱${totalCost.toFixed(2)}</b>
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
  const roomNumber = userText.trim().toUpperCase();

  try {
    const room = await dbGet('SELECT * FROM rooms WHERE UPPER(room_number) = ?', [roomNumber]);
    if (!room) {
      await sendTelegramMessage(chatId, `Room ${roomNumber} not found.`);
      return;
    }

    const bill = await dbGet(
      'SELECT * FROM bills WHERE room_id = ? ORDER BY created_at DESC LIMIT 1',
      [room.id]
    );

    if (!bill) {
      await sendTelegramMessage(chatId, `No bill found for room ${roomNumber}.`);
      return;
    }

    // Generate PDF
    try {
      const filename = await generateBillPDF(room, bill);
      const pdfUrl = `${process.env.BOT_URL || 'https://glenda-residences-production.up.railway.app'}/bills/${filename}`;
      
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
      `;
      await sendTelegramMessage(chatId, billText);
    }
  } catch (err) {
    console.error('View bill error:', err);
    await sendTelegramMessage(chatId, 'Error retrieving bill. Try again.');
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

  if (text === '/start') {
    await sendTelegramMessage(chatId, 'Glenda Residences bot online.\n\nCommands: /registertenant, /inputreading, /viewbill');
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

  if (text === '/viewbill') {
    await sendTelegramMessage(chatId, 'Which room?');
    conversationState[chatId] = { command: 'view_bill', step: 1 };
    return;
  }

  if (conversationState[chatId]?.command === 'register_tenant') {
    await handleRegisterTenant(chatId, text);
  } else if (conversationState[chatId]?.command === 'input_reading') {
    await handleInputReading(chatId, text);
  } else if (conversationState[chatId]?.command === 'view_bill') {
    await handleViewBill(chatId, text);
    delete conversationState[chatId];
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
