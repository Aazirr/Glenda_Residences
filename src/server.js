const http = require('http');

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/webhook') {
    const mode = requestUrl.searchParams.get('hub.mode');
    const token = requestUrl.searchParams.get('hub.verify_token');
    const challenge = requestUrl.searchParams.get('hub.challenge');

    if (!verifyToken) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'VERIFY_TOKEN is not set on server' }));
      return;
    }

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
      return;
    }

    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook verification failed' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
