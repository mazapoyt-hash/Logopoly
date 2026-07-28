/* Logopoly Chat — operator dashboard client. */
(function () {
  'use strict';

  const LS_KEY = 'logopoly_operator';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    operator: null,
    socket: null,
    inbox: [],
    activeId: null,
    activeVisitor: null,
    templates: [],
    opTypingTimer: null,
  };

  /* ------------------------------- Login ------------------------------- */
  const loginEl = $('#login');
  const appEl = $('#app');

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#loginName').value.trim();
    const email = $('#loginEmail').value.trim();
    if (!name) return;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (data.operator) {
      state.operator = data.operator;
      try { localStorage.setItem(LS_KEY, JSON.stringify(data.operator)); } catch {}
      boot();
    }
  });

  $('#logoutBtn').addEventListener('click', () => {
    try { localStorage.removeItem(LS_KEY); } catch {}
    if (state.socket) state.socket.disconnect();
    location.reload();
  });

  // Auto-login from storage
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) { state.operator = JSON.parse(saved); }
  } catch {}
  if (state.operator) boot();

  /* -------------------------------- Boot ------------------------------- */
  function boot() {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    $('#meName').textContent = state.operator.name;
    $('#meAvatar').textContent = (state.operator.name[0] || 'O').toUpperCase();

    loadTemplates();
    connect();
    bindComposer();
    bindDetailsDelegation();

    $('#statusSelect').addEventListener('change', (e) => {
      state.socket.emit('operator:status', { status: e.target.value });
    });
    $('#closeConvBtn').addEventListener('click', () => {
      if (state.activeId && confirm('Завершить этот диалог?')) {
        state.socket.emit('operator:close', { conversationId: state.activeId });
      }
    });
    bindTemplatesModal();
  }

  /* ------------------------------ Socket ------------------------------- */
  function connect() {
    state.socket = io({ auth: { role: 'operator', operatorId: state.operator.id } });

    state.socket.on('error:auth', () => {
      try { localStorage.removeItem(LS_KEY); } catch {}
      location.reload();
    });

    state.socket.on('inbox:list', (rows) => {
      state.inbox = rows;
      renderInbox();
    });

    state.socket.on('message:new', (msg) => {
      // Update inbox happens via inbox:list; here just append if active.
      if (msg.conversation_id === state.activeId) {
        appendMessage(msg);
        state.socket.emit('operator:open', { conversationId: state.activeId }); // keep read
      }
    });

    state.socket.on('conversation:history', (data) => {
      if (data.conversation.id !== state.activeId) return;
      state.activeVisitor = data.visitor;
      renderThread(data.messages);
      renderDetails(data.visitor, data.conversation);
      $('#chatTitle').textContent = data.visitor.name || 'Посетитель';
      $('#chatSub').textContent = subLine(data.visitor);
    });

    state.socket.on('visitor:typing', (data) => {
      if (data.conversationId !== state.activeId) return;
      const preview = $('#livePreview');
      const text = (data.text || '').trim();
      if (text) {
        $('#liveText').textContent = data.text;
        preview.classList.remove('hidden');
      } else {
        preview.classList.add('hidden');
      }
    });

    state.socket.on('visitor:info', (v) => {
      const idx = state.inbox.findIndex((c) => c.id === v.conversationId);
      if (v.conversationId === state.activeId) {
        state.activeVisitor = v;
        renderDetails(v, { id: v.conversationId });
        $('#chatTitle').textContent = v.name || 'Посетитель';
        $('#chatSub').textContent = subLine(v);
      }
      if (idx !== -1 && v.name) { state.inbox[idx].visitor_name = v.name; renderInbox(); }
    });

    state.socket.on('conversation:closed', ({ conversationId }) => {
      if (conversationId === state.activeId) {
        $('#chatSub').textContent = 'Диалог завершён';
      }
    });

    state.socket.on('operators:list', () => {});
  }

  /* ------------------------------- Inbox ------------------------------- */
  function renderInbox() {
    const box = $('#inbox');
    $('#inboxCount').textContent = state.inbox.length;
    box.innerHTML = '';
    for (const c of state.inbox) {
      const div = document.createElement('div');
      div.className = 'conv' + (c.id === state.activeId ? ' active' : '');
      const name = c.visitor_name || 'Посетитель';
      const initial = (name[0] || '?').toUpperCase();
      const lastYou = c.last_sender === 'operator';
      div.innerHTML = `
        <div class="conv-avatar">${escapeHtml(initial)}</div>
        <div class="conv-main">
          <div class="conv-top">
            <span class="conv-name">${escapeHtml(name)}</span>
            <span class="conv-time">${fmtTime(c.updated_at)}</span>
          </div>
          <div class="conv-last ${lastYou ? 'you' : ''}">${escapeHtml(c.last_message || 'Новый диалог')}</div>
        </div>
        ${c.unread > 0 ? `<span class="conv-badge">${c.unread}</span>` : ''}`;
      div.addEventListener('click', () => openConversation(c.id));
      box.appendChild(div);
    }
  }

  function openConversation(id) {
    state.activeId = id;
    $('#chatEmpty').classList.add('hidden');
    $('#chatActive').classList.remove('hidden');
    $('#details').classList.remove('hidden');
    $('#livePreview').classList.add('hidden');
    renderInbox();
    state.socket.emit('operator:open', { conversationId: id });
  }

  /* ------------------------------ Thread ------------------------------- */
  function renderThread(messages) {
    const thread = $('#thread');
    thread.innerHTML = '';
    (messages || []).forEach((m) => appendMessage(m, true));
    scrollThread();
  }

  function appendMessage(m, noScroll) {
    const thread = $('#thread');
    const div = document.createElement('div');
    div.className = 'bubble ' + m.sender_type;
    if (m.sender_type === 'system') {
      div.textContent = m.body;
    } else {
      div.textContent = m.body;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const who = m.sender_type === 'operator' ? (m.sender_name || 'Оператор') : '';
      meta.textContent = (who ? who + ' · ' : '') + fmtTime(m.created_at);
      div.appendChild(meta);
    }
    thread.appendChild(div);
    if (!noScroll) scrollThread();
  }

  function scrollThread() {
    const t = $('#thread');
    t.scrollTop = t.scrollHeight;
  }

  /* ----------------------------- Composer ------------------------------ */
  function bindComposer() {
    const input = $('#composerInput');
    const send = $('#sendBtn');

    const doSend = () => {
      const body = input.value.trim();
      if (!body || !state.activeId) return;
      state.socket.emit('operator:message', { conversationId: state.activeId, body });
      input.value = '';
      autoGrow(input);
      input.focus();
    };

    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    input.addEventListener('input', () => {
      autoGrow(input);
      if (state.activeId) state.socket.emit('operator:typing', { conversationId: state.activeId });
    });
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  /* ------------------------------ Details ------------------------------ */
  function renderDetails(v, conv) {
    if (!v) return;
    const loc = v.location && (v.location.city || v.location.country)
      ? [v.location.city, v.location.country].filter(Boolean).join(', ')
      : '—';
    const body = $('#detailsBody');
    body.innerHTML = `
      <div class="detail-group">
        <h4>Контакты</h4>
        <div class="field"><label>Имя</label><input data-f="name" value="${attr(v.name)}" placeholder="—" /></div>
        <div class="field"><label>Email</label><input data-f="email" value="${attr(v.email)}" placeholder="—" /></div>
        <div class="field"><label>Телефон</label><input data-f="phone" value="${attr(v.phone)}" placeholder="—" /></div>
        <button class="btn-primary" id="saveContacts">Сохранить</button>
      </div>

      <div class="detail-group">
        <h4>О визите</h4>
        <div class="detail-row"><span class="k">Страница</span><span class="v">${pageLink(v.page_url, v.page_title)}</span></div>
        <div class="detail-row"><span class="k">Источник</span><span class="v">${escapeHtml(v.referrer || '—')}</span></div>
        ${v.search_query ? `<div class="detail-row"><span class="k">Запрос</span><span class="v">${escapeHtml(v.search_query)}</span></div>` : ''}
        <div class="detail-row"><span class="k">Браузер</span><span class="v">${escapeHtml(v.browser || '—')}</span></div>
        <div class="detail-row"><span class="k">ОС</span><span class="v">${escapeHtml(v.os || '—')}</span></div>
        <div class="detail-row"><span class="k">Устройство</span><span class="v">${escapeHtml(v.device || '—')}</span></div>
        <div class="detail-row"><span class="k">Гео</span><span class="v">${escapeHtml(loc)}</span></div>
        <div class="detail-row"><span class="k">IP</span><span class="v">${escapeHtml(v.ip || '—')}</span></div>
        <div class="detail-row"><span class="k">Первый визит</span><span class="v">${fmtDate(v.created_at)}</span></div>
      </div>

      <div class="detail-group">
        <h4>Заметки и категория</h4>
        <div class="field"><label>Категория</label>
          <select data-f="category">
            ${['', 'Продажи', 'Поддержка', 'Жалоба', 'Спам'].map((c) =>
              `<option value="${attr(c)}" ${v.category === c ? 'selected' : ''}>${c || '— не задана —'}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Заметка оператора</label><textarea data-f="notes" rows="3" placeholder="Виден только операторам">${escapeHtml(v.notes || '')}</textarea></div>
        <button class="btn-primary" id="saveMeta">Сохранить заметку</button>
      </div>

      <div class="detail-group">
        <button class="block-btn ${v.blocked ? 'blocked' : ''}" id="blockBtn">
          ${v.blocked ? '🚫 Разблокировать' : 'Заблокировать посетителя'}
        </button>
      </div>`;
  }

  function bindDetailsDelegation() {
    $('#detailsBody').addEventListener('click', (e) => {
      const v = state.activeVisitor;
      if (!v) return;
      if (e.target.id === 'saveContacts') {
        updateVisitor(v.id, {
          name: valOf('name'), email: valOf('email'), phone: valOf('phone'),
        });
      } else if (e.target.id === 'saveMeta') {
        updateVisitor(v.id, { category: valOf('category'), notes: valOf('notes') });
      } else if (e.target.id === 'blockBtn') {
        updateVisitor(v.id, { blocked: v.blocked ? 0 : 1 });
      }
    });
  }

  function valOf(f) {
    const el = document.querySelector(`#detailsBody [data-f="${f}"]`);
    return el ? el.value : undefined;
  }

  function updateVisitor(visitorId, fields) {
    state.socket.emit('operator:update-visitor', {
      visitorId, conversationId: state.activeId, fields,
    });
    flash('Сохранено');
  }

  /* ----------------------------- Templates ----------------------------- */
  async function loadTemplates() {
    const res = await fetch('/api/templates?operatorId=' + encodeURIComponent(state.operator.id));
    const data = await res.json();
    state.templates = data.templates || [];
  }

  function bindTemplatesModal() {
    const modal = $('#templatesModal');
    $('#templatesBtn').addEventListener('click', () => { renderTemplates(); modal.classList.remove('hidden'); });
    $('#templatesClose').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    $('#tplAdd').addEventListener('click', async () => {
      const title = $('#tplTitle').value.trim();
      const body = $('#tplBody').value.trim();
      if (!title || !body) return;
      const res = await fetch('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorId: state.operator.id, title, body }),
      });
      const data = await res.json();
      if (data.template) {
        state.templates.push(data.template);
        $('#tplTitle').value = ''; $('#tplBody').value = '';
        renderTemplates();
      }
    });
  }

  function renderTemplates() {
    const list = $('#templatesList');
    list.innerHTML = '';
    if (!state.templates.length) {
      list.innerHTML = '<p class="muted" style="font-size:13px">Пока нет шаблонов. Добавьте первый ниже.</p>';
    }
    for (const t of state.templates) {
      const item = document.createElement('div');
      item.className = 'tpl-item';
      item.innerHTML = `<span class="tpl-del" data-id="${t.id}">удалить</span>
        <div class="tpl-title">${escapeHtml(t.title)}</div>
        <div class="tpl-body">${escapeHtml(t.body)}</div>`;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('tpl-del')) {
          fetch('/api/templates/' + t.id, { method: 'DELETE' });
          state.templates = state.templates.filter((x) => x.id !== t.id);
          renderTemplates();
          return;
        }
        const input = $('#composerInput');
        input.value = input.value ? input.value + '\n' + t.body : t.body;
        autoGrow(input);
        $('#templatesModal').classList.add('hidden');
        input.focus();
      });
      list.appendChild(item);
    }
  }

  /* ------------------------------- Utils ------------------------------- */
  function subLine(v) {
    const bits = [];
    if (v.os) bits.push(v.os);
    if (v.browser) bits.push(v.browser);
    if (v.referrer) bits.push(v.referrer);
    return bits.join(' · ') || '—';
  }

  function pageLink(url, title) {
    if (!url) return '—';
    const label = title || url;
    return `<a href="${attr(url)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(trunc(label, 40))}</a>`;
  }

  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function flash(text) {
    let n = document.querySelector('.flash-toast');
    if (!n) {
      n = document.createElement('div');
      n.className = 'flash-toast';
      n.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1c2b;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:200;opacity:0;transition:opacity .2s';
      document.body.appendChild(n);
    }
    n.textContent = text;
    n.style.opacity = '1';
    clearTimeout(n._t);
    n._t = setTimeout(() => { n.style.opacity = '0'; }, 1400);
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDate(ts) { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function attr(s) { return escapeHtml(s == null ? '' : s); }
})();
