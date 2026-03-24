/**
 * SQLite-based message store for Telegram messages.
 *
 * Captures every platform_message and platform_mention event into a local
 * SQLite database so we have durable, queryable history independent of
 * the in-memory event queue's rolling window.
 *
 * Design choices:
 *   - WAL mode for concurrent reads while writing
 *   - Prepared statements for performance
 *   - INSERT OR IGNORE for idempotent writes (unique on chat_id + message_id)
 *   - Fire-and-forget from the event layer — never blocks the event flow
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ─── Schema ────────────────────────────────────────────────────────

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id          INTEGER NOT NULL,
  chat_id             TEXT    NOT NULL,
  topic_id            INTEGER,
  sender_id           TEXT    NOT NULL,
  sender_name         TEXT    NOT NULL,
  text                TEXT,
  message_type        TEXT    NOT NULL DEFAULT 'text',
  reply_to_message_id INTEGER,
  timestamp           TEXT    NOT NULL,
  raw_event           TEXT
)`;

const CREATE_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_msg
  ON messages (chat_id, message_id)`;

const CREATE_INDEX_CHAT_TS = `
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
  ON messages (chat_id, timestamp)`;

const CREATE_INDEX_SENDER = `
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages (sender_id)`;

const CREATE_INDEX_TOPIC = `
CREATE INDEX IF NOT EXISTS idx_messages_topic
  ON messages (topic_id)`;

// ─── Types ─────────────────────────────────────────────────────────

export interface MessageRow {
  id: number;
  message_id: number;
  chat_id: string;
  topic_id: number | null;
  sender_id: string;
  sender_name: string;
  text: string | null;
  message_type: string;
  reply_to_message_id: number | null;
  timestamp: string;
  raw_event: string | null;
}

export interface QueryOptions {
  chatId?: string;
  senderId?: string;
  topicId?: number;
  since?: string;   // ISO 8601
  until?: string;   // ISO 8601
  limit?: number;   // default 50, max 200
  offset?: number;
}

export interface MessageStats {
  totalMessages: number;
  byChatId: Array<{ chat_id: string; count: number }>;
  bySender: Array<{ sender_id: string; sender_name: string; count: number }>;
  byTopic: Array<{ topic_id: number | null; count: number }>;
}

export interface MessageStore {
  storeMessage: (event: Record<string, any>) => void;
  queryMessages: (opts: QueryOptions) => MessageRow[];
  getStats: () => MessageStats;
  close: () => void;
}

// ─── Prepared statements (lazily bound after DB open) ──────────────

let db: BetterSqlite3.Database | null = null;
let insertStmt: BetterSqlite3.Statement | null = null;

// ─── Init ──────────────────────────────────────────────────────────

function resolveDbPath(requestedPath?: string): string {
  if (requestedPath) return requestedPath;

  // Prefer /data (Docker volume mount) if it exists and is writable
  try {
    if (existsSync('/data')) {
      return '/data/telegram-messages.db';
    }
  } catch {
    // fall through
  }
  return './telegram-messages.db';
}

export function initMessageStore(dbPath?: string): MessageStore {
  if (db) {
    // Already initialised — return the existing store
    return { storeMessage, queryMessages, getStats, close };
  }

  const resolved = resolveDbPath(dbPath);

  // Ensure parent directory exists
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolved);

  // Performance: WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create schema
  db.exec(CREATE_TABLE);
  db.exec(CREATE_UNIQUE_INDEX);
  db.exec(CREATE_INDEX_CHAT_TS);
  db.exec(CREATE_INDEX_SENDER);
  db.exec(CREATE_INDEX_TOPIC);

  // Prepare insert statement
  insertStmt = db.prepare(`
    INSERT OR IGNORE INTO messages
      (message_id, chat_id, topic_id, sender_id, sender_name, text,
       message_type, reply_to_message_id, timestamp, raw_event)
    VALUES
      (@message_id, @chat_id, @topic_id, @sender_id, @sender_name, @text,
       @message_type, @reply_to_message_id, @timestamp, @raw_event)
  `);

  console.log(`[MessageStore] Opened SQLite database at ${resolved}`);

  return { storeMessage, queryMessages, getStats, close };
}

// ─── Store ─────────────────────────────────────────────────────────

export function storeMessage(event: Record<string, any>): void {
  if (!db || !insertStmt) return;

  const data = event.data ?? event;

  insertStmt.run({
    message_id: data.message_id ?? 0,
    chat_id: String(data.chat_id ?? ''),
    topic_id: data.topic_id ?? null,
    sender_id: String(data.sender_id ?? ''),
    sender_name: String(data.sender_name ?? ''),
    text: data.text ?? null,
    message_type: data.message_type ?? 'text',
    reply_to_message_id: data.reply_to_message_id ?? null,
    timestamp: data.timestamp ?? new Date().toISOString(),
    raw_event: JSON.stringify(event),
  });
}

// ─── Query ─────────────────────────────────────────────────────────

export function queryMessages(opts: QueryOptions): MessageRow[] {
  if (!db) return [];

  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (opts.chatId) {
    conditions.push('chat_id = @chatId');
    params.chatId = opts.chatId;
  }
  if (opts.senderId) {
    conditions.push('sender_id = @senderId');
    params.senderId = opts.senderId;
  }
  if (opts.topicId !== undefined && opts.topicId !== null) {
    conditions.push('topic_id = @topicId');
    params.topicId = opts.topicId;
  }
  if (opts.since) {
    conditions.push('timestamp >= @since');
    params.since = opts.since;
  }
  if (opts.until) {
    conditions.push('timestamp <= @until');
    params.until = opts.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const sql = `SELECT * FROM messages ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit OFFSET @offset`;
  const stmt = db.prepare(sql);

  return stmt.all({ ...params, limit, offset }) as MessageRow[];
}

// ─── Stats ─────────────────────────────────────────────────────────

export function getStats(): MessageStats {
  if (!db) {
    return { totalMessages: 0, byChatId: [], bySender: [], byTopic: [] };
  }

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };

  const byChatId = db.prepare(
    'SELECT chat_id, COUNT(*) as count FROM messages GROUP BY chat_id ORDER BY count DESC LIMIT 50'
  ).all() as Array<{ chat_id: string; count: number }>;

  const bySender = db.prepare(
    'SELECT sender_id, sender_name, COUNT(*) as count FROM messages GROUP BY sender_id ORDER BY count DESC LIMIT 50'
  ).all() as Array<{ sender_id: string; sender_name: string; count: number }>;

  const byTopic = db.prepare(
    'SELECT topic_id, COUNT(*) as count FROM messages GROUP BY topic_id ORDER BY count DESC LIMIT 50'
  ).all() as Array<{ topic_id: number | null; count: number }>;

  return {
    totalMessages: totalRow.count,
    byChatId,
    bySender,
    byTopic,
  };
}

// ─── Close ─────────────────────────────────────────────────────────

export function close(): void {
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
    console.log('[MessageStore] Closed SQLite database');
  }
}
