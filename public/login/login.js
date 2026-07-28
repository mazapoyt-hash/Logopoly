/* Q desk — operator login site. */
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  const loading = $('#loading');
  const loginForm = $('#loginForm');
  const setupForm = $('#setupForm');

  /* Decide which screen to show: normal sign-in, or first-run setup. */
  fetch('/api/auth/state')
    .then((r) => r.json())
    .then((state) => {
      loading.classList.add('hidden');
      if (state.authenticated) { location.href = '/operator/'; return; }
      (state.needsSetup ? setupForm : loginForm).classList.remove('hidden');
      (state.needsSetup ? $('#sName') : $('#email')).focus();
    })
    .catch(() => {
      loading.textContent = 'Не удалось связаться с сервером. Обновите страницу.';
    });

  /* Show/hide password */
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.for);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    });
  });

  function showError(el, message) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
  function hideError(el) { el.classList.add('hidden'); }

  async function submit(url, payload, errorEl, button) {
    hideError(errorEl);
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Подождите…';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(errorEl, data.error || 'Не удалось войти. Попробуйте ещё раз.');
        return false;
      }
      // The session cookie is set by the server; go straight to the panel.
      location.href = '/operator/';
      return true;
    } catch {
      showError(errorEl, 'Сервер недоступен. Проверьте соединение.');
      return false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* ------------------------------ Sign in ------------------------------ */
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(
      '/api/auth/login',
      { email: $('#email').value.trim(), password: $('#password').value },
      $('#loginError'),
      $('#loginBtn')
    );
  });

  /* ------------------------- First-run setup --------------------------- */
  setupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#setupError');
    const pw = $('#sPassword').value;
    if (pw.length < 8) return showError(err, 'Пароль должен быть не короче 8 символов');
    if (pw !== $('#sPassword2').value) return showError(err, 'Пароли не совпадают');
    submit(
      '/api/auth/setup',
      { name: $('#sName').value.trim(), email: $('#sEmail').value.trim(), password: pw },
      err,
      $('#setupBtn')
    );
  });
})();
