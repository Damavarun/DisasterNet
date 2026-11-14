import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { mdns } from '@libp2p/mdns';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@libp2p/gossipsub';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { wireMessage } from './message.js';

const receiptSchema = z.object({ messageId: z.uuid(), receivedAt: z.number().int().positive() }).strict();

export async function createNetwork(config, handlers = {}) {
  await mkdir(config.DATA_DIR, { recursive: true });
  const keyPath = path.join(config.DATA_DIR, 'peer.key');
  let privateKey;
  try { privateKey = privateKeyFromProtobuf(await readFile(keyPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privateKey = await generateKeyPair('Ed25519');
    await writeFile(keyPath, privateKeyToProtobuf(privateKey), { mode: 0o600, flag: 'wx' });
  }
  const node = await createLibp2p({
    start: false,
    privateKey,
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${config.P2P_PORT}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: config.DISABLE_MDNS ? [] : [mdns({ serviceTag: `_${config.NETWORK_NAME}._udp.local`, interval: 5000 })],
    services: {
      identify: identify(),
      pubsub: gossipsub({ emitSelf: false, allowPublishToZeroTopicPeers: true, maxTransmitSize: 16384 }),
    },
    connectionManager: { maxConnections: 48 },
  });
  const topic = `/disasternet/${config.NETWORK_NAME}/1`;
  const pubsub = node.services.pubsub;
  const peerId = node.peerId.toString();
  const warnedPeers = new Set();
  let running = false;
  const safe = fn => (...args) => Promise.resolve(fn(...args)).catch(error => handlers.onError?.(error));

  node.addEventListener('peer:discovery', safe(async event => {
    if (event.detail.id.toString() === peerId) return;
    try { await node.dial(event.detail.id); }
    catch (error) {
      if (!warnedPeers.has(event.detail.id.toString())) {
        warnedPeers.add(event.detail.id.toString()); handlers.onError?.(error);
      }
    }
  }));
  node.addEventListener('peer:connect', () => handlers.onPeers?.());
  node.addEventListener('peer:disconnect', () => handlers.onPeers?.());

  pubsub.addEventListener('message', safe(async event => {
    const message = event.detail;
    if (message.topic !== topic || message.type !== 'signed' || message.data.length > 16384) return;
    const from = message.from.toString();
    if (from === peerId) return;
    let envelope;
    try { envelope = JSON.parse(new TextDecoder().decode(message.data)); } catch { return; }
    if (envelope.v !== 1 || typeof envelope.nonce !== 'string' || envelope.nonce.length > 64) return;
    if (envelope.type === 'message') {
      const parsed = wireMessage.safeParse(envelope.payload);
      if (!parsed.success || parsed.data.senderId !== from || parsed.data.expiresAt <= Date.now()) return;
      await handlers.onMessage?.(parsed.data, from);
    } else if (envelope.type === 'receipt') {
      const parsed = receiptSchema.safeParse(envelope.payload);
      if (parsed.success && parsed.data.receivedAt <= Date.now() + 300000) await handlers.onReceipt?.(parsed.data, from);
    } else if (envelope.type === 'sync') {
      await handlers.onSync?.(from);
    }
  }));

  function subscribers() { return pubsub.getSubscribers(topic).map(id => id.toString()); }
  async function publish(type, payload) {
    if (!running || subscribers().length === 0) return false;
    const data = new TextEncoder().encode(JSON.stringify({ v: 1, nonce: randomUUID(), type, payload }));
    await pubsub.publish(topic, data);
    return true;
  }
  return {
    node, peerId,
    subscribers,
    peers: () => node.getPeers().map(id => ({ id: id.toString(), subscribed: subscribers().includes(id.toString()) })),
    addresses: () => node.getMultiaddrs().map(a => a.toString()),
    publish: message => publish('message', message),
    receipt: (messageId, receivedAt) => publish('receipt', { messageId, receivedAt }),
    requestSync: () => publish('sync', {}),
    connect: async address => {
      const parsed = multiaddr(address);
      if (!parsed.toString().includes('/p2p/')) throw new Error('Use a complete peer address ending in /p2p/<peer-id>');
      await node.dial(parsed);
    },
    async start() {
      await node.start();
      running = true;
      pubsub.subscribe(topic);
      for (const address of config.BOOTSTRAP_PEERS.split(',').map(x => x.trim()).filter(Boolean)) {
        try { await node.dial(multiaddr(address)); } catch (error) { handlers.onError?.(error); }
      }
    },
    async stop() { running = false; await node.stop(); },
  };
}
