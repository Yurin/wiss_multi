const express = require('express');
const path = require('node:path');
// Resolve against this file so npm, PM2, and direct launches use the same config.
// Explicit process environment variables take precedence over .env values.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const { createServer } = require('node:http');
const { createWiss } = require('./wiss/router');

const app = express();
const wiss = createWiss();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use('/api/wiss', wiss.router);
app.get('/health', (req, res) => res.json({ success: true, message: 'WISS backend is running' }));
app.get('/', (req, res) => res.redirect('/booth/'));
app.use(express.static(path.join(__dirname, '..', 'photographer')));

const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  try {
    if (new URL(req.url, 'http://localhost').pathname === '/ws/wiss') {
      wiss.upgrade(req, socket, head);
      return;
    }
  } catch { /* Reject malformed upgrade requests. */ }
  socket.destroy();
});
server.listen(port, host, () => {
  console.log(`WISS backend listening on http://${host}:${port}`);
});
