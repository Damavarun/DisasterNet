import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';

export async function createStore(config) {
  const pool = mysql.createPool({
    host: config.MYSQL_HOST, port: config.MYSQL_PORT, user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD, database: config.MYSQL_DATABASE,
    connectionLimit: 6, charset: 'utf8mb4', timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: false,
  });
  try { await pool.query('SELECT 1'); }
  catch (error) { await pool.end(); throw error; }
  return new Store(pool);
}

function hydrate(row) {
  return {
    id: row.id, roomId: row.room_id, senderId: row.sender_id, senderName: row.sender_name,
    body: row.body, kind: row.kind, category: row.category ?? undefined,
    location: row.location ?? undefined, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    isLocal: Boolean(row.is_local), state: row.publish_state,
    receipts: typeof row.receipts === 'string' ? JSON.parse(row.receipts) : (row.receipts ?? []),
  };
}

const selectMessages = `SELECT m.*, COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('peerId', r.peer_id, 'receivedAt', r.received_at))
  FROM message_receipts r WHERE r.message_id = m.id), JSON_ARRAY()) AS receipts FROM messages m`;

export class Store {
  constructor(pool) { this.pool = pool; }
  async ping() { await this.pool.query('SELECT 1'); }
  async migrate() {
    const sql = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await this.pool.query(statement);
  }
  async rooms() {
    const [rows] = await this.pool.query('SELECT id, name, description FROM rooms ORDER BY FIELD(id, "general", "rescue", "supplies")');
    return rows;
  }
  async save(message, local = false) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('INSERT INTO identities (peer_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)', [message.senderId, message.senderName]);
      const [result] = await conn.execute(`INSERT IGNORE INTO messages
        (id, room_id, sender_id, sender_name, body, kind, category, location, created_at, expires_at, is_local, publish_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.id, message.roomId, message.senderId, message.senderName, message.body, message.kind, message.category ?? null,
        message.location ?? null, message.createdAt, message.expiresAt, local, local ? 'pending' : 'received']);
      await conn.commit();
      return result.affectedRows === 1;
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }
  async get(id) {
    const [rows] = await this.pool.execute(`${selectMessages} WHERE m.id = ?`, [id]);
    return rows[0] ? hydrate(rows[0]) : null;
  }
  async messages(room, { before, limit = 100 } = {}) {
    const count = Math.max(1, Math.min(200, Number(limit) || 100));
    const [rows] = await this.pool.execute(`${selectMessages} WHERE m.room_id = ? ${before ? 'AND m.created_at < ?' : ''}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${count}`, before ? [room, Number(before)] : [room]);
    return rows.map(hydrate).reverse();
  }
  async recent(room) {
    const [rows] = await this.pool.execute(`${selectMessages} WHERE m.room_id = ? AND m.expires_at > ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [room, Date.now()]);
    return rows.map(hydrate).reverse();
  }
  async pending() {
    await this.pool.execute("UPDATE messages SET publish_state = 'expired' WHERE is_local = TRUE AND expires_at <= ? AND publish_state IN ('pending', 'published')", [Date.now()]);
    const [rows] = await this.pool.execute(`${selectMessages} WHERE m.is_local = TRUE AND m.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id = m.id) ORDER BY m.created_at LIMIT 200`, [Date.now()]);
    return rows.map(hydrate);
  }
  async published(id) {
    await this.pool.execute("UPDATE messages SET publish_state = 'published' WHERE id = ? AND is_local = TRUE AND publish_state <> 'expired'", [id]);
  }
  async receipt(messageId, peerId, receivedAt) {
    const [result] = await this.pool.execute(`INSERT IGNORE INTO message_receipts (message_id, peer_id, received_at)
      SELECT id, ?, ? FROM messages WHERE id = ? AND is_local = TRUE AND sender_id <> ?`, [peerId, receivedAt, messageId, peerId]);
    return result.affectedRows === 1;
  }
  async close() { await this.pool.end(); }
}
