import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';

import { Sites, Operators, Sessions, Access, Visitors, Conversations, Messages, Templates } from './db.js';
import { parseUserAgent, deriveSource, geoFromIp, clientIp } from './enrich.js';
import {
  SESSION_COOKIE, SESSION_TTL_MS, hashPassword, verifyPassword, validatePassword,
  newSessionToken, parseCookies, setSessionCookie, clearSessionCookie,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ------------------------------- Auth -------------------------------- */
/** The signed-in operator for a request, from the httpOnly session cookie. */
function currentOperator(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return Sessions.operatorFor(token);
}
function requireAuth(req, res, next) {
  const op = currentOperator(req);
  if (!op) return res.status(401).json({ error: 'не авторизован' });
  req.operator = op;
  next();
}
function requireAdmin(req, res, next) {
  const op = currentOperator(req);
  if (!op) return res.status(401).json({ error: 'не авторизован' });
  if (op.role !== 'admin') return res.status(403).json({ error: 'только для руководителя' });
  req.operator = op;
  next();
}

/* ------------------------- Entry points / guards --------------------- */
app.get('/', (req, res) => res.redirect(currentOperator(req) ? '/operator/' : '/login/'));

// The operator area is private: bounce anonymous visitors to the login site.
app.get(['/operator', '/operator/', '/operator/index.html'], (req, res, next) => {
  if (!currentOperator(req)) return res.redirect('/login/');
  next();
});

// Already signed in? Skip the login screen.
app.get(['/login', '/login/', '/login/index.html'], (req, res, next) => {
  if (currentOperator(req)) return res.redirect('/operator/');
  next();
});

/* ------------------------------- Static ------------------------------ */
app.use(express.static(PUBLIC_DIR));

/* ----------------------------- Auth REST ----------------------------- */
/** Tells the login page whether to show sign-in or first-run setup. */
app.get('/api/auth/state', (req, res) => {
  res.json({ needsSetup: Operators.needsSetup(), authenticated: !!currentOperator(req) });
});

/** First run only: creates the team lead account. Closed once one exists. */
app.post('/api/auth/setup', (req, res) => {
  if (!Operators.needsSetup()) return res.status(403).json({ error: 'учётная запись уже создана' });
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (!email) return res.status(400).json({ error: 'Укажите email' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // A migrated database may already hold this person without a password.
  const existing = Operators.getByEmail(email);
  let op;
  if (existing) {
    Operators.setPassword(existing.id, hashPassword(password));
    Operators.setRole(existing.id, 'admin');
    op = Operators.update(existing.id, { name });
  } else {
    op = Operators.create({ name, email, passwordHash: hashPassword(password), role: 'admin' });
  }
  startSession(req, res, op);
  res.json({ operator: publicOperator(op) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const op = Operators.getByEmail(email);
  // Same message either way so the form cannot be used to probe for accounts.
  const invalid = () => res.status(401).json({ error: 'Неверный email или пароль' });
  if (!op || !op.password_hash || !verifyPassword(password, op.password_hash)) return invalid();
  if (!op.active) return res.status(403).json({ error: 'Учётная запись отключена руководителем' });
  startSession(req, res, op);
  res.json({ operator: publicOperator(op) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) Sessions.destroy(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

/** Lets a signed-in operator change their own password. */
app.post('/api/auth/password', requireAuth, (req, res) => {
  const current = String(req.body?.current || '');
  const next = req.body?.next;
  if (!verifyPassword(current, req.operator.password_hash)) {
    return res.status(400).json({ error: 'Текущий пароль неверен' });
  }
  const pwErr = validatePassword(next);
  if (pwErr) return res.status(400).json({ error: pwErr });
  Operators.setPassword(req.operator.id, hashPassword(next));
  res.json({ ok: true });
});

function startSession(req, res, op) {
  const token = newSessionToken();
  Sessions.create({
    token,
    operatorId: op.id,
    ttlMs: SESSION_TTL_MS,
    userAgent: req.get('user-agent') || null,
  });
  setSessionCookie(req, res, token);
}

app.get('/api/me', requireAuth, (req, res) => {
  const op = req.operator;
  res.json({ operator: publicOperator(op), sites: Access.siteIdsFor(op.id).map((id) => publicSite(Sites.get(id))) });
});

/* ---------------------------- Admin: sites --------------------------- */
app.get('/api/sites', requireAuth, (req, res) => {
  const ids = Access.siteIdsFor(req.operator.id);
  res.json({ sites: ids.map((id) => publicSite(Sites.get(id))) });
});

app.post('/api/sites', requireAdmin, (req, res) => {
  const { name, color, domain } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const site = Sites.create({ name: String(name).trim(), color, domain });
  broadcastConfigChanged();
  res.json({ site: publicSite(site) });
});

app.patch('/api/sites/:id', requireAdmin, (req, res) => {
  const site = Sites.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  const updated = Sites.update(site.id, req.body || {});
  broadcastConfigChanged();
  res.json({ site: publicSite(updated) });
});

app.delete('/api/sites/:id', requireAdmin, (req, res) => {
  const site = Sites.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  Sites.remove(site.id); // archive — conversation history is preserved
  broadcastConfigChanged();
  res.json({ ok: true });
});

/* --------------------------- Admin: the team ------------------------- */
app.get('/api/operators', requireAdmin, (_req, res) => {
  const operators = Operators.list().map((op) => ({
    ...publicOperator(op),
    siteIds: Access.assignedIdsFor(op.id),
  }));
  res.json({ operators });
});

/** The lead creates employee accounts — there is no public sign-up. */
app.post('/api/operators', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  const role = req.body?.role === 'admin' ? 'admin' : 'operator';
  if (!name) return res.status(400).json({ error: 'Укажите имя' });
  if (!email) return res.status(400).json({ error: 'Укажите email' });
  if (Operators.getByEmail(email)) return res.status(409).json({ error: 'Сотрудник с таким email уже есть' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const op = Operators.create({ name, email, passwordHash: hashPassword(password), role });
  const siteIds = Array.isArray(req.body?.siteIds) ? req.body.siteIds : [];
  if (siteIds.length) Access.setSites(op.id, siteIds);
  res.json({ operator: { ...publicOperator(op), siteIds: Access.assignedIdsFor(op.id) } });
});

/** Reset someone's password; their existing sessions are dropped. */
app.post('/api/operators/:id/password', requireAdmin, (req, res) => {
  const target = Operators.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  const pwErr = validatePassword(req.body?.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  Operators.setPassword(target.id, hashPassword(req.body.password));
  Sessions.destroyAllFor(target.id);
  if (target.id !== req.operator.id) disconnectOperator(target.id, 'Пароль изменён руководителем. Войдите заново.');
  res.json({ ok: true });
});

/** Switch an account off without deleting its history. */
app.post('/api/operators/:id/active', requireAdmin, (req, res) => {
  const target = Operators.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.id === req.operator.id) return res.status(400).json({ error: 'нельзя отключить себя' });
  const active = !!req.body?.active;
  Operators.setActive(target.id, active);
  if (!active) {
    Sessions.destroyAllFor(target.id);
    disconnectOperator(target.id, 'Учётная запись отключена руководителем.');
  }
  res.json({ operator: { ...publicOperator(Operators.get(target.id)), siteIds: Access.assignedIdsFor(target.id) } });
});

/** Set exactly which sites an operator handles. */
app.put('/api/operators/:id/sites', requireAdmin, (req, res) => {
  const target = Operators.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  const siteIds = Array.isArray(req.body?.siteIds) ? req.body.siteIds : [];
  Access.setSites(target.id, siteIds);
  refreshOperatorSession(target.id);
  res.json({ operator: { ...publicOperator(target), siteIds: Access.assignedIdsFor(target.id) } });
});

app.patch('/api/operators/:id', requireAdmin, (req, res) => {
  const target = Operators.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.id === req.operator.id && req.body?.role && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'нельзя снять с себя роль руководителя' });
  }
  const updated = req.body?.role ? Operators.setRole(target.id, req.body.role) : target;
  refreshOperatorSession(target.id);
  res.json({ operator: { ...publicOperator(updated), siteIds: Access.assignedIdsFor(updated.id) } });
});

app.delete('/api/operators/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.operator.id) return res.status(400).json({ error: 'нельзя удалить себя' });
  const target = Operators.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  Operators.remove(target.id);
  disconnectOperator(target.id);
  res.json({ ok: true });
});

/* ------------------------------ Templates ---------------------------- */
app.get('/api/templates', requireAuth, (req, res) => {
  res.json({ templates: Templates.listFor(req.operator.id, req.query.siteId) });
});

app.post('/api/templates', requireAuth, (req, res) => {
  const { siteId, title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  res.json({ template: Templates.create({ operatorId: req.operator.id, siteId, title, body }) });
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const tpl = Templates.get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not found' });
  // Shared templates are the lead's to remove; personal ones belong to the author.
  const mine = tpl.operator_id && tpl.operator_id === req.operator.id;
  if (!mine && req.operator.role !== 'admin') return res.status(403).json({ error: 'нет прав' });
  Templates.remove(tpl.id);
  res.json({ ok: true });
});

/* ------------------------- Public (for demo pages) ------------------- */
app.get('/api/public/sites', (_req, res) => {
  res.json({ sites: Sites.list().map((s) => ({ key: s.key, name: s.name, color: s.color })) });
});

app.get('/api/public/site/:key', (req, res) => {
  const site = Sites.getByKey(req.params.key);
  if (!site) return res.status(404).json({ error: 'not found' });
  res.json({ site: { key: site.key, name: site.name, color: site.color } });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ------------------------------ Socket.IO ---------------------------- */
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

const siteRoom = (siteId) => `site:${siteId}`;
const siteVisitorsRoom = (siteId) => `sitev:${siteId}`;

/** Operators online for a given site (admins count for every site). */
function operatorOnlineForSite(siteId) {
  return Access.operatorIdsForSite(siteId).some((id) => {
    const op = Operators.get(id);
    return op && op.status === 'online' && operatorIsConnected(id);
  });
}

function operatorIsConnected(operatorId) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role === 'operator' && s.data.operatorId === operatorId) return true;
  }
  return false;
}

function broadcastPresenceForSite(siteId) {
  io.to(siteVisitorsRoom(siteId)).emit('presence', { operatorOnline: operatorOnlineForSite(siteId) });
}

function broadcastPresenceAll() {
  for (const s of Sites.list()) broadcastPresenceForSite(s.id);
}

function decorateInboxRow(row) {
  let location = null;
  try { location = row.location ? JSON.parse(row.location) : null; } catch {}
  return { ...row, location };
}

/** Each operator gets an inbox scoped to their own sites. */
function pushInbox() {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role !== 'operator') continue;
    const rows = Conversations.listForInbox({ status: 'open', siteIds: s.data.siteIds }).map(decorateInboxRow);
    s.emit('inbox:list', rows);
  }
}

/** Re-evaluate a connected operator's site access after the lead changes it. */
function refreshOperatorSession(operatorId) {
  const siteIds = Access.siteIdsFor(operatorId);
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role !== 'operator' || s.data.operatorId !== operatorId) continue;
    for (const room of [...s.rooms]) {
      if (room.startsWith('site:')) s.leave(room);
    }
    for (const id of siteIds) s.join(siteRoom(id));
    s.data.siteIds = siteIds;
    s.emit('sites:list', siteIds.map((id) => publicSite(Sites.get(id))));
    s.emit('inbox:list', Conversations.listForInbox({ status: 'open', siteIds }).map(decorateInboxRow));
  }
  broadcastPresenceAll();
}

function disconnectOperator(operatorId, message = 'Доступ отозван руководителем.') {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role === 'operator' && s.data.operatorId === operatorId) {
      s.emit('error:auth', { message });
      s.disconnect(true);
    }
  }
}

