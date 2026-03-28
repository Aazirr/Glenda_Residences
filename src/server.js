const http = require('http');
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
    { field: 'room_number', prompt: 'Room recorded.\n\nWhat is the electricity rate (PHP per kWh)?' },
    { field: 'electricity_rate', prompt: 'Electricity rate recorded.\n\nWhat is the current electricity meter reading?' },
    { field: 'electricity_reading', prompt: 'Current electricity reading recorded.\n\nWhat is the water rate? Enter "fixed:<amount>" for fixed or "per:<rate>" for per-unit.' },
    { field: 'water_rate', prompt: 'Water rate recorded.\n\nWhat is the current water meter reading?' },
    { field: 'water_reading', prompt: 'Registering tenant...' },
  ];

  if (state.step < steps.length) {
    const currentStep = steps[state.step - 1];
    state.data[currentStep.field] = userText;
    state.step++;

    if (state.step <= steps.length) {
      await sendTelegramMessage(chatId, steps[state.step - 1].prompt);
    }

    if (state.step > steps.length) {
      const waterType = state.data.water_rate.startsWith('fixed:') ? 'fixed' : 'per_unit';
      const waterValue = parseFloat(state.data.water_rate.split(':')[1]);

      try {
        await dbRun(
          `INSERT INTO rooms (room_number, tenant_name, electricity_rate, electricity_reading, water_rate_type, water_rate, water_reading)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            state.data.room_number,
            state.data.name,
            parseFloat(state.data.electricity_rate),
            parseFloat(state.data.electricity_reading),
            waterType,
            waterValue,
            parseFloat(state.data.water_reading),
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
  const roomNumber = userText.trim();

  try {
    const room = await dbGet('SELECT * FROM rooms WHERE room_number = ?', [roomNumber]);
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
