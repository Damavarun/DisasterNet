import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { createNetwork } from '../src/network.js';
import { toWire } from '../src/message.js';

async function until(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for peer/message state');
}

test('MySQL + HTTP + WebSocket + two real libp2p nodes', { timeout: 120000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const databases = [`dn_it_${suffix}_a`, `dn_it_${suffix}_b`];
  const directory = await mkdtemp(path.join(tmpdir(), 'disasternet-test-'));
  const mysqlConfig = { host: process.env.TEST_MYSQL_HOST || '127.0.0.1', port: Number(process.env.TEST_MYSQL_PORT || 3306),
    user: process.env.TEST_MYSQL_USER || 'root', password: process.env.TEST_MYSQL_PASSWORD || '' };
  const admin = await mysql.createConnection(mysqlConfig);
  const running = new Set();
  const stores = new Set();
  const sockets = new Set();
  let a, b, storeA, storeB;
  const configs = databases.map((database, i) => ({ ...readConfig({
    MYSQL_HOST: mysqlConfig.host, MYSQL_PORT: String(mysqlConfig.port), MYSQL_USER: mysqlConfig.user,
    MYSQL_PASSWORD: mysqlConfig.password, MYSQL_DATABASE: database, PORT: '0', P2P_PORT: '0', HOST: '127.0.0.1',
    NODE_NAME: i ? 'Rescue node' : 'Varun node', NETWORK_NAME: `test-${suffix}`, DATA_DIR: path.join(directory, String(i)), ACCESS_PIN: 'integration-only-pin',
  }), DISABLE_MDNS: true }));
  const start = async (config, store) => {
    const app = await createApp(config, store); await app.start(); running.add(app); return app;
  };
  const stop = async app => { await app.stop(); running.delete(app); };
  const url = app => `http://127.0.0.1:${app.server.address().port}`;
  const login = async app => {
    const response = await fetch(`${url(app)}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'integration-only-pin' }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  const post = async (app, cookie, body) => {
    const response = await fetch(`${url(app)}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal(response.status, 201); return response.json();
  };
  const link = async () => {
    await a.service.network.connect(b.service.network.addresses()[0]);
    await until(() => a.service.network.subscribers().length && b.service.network.subscribers().length);
  };
  try {
    for (const database of databases) await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    storeA = await createStore(configs[0]); stores.add(storeA); await storeA.migrate();
    storeB = await createStore(configs[1]); stores.add(storeB); await storeB.migrate();
    a = await start(configs[0], storeA);
    let cookieA = await login(a);
    let queued;
    await t.test('unauthenticated writes are blocked; disconnected messages stay pending', async () => {
      const denied = await fetch(`${url(a)}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 401);
      const wrongOrigin = await fetch(`${url(a)}/api/status`, { headers: { Origin: 'https://untrusted.invalid', Cookie: cookieA } });
      assert.equal(wrongOrigin.status, 403);
      queued = await post(a, cookieA, { senderName: 'Varun', body: 'Waiting for local peers', roomId: 'general' });
      assert.equal(queued.state, 'pending'); assert.equal(queued.receipts.length, 0);
    });
    b = await start(configs[1], storeB);
    const cookieB = await login(b);
    const events = [];
    const socket = new WebSocket(`${url(b).replace('http:', 'ws:')}/ws`, { headers: { Cookie: cookieB } });
    sockets.add(socket); socket.on('message', data => events.push(JSON.parse(data.toString())));
    await until(() => socket.readyState === WebSocket.OPEN);
    await link();
    await t.test('queued delivery, committed receipts, and live browser updates', async () => {
      await until(async () => (await storeA.get(queued.id))?.receipts.length);
      assert.equal((await storeB.get(queued.id)).body, queued.body);
      await until(() => events.some(event => event.type === 'message' && event.data.id === queued.id));
    });
    let rescue;
    await t.test('SOS is stored in rescue room; retries do not duplicate a message', async () => {
      rescue = await post(a, cookieA, { senderName: 'Varun', roomId: 'rescue', body: 'Need medical supplies', kind: 'sos', category: 'Medical', location: 'Community hall' });
      await until(async () => (await storeA.get(rescue.id))?.receipts.length);
      await a.service.network.publish(toWire(rescue));
      await until(async () => (await storeB.get(rescue.id))?.kind === 'sos');
      assert.equal((await storeB.messages('rescue')).filter(m => m.id === rescue.id).length, 1);
      assert.equal((await storeB.messages('general')).some(m => m.id === rescue.id), false);
    });
    await t.test('signed publisher cannot impersonate another peer ID', async () => {
      const fake = { ...toWire(rescue), id: randomUUID(), senderId: b.service.network.peerId };
      await a.service.network.publish(fake);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(await storeB.get(fake.id), null);
    });
    await t.test('restart preserves peer identity and saved history, then synchronizes missed messages', async () => {
      const oldId = a.service.network.peerId;
      await stop(a);
      await until(() => b.service.network.peers().length === 0);
      const missed = await post(b, cookieB, { senderName: 'Rescue', roomId: 'general', body: 'Update while Varun was disconnected' });
      a = await start(configs[0], storeA); cookieA = await login(a);
      assert.equal(a.service.network.peerId, oldId);
      assert.equal((await storeA.get(queued.id)).body, queued.body);
      await link();
      await a.service.network.requestSync();
      await until(async () => storeA.get(missed.id));
      assert.equal((await storeA.get(missed.id)).body, missed.body);
    });
    await t.test('unacknowledged expired messages stop retrying', async () => {
      const now = Date.now();
      const expired = { ...toWire(queued), id: randomUUID(), createdAt: now - 2000, expiresAt: now - 1000 };
      await storeA.save(expired, true);
      assert.equal((await storeA.pending()).some(m => m.id === expired.id), false);
      assert.equal((await storeA.get(expired.id)).state, 'expired');
    });
    await t.test('API validates empty messages and database-backed health', async () => {
      const invalid = await fetch(`${url(a)}/api/messages`, { method: 'POST', headers: { Cookie: cookieA, 'Content-Type': 'application/json' }, body: JSON.stringify({ senderName: 'Varun', body: ' ' }) });
      assert.equal(invalid.status, 400);
      const health = await fetch(`${url(a)}/api/health`); assert.equal(health.status, 200);
      assert.equal((await health.json()).database, 'mysql');
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const app of running) await app.stop();
    for (const store of stores) await store.close();
    for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end(); await rm(directory, { recursive: true, force: true });
  }
});

test('mDNS discovers a second node on the local host', { timeout: 35000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'disasternet-mdns-'));
  const suffix = randomUUID().slice(0, 8);
  const config = { P2P_PORT: 0, NETWORK_NAME: `mdns-${suffix}`, BOOTSTRAP_PEERS: '' };
  let first, second;
  try {
    first = await createNetwork({ ...config, DATA_DIR: path.join(directory, 'a') });
    second = await createNetwork({ ...config, DATA_DIR: path.join(directory, 'b') });
    await first.start(); await second.start();
    await until(() => first.peers().length && second.peers().length, 25000);
    assert.equal(first.peers()[0].id, second.peerId);
  } finally { await first?.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true }); }
});
