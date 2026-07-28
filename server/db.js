import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests (and deployments) can point at their own storage.
const DATA_DIR = process.env.QDESK_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,   -- public widget key used in the embed snippet
  name        TEXT NOT NULL,
  color       TEXT,
  domain      TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  avatar      TEXT,
  role        TEXT NOT NULL DEFAULT 'operator',  -- admin | operator
  status      TEXT NOT NULL DEFAULT 'offline',   -- online | away | offline
  created_at  INTEGER NOT NULL
);

-- Which sites each operator is allowed to work with (set by the team lead).
CREATE TABLE IF NOT EXISTS operator_sites (
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (operator_id, site_id)
);

CREATE TABLE IF NOT EXISTS visitors (
  id          TEXT PRIMARY KEY,
  site_id     TEXT REFERENCES sites(id),
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
  utm         TEXT,
  location    TEXT,
  search_query TEXT,
  notes       TEXT,
  category    TEXT,
  blocked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  site_id       TEXT REFERENCES sites(id),
  visitor_id    TEXT NOT NULL REFERENCES visitors(id),
  channel       TEXT NOT NULL DEFAULT 'web',
  status        TEXT NOT NULL DEFAULT 'open',
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
  site_id     TEXT REFERENCES sites(id),      -- null = all sites
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor_id);
`);

/* --------------------------- Schema migrations ------------------------ */
/** Add a column to an existing table if a previous version lacked it. */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('operators', 'role', `role TEXT NOT NULL DEFAULT 'operator'`);
ensureColumn('visitors', 'site_id', `site_id TEXT REFERENCES sites(id)`);
ensureColumn('conversations', 'site_id', `site_id TEXT REFERENCES sites(id)`);
ensureColumn('templates', 'site_id', `site_id TEXT REFERENCES sites(id)`);

// Indexes over migrated columns must come after the ALTERs above.
db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_site ON conversations(site_id, status, updated_at);`);

const now = () => Date.now();

/* -------------------------------- Sites ------------------------------- */
export const Sites = {
  create({ name, color, domain }) {
    const id = nanoid(12);
    const key = 'st_' + nanoid(12);
    db.prepare(
      `INSERT INTO sites (id, key, name, color, domain, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(id, key, name, color || pickColor(), domain || null, now());
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM sites WHERE id = ?`).get(id);
  },
  getByKey(key) {
    return db.prepare(`SELECT * FROM sites WHERE key = ?`).get(key);
  },
  list({ includeArchived = false } = {}) {
    return db
      .prepare(`SELECT * FROM sites ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`)
      .all();
  },
  update(id, fields) {
    const allowed = ['name', 'color', 'domain', 'archived'];
    const sets = [];
    const vals = { id };
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = @${k}`); vals[k] = fields[k]; }
    }
    if (!sets.length) return this.get(id);
    db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = @id`).run(vals);
    return this.get(id);
  },
  remove(id) {
    // Keep conversation history; just archive so nothing is silently destroyed.
    return this.update(id, { archived: 1 });
  },
  /** The fallback site used when a widget embed carries no (or an unknown) key. */
  ensureDefault() {
    const existing = db.prepare(`SELECT * FROM sites ORDER BY created_at LIMIT 1`).get();
    if (existing) return existing;
    return this.create({ name: 'Основной сайт', color: '#6d5efc' });
  },
};

