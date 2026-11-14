import { randomUUID } from 'node:crypto';
import { messageInput, toWire } from './message.js';
import { createNetwork } from './network.js';

export async function createService(config, store, emit = () => {}) {
  const rooms = await store.rooms();
  const roomSet = new Set(rooms.map(r => r.id));
  const syncTimes = new Map();
  const inFlight = new Set();
  let lastError = null;
  let database = 'connected';
  let retrying = false;
  const network = await createNetwork(config, {
    onError: error => { lastError = error.code ?? error.name ?? 'Network error'; },
    onPeers: () => emit('status', status()),
    onMessage: async message => {
      if (!roomSet.has(message.roomId)) return;
      // Only acknowledge after MySQL commits the message. A failed write must never look delivered.
      if (await store.save(message)) emit('message', await store.get(message.id));
      await network.receipt(message.id, Date.now());
    },
    onReceipt: async (receipt, from) => {
      if (await store.receipt(receipt.messageId, from, receipt.receivedAt)) emit('message', await store.get(receipt.messageId));
    },
    onSync: async from => {
      const now = Date.now();
      if (now - (syncTimes.get(from) ?? 0) < 15000) return;
      syncTimes.set(from, now);
      // Re-publish only this node's messages so GossipSub's signed sender remains authentic.
      // Bounded catch-up: most recent 100 unexpired messages in each room.
      for (const room of rooms) {
        for (const message of await store.recent(room.id)) {
          if (message.isLocal && message.senderId === network.peerId) await network.publish(toWire(message));
        }
      }
    },
  });

  function status() {
    return { peerId: network.peerId, nodeName: config.NODE_NAME, networkName: config.NETWORK_NAME,
      peers: network.peers(), addresses: network.addresses(), database, lastError,
      localNetworkRequired: true };
  }
  async function publish(message) {
    if (inFlight.has(message.id) || message.senderId !== network.peerId) return;
    inFlight.add(message.id);
    try {
      if (await network.publish(toWire(message))) {
        await store.published(message.id);
        emit('message', await store.get(message.id));
      }
    } finally { inFlight.delete(message.id); }
  }
  async function retry() {
    if (retrying) return;
    retrying = true;
    try {
      try { await store.ping(); database = 'connected'; }
      catch (error) { database = 'unavailable'; throw error; }
      for (const message of await store.pending()) await publish(message);
      emit('status', status());
    } catch (error) { lastError = error.code ?? error.name; emit('status', status()); }
    finally { retrying = false; }
  }
  const timers = [];
  return {
    network, rooms, status,
    async send(input) {
      const parsed = messageInput.parse(input);
      if (!roomSet.has(parsed.roomId)) throw Object.assign(new Error('Unknown room'), { status: 400 });
      const now = Date.now();
      const message = { ...parsed, id: randomUUID(), senderId: network.peerId, createdAt: now,
        expiresAt: now + (parsed.kind === 'sos' ? 86400000 : 7 * 86400000) };
      await store.save(message, true);
      emit('message', await store.get(message.id));
      try { await publish(message); } catch (error) { lastError = error.code ?? error.name; }
      return store.get(message.id);
    },
    async start() {
      await network.start();
      const schedule = (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); timers.push(timer); };
      schedule(() => void retry(), 5000);
      schedule(() => void network.requestSync().catch(error => { lastError = error.code ?? error.name; }), 20000);
    },
    async stop() { timers.forEach(clearInterval); await network.stop(); },
  };
}