/** Tell every operator the site list changed (created / renamed / archived). */
function broadcastConfigChanged() {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role !== 'operator') continue;
    refreshOperatorSession(s.data.operatorId);
  }
}

io.on('connection', (socket) => {
  const { role } = socket.handshake.auth || {};

  /* ============================ VISITOR ============================ */
  if (role === 'visitor') {
    socket.data.role = 'visitor';

    socket.on('visitor:init', (payload = {}) => {
      const site = (payload.siteKey && Sites.getByKey(payload.siteKey)) || Sites.ensureDefault();
      const ip = clientIp({ headers: socket.handshake.headers, socket: socket.conn });
      const ua = socket.handshake.headers['user-agent'] || '';
      const { browser, os, device } = parseUserAgent(ua);
      const page = payload.page || {};
      const { source, searchQuery } = deriveSource({ referrer: page.referrer, utm: page.utm });
      const geo = geoFromIp(ip);

      const visitor = Visitors.upsert(payload.visitorId, {
        site_id: site.id,
        ip,
        user_agent: ua,
        browser,
        os,
        device,
        page_url: page.url || null,
        page_title: page.title || null,
        referrer: source,
        utm: page.utm ? JSON.stringify(page.utm) : null,
        location: JSON.stringify(geo),
        search_query: searchQuery,
      });

      if (visitor.blocked) {
        socket.emit('visitor:blocked');
        socket.disconnect(true);
        return;
      }

      const conv = Conversations.getOrCreateOpen(visitor.id, site.id, 'web');
      socket.data.visitorId = visitor.id;
      socket.data.conversationId = conv.id;
      socket.data.siteId = site.id;
      socket.join(`conv:${conv.id}`);
      socket.join(siteVisitorsRoom(site.id));

      socket.emit('visitor:session', {
        visitorId: visitor.id,
        conversationId: conv.id,
        site: { name: site.name, color: site.color },
        operatorOnline: operatorOnlineForSite(site.id),
        messages: Messages.listForConversation(conv.id),
        rating: conv.rating,
      });

      io.to(siteRoom(site.id)).emit('visitor:info', publicVisitor(visitor, conv.id));
      pushInbox();
    });

    socket.on('visitor:message', (payload = {}) => {
      const body = String(payload.body || '').trim();
      const convId = socket.data.conversationId;
      if (!body || !convId) return;
      const msg = Messages.add({
        conversationId: convId,
        senderType: 'visitor',
        senderId: socket.data.visitorId,
        body,
      });
      io.to(`conv:${convId}`).emit('message:new', msg);
      io.to(siteRoom(socket.data.siteId)).emit('message:new', msg);
      pushInbox();
    });

    // Signature Talk-Me feature: operators of this site see the visitor's text
    // as it is typed, before it is sent.
    socket.on('visitor:typing', (payload = {}) => {
      const convId = socket.data.conversationId;
      if (!convId) return;
      io.to(siteRoom(socket.data.siteId)).emit('visitor:typing', {
        conversationId: convId,
        text: String(payload.text || '').slice(0, 500),
      });
    });

    socket.on('visitor:profile', (payload = {}) => {
      if (!socket.data.visitorId) return;
      const v = Visitors.update(socket.data.visitorId, {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
      });
      io.to(siteRoom(socket.data.siteId)).emit('visitor:info', publicVisitor(v, socket.data.conversationId));
      pushInbox();
    });

    socket.on('visitor:rate', (payload = {}) => {
      const convId = socket.data.conversationId;
      if (!convId) return;
      const rating = Math.max(1, Math.min(5, parseInt(payload.rating, 10) || 0));
      Conversations.rate(convId, rating, payload.comment);
      const sys = Messages.add({
        conversationId: convId,
        senderType: 'system',
        body: `Посетитель оценил диалог: ${rating}/5${payload.comment ? ' — «' + payload.comment + '»' : ''}`,
      });
      io.to(`conv:${convId}`).emit('message:new', sys);
      io.to(siteRoom(socket.data.siteId)).emit('message:new', sys);
      pushInbox();
    });

    socket.on('disconnect', () => {
      if (socket.data.conversationId) {
        io.to(siteRoom(socket.data.siteId)).emit('visitor:offline', { conversationId: socket.data.conversationId });
      }
    });
    return;
  }

  /* =========================== OPERATOR =========================== */
  if (role === 'operator') {
    // Identity comes from the session cookie, never from what the client claims.
    const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
    const op = Sessions.operatorFor(token);
    if (!op) {
      socket.emit('error:auth', { message: 'Сессия истекла. Войдите заново.' });
      socket.disconnect(true);
      return;
    }
    socket.data.role = 'operator';
    socket.data.operatorId = op.id;
    socket.data.siteIds = Access.siteIdsFor(op.id);

    for (const id of socket.data.siteIds) socket.join(siteRoom(id));
    Operators.setStatus(op.id, 'online');

    socket.emit('sites:list', socket.data.siteIds.map((id) => publicSite(Sites.get(id))));
    socket.emit('inbox:list', Conversations.listForInbox({ status: 'open', siteIds: socket.data.siteIds }).map(decorateInboxRow));
    broadcastPresenceAll();

    /** Guard: never let an operator touch a conversation outside their sites. */
    const allowed = (conv) => conv && socket.data.siteIds.includes(conv.site_id);

    socket.on('operator:open', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!allowed(conv)) return;
      Messages.markRead(conv.id);
      socket.join(`conv:${conv.id}`);
      const visitor = Visitors.get(conv.visitor_id);
      const site = conv.site_id ? Sites.get(conv.site_id) : null;
      socket.emit('conversation:history', {
        conversation: conv,
        site: site ? publicSite(site) : null,
        visitor: publicVisitor(visitor, conv.id),
        messages: Messages.listForConversation(conv.id),
      });
      pushInbox();
    });

    socket.on('operator:message', (payload = {}) => {
      const body = String(payload.body || '').trim();
      const conv = Conversations.get(payload.conversationId);
      if (!body || !allowed(conv)) return;
      if (!conv.assigned_to) Conversations.assign(conv.id, op.id);
      const msg = Messages.add({
        conversationId: conv.id,
        senderType: 'operator',
        senderId: op.id,
        senderName: op.name,
        body,
      });
      io.to(`conv:${conv.id}`).emit('message:new', msg);
      io.to(siteRoom(conv.site_id)).emit('message:new', msg);
      pushInbox();
    });

    socket.on('operator:typing', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!allowed(conv)) return;
      io.to(`conv:${conv.id}`).emit('operator:typing', { conversationId: conv.id, name: op.name });
    });

    socket.on('operator:assign', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!allowed(conv)) return;
      Conversations.assign(conv.id, payload.operatorId || op.id);
      pushInbox();
    });

    socket.on('operator:close', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!allowed(conv)) return;
      Conversations.close(conv.id);
      const sys = Messages.add({
        conversationId: conv.id,
        senderType: 'system',
        body: 'Диалог завершён оператором.',
      });
      io.to(`conv:${conv.id}`).emit('conversation:closed', { conversationId: conv.id });
      io.to(`conv:${conv.id}`).emit('message:new', sys);
      pushInbox();
    });

    socket.on('operator:update-visitor', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!allowed(conv)) return;
      const v = Visitors.update(payload.visitorId, payload.fields || {});
      if (v) {
        io.to(siteRoom(conv.site_id)).emit('visitor:info', publicVisitor(v, payload.conversationId));
        pushInbox();
      }
    });

    socket.on('operator:status', (payload = {}) => {
      const status = ['online', 'away', 'offline'].includes(payload.status) ? payload.status : 'online';
      Operators.setStatus(op.id, status);
      broadcastPresenceAll();
    });

    socket.on('disconnect', () => {
      if (!operatorIsConnected(op.id)) Operators.setStatus(op.id, 'offline');
      broadcastPresenceAll();
    });
    return;
  }

  socket.disconnect(true);
});

