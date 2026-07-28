/* Q desk — operator dashboard client. */
(function () {
  'use strict';

  const LS_COLLAPSED = 'qdesk_collapsed_sites';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    operator: null,
    socket: null,
    sites: [],            // sites this operator may work with
    inbox: [],
    activeId: null,
    activeVisitor: null,
    templates: [],
    collapsed: new Set(), // site ids whose group is folded away
  };

  try { state.collapsed = new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]')); } catch {}

  /* -------------------------------- Boot ------------------------------- */
  const appEl = $('#app');

  $('#logoutBtn').addEventListener('click', async () => {
    if (state.socket) state.socket.disconnect();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    location.href = '/login/';
  });

  // Identity always comes from the session cookie — no client-held credentials.
  boot();

  async function boot() {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) { location.href = '/login/'; return; }
      const data = await res.json();
      state.operator = data.operator;
      state.sites = data.sites || [];
    } catch {
      location.href = '/login/';
      return;
    }

    appEl.classList.remove('hidden');
    $('#meName').childNodes[0].nodeValue = state.operator.name + ' ';
    $('#meAvatar').textContent = (state.operator.name[0] || 'O').toUpperCase();

    const isAdmin = state.operator.role === 'admin';
    $('#roleBadge').classList.toggle('hidden', !isAdmin);
    $('#settingsBtn').classList.toggle('hidden', !isAdmin);

    loadTemplates();
    connect();
    bindComposer();
    bindDetailsDelegation();
    bindTemplatesModal();
    if (isAdmin) bindSettingsModal();

    $('#statusSelect').addEventListener('change', (e) => {
      state.socket.emit('operator:status', { status: e.target.value });
    });
    $('#closeConvBtn').addEventListener('click', () => {
      if (state.activeId && confirm('Завершить этот диалог?')) {
        state.socket.emit('operator:close', { conversationId: state.activeId });
      }
    });
  }

  /* ------------------------------ Socket ------------------------------- */
  function connect() {
    // The server authenticates the socket from the session cookie.
    state.socket = io({ auth: { role: 'operator' } });

    state.socket.on('error:auth', (d) => {
      if (d && d.message) alert(d.message);
      location.href = '/login/';
    });

    state.socket.on('sites:list', (sites) => {
      state.sites = sites || [];
      renderInbox();
    });

    state.socket.on('inbox:list', (rows) => {
      state.inbox = rows;
      // The active conversation may have moved out of our reach.
      if (state.activeId && !rows.some((r) => r.id === state.activeId)) {
        const stillOpen = rows.length > 0;
        if (!stillOpen) closeActiveView();
      }
      renderInbox();
    });

    state.socket.on('message:new', (msg) => {
      if (msg.conversation_id === state.activeId) {
        appendMessage(msg);
        state.socket.emit('operator:open', { conversationId: state.activeId });
      }
    });

    state.socket.on('conversation:history', (data) => {
      if (data.conversation.id !== state.activeId) return;
      state.activeVisitor = data.visitor;
      renderThread(data.messages);
      renderDetails(data.visitor, data.conversation, data.site);
      $('#chatTitle').textContent = data.visitor.name || 'Посетитель';
      $('#chatSub').innerHTML = subLine(data.visitor, data.site);
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
      if (v.conversationId === state.activeId) {
        state.activeVisitor = v;
        const site = state.sites.find((s) => s.id === v.siteId);
        renderDetails(v, { id: v.conversationId }, site);
        $('#chatTitle').textContent = v.name || 'Посетитель';
        $('#chatSub').innerHTML = subLine(v, site);
      }
      const idx = state.inbox.findIndex((c) => c.id === v.conversationId);
      if (idx !== -1 && v.name) { state.inbox[idx].visitor_name = v.name; renderInbox(); }
    });

    state.socket.on('conversation:closed', ({ conversationId }) => {
      if (conversationId === state.activeId) $('#chatSub').textContent = 'Диалог завершён';
    });
  }

  /* --------------------- Inbox, grouped by site ------------------------ */
  function renderInbox() {
    const box = $('#inbox');
    $('#inboxCount').textContent = state.inbox.length;
    box.innerHTML = '';

    if (!state.sites.length) {
      box.innerHTML = `<div class="site-group-empty" style="padding:20px 16px">
        Вам пока не назначен ни один сайт. Обратитесь к руководителю отдела.</div>`;
      return;
    }

    // Group conversations by site, preserving the server's recency ordering.
    const bySite = new Map(state.sites.map((s) => [s.id, []]));
    for (const c of state.inbox) {
      if (!bySite.has(c.site_id)) bySite.set(c.site_id, []);
      bySite.get(c.site_id).push(c);
    }

    for (const site of state.sites) {
      const convs = bySite.get(site.id) || [];
      const unread = convs.reduce((n, c) => n + (c.unread || 0), 0);
      const collapsed = state.collapsed.has(site.id);

      const group = document.createElement('div');
      group.className = 'site-group' + (collapsed ? ' collapsed' : '');

      const head = document.createElement('div');
      head.className = 'site-group-head';
      head.innerHTML = `
        <span class="site-caret">▼</span>
        <span class="site-dot" style="background:${attr(site.color || '#999')}"></span>
        <span class="site-group-name">${escapeHtml(site.name)}</span>
        ${unread > 0 ? `<span class="site-group-unread">${unread}</span>` : ''}
        <span class="site-group-count">${convs.length}</span>`;
      head.addEventListener('click', () => toggleSite(site.id));
      group.appendChild(head);

      const body = document.createElement('div');
      body.className = 'site-group-body';
      if (!convs.length) {
        body.innerHTML = '<div class="site-group-empty">Нет активных диалогов</div>';
      } else {
        for (const c of convs) body.appendChild(renderConvRow(c));
      }
      group.appendChild(body);
      box.appendChild(group);
    }
  }

  function renderConvRow(c) {
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
    return div;
  }

  function toggleSite(siteId) {
    if (state.collapsed.has(siteId)) state.collapsed.delete(siteId);
    else state.collapsed.add(siteId);
    try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...state.collapsed])); } catch {}
    renderInbox();
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

  function closeActiveView() {
    state.activeId = null;
    state.activeVisitor = null;
    $('#chatActive').classList.add('hidden');
    $('#details').classList.add('hidden');
    $('#chatEmpty').classList.remove('hidden');
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
    div.textContent = m.body;
    if (m.sender_type !== 'system') {
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
  function renderDetails(v, conv, site) {
    if (!v) return;
    const loc = v.location && (v.location.city || v.location.country)
      ? [v.location.city, v.location.country].filter(Boolean).join(', ')
      : '—';
    $('#detailsBody').innerHTML = `
      ${site ? `<div class="detail-group">
        <h4>Сайт</h4>
        <div class="detail-row">
          <span class="k"><span class="site-dot" style="display:inline-block;background:${attr(site.color || '#999')}"></span></span>
          <span class="v"><b>${escapeHtml(site.name)}</b></span>
        </div>
      </div>` : ''}

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
        <div class="field"><label>Заметка оператора</label><textarea data-f="notes" rows="3" placeholder="Видна только операторам">${escapeHtml(v.notes || '')}</textarea></div>
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
        updateVisitor(v.id, { name: valOf('name'), email: valOf('email'), phone: valOf('phone') });
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
    state.socket.emit('operator:update-visitor', { visitorId, conversationId: state.activeId, fields });
    flash('Сохранено');
  }

  /* ----------------------------- Templates ----------------------------- */
  async function loadTemplates() {
    const res = await fetch('/api/templates');
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
        body: JSON.stringify({ title, body }),
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

  /* ------------------- Team lead settings (admin only) ------------------ */
  function api(url, opts = {}) {
    return fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  }

  function bindSettingsModal() {
    const modal = $('#settingsModal');
    $('#settingsBtn').addEventListener('click', async () => {
      modal.classList.remove('hidden');
      await Promise.all([renderSitesTab(), renderTeamTab()]);
    });
    $('#settingsClose').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.tab;
        $('#tabSites').classList.toggle('hidden', which !== 'sites');
        $('#tabTeam').classList.toggle('hidden', which !== 'team');
      });
    });

    $('#empAdd').addEventListener('click', async () => {
      const err = $('#empError');
      err.classList.add('hidden');
      const payload = {
        name: $('#empName').value.trim(),
        email: $('#empEmail').value.trim(),
        password: $('#empPassword').value,
      };
      if (!payload.name || !payload.email) {
        err.textContent = 'Заполните имя и email'; err.classList.remove('hidden'); return;
      }
      if ((payload.password || '').length < 8) {
        err.textContent = 'Пароль должен быть не короче 8 символов'; err.classList.remove('hidden'); return;
      }
      const res = await api('/api/operators', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        err.textContent = data.error || 'Не удалось создать аккаунт'; err.classList.remove('hidden'); return;
      }
      $('#empName').value = ''; $('#empEmail').value = ''; $('#empPassword').value = '';
      $('#addEmployee').removeAttribute('open');
      await renderTeamTab();
      flash('Аккаунт создан');
    });

    $('#siteAdd').addEventListener('click', async () => {
      const name = $('#siteName').value.trim();
      if (!name) return;
      const res = await api('/api/sites', {
        method: 'POST',
        body: JSON.stringify({ name, domain: $('#siteDomain').value.trim(), color: $('#siteColor').value }),
      });
      if (res.ok) {
        $('#siteName').value = ''; $('#siteDomain').value = '';
        await renderSitesTab();
        await renderTeamTab();
        flash('Сайт добавлен');
      }
    });
  }

  async function renderSitesTab() {
    const res = await api('/api/sites');
    const data = await res.json();
    const sites = data.sites || [];
    const list = $('#sitesList');
    list.innerHTML = '';
    if (!sites.length) {
      list.innerHTML = '<p class="hint-text">Пока нет ни одного сайта. Добавьте первый ниже.</p>';
    }
    for (const s of sites) {
      const snippet = `<script src="${location.origin}/widget/widget.js" data-site="${s.key}"><\/script>`;
      const row = document.createElement('div');
      row.className = 'site-row';
      row.innerHTML = `
        <span class="site-dot" style="background:${attr(s.color || '#999')}"></span>
        <div class="site-row-main">
          <div class="site-row-name">${escapeHtml(s.name)}</div>
          <div class="site-row-key">${escapeHtml(s.key)}${s.domain ? ' · ' + escapeHtml(s.domain) : ''}</div>
        </div>
        <div class="site-row-actions">
          <button class="mini-btn" data-act="copy">Код</button>
          <button class="mini-btn" data-act="rename">Переим.</button>
          <button class="mini-btn danger" data-act="archive">В архив</button>
        </div>`;
      row.querySelector('[data-act=copy]').addEventListener('click', () => {
        navigator.clipboard?.writeText(snippet);
        flash('Код виджета скопирован');
      });
      row.querySelector('[data-act=rename]').addEventListener('click', async () => {
        const name = prompt('Новое название сайта:', s.name);
        if (!name || !name.trim()) return;
        await api('/api/sites/' + s.id, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
        await renderSitesTab(); await renderTeamTab();
      });
      row.querySelector('[data-act=archive]').addEventListener('click', async () => {
        if (!confirm(`Убрать «${s.name}» из работы? История диалогов сохранится.`)) return;
        await api('/api/sites/' + s.id, { method: 'DELETE' });
        await renderSitesTab(); await renderTeamTab();
      });
      list.appendChild(row);
    }
  }

  async function renderTeamTab() {
    const [opsRes, sitesRes] = await Promise.all([api('/api/operators'), api('/api/sites')]);
    const { operators } = await opsRes.json();
    const { sites } = await sitesRes.json();
    const list = $('#teamList');
    list.innerHTML = '';

    for (const op of operators || []) {
      const row = document.createElement('div');
      row.className = 'team-row';
      const isAdmin = op.role === 'admin';
      const isMe = op.id === state.operator.id;
      if (!op.active) row.classList.add('inactive');
      row.innerHTML = `
        <div class="team-row-head">
          <div class="team-avatar">${escapeHtml((op.name[0] || '?').toUpperCase())}</div>
          <div class="team-name">${escapeHtml(op.name)}${isMe ? ' <span class="you-tag">это вы</span>' : ''}
            <small>${escapeHtml(op.email || 'без email')} · ${isAdmin ? 'руководитель' : 'оператор'}${op.active ? '' : ' · отключён'}</small>
          </div>
          <div class="team-row-actions">
            <button class="mini-btn" data-act="password">Пароль</button>
            ${isMe ? '' : `<button class="mini-btn ${op.active ? 'danger' : ''}" data-act="active">${op.active ? 'Отключить' : 'Включить'}</button>`}
            <button class="mini-btn" data-act="role">${isAdmin ? 'Сделать оператором' : 'Сделать руководителем'}</button>
          </div>
        </div>
        <div class="team-sites"></div>`;

      row.querySelector('[data-act=password]').addEventListener('click', async () => {
        const pw = prompt(`Новый пароль для «${op.name}» (минимум 8 символов):`);
        if (pw === null) return;
        if (pw.length < 8) { flash('Пароль слишком короткий'); return; }
        const res = await api(`/api/operators/${op.id}/password`, {
          method: 'POST', body: JSON.stringify({ password: pw }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); flash(e.error || 'Не удалось'); return; }
        flash(isMe ? 'Пароль изменён — войдите заново' : 'Пароль изменён, сотрудник разлогинен');
        if (isMe) setTimeout(() => { location.href = '/login/'; }, 1200);
      });

      const activeBtn = row.querySelector('[data-act=active]');
      if (activeBtn) {
        activeBtn.addEventListener('click', async () => {
          if (op.active && !confirm(`Отключить доступ для «${op.name}»?`)) return;
          const res = await api(`/api/operators/${op.id}/active`, {
            method: 'POST', body: JSON.stringify({ active: !op.active }),
          });
          if (!res.ok) { const e = await res.json().catch(() => ({})); flash(e.error || 'Не удалось'); return; }
          await renderTeamTab();
        });
      }

      const sitesBox = row.querySelector('.team-sites');
      if (isAdmin) {
        sitesBox.innerHTML = '<span class="team-all">Руководитель видит все сайты отдела</span>';
      } else {
        for (const s of sites) {
          const on = (op.siteIds || []).includes(s.id);
          const label = document.createElement('label');
          label.className = 'site-check' + (on ? ' on' : '');
          label.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''} value="${attr(s.id)}" />
            <span class="site-dot" style="background:${attr(s.color || '#999')}"></span>${escapeHtml(s.name)}`;
          label.querySelector('input').addEventListener('change', async () => {
            const checked = [...sitesBox.querySelectorAll('input:checked')].map((i) => i.value);
            await api(`/api/operators/${op.id}/sites`, { method: 'PUT', body: JSON.stringify({ siteIds: checked }) });
            label.classList.toggle('on', label.querySelector('input').checked);
            flash(`Доступы обновлены: ${op.name}`);
          });
          sitesBox.appendChild(label);
        }
        if (!sites.length) sitesBox.innerHTML = '<span class="team-all">Сначала добавьте сайты</span>';
      }

      row.querySelector('[data-act=role]').addEventListener('click', async () => {
        const res = await api('/api/operators/' + op.id, {
          method: 'PATCH', body: JSON.stringify({ role: isAdmin ? 'operator' : 'admin' }),
        });
        if (!res.ok) { const e = await res.json(); flash(e.error || 'Не удалось'); return; }
        await renderTeamTab();
      });
      list.appendChild(row);
    }
  }

  /* ------------------------------- Utils ------------------------------- */
  function subLine(v, site) {
    const bits = [];
    if (v.os) bits.push(escapeHtml(v.os));
    if (v.browser) bits.push(escapeHtml(v.browser));
    if (v.referrer) bits.push(escapeHtml(v.referrer));
    const tail = bits.join(' · ') || '—';
    if (!site) return tail;
    return `<span class="site-dot" style="display:inline-block;background:${attr(site.color || '#999')}"></span>
            <b>${escapeHtml(site.name)}</b> · ${tail}`;
  }

  function pageLink(url, title) {
    if (!url) return '—';
    return `<a href="${attr(url)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(trunc(title || url, 40))}</a>`;
  }

  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function flash(text) {
    let n = document.querySelector('.flash-toast');
    if (!n) {
      n = document.createElement('div');
      n.className = 'flash-toast';
      n.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1c2b;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:300;opacity:0;transition:opacity .2s';
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
