import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';

import { Operators, Visitors, Conversations, Messages, Templates } from './db.js';
import { parseUserAgent, deriveSource, geoFromIp, clientIp } from './enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ------------------------------- Static ------------------------------ */
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.redirect('/demo/'));

/* -------------------------------- REST ------------------------------- */
app.post('/api/login', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const op = Operators.loginOrCreate({ name: String(name).trim(), email: email ? String(email).trim() : null });
  res.json({ operator: publicOperator(op) });
});

app.get('/api/templates', (req, res) => {
  res.json({ templates: Templates.listFor(req.query.operatorId) });
});

app.post('/api/templates', (req, res) => {
  const { operatorId, title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  res.json({ template: Templates.create({ operatorId, title, body }) });
});

app.delete('/api/templates/:id', (req, res) => {
  Templates.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ------------------------------ Socket.IO ---------------------------- */
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

// operatorId -> Set<socketId>
const operatorSockets = new Map();
const anyOperatorOnline = () =>
  [...operatorSockets.keys()].some((id) => {
    const op = Operators.get(id);
    return op && op.status === 'online';
  });

function broadcastPresence() {
  io.to('visitors').emit('presence', { operatorOnline: anyOperatorOnline() });
}

function inboxSnapshot() {
  return Conversations.listForInbox({ status: 'open' }).map(decorateInboxRow);
}

function pushInbox() {
  io.to('operators').emit('inbox:list', inboxSnapshot());
}

function decorateInboxRow(row) {
  let location = null;
  try { location = row.location ? JSON.parse(row.location) : null; } catch {}
  return { ...row, location };
}

io.on('connection', (socket) => {
  const { role } = socket.handshake.auth || {};

  /* ============================ VISITOR ============================ */
  if (role === 'visitor') {
    socket.join('visitors');
    socket.data.role = 'visitor';

    socket.on('visitor:init', (payload = {}) => {
      const ip = clientIp({ headers: socket.handshake.headers, socket: socket.conn });
      const ua = socket.handshake.headers['user-agent'] || '';
      const { browser, os, device } = parseUserAgent(ua);
      const page = payload.page || {};
      const { source, searchQuery } = deriveSource({ referrer: page.referrer, utm: page.utm });
      const geo = geoFromIp(ip);

      const visitor = Visitors.upsert(payload.visitorId, {
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

      const conv = Conversations.getOrCreateOpen(visitor.id, 'web');
      socket.data.visitorId = visitor.id;
      socket.data.conversationId = conv.id;
      socket.join(`conv:${conv.id}`);

      socket.emit('visitor:session', {
        visitorId: visitor.id,
        conversationId: conv.id,
        operatorOnline: anyOperatorOnline(),
        messages: Messages.listForConversation(conv.id),
        rating: conv.rating,
      });

      // Let operators know this visitor is present / refresh inbox
      io.to('operators').emit('visitor:info', publicVisitor(visitor, conv.id));
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
      io.to('operators').emit('message:new', msg);
      pushInbox();
    });

    // Signature Talk-Me feature: operator sees the visitor's text as they type,
    // before it is sent.
    socket.on('visitor:typing', (payload = {}) => {
      const convId = socket.data.conversationId;
      if (!convId) return;
      io.to('operators').emit('visitor:typing', {
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
      io.to('operators').emit('visitor:info', publicVisitor(v, socket.data.conversationId));
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
      io.to('operators').emit('message:new', sys);
      pushInbox();
    });

    socket.on('disconnect', () => {
      if (socket.data.conversationId) {
        io.to('operators').emit('visitor:offline', { conversationId: socket.data.conversationId });
      }
    });
    return;
  }

  /* =========================== OPERATOR =========================== */
  if (role === 'operator') {
    const operatorId = socket.handshake.auth.operatorId;
    const op = operatorId && Operators.get(operatorId);
    if (!op) {
      socket.emit('error:auth', { message: 'Unknown operator. Please log in again.' });
      socket.disconnect(true);
      return;
    }
    socket.data.role = 'operator';
    socket.data.operatorId = op.id;
    socket.join('operators');

    if (!operatorSockets.has(op.id)) operatorSockets.set(op.id, new Set());
    operatorSockets.get(op.id).add(socket.id);
    Operators.setStatus(op.id, 'online');

    socket.emit('inbox:list', inboxSnapshot());
    socket.emit('operators:list', Operators.list().map(publicOperator));
    broadcastPresence();
    io.to('operators').emit('operators:list', Operators.list().map(publicOperator));

    socket.on('operator:open', (payload = {}) => {
      const conv = Conversations.get(payload.conversationId);
      if (!conv) return;
      Messages.markRead(conv.id);
      socket.join(`conv:${conv.id}`);
      const visitor = Visitors.get(conv.visitor_id);
      socket.emit('conversation:history', {
        conversation: conv,
        visitor: publicVisitor(visitor, conv.id),
        messages: Messages.listForConversation(conv.id),
      });
      pushInbox();
    });

    socket.on('operator:message', (payload = {}) => {
      const body = String(payload.body || '').trim();
      const conv = Conversations.get(payload.conversationId);
      if (!body || !conv) return;
      if (!conv.assigned_to) Conversations.assign(conv.id, op.id);
      const msg = Messages.add({
        conversationId: conv.id,
        senderType: 'operator',
        senderId: op.id,
        senderName: op.name,
        body,
      });
      io.to(`conv:${conv.id}`).emit('message:new', msg);
      io.to('operators').emit('message:new', msg);
      pushInbox();
    });

    socket.on('operator:typing', (payload = {}) => {
      if (!payload.conversationId) return;
      io.to(`conv:${payload.conversationId}`).emit('operator:typing', {
        conversationId: payload.conversationId,
        name: op.name,
      });
    });

    socket.on('operator:assign', (payload = {}) => {
      const conv = Conversations.assign(payload.conversationId, payload.operatorId || op.id);
      if (conv) pushInbox();
    });

    socket.on('operator:close', (payload = {}) => {
      const conv = Conversations.close(payload.conversationId);
      if (!conv) return;
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
      const v = Visitors.update(payload.visitorId, payload.fields || {});
      if (v) {
        io.to('operators').emit('visitor:info', publicVisitor(v, payload.conversationId));
        pushInbox();
      }
    });

    socket.on('operator:status', (payload = {}) => {
      const status = ['online', 'away', 'offline'].includes(payload.status) ? payload.status : 'online';
      Operators.setStatus(op.id, status);
      io.to('operators').emit('operators:list', Operators.list().map(publicOperator));
      broadcastPresence();
    });

    socket.on('disconnect', () => {
      const set = operatorSockets.get(op.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          operatorSockets.delete(op.id);
          Operators.setStatus(op.id, 'offline');
          io.to('operators').emit('operators:list', Operators.list().map(publicOperator));
        }
      }
      broadcastPresence();
    });
    return;
  }

  // Unknown role
  socket.disconnect(true);
});

/* ------------------------------ Helpers ------------------------------ */
function publicOperator(op) {
  if (!op) return null;
  return { id: op.id, name: op.name, email: op.email, avatar: op.avatar, status: op.status };
}

function publicVisitor(v, conversationId) {
  if (!v) return null;
  let location = null;
  try { location = v.location ? JSON.parse(v.location) : null; } catch {}
  return {
    id: v.id,
    conversationId,
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

server.listen(PORT, () => {
  console.log(`\n  Logopoly Chat server running`);
  console.log(`  ─ Demo site (visitor):  http://localhost:${PORT}/demo/`);
  console.log(`  ─ Operator dashboard:   http://localhost:${PORT}/operator/`);
  console.log(`  ─ Widget script:        http://localhost:${PORT}/widget/widget.js\n`);
});