const PALETTE = ['#6d5efc', '#ff6b6b', '#f7a325', '#38d39f', '#2ea8ff', '#c86dd7', '#00b8a9', '#ff8fab'];
function pickColor() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM sites`).get().n;
  return PALETTE[count % PALETTE.length];
}

/* ----------------------------- Operators ------------------------------ */
export const Operators = {
  create({ name, email, avatar, role }) {
    const id = nanoid(12);
    // The very first operator bootstraps as the team lead (admin).
    const isFirst = db.prepare(`SELECT COUNT(*) AS n FROM operators`).get().n === 0;
    const finalRole = role || (isFirst ? 'admin' : 'operator');
    db.prepare(
      `INSERT INTO operators (id, name, email, avatar, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'offline', ?)`
    ).run(id, name, email || null, avatar || null, finalRole, now());
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
  setRole(id, role) {
    if (!['admin', 'operator'].includes(role)) return this.get(id);
    db.prepare(`UPDATE operators SET role = ? WHERE id = ?`).run(role, id);
    return this.get(id);
  },
  remove(id) {
    db.prepare(`DELETE FROM operator_sites WHERE operator_id = ?`).run(id);
    db.prepare(`DELETE FROM operators WHERE id = ?`).run(id);
  },
  list() {
    return db.prepare(`SELECT * FROM operators ORDER BY role DESC, name`).all();
  },
  isAdmin(id) {
    const op = this.get(id);
    return !!op && op.role === 'admin';
  },
};

/* ------------------------ Operator ↔ site access ---------------------- */
export const Access = {
  /** Site ids an operator may work with. Admins implicitly get every site. */
  siteIdsFor(operatorId) {
    const op = Operators.get(operatorId);
    if (!op) return [];
    if (op.role === 'admin') return Sites.list().map((s) => s.id);
    return db
      .prepare(
        `SELECT s.id FROM operator_sites os
         JOIN sites s ON s.id = os.site_id AND s.archived = 0
         WHERE os.operator_id = ?`
      )
      .all(operatorId)
      .map((r) => r.id);
  },
  /** Raw assignments (ignores the admin-sees-all rule) — used by the settings UI. */
  assignedIdsFor(operatorId) {
    return db
      .prepare(`SELECT site_id FROM operator_sites WHERE operator_id = ?`)
      .all(operatorId)
      .map((r) => r.site_id);
  },
  setSites(operatorId, siteIds) {
    const del = db.prepare(`DELETE FROM operator_sites WHERE operator_id = ?`);
    const ins = db.prepare(`INSERT OR IGNORE INTO operator_sites (operator_id, site_id) VALUES (?, ?)`);
    db.transaction(() => {
      del.run(operatorId);
      for (const sid of siteIds || []) {
        if (Sites.get(sid)) ins.run(operatorId, sid);
      }
    })();
    return this.assignedIdsFor(operatorId);
  },
  canAccess(operatorId, siteId) {
    return this.siteIdsFor(operatorId).includes(siteId);
  },
  /** Operators (ids) currently allowed on a site — for per-site presence. */
  operatorIdsForSite(siteId) {
    const admins = db.prepare(`SELECT id FROM operators WHERE role = 'admin'`).all().map((r) => r.id);
    const assigned = db
      .prepare(`SELECT operator_id FROM operator_sites WHERE site_id = ?`)
      .all(siteId)
      .map((r) => r.operator_id);
    return [...new Set([...admins, ...assigned])];
  },
};

/* ------------------------------ Visitors ------------------------------ */
export const Visitors = {
  upsert(id, data = {}) {
    const existing = id ? db.prepare(`SELECT * FROM visitors WHERE id = ?`).get(id) : null;
    if (existing) {
      const merged = { ...existing, ...clean(data), last_seen: now() };
      db.prepare(
        `UPDATE visitors SET site_id=@site_id, name=@name, email=@email, phone=@phone, ip=@ip,
           user_agent=@user_agent, browser=@browser, os=@os, device=@device,
           page_url=@page_url, page_title=@page_title, referrer=@referrer,
           utm=@utm, location=@location, search_query=@search_query,
           last_seen=@last_seen WHERE id=@id`
      ).run(merged);
      return this.get(id);
    }
    const newId = id || nanoid(16);
    const rec = {
      id: newId, site_id: null,
      name: null, email: null, phone: null, ip: null, user_agent: null,
      browser: null, os: null, device: null, page_url: null, page_title: null,
      referrer: null, utm: null, location: null, search_query: null,
      notes: null, category: null, blocked: 0,
      ...clean(data),
      created_at: now(), last_seen: now(),
    };
    db.prepare(
      `INSERT INTO visitors (id, site_id, name, email, phone, ip, user_agent, browser, os, device,
         page_url, page_title, referrer, utm, location, search_query, notes, category,
         blocked, created_at, last_seen)
       VALUES (@id,@site_id,@name,@email,@phone,@ip,@user_agent,@browser,@os,@device,
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

/* ---------------------------- Conversations --------------------------- */
export const Conversations = {
  create({ visitorId, siteId, channel = 'web' }) {
    const id = nanoid(14);
    db.prepare(
      `INSERT INTO conversations (id, site_id, visitor_id, channel, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`
    ).run(id, siteId || null, visitorId, channel, now(), now());
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  },
  openForVisitor(visitorId, siteId) {
    return db
      .prepare(
        `SELECT * FROM conversations
         WHERE visitor_id = ? AND status = 'open' AND (site_id IS ? OR site_id = ?)
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(visitorId, siteId || null, siteId || null);
  },
  getOrCreateOpen(visitorId, siteId, channel = 'web') {
    return this.openForVisitor(visitorId, siteId) || this.create({ visitorId, siteId, channel });
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
  /**
   * Inbox rows for the operator panel, restricted to the sites the operator may
   * see. Passing an empty siteIds array yields nothing (operator has no sites).
   */
  listForInbox({ status = 'open', siteIds = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('c.status = ?'); params.push(status); }
    if (siteIds) {
      if (!siteIds.length) return [];
      where.push(`c.site_id IN (${siteIds.map(() => '?').join(',')})`);
      params.push(...siteIds);
    }
    const sql = `
      SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.page_url,
             v.location, v.browser, v.os, v.last_seen AS visitor_last_seen,
             s.name AS site_name, s.color AS site_color,
             (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
             (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'visitor' AND m.read_by_op = 0) AS unread
      FROM conversations c
      JOIN visitors v ON v.id = c.visitor_id
      LEFT JOIN sites s ON s.id = c.site_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.updated_at DESC
      LIMIT 300`;
    return db.prepare(sql).all(...params);
  },
};

/* ------------------------------ Messages ------------------------------ */
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

/* ------------------------------ Templates ----------------------------- */
export const Templates = {
  create({ operatorId, siteId, title, body }) {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO templates (id, operator_id, site_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, operatorId || null, siteId || null, title, body, now());
    return db.prepare(`SELECT * FROM templates WHERE id = ?`).get(id);
  },
  /** Shared templates + the operator's own; optionally narrowed to one site. */
  listFor(operatorId, siteId) {
    return db
      .prepare(
        `SELECT * FROM templates
         WHERE (operator_id IS NULL OR operator_id = ?)
           AND (site_id IS NULL OR site_id = ?)
         ORDER BY title`
      )
      .all(operatorId || null, siteId || null);
  },
  remove(id) {
    db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
  },
};

Sites.ensureDefault();

/**
 * Databases created before roles existed have no admin at all, which would
 * lock the team out of the settings. Promote the earliest operator.
 */
(function ensureAdmin() {
  const admins = db.prepare(`SELECT COUNT(*) AS n FROM operators WHERE role = 'admin'`).get().n;
  if (admins > 0) return;
  const first = db.prepare(`SELECT id FROM operators ORDER BY created_at LIMIT 1`).get();
  if (first) db.prepare(`UPDATE operators SET role = 'admin' WHERE id = ?`).run(first.id);
})();

/** Backfill rows created before sites existed so nothing is orphaned. */
(function backfillSite() {
  const fallback = db.prepare(`SELECT id FROM sites ORDER BY created_at LIMIT 1`).get();
  if (!fallback) return;
  db.prepare(`UPDATE conversations SET site_id = ? WHERE site_id IS NULL`).run(fallback.id);
  db.prepare(`UPDATE visitors SET site_id = ? WHERE site_id IS NULL`).run(fallback.id);
})();

export default db;
