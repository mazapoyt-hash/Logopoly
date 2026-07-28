/**
 * Q desk — embeddable website widget (visitor side).
 *
 * Usage on any site:
 *   <script src="https://your-host/widget/widget.js" data-title="Support"></script>
 *
 * The script injects a self-contained, style-scoped chat widget and connects to
 * the Q desk server over Socket.IO.
 */
(function () {
  'use strict';
  if (window.__qdeskChatLoaded) return;
  window.__qdeskChatLoaded = true;

  // --- Resolve the server origin from this script's own <src> ---------------
  const currentScript =
    document.currentScript ||
    (function () {
      const s = document.getElementsByTagName('script');
      return s[s.length - 1];
    })();
  const SRC_URL = new URL(currentScript.src);
  const ORIGIN = SRC_URL.origin;
  // The site key ties this embed to one project (e.g. one casino brand).
  const SITE_KEY = currentScript.getAttribute('data-site') || SRC_URL.searchParams.get('site') || null;
  const cfg = {
    title: currentScript.getAttribute('data-title') || 'Онлайн-чат',
    subtitle: currentScript.getAttribute('data-subtitle') || 'Мы обычно отвечаем за пару минут',
    accent: currentScript.getAttribute('data-accent') || '#6d5efc',
  };

  // Visitor identity is per-site, so the same browser is a separate visitor on
  // each brand's website.
  const STORAGE_KEY = 'qdesk_visitor_id' + (SITE_KEY ? '_' + SITE_KEY : '');
  let visitorId = null;
  try { visitorId = localStorage.getItem(STORAGE_KEY); } catch {}

  /* ------------------------------- Styles -------------------------------- */
  const css = `
  .qd-root{position:fixed;bottom:24px;right:24px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .qd-launcher{width:60px;height:60px;border-radius:50%;background:${cfg.accent};box-shadow:0 8px 30px rgba(70,50,220,.4);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s ease;position:relative;}
  .qd-launcher:hover{transform:scale(1.06);}
  .qd-launcher svg{width:28px;height:28px;fill:#fff;}
  .qd-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ff4d5e;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 0 0 2px #fff;}
  .qd-panel{position:absolute;bottom:76px;right:0;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(20,20,60,.28);display:none;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px);transition:opacity .2s ease,transform .2s ease;}
  .qd-open .qd-panel{display:flex;opacity:1;transform:translateY(0);}
  .qd-header{background:linear-gradient(135deg,${cfg.accent},#8a7bff);color:#fff;padding:18px 18px 16px;}
  .qd-header h3{margin:0;font-size:17px;font-weight:700;}
  .qd-header p{margin:3px 0 0;font-size:12.5px;opacity:.9;}
  .qd-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;opacity:.95;}
  .qd-dot{width:8px;height:8px;border-radius:50%;background:#9aa0b5;}
  .qd-dot.on{background:#38d39f;box-shadow:0 0 0 3px rgba(56,211,159,.3);}
  .qd-close{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.18);border:none;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;}
  .qd-body{flex:1;overflow-y:auto;padding:16px;background:#f5f6fb;display:flex;flex-direction:column;gap:10px;}
  .qd-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}
  .qd-msg.visitor{align-self:flex-end;background:${cfg.accent};color:#fff;border-bottom-right-radius:4px;}
  .qd-msg.operator{align-self:flex-start;background:#fff;color:#1a1c2b;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .qd-msg.system{align-self:center;background:transparent;color:#8a8fa3;font-size:12px;text-align:center;max-width:100%;}
  .qd-msg .qd-meta{display:block;font-size:10.5px;opacity:.7;margin-top:3px;}
  .qd-typing{align-self:flex-start;color:#8a8fa3;font-size:12.5px;padding:2px 4px;display:none;}
  .qd-footer{border-top:1px solid #eceef5;padding:10px 12px;background:#fff;}
  .qd-inputRow{display:flex;align-items:flex-end;gap:8px;}
  .qd-input{flex:1;border:1px solid #e2e5f0;border-radius:12px;padding:9px 12px;font-size:14px;resize:none;max-height:96px;font-family:inherit;outline:none;}
  .qd-input:focus{border-color:${cfg.accent};}
  .qd-send{background:${cfg.accent};border:none;border-radius:12px;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .qd-send:disabled{opacity:.5;cursor:default;}
  .qd-send svg{width:20px;height:20px;fill:#fff;}
  .qd-branding{text-align:center;font-size:11px;color:#a7abbd;padding:6px 0 2px;}
  .qd-branding a{color:${cfg.accent};text-decoration:none;}
  .qd-prechat{padding:16px;display:flex;flex-direction:column;gap:10px;background:#f5f6fb;flex:1;}
  .qd-prechat input{border:1px solid #e2e5f0;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;}
  .qd-prechat button{background:${cfg.accent};color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;}
  .qd-prechat h4{margin:4px 0;color:#1a1c2b;font-size:15px;}
  .qd-prechat p{margin:0 0 4px;color:#6a6f85;font-size:13px;}
  .qd-rate{padding:16px;text-align:center;background:#f5f6fb;}
  .qd-stars{font-size:30px;letter-spacing:6px;cursor:pointer;user-select:none;color:#d7d9e6;}
  .qd-stars span:hover,.qd-stars span.active{color:#ffb020;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* -------------------------------- DOM ---------------------------------- */
  const root = document.createElement('div');
  root.className = 'qd-root';
  root.innerHTML = `
    <button class="qd-launcher" aria-label="Открыть чат">
      <span class="qd-badge">0</span>
      <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 9h10v2H7V9zm7 5H7v-2h7v2zm3-6H7V6h10v2z"/></svg>
    </button>
    <div class="qd-panel" role="dialog" aria-label="Окно чата">
      <div class="qd-header">
        <button class="qd-close" aria-label="Свернуть">×</button>
        <h3>${escapeHtml(cfg.title)}</h3>
        <p>${escapeHtml(cfg.subtitle)}</p>
        <span class="qd-status"><span class="qd-dot"></span><span class="qd-status-text">Оффлайн</span></span>
      </div>
      <div class="qd-prechat">
        <h4>Здравствуйте! 👋</h4>
        <p>Как к вам обращаться? (необязательно)</p>
        <input class="qd-name" type="text" placeholder="Ваше имя" />
        <input class="qd-email" type="email" placeholder="Email для ответа (необязательно)" />
        <button class="qd-start">Начать диалог</button>
      </div>
      <div class="qd-body" style="display:none"></div>
      <div class="qd-footer" style="display:none">
        <div class="qd-typing"></div>
        <div class="qd-inputRow">
          <textarea class="qd-input" rows="1" placeholder="Напишите сообщение…"></textarea>
          <button class="qd-send" aria-label="Отправить">
            <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
        </div>
        <div class="qd-branding">Работает на <a href="${ORIGIN}" target="_blank" rel="noopener">Q&nbsp;desk</a></div>
      </div>
      <div class="qd-rate" style="display:none">
        <h4 style="margin:0 0 8px">Оцените, пожалуйста, диалог</h4>
        <div class="qd-stars">
          <span data-v="1">★</span><span data-v="2">★</span><span data-v="3">★</span><span data-v="4">★</span><span data-v="5">★</span>
        </div>
        <div class="qd-branding" style="margin-top:8px">Спасибо, что были с нами!</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const el = {
    launcher: root.querySelector('.qd-launcher'),
    badge: root.querySelector('.qd-badge'),
    panel: root.querySelector('.qd-panel'),
    close: root.querySelector('.qd-close'),
    prechat: root.querySelector('.qd-prechat'),
    startBtn: root.querySelector('.qd-start'),
    nameInput: root.querySelector('.qd-name'),
    emailInput: root.querySelector('.qd-email'),
    body: root.querySelector('.qd-body'),
    footer: root.querySelector('.qd-footer'),
    input: root.querySelector('.qd-input'),
    send: root.querySelector('.qd-send'),
    typing: root.querySelector('.qd-typing'),
    dot: root.querySelector('.qd-dot'),
    statusText: root.querySelector('.qd-status-text'),
    rate: root.querySelector('.qd-rate'),
    stars: root.querySelector('.qd-stars'),
  };

  let socket = null;
  let unread = 0;
  let started = false;
  let opTypingTimer = null;

  function setOpen(open) {
    root.classList.toggle('qd-open', open);
    if (open) { unread = 0; renderBadge(); scrollBottom(); el.input.focus(); }
  }
  function renderBadge() {
    el.badge.textContent = unread;
    el.badge.style.display = unread > 0 ? 'flex' : 'none';
  }

  el.launcher.addEventListener('click', () => setOpen(!root.classList.contains('qd-open')));
  el.close.addEventListener('click', () => setOpen(false));

  /* --------------------------- Socket.IO load ---------------------------- */
  function loadSocketIo(cb) {
    if (window.io) return cb();
    const s = document.createElement('script');
    s.src = ORIGIN + '/socket.io/socket.io.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function connect() {
    loadSocketIo(() => {
      socket = window.io(ORIGIN, { auth: { role: 'visitor', visitorId } });

      socket.on('connect', () => {
        socket.emit('visitor:init', { visitorId, siteKey: SITE_KEY, page: pageInfo() });
      });

      socket.on('visitor:blocked', () => { root.style.display = 'none'; });

      socket.on('visitor:session', (data) => {
        visitorId = data.visitorId;
        try { localStorage.setItem(STORAGE_KEY, visitorId); } catch {}
        setPresence(data.operatorOnline);
        el.body.innerHTML = '';
        (data.messages || []).forEach(addMessage);
        if (data.rating) { /* already rated previously */ }
        scrollBottom();
      });

      socket.on('presence', (data) => setPresence(data.operatorOnline));

      socket.on('message:new', (msg) => {
        addMessage(msg);
        if (msg.sender_type === 'operator') {
          hideOpTyping();
          if (!root.classList.contains('qd-open')) { unread++; renderBadge(); }
        }
        scrollBottom();
      });

      socket.on('operator:typing', () => {
        el.typing.textContent = 'печатает…';
        el.typing.style.display = 'block';
        clearTimeout(opTypingTimer);
        opTypingTimer = setTimeout(hideOpTyping, 2500);
        scrollBottom();
      });

      socket.on('conversation:closed', () => {
        showRating();
      });
    });
  }

  function hideOpTyping() { el.typing.style.display = 'none'; }

  function setPresence(online) {
    el.dot.classList.toggle('on', !!online);
    el.statusText.textContent = online ? 'Оператор на связи' : 'Мы офлайн, но ответим на email';
  }

  /* ----------------------------- Messaging ------------------------------- */
  el.startBtn.addEventListener('click', startChat);
  el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startChat(); });

  function startChat() {
    started = true;
    el.prechat.style.display = 'none';
    el.body.style.display = 'flex';
    el.footer.style.display = 'block';
    const name = el.nameInput.value.trim();
    const email = el.emailInput.value.trim();
    if ((name || email) && socket) socket.emit('visitor:profile', { name, email });
    el.input.focus();
  }

  el.send.addEventListener('click', sendMessage);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  el.input.addEventListener('input', () => {
    autoGrow();
    // Live typing preview — send current text to operators before it's sent.
    if (socket) socket.emit('visitor:typing', { text: el.input.value });
  });

  function sendMessage() {
    const body = el.input.value.trim();
    if (!body || !socket) return;
    socket.emit('visitor:message', { body });
    socket.emit('visitor:typing', { text: '' });
    el.input.value = '';
    autoGrow();
    el.input.focus();
  }

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 96) + 'px';
  }

  /* ------------------------------ Rendering ------------------------------ */
  function addMessage(msg) {
    const div = document.createElement('div');
    div.className = 'qd-msg ' + msg.sender_type;
    if (msg.sender_type === 'system') {
      div.textContent = msg.body;
    } else {
      div.textContent = msg.body;
      const meta = document.createElement('span');
      meta.className = 'qd-meta';
      meta.textContent = (msg.sender_type === 'operator' && msg.sender_name ? msg.sender_name + ' · ' : '') + fmtTime(msg.created_at);
      div.appendChild(meta);
    }
    el.body.appendChild(div);
  }

  function scrollBottom() { el.body.scrollTop = el.body.scrollHeight; }

  /* ------------------------------- Rating -------------------------------- */
  function showRating() {
    el.footer.style.display = 'none';
    el.rate.style.display = 'block';
  }
  el.stars.querySelectorAll('span').forEach((star) => {
    star.addEventListener('mouseenter', () => paintStars(+star.dataset.v));
    star.addEventListener('click', () => {
      const v = +star.dataset.v;
      if (socket) socket.emit('visitor:rate', { rating: v });
      paintStars(v);
      setTimeout(() => { el.rate.querySelector('h4').textContent = 'Спасибо за оценку!'; }, 150);
    });
  });
  el.stars.addEventListener('mouseleave', () => paintStars(0));
  function paintStars(n) {
    el.stars.querySelectorAll('span').forEach((s) => s.classList.toggle('active', +s.dataset.v <= n));
  }

  /* ------------------------------- Utils --------------------------------- */
  function pageInfo() {
    const utm = {};
    try {
      const p = new URLSearchParams(location.search);
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
        if (p.get(k)) utm[k] = p.get(k);
      }
    } catch {}
    return {
      url: location.href,
      title: document.title,
      referrer: document.referrer || null,
      utm: Object.keys(utm).length ? utm : null,
    };
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  connect();
})();
