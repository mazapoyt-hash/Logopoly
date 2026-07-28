/**
 * Logopoly Chat — embeddable website widget (visitor side).
 *
 * Usage on any site:
 *   <script src="https://your-host/widget/widget.js" data-title="Support"></script>
 *
 * The script injects a self-contained, style-scoped chat widget and connects to
 * the Logopoly Chat server over Socket.IO.
 */
(function () {
  'use strict';
  if (window.__logopolyChatLoaded) return;
  window.__logopolyChatLoaded = true;

  // --- Resolve the server origin from this script's own <src> ---------------
  const currentScript =
    document.currentScript ||
    (function () {
      const s = document.getElementsByTagName('script');
      return s[s.length - 1];
    })();
  const ORIGIN = new URL(currentScript.src).origin;
  const cfg = {
    title: currentScript.getAttribute('data-title') || 'Онлайн-чат',
    subtitle: currentScript.getAttribute('data-subtitle') || 'Мы обычно отвечаем за пару минут',
    accent: currentScript.getAttribute('data-accent') || '#6d5efc',
  };

  const STORAGE_KEY = 'logopoly_visitor_id';
  let visitorId = null;
  try { visitorId = localStorage.getItem(STORAGE_KEY); } catch {}

  /* ------------------------------- Styles -------------------------------- */
  const css = `
  .lpc-root{position:fixed;bottom:24px;right:24px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .lpc-launcher{width:60px;height:60px;border-radius:50%;background:${cfg.accent};box-shadow:0 8px 30px rgba(70,50,220,.4);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s ease;position:relative;}
  .lpc-launcher:hover{transform:scale(1.06);}
  .lpc-launcher svg{width:28px;height:28px;fill:#fff;}
  .lpc-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ff4d5e;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 0 0 2px #fff;}
  .lpc-panel{position:absolute;bottom:76px;right:0;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(20,20,60,.28);display:none;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px);transition:opacity .2s ease,transform .2s ease;}
  .lpc-open .lpc-panel{display:flex;opacity:1;transform:translateY(0);}
  .lpc-header{background:linear-gradient(135deg,${cfg.accent},#8a7bff);color:#fff;padding:18px 18px 16px;}
  .lpc-header h3{margin:0;font-size:17px;font-weight:700;}
  .lpc-header p{margin:3px 0 0;font-size:12.5px;opacity:.9;}
  .lpc-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;opacity:.95;}
  .lpc-dot{width:8px;height:8px;border-radius:50%;background:#9aa0b5;}
  .lpc-dot.on{background:#38d39f;box-shadow:0 0 0 3px rgba(56,211,159,.3);}
  .lpc-close{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.18);border:none;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;}
  .lpc-body{flex:1;overflow-y:auto;padding:16px;background:#f5f6fb;display:flex;flex-direction:column;gap:10px;}
  .lpc-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}
  .lpc-msg.visitor{align-self:flex-end;background:${cfg.accent};color:#fff;border-bottom-right-radius:4px;}
  .lpc-msg.operator{align-self:flex-start;background:#fff;color:#1a1c2b;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .lpc-msg.system{align-self:center;background:transparent;color:#8a8fa3;font-size:12px;text-align:center;max-width:100%;}
  .lpc-msg .lpc-meta{display:block;font-size:10.5px;opacity:.7;margin-top:3px;}
  .lpc-typing{align-self:flex-start;color:#8a8fa3;font-size:12.5px;padding:2px 4px;display:none;}
  .lpc-footer{border-top:1px solid #eceef5;padding:10px 12px;background:#fff;}
  .lpc-inputRow{display:flex;align-items:flex-end;gap:8px;}
  .lpc-input{flex:1;border:1px solid #e2e5f0;border-radius:12px;padding:9px 12px;font-size:14px;resize:none;max-height:96px;font-family:inherit;outline:none;}
  .lpc-input:focus{border-color:${cfg.accent};}
  .lpc-send{background:${cfg.accent};border:none;border-radius:12px;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .lpc-send:disabled{opacity:.5;cursor:default;}
  .lpc-send svg{width:20px;height:20px;fill:#fff;}
  .lpc-branding{text-align:center;font-size:11px;color:#a7abbd;padding:6px 0 2px;}
  .lpc-branding a{color:${cfg.accent};text-decoration:none;}
  .lpc-prechat{padding:16px;display:flex;flex-direction:column;gap:10px;background:#f5f6fb;flex:1;}
  .lpc-prechat input{border:1px solid #e2e5f0;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;}
  .lpc-prechat button{background:${cfg.accent};color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;}
  .lpc-prechat h4{margin:4px 0;color:#1a1c2b;font-size:15px;}
  .lpc-prechat p{margin:0 0 4px;color:#6a6f85;font-size:13px;}
  .lpc-rate{padding:16px;text-align:center;background:#f5f6fb;}
  .lpc-stars{font-size:30px;letter-spacing:6px;cursor:pointer;user-select:none;color:#d7d9e6;}
  .lpc-stars span:hover,.lpc-stars span.active{color:#ffb020;}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* -------------------------------- DOM ---------------------------------- */
  const root = document.createElement('div');
  root.className = 'lpc-root';
  root.innerHTML = `
    <button class="lpc-launcher" aria-label="Открыть чат">
      <span class="lpc-badge">0</span>
      <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 9h10v2H7V9zm7 5H7v-2h7v2zm3-6H7V6h10v2z"/></svg>
    </button>
    <div class="lpc-panel" role="dialog" aria-label="Окно чата">
      <div class="lpc-header">
        <button class="lpc-close" aria-label="Свернуть">×</button>
        <h3>${escapeHtml(cfg.title)}</h3>
        <p>${escapeHtml(cfg.subtitle)}</p>
        <span class="lpc-status"><span class="lpc-dot"></span><span class="lpc-status-text">Оффлайн</span></span>
      </div>
      <div class="lpc-prechat">
        <h4>Здравствуйте! 👋</h4>
        <p>Как к вам обращаться? (необязательно)</p>
        <input class="lpc-name" type="text" placeholder="Ваше имя" />
        <input class="lpc-email" type="email" placeholder="Email для ответа (необязательно)" />
        <button class="lpc-start">Начать диалог</button>
      </div>
      <div class="lpc-body" style="display:none"></div>
      <div class="lpc-footer" style="display:none">
        <div class="lpc-typing"></div>
        <div class="lpc-inputRow">
          <textarea class="lpc-input" rows="1" placeholder="Напишите сообщение…"></textarea>
          <button class="lpc-send" aria-label="Отправить">
            <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
        </div>
        <div class="lpc-branding">Работает на <a href="${ORIGIN}" target="_blank" rel="noopener">Logopoly&nbsp;Chat</a></div>
      </div>
      <div class="lpc-rate" style="display:none">
        <h4 style="margin:0 0 8px">Оцените, пожалуйста, диалог</h4>
        <div class="lpc-stars">
          <span data-v="1">★</span><span data-v="2">★</span><span data-v="3">★</span><span data-v="4">★</span><span data-v="5">★</span>
        </div>
        <div class="lpc-branding" style="margin-top:8px">Спасибо, что были с нами!</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const el = {
    launcher: root.querySelector('.lpc-launcher'),
    badge: root.querySelector('.lpc-badge'),
    panel: root.querySelector('.lpc-panel'),
    close: root.querySelector('.lpc-close'),
    prechat: root.querySelector('.lpc-prechat'),
    startBtn: root.querySelector('.lpc-start'),
    nameInput: root.querySelector('.lpc-name'),
    emailInput: root.querySelector('.lpc-email'),
    body: root.querySelector('.lpc-body'),
    footer: root.querySelector('.lpc-footer'),
    input: root.querySelector('.lpc-input'),
    send: root.querySelector('.lpc-send'),
    typing: root.querySelector('.lpc-typing'),
    dot: root.querySelector('.lpc-dot'),
    statusText: root.querySelector('.lpc-status-text'),
    rate: root.querySelector('.lpc-rate'),
    stars: root.querySelector('.lpc-stars'),
  };

  let socket = null;
  let unread = 0;
  let started = false;
  let opTypingTimer = null;

  function setOpen(open) {
    root.classList.toggle('lpc-open', open);
    if (open) { unread = 0; renderBadge(); scrollBottom(); el.input.focus(); }
  }
  function renderBadge() {
    el.badge.textContent = unread;
    el.badge.style.display = unread > 0 ? 'flex' : 'none';
  }

  el.launcher.addEventListener('click', () => setOpen(!root.classList.contains('lpc-open')));
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
        socket.emit('visitor:init', { visitorId, page: pageInfo() });
      });

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
          if (!root.classList.contains('lpc-open')) { unread++; renderBadge(); }
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
    div.className = 'lpc-msg ' + msg.sender_type;
    if (msg.sender_type === 'system') {
      div.textContent = msg.body;
    } else {
      div.textContent = msg.body;
      const meta = document.createElement('span');
      meta.className = 'lpc-meta';
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
