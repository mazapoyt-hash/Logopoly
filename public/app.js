/* CoinScope — dashboard client. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = { status: null, open: [], market: [], prices: {}, chart: null };

  /* ------------------------------ Helpers ----------------------------- */
  const fmtPrice = (v) => {
    if (v == null || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 8;
    return v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
  const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const fmtR = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const OUTCOME = {
    win: { label: 'Тейк', cls: 'up' },
    loss: { label: 'Стоп', cls: 'down' },
    expired: { label: 'Истёк', cls: '' },
  };

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  /* -------------------------------- Tabs ------------------------------ */
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.view').forEach((v) => v.classList.add('hidden'));
      $(`#view-${tab.dataset.view}`).classList.remove('hidden');
      if (tab.dataset.view === 'market') loadMarket();
      if (tab.dataset.view === 'history') loadHistory();
      if (tab.dataset.view === 'stats') loadStats();
    });
  });

  /* ------------------------------- Status ----------------------------- */
  async function loadStatus() {
    state.status = await api('/api/status');
    $('#minSample').textContent = state.status.minSampleForStats;

    const banner = $('#sourceBanner');
    const health = state.status.sourceHealth;
    if (state.status.source === 'synthetic') {
      banner.innerHTML = '<b>Демо-режим:</b> данные синтетические, не биржевые. ' +
        'Для реальных котировок запустите с <code>COINSCOPE_SOURCE=binance</code>.';
      banner.classList.remove('hidden');
    } else if (health && !health.ok) {
      banner.innerHTML = `<b>Источник недоступен:</b> ${esc(health.error || '')}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    renderScanStatus();
  }

  function renderScanStatus() {
    const s = state.status?.scan;
    if (!s || !s.lastScanAt) { $('#scanStatus').textContent = 'сканирование…'; return; }
    const errs = s.errors?.length ? ` · ошибок: ${s.errors.length}` : '';
    $('#scanStatus').textContent = `обновлено ${fmtTime(s.lastScanAt)}${errs}`;
  }

  /* ------------------------------ Signals ----------------------------- */
  async function loadSignals() {
    const { signals } = await api('/api/signals/open');
    state.open = signals;
    $('#openCount').textContent = signals.length;
    renderSignals();
    // Current prices let each card show live progress toward TP/SL.
    for (const s of signals) fetchPrice(s.symbol);
  }

  async function fetchPrice(symbol) {
    try {
      const { candles } = await api(`/api/candles/${symbol}?limit=1`);
      if (candles.length) { state.prices[symbol] = candles[candles.length - 1].close; renderSignals(); }
    } catch { /* price is a nicety, not required */ }
  }

  function renderSignals() {
    const box = $('#openSignals');
    $('#openEmpty').classList.toggle('hidden', state.open.length > 0);
    box.innerHTML = '';

    for (const s of state.open) {
      const price = state.prices[s.symbol];
      const long = s.direction === 'LONG';
      let progress = '';
      if (price != null) {
        const move = long ? (price - s.entry) / s.entry : (s.entry - price) / s.entry;
        const risk = Math.abs(s.entry - s.stop) / s.entry;
        const r = risk > 0 ? move / risk : 0;
        progress = `<span class="live-pnl ${r >= 0 ? 'up' : 'down'}">${fmtR(r)}</span>`;
      }

      const shown = s.reasons.slice(0, 4);
      const rest = s.reasons.length - shown.length;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-top">
          <div class="sym">${esc(s.symbol)}<small>${esc(s.timeframe)}</small></div>
          <div class="dir ${s.direction}">${long ? '▲ ЛОНГ' : '▼ ШОРТ'}</div>
        </div>
        <div class="levels">
          <div class="level"><div class="k">Вход</div><div class="v">${fmtPrice(s.entry)}</div></div>
          <div class="level sl"><div class="k">Стоп</div><div class="v">${fmtPrice(s.stop)}</div></div>
          <div class="level tp"><div class="k">Тейк</div><div class="v">${fmtPrice(s.target)}</div></div>
        </div>
        <div class="score-row">
          <div class="score-bar"><div class="score-fill" style="width:${s.score}%"></div></div>
          <div class="score-val">${s.score}/100</div>
        </div>
        <ul class="reasons">
          ${shown.map((r) => `<li>${esc(r.text)}</li>`).join('')}
          ${rest > 0 ? `<li class="more">ещё ${rest}</li>` : ''}
        </ul>
        <div class="card-foot">
          <span>${fmtTime(s.created_at)}</span>
          <span>${progress}${progress ? ' · ' : ''}риск ${fmtNum(Math.abs((s.entry - s.stop) / s.entry) * 100, 2)}%</span>
        </div>`;
      card.addEventListener('click', () => openChart(s));
      box.appendChild(card);
    }
  }

  /* ------------------------------- Market ----------------------------- */
  async function loadMarket() {
    const { market } = await api('/api/market');
    const tbody = $('#marketTable tbody');
    tbody.innerHTML = market.map((m) => {
      if (m.error) return `<tr><td>${esc(m.symbol)}</td><td colspan="7" class="muted">${esc(m.error)}</td></tr>`;
      const trendTag = { up: 'tag up', down: 'tag down', flat: 'tag flat' }[m.htfTrend] || 'tag flat';
      const trendText = { up: 'вверх', down: 'вниз', flat: 'боковик' }[m.htfTrend] || '—';
      return `<tr>
        <td><b>${esc(m.symbol)}</b></td>
        <td class="num">${fmtPrice(m.price)}</td>
        <td class="num ${m.change24 >= 0 ? 'up' : 'down'}">${fmtPct(m.change24)}</td>
        <td class="num">${fmtNum(m.rsi, 0)}</td>
        <td class="num">${fmtNum(m.adx, 0)}</td>
        <td class="num">×${fmtNum(m.relVol)}</td>
        <td><span class="tag ${m.aboveEma200 ? 'up' : 'down'}">${m.aboveEma200 ? 'выше' : 'ниже'}</span></td>
        <td><span class="${trendTag}">${trendText}</span></td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------ History ----------------------------- */
  async function loadHistory() {
    const { signals } = await api('/api/signals/history?limit=200');
    $('#historyEmpty').classList.toggle('hidden', signals.length > 0);
    $('#historyTable').classList.toggle('hidden', signals.length === 0);
    $('#historyTable tbody').innerHTML = signals.map((s) => {
      const o = OUTCOME[s.status] || { label: s.status, cls: '' };
      const rCls = s.r > 0 ? 'up' : s.r < 0 ? 'down' : '';
      return `<tr>
        <td><b>${esc(s.symbol)}</b></td>
        <td><span class="dir ${s.direction}">${s.direction === 'LONG' ? 'ЛОНГ' : 'ШОРТ'}</span></td>
        <td class="num">${fmtPrice(s.entry)}</td>
        <td class="num">${fmtPrice(s.exit_price)}</td>
        <td class="num ${rCls}">${fmtR(s.r)} <span class="muted">${o.label}</span></td>
        <td class="num">${s.score}</td>
        <td class="num">${s.bars_held ?? '—'}</td>
        <td>${fmtTime(s.exit_time)}</td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------- Stats ------------------------------ */
  function metricsHtml(stats, minSample, emptyNote) {
    if (!stats || !stats.trades) {
      return `<div class="low-sample">${esc(emptyNote)}</div>`;
    }
    const warn = !stats.reliable
      ? `<div class="low-sample" style="grid-column:1/-1">
           Сделок всего ${stats.trades}. Это слишком мало, чтобы винрейт что-то значил —
           показываем его как факт, а не как обещание. Нужно минимум ${minSample}.
         </div>`
      : '';
    const pf = stats.profitFactor === null ? '—'
      : (stats.profitFactor === Infinity ? '∞' : fmtNum(stats.profitFactor));
    return `
      ${warn}
      <div class="metric"><div class="k">Сделок</div><div class="v">${stats.trades}</div></div>
      <div class="metric"><div class="k">Винрейт</div><div class="v">${stats.winRate == null ? '—' : (stats.winRate * 100).toFixed(1) + '%'}</div>
        <div class="note">${stats.wins} из ${stats.trades}</div></div>
      <div class="metric"><div class="k">Средний R</div><div class="v ${stats.avgR >= 0 ? 'up' : 'down'}">${fmtR(stats.avgR)}</div>
        <div class="note">на сделку</div></div>
      <div class="metric"><div class="k">Profit factor</div><div class="v">${pf}</div></div>
      <div class="metric"><div class="k">Сумма</div><div class="v ${stats.totalR >= 0 ? 'up' : 'down'}">${fmtR(stats.totalR)}</div></div>
      <div class="metric"><div class="k">Просадка</div><div class="v down">−${fmtNum(stats.maxDrawdownR, 1)}R</div></div>`;
  }

  async function loadStats() {
    const [record, bt] = await Promise.all([api('/api/record'), api('/api/backtest')]);
    const minSample = record.minSample;

    $('#liveStats').innerHTML = metricsHtml(
      record.portfolio, minSample,
      'Ни один сигнал ещё не закрылся. Пока сделок нет, показывать здесь нечего — и придумывать цифры мы не будем.'
    );

    const rows = bt.results || [];
    const totals = rows.reduce((acc, r) => {
      const s = r.stats;
      if (!s || !s.trades) return acc;
      acc.trades += s.trades; acc.wins += s.wins; acc.totalR += s.totalR;
      acc.grossWin += s.grossWinR || 0;
      acc.grossLoss += s.grossLossR || 0;
      // Per-symbol drawdowns cannot be summed into a portfolio drawdown, so
      // report the worst single-symbol one rather than inventing a number.
      acc.maxDrawdownR = Math.max(acc.maxDrawdownR, s.maxDrawdownR);
      return acc;
    }, { trades: 0, wins: 0, totalR: 0, maxDrawdownR: 0, grossWin: 0, grossLoss: 0 });

    const portfolio = totals.trades ? {
      trades: totals.trades,
      wins: totals.wins,
      winRate: totals.wins / totals.trades,
      avgR: totals.totalR / totals.trades,
      totalR: totals.totalR,
      maxDrawdownR: totals.maxDrawdownR,
      profitFactor: totals.grossLoss > 0
        ? totals.grossWin / totals.grossLoss
        : (totals.grossWin > 0 ? Infinity : null),
      reliable: totals.trades >= minSample,
    } : null;

    $('#btStats').innerHTML = metricsHtml(
      portfolio, minSample,
      'Бэктест ещё не запускался. Нажмите «Пересчитать», чтобы прогнать стратегию по имеющейся истории.'
    );

    $('#btTable tbody').innerHTML = rows.map((r) => {
      const s = r.stats || {};
      const pf = s.profitFactor == null ? '—' : (s.profitFactor === Infinity ? '∞' : fmtNum(s.profitFactor));
      return `<tr>
        <td><b>${esc(r.symbol)}</b></td>
        <td class="num">${s.trades ?? 0}</td>
        <td class="num">${s.winRate == null ? '—' : (s.winRate * 100).toFixed(1) + '%'}</td>
        <td class="num ${s.avgR >= 0 ? 'up' : 'down'}">${fmtR(s.avgR)}</td>
        <td class="num">${pf}</td>
        <td class="num ${s.totalR >= 0 ? 'up' : 'down'}">${fmtNum(s.totalR, 1)}R</td>
        <td class="num down">−${fmtNum(s.maxDrawdownR, 1)}R</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">Бэктест ещё не запускался.</td></tr>';
  }

  $('#runBacktest').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Считаю…';
    try { await api('/api/backtest/run', { method: 'POST' }); await loadStats(); }
    finally { btn.disabled = false; btn.textContent = 'Пересчитать'; }
  });

  $('#scanNow').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Сканирую…';
    try { await api('/api/scan', { method: 'POST' }); await Promise.all([loadStatus(), loadSignals()]); }
    finally { btn.disabled = false; btn.textContent = 'Сканировать'; }
  });

  /* -------------------------------- Chart ----------------------------- */
  async function openChart(sig) {
    $('#chartModal').classList.remove('hidden');
    $('#chartTitle').textContent = `${sig.symbol} · ${sig.direction === 'LONG' ? 'Лонг' : 'Шорт'}`;
    $('#chartSub').textContent =
      `Вход ${fmtPrice(sig.entry)} · стоп ${fmtPrice(sig.stop)} · тейк ${fmtPrice(sig.target)} · score ${sig.score}/100`;
    $('#chartLegend').innerHTML = sig.reasons.map((r) => `<span class="legend-item">✓ ${esc(r.text)}</span>`).join('');

    const box = $('#chartBox');
    box.innerHTML = '';
    if (window.__noChart || !window.LightweightCharts) {
      box.innerHTML = '<div class="empty">График недоступен: библиотека не загрузилась.</div>';
      return;
    }

    const { candles } = await api(`/api/candles/${sig.symbol}?limit=200&tf=${encodeURIComponent(sig.timeframe)}`);
    const chart = window.LightweightCharts.createChart(box, {
      layout: { background: { color: '#141824' }, textColor: '#8b93a8' },
      grid: { vertLines: { color: '#1e2433' }, horzLines: { color: '#1e2433' } },
      rightPriceScale: { borderColor: '#232a3b' },
      timeScale: { borderColor: '#232a3b', timeVisible: true },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#16c784', downColor: '#ea3943',
      borderUpColor: '#16c784', borderDownColor: '#ea3943',
      wickUpColor: '#16c784', wickDownColor: '#ea3943',
    });
    series.setData(candles.map((c) => ({
      time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    const line = (price, color, title) => series.createPriceLine({
      price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title,
    });
    line(sig.entry, '#4d8dff', 'вход');
    line(sig.stop, '#ea3943', 'стоп');
    line(sig.target, '#16c784', 'тейк');
    state.chart = chart;
  }

  function closeChart() {
    $('#chartModal').classList.add('hidden');
    if (state.chart) { state.chart.remove(); state.chart = null; }
  }
  $('#chartClose').addEventListener('click', closeChart);
  $('#chartModal').addEventListener('click', (e) => { if (e.target.id === 'chartModal') closeChart(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChart(); });

  /* ------------------------------- Live feed -------------------------- */
  function connectFeed() {
    const es = new EventSource('/api/events');
    es.addEventListener('signal:new', () => loadSignals());
    es.addEventListener('signal:resolved', () => { loadSignals(); loadHistory(); });
    es.addEventListener('scan:done', (e) => {
      try { state.status.scan = JSON.parse(e.data); renderScanStatus(); } catch {}
    });
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }

  /* -------------------------------- Init ------------------------------ */
  (async function init() {
    await loadStatus();
    await loadSignals();
    connectFeed();
    setInterval(loadSignals, 60_000);
  })();
})();
