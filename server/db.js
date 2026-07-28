import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS operators (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  avatar      TEXT,
  status      TEXT NOT NULL DEFAULT 'offline',  -- online | away | offline
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visitors (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  ip          TEXT,
  user_agent  TEXT,
  browser     TEXT,
  os          TEXT,
  device      TEXT,
  page_url    TEXT,
  page_title  TEXT,
  referrer    TEXT,
  utm         TEXT,           -- json string of utm/source params
  location    TEXT,           -- json string { country, city }
  search_query TEXT,
  notes       TEXT,
  category    TEXT,
  blocked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  visitor_id    TEXT NOT NULL REFERENCES visitors(id),
  channel       TEXT NOT NULL DEFAULT 'web',  -- web | telegram | whatsapp | ...
  status        TEXT NOT NULL DEFAULT 'open', -- open | closed
  assigned_to   TEXT REFERENCES operators(id),
  rating        INTEGER,
  rating_comment TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_type     TEXT NOT NULL,   -- visitor | operator | system | bot
  sender_id       TEXT,
  sender_name     TEXT,
  body            TEXT NOT NULL,
  read_by_op      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id          TEXT PRIMARY KEY,
  operator_id TEXT REFERENCES operators(id),  -- null = shared
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status, updated_at);
`);

const now = () => Date.now();

/* ----------------------------- Operators ----------------------------- */
export const Operators = {
  create({ name, email, avatar }) {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO operators (id, name, email, avatar, status, created_at)
       VALUES (?, ?, ?, ?, 'offline', ?)`
    ).run(id, name, email || null, avatar || null, now());
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM operators WHERE id = ?`).get(id);
  },
  getByEmail(email) {
    return db.prepare(`SELECT * FROM operators WHERE email = ?`).get(email);
  },
  loginOrCreate({ name, email }) {
    if (email) {
      const found = this.getByEmail(email);
      if (found) return found;
    }
    return this.create({ name, email });
  },
  setStatus(id, status) {
    db.prepare(`UPDATE operators SET status = ? WHERE id = ?`).run(status, id);
  },
  list() {
    return db.prepare(`SELECT * FROM operators ORDER BY name`).all();
  },
};

/* ------------------------------ Visitors ----------------------------- */
export const Visitors = {
  upsert(id, data = {}) {
    const existing = id ? db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(id) : null;
    if (existing) {
      const merged = { ...existing, ...clean(data), last_seen: now() };
      db.prepare(
        `UPDATE visitors SET name=@name, email=@email, phone=@phone, ip=@ip,
           user_agent=@user_agent, browser=@browser, os=@os, device=@device,
           page_url=@page_url, page_title=@page_title, referrer=@referrer,
           utm=@utm, location=@location, search_query=@search_query,
           last_seen=@last_seen WHERE id=@id`
      ).run(merged);
      return this.get(id);
    }
    const newId = id || nanoid(16);
    const rec = {
      id: newId,
      name: null, email: null, phone: null, ip: null, user_agent: null,
      browser: null, os: null, device: null, page_url: null, page_title: null,
      referrer: null, utm: null, location: null, search_query: null,
      notes: null, category: null, blocked: 0,
      ...clean(data),
      created_at: now(), last_seen: now(),
    };
    db.prepare(
      `INSERT INTO visitors (id, name, email, phone, ip, user_agent, browser, os, device,
         page_url, page_title, referrer, utm, location, search_query, notes, category,
         blocked, created_at, last_seen)
       VALUES (@id,@name,@email,@phone,@ip,@user_agent,@browser,@os,@device,
         @page_url,@page_title,@referrer,@utm,@location,@search_query,@notes,@category,
         @blocked,@created_at,@last_seen)`
    ).run(rec);
    return this.get(newId);
  },
  get(id) {
    return db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(id);
  },
  update(id, fields) {
    const allowed = ['name', 'email', 'phone', 'notes', 'category', 'blocked'];
    const sets = [];
    const vals = {};
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = @${k}`); vals[k] = fields[k]; }
    }
    if (!sets.length) return this.get(id);
    vals.id = id;
    db.prepare(`UPDATE visitors SET ${sets.join(', ')} WHERE id = @id`).run(vals);
    return this.get(id);
  },
};

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/* ---------------------------- Conversations -------------------------- */
export const Conversations = {
  create({ visitorId, channel = 'web' }) {
    const id = nanoid(14);
    db.prepare(
      `INSERT INTO conversations (id, visitor_id, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?)`
    ).run(id, visitorId, channel, now(), now());
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  },
  openForVisitor(visitorId) {
    return db
      .prepare(`SELECT * FROM conversations WHERE visitor_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1`)
      .get(visitorId);
  },
  getOrCreateOpen(visitorId, channel = 'web') {
    return this.openForVisitor(visitorId) || this.create({ visitorId, channel });
  },
  touch(id) {
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now(), id);
  },
  assign(id, operatorId) {
    db.prepare(`UPDATE conversations SET assigned_to = ?, updated_at = ? WHERE id = ?`).run(operatorId, now(), id);
    return this.get(id);
  },
  close(id) {
    db.prepare(`UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?`).run(now(), id);
    return this.get(id);
  },
  reopen(id) {
    db.prepare(`UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`).run(now(), id);
    return this.get(id);
  },
  rate(id, rating, comment) {
    db.prepare(`UPDATE conversations SET rating = ?, rating_comment = ? WHERE id = ?`).run(rating, comment || null, id);
    return this.get(id);
  },
  /** Rich list for the operator inbox. */
  listForInbox({ status } = {}) {
    const rows = db
      .prepare(
        `SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.page_url,
                v.location, v.browser, v.os, v.last_seen AS visitor_last_seen,
                (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'visitor' AND m.read_by_op = 0) AS unread
         FROM conversations c
         JOIN visitors v ON v.id = c.visitor_id
         ${status ? 'WHERE c.status = ?' : ''}
         ORDER BY c.updated_at DESC
         LIMIT 200`
      );
    return status ? rows.all(status) : rows.all();
  },
};

/* ------------------------------ Messages ----------------------------- */
export const Messages = {
  add({ conversationId, senderType, senderId, senderName, body }) {
    const id = nanoid(16);
    const readByOp = senderType === 'operator' ? 1 : 0;
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_name, body, read_by_op, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, conversationId, senderType, senderId || null, senderName || null, body, readByOp, now());
    Conversations.touch(conversationId);
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  },
  listForConversation(conversationId, limit = 200) {
    return db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(conversationId, limit);
  },
  markRead(conversationId) {
    db.prepare(
      `UPDATE messages SET read_by_op = 1 WHERE conversation_id = ? AND sender_type = 'visitor'`
    ).run(conversationId);
  },
};

/* ------------------------------ Templates ---------------------------- */
export const Templates = {
  create({ operatorId, title, body }) {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO templates (id, operator_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, operatorId || null, title, body, now());
    return db.prepare(`SELECT * FROM templates WHERE id = ?`).get(id);
  },
  listFor(operatorId) {
    return db
      .prepare(`SELECT * FROM templates WHERE operator_id IS NULL OR operator_id = ? ORDER BY title`)
      .all(operatorId || null);
  },
  remove(id) {
    db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
  },
};

export default db;
