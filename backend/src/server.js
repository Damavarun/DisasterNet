import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { createService } from './service.js';
import { roomId } from './message.js';

export async function createApp(config, store) {
  const app = express();
  app.disable('x-powered-by');
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const sessions = new Map();
  const lifetime = 12 * 3600000;
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const addresses of Object.values(networkInterfaces())) for (const entry of addresses ?? []) {
    if (entry.family === 'IPv4') allowedHosts.add(entry.address);
  }
  const allowedOrigins = new Set(config.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
  function originAllowed(origin) {
    if (!origin) return true; // CLI clients authenticate using the same PIN session.
    try { const url = new URL(origin); return allowedOrigins.has(url.origin) || (['http:', 'https:'].includes(url.protocol) && allowedHosts.has(url.hostname)); }
    catch { return false; }
  }
  function session(req) {
    const cookie = /(?:^|;\s*)dn_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const expires = sessions.get(cookie);
    if (!expires || expires <= Date.now()) { if (cookie) sessions.delete(cookie); return false; }
    return true;
  }
  const broadcast = (type, data) => {
    const payload = JSON.stringify({ type, data });
    for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) {
      if (socket.expiresAt <= Date.now()) { socket.close(1008, 'Session expired'); continue; }
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Client too slow'); continue; }
      socket.send(payload);
    }
  };
  const service = await createService(config, store, broadcast);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
    if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', async (req, res) => {
    try { await store.ping(); res.json({ service: 'DisasterNet', ready: true, database: 'mysql' }); }
    catch { res.status(503).json({ service: 'DisasterNet', ready: false, database: 'unavailable' }); }
  });
  app.get('/api/session', (req, res) => res.json({ authenticated: session(req) }));
  app.post('/api/session', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res) => {
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    const expected = Buffer.from(config.ACCESS_PIN);
    const candidate = Buffer.from(pin);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return res.status(401).json({ error: 'Incorrect local access PIN' });
    for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
    if (sessions.size >= 200) return res.status(503).json({ error: 'Too many active sessions' });
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + lifetime);
    res.setHeader('Set-Cookie', `dn_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}`);
    res.json({ authenticated: true });
  });
  app.use('/api', (req, res, next) => session(req) ? next() : res.status(401).json({ error: 'Enter this node's access PIN to connect' }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.get('/api/status', (req, res) => res.json(service.status()));
  app.get('/api/rooms', (req, res) => res.json(service.rooms));
  app.get('/api/messages', async (req, res) => {
    const query = z.object({ roomId: roomId.default('general'), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    res.json(await store.messages(query.roomId, query));
  });
  app.post('/api/messages', async (req, res) => res.status(201).json(await service.send(req.body)));
  app.post('/api/peers', rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }), async (req, res) => {
    const { address } = z.object({ address: z.string().min(20).max(512) }).strict().parse(req.body);
    try { await service.network.connect(address); }
    catch { return res.status(400).json({ error: 'Could not connect. Check the peer address, network, and firewall.' }); }
    res.json(service.status());
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  const dist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (req, res) => res.sendFile(`${dist}/index.html`));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof z.ZodError || error.type === 'entity.parse.failed' ? 400 : error.status ?? 500;
    if (status >= 500) console.error('Request failed:', error.code ?? error.name);
    res.status(status).json({ error: error instanceof z.ZodError ? error.issues.map(i => i.message).join('; ')
      : status === 500 ? 'Local service error. Check the server and database.' : status === 413 ? 'Message is too large' : error.message });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !session(req) || !originAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const cookie = /(?:^|;\s*)dn_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      ws.expiresAt = sessions.get(cookie);
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => ws.terminate());
      ws.send(JSON.stringify({ type: 'status', data: service.status() }));
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive || socket.expiresAt <= Date.now()) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  }, 30000);
  heartbeat.unref();
  return {
    app, service, server,
    async start() {
      await service.start();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.PORT, config.HOST, () => { server.removeListener('error', reject); resolve(); });
        });
      } catch (error) { await service.stop(); clearInterval(heartbeat); throw error; }
      return server.address();
    },
    async stop() {
      clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await service.stop();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
