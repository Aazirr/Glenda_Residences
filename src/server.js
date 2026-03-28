const http = require('http');

const port = process.env.PORT || 3000;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

async function sendTelegramMessage(chatId, text) {
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

  console.log(`Telegram message from ${chatId}: ${text}`);

  if (text === '/start') {
    await sendTelegramMessage(chatId, 'Glenda Residences bot is online.');
    return;
  }

  if (text === '/ping') {
    await sendTelegramMessage(chatId, 'pong');
    return;
  }

  await sendTelegramMessage(chatId, `Received: ${text}`);
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
    res.end(JSON.stringify({
      service: 'glenda-bh-telegram-bot',
      status: 'ok',
    }));
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
