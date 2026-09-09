/* CoinScope — dashboard client. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = { status: null, open: [], closed: [], prices: {}, pricesAt: null, chart: null };

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
  const fmtProb = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const OUTCOME = {
    win: { label: '✓ Успешный', cls: 'ok' },
    loss: { label: '✗ Неудачный', cls: 'bad' },
    expired: { label: '○ Истёк', cls: 'neutral' },
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
      if (tab.dataset.view === 'history') loadSignals();
      if (tab.dataset.view === 'stats') loadStats();
    });
  });

  /* ------------------------------- Status ----------------------------- */
  async function loadStatus() {
    state.status = await api('/api/status');
    $('#minSample').textContent = state.status.minSampleForStats;

    const banner = $('#sourceBanner');
    const health = state.status.sourceHealth;
    if (!health?.ok) {
      banner.className = 'banner error';
      banner.innerHTML = `<b>Нет связи с биржей:</b> ${esc(health?.error || 'источник не отвечает')}. ` +
        'Пока котировок нет, новые сигналы не выдаются.';
      banner.classList.remove('hidden');
    } else if (state.status.source === 'synthetic') {
      banner.className = 'banner';
      banner.innerHTML = '<b>Демо-режим:</b> данные синтетические, не биржевые. ' +
        'Для реальных котировок запустите с <code>COINSCOPE_SOURCE=binance</code>.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    $('#sourceTag').textContent = state.status.source === 'binance' ? 'Binance · live' : 'демо-данные';
    $('#sourceTag').className = 'source-tag ' + (state.status.source === 'binance' && health?.ok ? 'live' : 'demo');
    renderScanStatus();
  }

  function renderScanStatus() {
    const s = state.status?.scan;
    const bits = [];
    if (state.pricesAt) bits.push(`цены ${new Date(state.pricesAt).toLocaleTimeString('ru-RU')}`);
    if (s?.lastScanAt) bits.push(`скан ${new Date(s.lastScanAt).toLocaleTimeString('ru-RU')}`);
    if (s?.errors?.length) bits.push(`ошибок: ${s.errors.length}`);
    $('#scanStatus').textContent = bits.join(' · ') || 'ожидание данных…';
  }

  /* ------------------------------ Signals ----------------------------- */
  async function loadSignals() {
    const data = await api('/api/signals/all?limit=300');
    state.open = data.open;
    state.closed = data.closed;
    $('#openCount').textContent = data.open.length;
    $('#histCount').textContent = data.closed.length;
    renderSignals();
    renderHistory();
  }

  async function loadPrices() {
    try {
      const p = await api('/api/prices');
      applyPrices(p);
    } catch { /* the SSE feed will catch up */ }
  }

  function applyPrices(p) {
    if (!p?.values) return;
    state.prices = p.values;
    state.pricesAt = p.at;
    renderSignals();
    renderScanStatus();
  }

  /** Where the price sits between stop and target, 0..1. */
  function progressOf(sig, price) {
    if (!Number.isFinite(price)) return null;
    const span = sig.target - sig.stop;
    if (!span) return null;
    return Math.max(0, Math.min(1, (price - sig.stop) / span));
  }

  function probabilityBlock(sig) {
    if (sig.win_prob == null) {
      const have = sig.prob_sample ?? 0;
      return `<div class="prob unknown">
          <div class="prob-head"><span class="prob-label">Вероятность успеха</span><span class="prob-val">нет оценки</span></div>
          <div class="prob-note">Похожих завершённых сигналов пока ${have} — этого мало для честной цифры.</div>
        </div>`;
    }
    const pct = Math.round(sig.win_prob * 100);
    const cls = pct >= 55 ? 'good' : pct >= 45 ? 'mid' : 'weak';
    const range = sig.prob_low != null && sig.prob_high != null
      ? `${Math.round(sig.prob_low * 100)}–${Math.round(sig.prob_high * 100)}%`
      : '—';
    const ev = sig.expected_r != null
      ? `<span class="${sig.expected_r >= 0 ? 'up' : 'down'}">${fmtR(sig.expected_r)}</span> в среднем на сделку`
      : '';
    return `<div class="prob ${cls}">
        <div class="prob-head">
          <span class="prob-label">Вероятность успеха</span>
          <span class="prob-val">${pct}%</span>
        </div>
        <div class="prob-bar"><div class="prob-fill" style="width:${pct}%"></div></div>
        <div class="prob-note">
          Доверительный интервал ${range} · по ${sig.prob_sample} похожим сигналам
          <span class="muted">(${esc(sig.prob_basis === 'all' ? 'все сигналы' : sig.prob_basis || '')})</span>
          ${ev ? '<br>' + ev : ''}
        </div>
      </div>`;
  }

  function renderSignals() {
    const box = $('#openSignals');
    $('#openEmpty').classList.toggle('hidden', state.open.length > 0);
    box.innerHTML = '';

    for (const s of state.open) {
      const price = state.prices[s.symbol];
      const long = s.direction === 'LONG';
      const risk = Math.abs(s.entry - s.stop);
      const tpPct = ((s.target - s.entry) / s.entry) * 100 * (long ? 1 : -1);
      const slPct = ((s.stop - s.entry) / s.entry) * 100 * (long ? 1 : -1);
      const rr = risk > 0 ? Math.abs(s.target - s.entry) / risk : 0;

      let liveRow = '<div class="live-row muted">Ожидаем котировку…</div>';
      const prog = progressOf(s, price);
      if (Number.isFinite(price)) {
        const move = long ? (price - s.entry) / s.entry : (s.entry - price) / s.entry;
        const r = risk > 0 ? (move * s.entry) / risk : 0;
        const pos = long ? prog : 1 - prog;
        liveRow = `
          <div class="live-row">
            <span class="live-price">${fmtPrice(price)}</span>
            <span class="live-pnl ${r >= 0 ? 'up' : 'down'}">${fmtR(r)}</span>
          </div>
          <div class="track">
            <div class="track-fill" style="width:${(pos * 100).toFixed(1)}%"></div>
            <div class="track-entry" style="left:${(((long ? s.entry - s.stop : s.stop - s.entry) / (long ? s.target - s.stop : s.stop - s.target)) * 100).toFixed(1)}%"></div>
          </div>
          <div class="track-ends"><span class="down">стоп</span><span class="up">тейк</span></div>`;
      }

      const shown = s.reasons.slice(0, 3);
      const rest = s.reasons.length - shown.length;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-top">
          <div class="sym">${esc(s.symbol)}<small>${esc(s.timeframe)}</small></div>
          <div class="dir ${s.direction}">${long ? '▲ ЛОНГ' : '▼ ШОРТ'}</div>
        </div>

        ${probabilityBlock(s)}

        <div class="plan">
          <div class="plan-row take">
            <div class="plan-k">Фиксировать прибыль</div>
            <div class="plan-v">${fmtPrice(s.target)}<span class="plan-sub">${fmtPct(tpPct)} · +${fmtNum(rr, 1)}R</span></div>
          </div>
          <div class="plan-row lose">
            <div class="plan-k">Фиксировать убыток</div>
            <div class="plan-v">${fmtPrice(s.stop)}<span class="plan-sub">${fmtPct(slPct)} · −1R</span></div>
          </div>
          <div class="plan-row entry">
            <div class="plan-k">Вход</div>
            <div class="plan-v">${fmtPrice(s.entry)}<span class="plan-sub">риск ${fmtNum(Math.abs(slPct), 2)}%</span></div>
          </div>
        </div>

        ${liveRow}

        <div class="score-row">
          <div class="score-bar"><div class="score-fill" style="width:${s.score}%"></div></div>
          <div class="score-val">score ${s.score}/100</div>
        </div>
        <ul class="reasons">
          ${shown.map((r) => `<li>${esc(r.text)}</li>`).join('')}
          ${rest > 0 ? `<li class="more">ещё ${rest}</li>` : ''}
        </ul>
        <div class="card-foot"><span>выдан ${fmtTime(s.created_at)}</span><span>подробнее →</span></div>`;
      card.addEventListener('click', () => openChart(s));
      box.appendChild(card);
    }
  }

  /* ------------------------------ History ----------------------------- */
  function renderHistory() {
    const rows = state.closed;
    $('#historyEmpty').classList.toggle('hidden', rows.length > 0);
    $('#historyTable').classList.toggle('hidden', rows.length === 0);

    // Claimed-vs-actual: the only way to tell whether the probabilities mean
    // anything is to check them against what happened.
    const withProb = rows.filter((s) => s.win_prob != null);
    const claimed = withProb.length
      ? withProb.reduce((acc, s) => acc + s.win_prob, 0) / withProb.length : null;
    const actual = rows.length ? rows.filter((s) => s.r > 0).length / rows.length : null;
    const replayed = rows.filter((s) => s.origin === 'replay').length;
    const replayNote = replayed
      ? ` Из них ${replayed} восстановлены по прошлым свечам (<span class="tag replay">реплей</span>) —
          они не считаются живым результатом.`
      : '';
    $('#calibration').innerHTML = withProb.length
      ? `Заявленная вероятность в среднем <b>${fmtProb(claimed)}</b>, фактический результат
         <b>${fmtProb(actual)}</b> на ${rows.length} закрытых сигналах.${replayNote}`
      : `Закрытых сигналов: ${rows.length}. Оценок вероятности среди них пока нет.${replayNote}`;

    $('#historyTable tbody').innerHTML = rows.map((s) => {
      const o = OUTCOME[s.status] || { label: s.status, cls: 'neutral' };
      const rCls = s.r > 0 ? 'up' : s.r < 0 ? 'down' : '';
      const replay = s.origin === 'replay'
        ? ' <span class="tag replay" title="Восстановлен по прошлым свечам, не выдавался в реальном времени">реплей</span>' : '';
      return `<tr>
        <td><b>${esc(s.symbol)}</b>${replay}</td>
        <td><span class="dir ${s.direction}">${s.direction === 'LONG' ? 'ЛОНГ' : 'ШОРТ'}</span></td>
        <td><span class="badge ${o.cls}">${o.label}</span></td>
        <td class="num">${fmtPrice(s.entry)}</td>
        <td class="num">${fmtPrice(s.exit_price)}</td>
        <td class="num ${rCls}">${fmtR(s.r)}</td>
        <td class="num">${s.win_prob == null ? '—' : fmtProb(s.win_prob)}</td>
        <td class="num">${s.score}</td>
        <td>${fmtTime(s.exit_time)}</td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------- Market ----------------------------- */
  async function loadMarket() {
    const { market } = await api('/api/market');
    $('#marketTable tbody').innerHTML = market.map((m) => {
      if (m.error) return `<tr><td>${esc(m.symbol)}</td><td colspan="7" class="muted">${esc(m.error)}</td></tr>`;
      const live = state.prices[m.symbol];
      const trendTag = { up: 'tag up', down: 'tag down', flat: 'tag flat' }[m.htfTrend] || 'tag flat';
      const trendText = { up: 'вверх', down: 'вниз', flat: 'боковик' }[m.htfTrend] || '—';
      return `<tr>
        <td><b>${esc(m.symbol)}</b></td>
        <td class="num">${fmtPrice(Number.isFinite(live) ? live : m.price)}</td>
        <td class="num ${m.change24 >= 0 ? 'up' : 'down'}">${fmtPct(m.change24)}</td>
        <td class="num">${fmtNum(m.rsi, 0)}</td>
        <td class="num">${fmtNum(m.adx, 0)}</td>
        <td class="num">×${fmtNum(m.relVol)}</td>
        <td><span class="tag ${m.aboveEma200 ? 'up' : 'down'}">${m.aboveEma200 ? 'выше' : 'ниже'}</span></td>
        <td><span class="${trendTag}">${trendText}</span></td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------- Stats ------------------------------ */
  function metricsHtml(stats, minSample, emptyNote) {
    if (!stats || !stats.trades) return `<div class="low-sample">${esc(emptyNote)}</div>`;
    const warn = !stats.reliable
      ? `<div class="low-sample" style="grid-column:1/-1">
           Сделок всего ${stats.trades}. Это слишком мало, чтобы винрейт что-то значил —
           показываем его как факт, а не как обещание. Нужно минимум ${minSample}.
         </div>` : '';
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

    $('#liveStats').innerHTML = metricsHtml(record.portfolio, minSample,
      'Ни один сигнал ещё не закрылся. Пока сделок нет, показывать здесь нечего — и придумывать цифры мы не будем.');

    const rows = bt.results || [];
    const totals = rows.reduce((acc, r) => {
      const s = r.stats;
      if (!s || !s.trades) return acc;
      acc.trades += s.trades; acc.wins += s.wins; acc.totalR += s.totalR;
      acc.grossWin += s.grossWinR || 0;
      acc.grossLoss += s.grossLossR || 0;
      acc.maxDrawdownR = Math.max(acc.maxDrawdownR, s.maxDrawdownR);
      return acc;
    }, { trades: 0, wins: 0, totalR: 0, maxDrawdownR: 0, grossWin: 0, grossLoss: 0 });

    const portfolio = totals.trades ? {
      trades: totals.trades, wins: totals.wins,
      winRate: totals.wins / totals.trades,
      avgR: totals.totalR / totals.trades,
      totalR: totals.totalR,
      maxDrawdownR: totals.maxDrawdownR,
      profitFactor: totals.grossLoss > 0 ? totals.grossWin / totals.grossLoss
        : (totals.grossWin > 0 ? Infinity : null),
      reliable: totals.trades >= minSample,
    } : null;

    $('#btStats').innerHTML = metricsHtml(portfolio, minSample,
      'Бэктест ещё не запускался. Нажмите «Пересчитать», чтобы прогнать стратегию по имеющейся истории.');

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
    try {
      await api('/api/scan', { method: 'POST' });
      await Promise.all([loadStatus(), loadSignals(), loadPrices()]);
    } finally { btn.disabled = false; btn.textContent = 'Сканировать'; }
  });

  /* -------------------------------- Chart ----------------------------- */
  async function openChart(sig) {
    $('#chartModal').classList.remove('hidden');
    $('#chartTitle').textContent = `${sig.symbol} · ${sig.direction === 'LONG' ? 'Лонг' : 'Шорт'}`;
    const probText = sig.win_prob == null ? 'вероятность не оценена'
      : `вероятность ${fmtProb(sig.win_prob)} (по ${sig.prob_sample} похожим)`;
    $('#chartSub').textContent =
      `Вход ${fmtPrice(sig.entry)} · фиксировать убыток ${fmtPrice(sig.stop)} · прибыль ${fmtPrice(sig.target)} · ${probText}`;
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
    line(sig.stop, '#ea3943', 'убыток');
    line(sig.target, '#16c784', 'прибыль');
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
    es.addEventListener('signal:resolved', () => loadSignals());
    es.addEventListener('prices', (e) => { try { applyPrices(JSON.parse(e.data)); } catch {} });
    es.addEventListener('scan:done', (e) => {
      try { state.status.scan = JSON.parse(e.data); renderScanStatus(); } catch {}
    });
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }

  /* -------------------------------- Init ------------------------------ */
  (async function init() {
    await loadStatus();
    await Promise.all([loadSignals(), loadPrices()]);
    connectFeed();
    setInterval(loadSignals, 60_000);
    setInterval(loadStatus, 120_000);
  })();
})();