/* ------------------------------ Helpers ------------------------------ */
function publicOperator(op) {
  if (!op) return null;
  // Never expose password_hash.
  return {
    id: op.id, name: op.name, email: op.email, avatar: op.avatar,
    role: op.role, status: op.status, active: !!op.active,
  };
}

function publicSite(site) {
  if (!site) return null;
  return { id: site.id, key: site.key, name: site.name, color: site.color, domain: site.domain, archived: !!site.archived };
}

function publicVisitor(v, conversationId) {
  if (!v) return null;
  let location = null;
  try { location = v.location ? JSON.parse(v.location) : null; } catch {}
  return {
    id: v.id,
    conversationId,
    siteId: v.site_id,
    name: v.name,
    email: v.email,
    phone: v.phone,
    ip: v.ip,
    browser: v.browser,
    os: v.os,
    device: v.device,
    page_url: v.page_url,
    page_title: v.page_title,
    referrer: v.referrer,
    search_query: v.search_query,
    location,
    notes: v.notes,
    category: v.category,
    blocked: !!v.blocked,
    created_at: v.created_at,
    last_seen: v.last_seen,
  };
}

// Housekeeping: drop expired sessions on boot and once a day after that.
Sessions.purgeExpired();
setInterval(() => Sessions.purgeExpired(), 24 * 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`\n  Q desk server running`);
  console.log(`  ─ Operator login:        http://localhost:${PORT}/login/`);
  console.log(`  ─ Operator dashboard:    http://localhost:${PORT}/operator/`);
  console.log(`  ─ Demo sites (visitor):  http://localhost:${PORT}/demo/`);
  console.log(`  ─ Widget script:         http://localhost:${PORT}/widget/widget.js`);
  if (Operators.needsSetup()) {
    console.log(`\n  ⚠ Аккаунтов нет — откройте /login/ и создайте руководителя.`);
  }
  console.log('');
});
