import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { messageInput, wireMessage, toWire } from '../src/message.js';
import { mergeMessages } from '../../frontend/src/api.js';

test('input rejects whitespace, oversized content, and SOS without a category', () => {
  assert.equal(messageInput.safeParse({ senderName: 'Varun', body: '  ' }).success, false);
  assert.equal(messageInput.safeParse({ senderName: 'Varun', body: 'a'.repeat(2001) }).success, false);
  assert.equal(messageInput.safeParse({ senderName: 'Varun', body: 'Help', kind: 'sos' }).success, false);
  assert.equal(messageInput.parse({ senderName: ' Varun ', body: ' Update ' }).body, 'Update');
});

test('wire schema rejects invalid lifetimes and excludes local database fields', () => {
  const now = Date.now();
  const message = { id: randomUUID(), roomId: 'general', senderId: 'test-peer-identifier', senderName: 'Varun', body: 'Hello',
    kind: 'chat', createdAt: now, expiresAt: now + 1000, isLocal: true, state: 'pending', receipts: [] };
  assert.equal(toWire(message).isLocal, undefined);
  assert.equal(wireMessage.safeParse({ ...toWire(message), expiresAt: now - 1 }).success, false);
  assert.equal(wireMessage.safeParse({ ...toWire(message), createdAt: now + 600000, expiresAt: now + 900000 }).success, false);
});

test('UI catch-up merges duplicate IDs without losing receipts or regressing status', () => {
  const existing = [{ id: 'a', createdAt: 1, state: 'published', receipts: [{ peerId: 'b', receivedAt: 2 }] }];
  const result = mergeMessages(existing, [{ id: 'a', createdAt: 1, state: 'pending', receipts: [] }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].state, 'published');
  assert.equal(result[0].receipts.length, 1);
});
