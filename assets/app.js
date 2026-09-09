/* CoinScope — dashboard client.
 *
 * Runs in two modes from the same code:
 *   live   — behind the Node server: REST API plus an SSE feed.
 *   static — on GitHub Pages: reads JSON committed by the scheduled scan, and
 *            polls Binance directly from the browser for current prices, so
 *            the cards still move between scans.
 * Mode is detected, never configured.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    mode: null, status: null, open: [], closed: [], market: [],
    prices: {}, pricesAt: null, priceSource: null, chart: null,
  };

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
  const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString('ru-RU') : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const OUTCOME = {
    win: { label: '✓ Успешный', cls: 'ok' },
    loss: { label: '✗ Неудачный', cls: 'bad' },
    expired: { label: '○ Истёк', cls: 'neutral' },
  };

  /** One internal shape, whatever the source spells its fields. */
  function normalizeSignal(s) {
    return {
      id: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: s.direction,
      entry: s.entry, stop: s.stop, target: s.target,
      score: s.score,
      reasons: s.reasons || [],
      status: s.status,
      exit: s.exit ?? s.exit_price ?? null,
      exitTime: s.exitTime ?? s.exit_time ?? null,
      barsHeld: s.barsHeld ?? s.bars_held ?? null,
      r: s.r,
      createdAt: s.createdAt ?? s.created_at ?? null,
      barTime: s.barTime ?? s.bar_time ?? null,
      origin: s.origin || 'live',
      winProb: s.winProb ?? s.win_prob ?? null,
      probLow: s.probLow ?? s.prob_low ?? null,
      probHigh: s.probHigh ?? s.prob_high ?? null,
      probSample: s.probSample ?? s.prob_sample ?? null,
      probBasis: s.probBasis ?? s.prob_basis ?? null,
      expectedR: s.expectedR ?? s.expected_r ?? null,
    };
  }

  const getJson = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  };

  /* ------------------------- Data access layer ------------------------ */
  const Live = {
    name: 'live',
    status: () => getJson('/api/status'),
    signals: async () => {
      const d = await getJson('/api/signals/all?limit=300');
      return { open: d.open.map(normalizeSignal), closed: d.closed.map(normalizeSignal) };
    },
    market: async () => (await getJson('/api/market')).market,
    stats: async () => {
      const [record, bt] = await Promise.all([getJson('/api/record'), getJson('/api/backtest')]);
      return { live: record.portfolio, backtest: { perSymbol: bt.results, portfolio: null }, minSample: record.minSample };
    },
    validation: async () => (await getJson('/api/validation')).report,
    prices: async () => getJson('/api/prices'),
    candles: (symbol, tf, limit) => getJson(`/api/candles/${symbol}?limit=${limit}&tf=${encodeURIComponent(tf)}`),
  };

  const Static = {
    name: 'static',
    status: () => getJson('data/status.json'),
    signals: async () => {
      const d = await getJson('data/signals.json');
      return { open: (d.open || []).map(normalizeSignal), closed: (d.closed || []).map(normalizeSignal) };
    },
    market: async () => (await getJson('data/market.json')).market,
    stats: async () => {
      const s = await getJson('data/stats.json');
      return {
        live: s.live,
        backtest: { perSymbol: s.backtest.perSymbol, portfolio: s.backtest.portfolio },
        timeline: s.timeline, consistency: s.consistency, minSample: s.minSample,
      };
    },
    validation: () => getJson('data/validation.json').catch(() => null),

    /**
     * Prices straight from Binance. Its public market-data endpoints allow
     * cross-origin reads, so the page stays current between scheduled scans.
     * If the browser cannot reach it (blocked network, regional block), fall
     * back to the prices captured at the last scan and say so.
     */
    prices: async () => {
      const symbols = state.status?.symbols || [];
      if (!symbols.length) return { at: null, values: {} };
      try {
        const url = 'https://api.binance.com/api/v3/ticker/price?symbols=' +
          encodeURIComponent(JSON.stringify(symbols));
        const rows = await getJson(url);
        const values = {};
        for (const r of rows) {
          const p = Number(r.price);
          if (r.symbol && Number.isFinite(p)) values[r.symbol] = p;
        }
        state.priceSource = 'binance';
        return { at: Date.now(), values };
      } catch {
        state.priceSource = 'snapshot';
        const values = {};
        for (const m of state.market) if (Number.isFinite(m.price)) values[m.symbol] = m.price;
        return { at: state.status?.updatedAt || null, values };
      }
    },

    candles: async (symbol, tf, limit) => {
      const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${encodeURIComponent(tf)}&limit=${limit}`;
      const rows = await getJson(url);
      return {
        candles: rows.map((r) => ({
          time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
          low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
        })),
      };
    },
  };

  let API = Static;

  /** Prefer the live server when one is actually there. */
  async function detectMode() {
    try {
      const s = await Live.status();
      API = Live;
      state.mode = 'live';
      return s;
    } catch {
      API = Static;
      state.mode = 'static';
      return Static.status();
    }
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
      // loadValidation falls back to the time-segment verdict that loadStats
      // unpacks from stats.json, so it must run after it.
      if (tab.dataset.view === 'stats') loadStats().then(loadValidation);
    });
  });

  /* ------------------------------- Status ----------------------------- */
  async function loadStatus() {
    state.status = await detectMode();
    $('#minSample').textContent = state.status.minSampleForStats ?? 20;

    const modeBanner = $('#modeBanner');
    if (state.mode === 'static') {
      const age = state.status.updatedAt ? Date.now() - state.status.updatedAt : null;
      const mins = age == null ? null : Math.round(age / 60000);
      modeBanner.className = 'banner';
      modeBanner.innerHTML =
        `<b>Сайт работает без сервера.</b> Сигналы пересчитываются по расписанию в GitHub Actions` +
        (mins == null ? '' : `, последний прогон ${mins < 1 ? 'только что' : mins + ' мин назад'}`) +
        '. Цены в карточках обновляются в браузере в реальном времени.';
      modeBanner.classList.remove('hidden');
    } else {
      modeBanner.classList.add('hidden');
    }

    // Actions that need a running server have no meaning on the static site.
    for (const id of ['#scanNow', '#runBacktest', '#runValidation']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', state.mode !== 'live');
    }

    const banner = $('#sourceBanner');
    const health = state.mode === 'live' ? state.status.sourceHealth : { ok: state.status.ok };
    if (!health?.ok) {
      banner.className = 'banner error';
      banner.innerHTML = `<b>Нет связи с биржей:</b> ${esc(health?.error || state.status.error || 'источник не отвечает')}. ` +
        'Пока котировок нет, новые сигналы не выдаются.';
      banner.classList.remove('hidden');
    } else if (state.status.source === 'synthetic') {
      banner.className = 'banner';
      banner.innerHTML = '<b>Демо-режим:</b> данные синтетические, не биржевые.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const live = state.status.source === 'binance' && health?.ok;
    $('#sourceTag').textContent = live ? 'Binance · live' : 'демо-данные';
    $('#sourceTag').className = 'source-tag ' + (live ? 'live' : 'demo');
    renderScanStatus();
  }

  function renderScanStatus() {
    const bits = [];
    if (state.pricesAt) {
      bits.push(`цены ${fmtClock(state.pricesAt)}${state.priceSource === 'snapshot' ? ' (снимок)' : ''}`);
    }
    const scanAt = state.mode === 'live' ? state.status?.scan?.lastScanAt : state.status?.updatedAt;
    if (scanAt) bits.push(`скан ${fmtClock(scanAt)}`);
    const skipped = state.mode === 'live'
      ? state.status?.scan?.skipped?.length
      : (state.status?.dataQuality || []).filter((q) => !q.ok).length;
    if (skipped) bits.push(`пропущено по данным: ${skipped}`);
    $('#scanStatus').textContent = bits.join(' · ') || 'ожидание данных…';
  }

  /* ------------------------------ Signals ----------------------------- */
  async function loadSignals() {
    const data = await API.signals();
    state.open = data.open;
    state.closed = data.closed;
    $('#openCount').textContent = data.open.length;
    $('#histCount').textContent = data.closed.length;
    renderSignals();
    renderHistory();
  }

  async function loadPrices() {
    try { applyPrices(await API.prices()); } catch { /* next tick */ }
  }

  function applyPrices(p) {
    if (!p?.values) return;
    state.prices = p.values;
    state.pricesAt = p.at;
    renderSignals();
    renderScanStatus();
  }

  function progressOf(sig, price) {
    if (!Number.isFinite(price)) return null;
    const span = sig.target - sig.stop;
    if (!span) return null;
    return Math.max(0, Math.min(1, (price - sig.stop) / span));
  }

  function probabilityBlock(sig) {
    if (sig.winProb == null) {
      return `<div class="prob unknown">
          <div class="prob-head"><span class="prob-label">Вероятность успеха</span><span class="prob-val">нет оценки</span></div>
          <div class="prob-note">Похожих завершённых сигналов пока ${sig.probSample ?? 0} — этого мало для честной цифры.</div>
        </div>`;
    }
    const pct = Math.round(sig.winProb * 100);
    const cls = pct >= 55 ? 'good' : pct >= 45 ? 'mid' : 'weak';
    const range = sig.probLow != null && sig.probHigh != null
      ? `${Math.round(sig.probLow * 100)}–${Math.round(sig.probHigh * 100)}%` : '—';
    const ev = sig.expectedR != null
      ? `<span class="${sig.expectedR >= 0 ? 'up' : 'down'}">${fmtR(sig.expectedR)}</span> в среднем на сделку` : '';
    return `<div class="prob ${cls}">
        <div class="prob-head"><span class="prob-label">Вероятность успеха</span><span class="prob-val">${pct}%</span></div>
        <div class="prob-bar"><div class="prob-fill" style="width:${pct}%"></div></div>
        <div class="prob-note">
          Доверительный интервал ${range} · по ${sig.probSample} похожим сигналам
          <span class="muted">(${esc(sig.probBasis === 'all' ? 'все сигналы' : sig.probBasis || '')})</span>
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
        const entryAt = long
          ? (s.entry - s.stop) / (s.target - s.stop)
          : (s.stop - s.entry) / (s.stop - s.target);
        liveRow = `
          <div class="live-row">
            <span class="live-price">${fmtPrice(price)}</span>
            <span class="live-pnl ${r >= 0 ? 'up' : 'down'}">${fmtR(r)}</span>
          </div>
          <div class="track">
            <div class="track-fill" style="width:${(pos * 100).toFixed(1)}%"></div>
            <div class="track-entry" style="left:${(entryAt * 100).toFixed(1)}%"></div>
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
        <div class="card-foot"><span>выдан ${fmtTime(s.createdAt)}</span><span>подробнее →</span></div>`;
      card.addEventListener('click', () => openChart(s));
      box.appendChild(card);
    }
  }

  /* ------------------------------ History ----------------------------- */
  function renderHistory() {
    const rows = state.closed;
    $('#historyEmpty').classList.toggle('hidden', rows.length > 0);
    $('#historyTable').classList.toggle('hidden', rows.length === 0);

    const withProb = rows.filter((s) => s.winProb != null);
    const claimed = withProb.length ? withProb.reduce((a, s) => a + s.winProb, 0) / withProb.length : null;
    const actual = rows.length ? rows.filter((s) => s.r > 0).length / rows.length : null;
    const replayed = rows.filter((s) => s.origin === 'replay').length;
    const replayNote = replayed
      ? ` Из них ${replayed} восстановлены по прошлым свечам (<span class="tag replay">реплей</span>) — они не считаются живым результатом.`
      : '';
    $('#calibration').innerHTML = withProb.length
      ? `Заявленная вероятность в среднем <b>${fmtProb(claimed)}</b>, фактический результат
         <b>${fmtProb(actual)}</b> на ${rows.length} закрытых сигналах.${replayNote}`
      : `Закрытых сигналов: ${rows.length}. Оценок вероятности среди них пока нет.${replayNote}`;

    $('#historyTable tbody').innerHTML = rows.map((s) => {
      const o = OUTCOME[s.status] || { label: s.status, cls: 'neutral' };
      const rCls = s.r > 0 ? 'up' : s.r < 0 ? 'down' : '';
      const replay = s.origin === 'replay'
        ? ' <span class="tag replay" title="Восстановлен по прошлым свечам">реплей</span>' : '';
      return `<tr>
        <td><b>${esc(s.symbol)}</b>${replay}</td>
        <td><span class="dir ${s.direction}">${s.direction === 'LONG' ? 'ЛОНГ' : 'ШОРТ'}</span></td>
        <td><span class="badge ${o.cls}">${o.label}</span></td>
        <td class="num">${fmtPrice(s.entry)}</td>
        <td class="num">${fmtPrice(s.exit)}</td>
        <td class="num ${rCls}">${fmtR(s.r)}</td>
        <td class="num">${s.winProb == null ? '—' : fmtProb(s.winProb)}</td>
        <td class="num">${s.score}</td>
        <td>${fmtTime(s.exitTime)}</td>
      </tr>`;
    }).join('');
  }

  /* ------------------------------- Market ----------------------------- */
  async function loadMarket() {
    state.market = await API.market();
    $('#marketTable tbody').innerHTML = state.market.map((m) => {
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
    const pf = stats.profitFactor == null ? '—'
      : (stats.profitFactor === Infinity || stats.profitFactor === null ? '∞' : fmtNum(stats.profitFactor));
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
    const s = await API.stats();
    const minSample = s.minSample ?? 20;

    $('#liveStats').innerHTML = metricsHtml(s.live, minSample,
      'Ни один сигнал ещё не закрылся. Пока сделок нет, показывать здесь нечего — и придумывать цифры мы не будем.');

    const rows = s.backtest.perSymbol || [];
    let portfolio = s.backtest.portfolio;
    if (!portfolio) {
      const t = rows.reduce((acc, r) => {
        const st = r.stats;
        if (!st || !st.trades) return acc;
        acc.trades += st.trades; acc.wins += st.wins; acc.totalR += st.totalR;
        acc.grossWin += st.grossWinR || 0; acc.grossLoss += st.grossLossR || 0;
        acc.maxDrawdownR = Math.max(acc.maxDrawdownR, st.maxDrawdownR);
        return acc;
      }, { trades: 0, wins: 0, totalR: 0, maxDrawdownR: 0, grossWin: 0, grossLoss: 0 });
      portfolio = t.trades ? {
        trades: t.trades, wins: t.wins, winRate: t.wins / t.trades,
        avgR: t.totalR / t.trades, totalR: t.totalR, maxDrawdownR: t.maxDrawdownR,
        profitFactor: t.grossLoss > 0 ? t.grossWin / t.grossLoss : null,
        reliable: t.trades >= minSample,
      } : null;
    }

    $('#btStats').innerHTML = metricsHtml(portfolio, minSample,
      'Бэктест ещё не считался.');

    $('#btTable tbody').innerHTML = rows.map((r) => {
      const st = r.stats || {};
      const pf = st.profitFactor == null ? '—' : fmtNum(st.profitFactor);
      return `<tr>
        <td><b>${esc(r.symbol)}</b></td>
        <td class="num">${st.trades ?? 0}</td>
        <td class="num">${st.winRate == null ? '—' : (st.winRate * 100).toFixed(1) + '%'}</td>
        <td class="num ${st.avgR >= 0 ? 'up' : 'down'}">${fmtR(st.avgR)}</td>
        <td class="num">${pf}</td>
        <td class="num ${st.totalR >= 0 ? 'up' : 'down'}">${fmtNum(st.totalR, 1)}R</td>
        <td class="num down">−${fmtNum(st.maxDrawdownR, 1)}R</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">Бэктест ещё не считался.</td></tr>';

    // The static build ships the time-segment verdict inside stats.json.
    if (state.mode === 'static' && s.timeline) {
      state.staticTimeline = { timeline: s.timeline, consistency: s.consistency };
    }
  }

  /* ----------------------------- Validation --------------------------- */
  const VERDICT = {
    consistent: { cls: 'ok', label: 'Стабильно во времени' },
    concentrated: { cls: 'bad', label: 'Результат сделан одним периодом' },
    mixed: { cls: 'warn', label: 'Смешанно' },
    weak: { cls: 'bad', label: 'Неустойчиво' },
    robust: { cls: 'ok', label: 'Устойчиво к настройкам' },
    fragile: { cls: 'bad', label: 'Похоже на подгонку' },
    unknown: { cls: 'neutral', label: 'Данных не хватает' },
  };

  function timelineTable(timeline) {
    return (timeline || []).map((s) => `
      <tr>
        <td>${fmtTime(s.from)} — ${fmtTime(s.to)}</td>
        <td class="num">${s.stats.trades}</td>
        <td class="num">${s.stats.winRate == null ? '—' : (s.stats.winRate * 100).toFixed(0) + '%'}</td>
        <td class="num ${s.stats.totalR >= 0 ? 'up' : 'down'}">${fmtNum(s.stats.totalR, 1)}R</td>
      </tr>`).join('');
  }

  function renderValidation(report) {
    const box = $('#validation');
    const fallback = state.staticTimeline;

    if (!report && fallback) {
      const c = VERDICT[fallback.consistency?.verdict] || VERDICT.unknown;
      box.innerHTML = `
        <div class="verdict">
          <div class="verdict-head"><span class="badge ${c.cls}">${c.label}</span></div>
          <p>${esc(fallback.consistency?.text || '')}</p>
          <table class="grid mini">
            <thead><tr><th>Отрезок</th><th class="num">Сделок</th><th class="num">Винрейт</th><th class="num">Сумма</th></tr></thead>
            <tbody>${timelineTable(fallback.timeline)}</tbody>
          </table>
        </div>
        <p class="muted small">Проверка устойчивости к параметрам считается отдельно, раз в неделю — она тяжёлая.</p>`;
      return;
    }
    if (!report) {
      box.innerHTML = '<div class="low-sample">Проверка ещё не запускалась.</div>';
      return;
    }

    const c = VERDICT[report.consistency?.verdict] || VERDICT.unknown;
    const r = VERDICT[report.robustness?.verdict] || VERDICT.unknown;
    box.innerHTML = `
      <div class="verdicts">
        <div class="verdict">
          <div class="verdict-head"><span class="badge ${c.cls}">${c.label}</span></div>
          <p>${esc(report.consistency?.text || '')}</p>
          <table class="grid mini">
            <thead><tr><th>Отрезок</th><th class="num">Сделок</th><th class="num">Винрейт</th><th class="num">Сумма</th></tr></thead>
            <tbody>${timelineTable(report.timeline)}</tbody>
          </table>
        </div>
        <div class="verdict">
          <div class="verdict-head"><span class="badge ${r.cls}">${r.label}</span></div>
          <p>${esc(report.robustness?.text || '')}</p>
          <p class="muted small">
            Проверено ${report.grid?.length || 0} наборов порогов. Лучшая ячейка намеренно не
            предлагается как настройка: выбирать максимум по той же истории — и есть подгонка.
          </p>
        </div>
      </div>
      <p class="muted small">Проверка от ${fmtTime(report.storedAt || report.createdAt)} · источник ${esc(report.source)}</p>`;
  }

  async function loadValidation() {
    try { renderValidation(await API.validation()); }
    catch { renderValidation(null); }
  }

  /* ------------------------------ Actions ----------------------------- */
  function bindAction(id, path, busyLabel, after) {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = busyLabel;
      try { await fetch(path, { method: 'POST' }); await after(); }
      finally { btn.disabled = false; btn.textContent = original; }
    });
  }
  bindAction('#runBacktest', '/api/backtest/run', 'Считаю…', loadStats);
  bindAction('#runValidation', '/api/validation/run', 'Проверяю…', loadValidation);
  bindAction('#scanNow', '/api/scan', 'Сканирую…', async () => {
    await Promise.all([loadStatus(), loadSignals(), loadPrices()]);
  });

  /* -------------------------------- Chart ----------------------------- */
  async function openChart(sig) {
    $('#chartModal').classList.remove('hidden');
    $('#chartTitle').textContent = `${sig.symbol} · ${sig.direction === 'LONG' ? 'Лонг' : 'Шорт'}`;
    const probText = sig.winProb == null ? 'вероятность не оценена'
      : `вероятность ${fmtProb(sig.winProb)} (по ${sig.probSample} похожим)`;
    $('#chartSub').textContent =
      `Вход ${fmtPrice(sig.entry)} · фиксировать убыток ${fmtPrice(sig.stop)} · прибыль ${fmtPrice(sig.target)} · ${probText}`;
    $('#chartLegend').innerHTML = sig.reasons.map((r) => `<span class="legend-item">✓ ${esc(r.text)}</span>`).join('');

    const box = $('#chartBox');
    box.innerHTML = '';
    if (window.__noChart || !window.LightweightCharts) {
      box.innerHTML = '<div class="empty">График недоступен: библиотека не загрузилась.</div>';
      return;
    }

    let candles;
    try {
      ({ candles } = await API.candles(sig.symbol, sig.timeframe, 200));
    } catch {
      box.innerHTML = '<div class="empty">Не удалось загрузить свечи.</div>';
      return;
    }

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
    if (state.mode !== 'live') return;
    const es = new EventSource('/api/events');
    es.addEventListener('signal:new', () => loadSignals());
    es.addEventListener('signal:resolved', () => loadSignals());
    es.addEventListener('prices', (e) => { try { applyPrices(JSON.parse(e.data)); } catch {} });
    es.addEventListener('scan:done', (e) => {
      try { state.status.scan = JSON.parse(e.data); renderScanStatus(); } catch {}
    });
    es.onerror = () => {};
  }

  /* -------------------------------- Init ------------------------------ */
  (async function init() {
    try {
      await loadStatus();
    } catch {
      // Before the first scheduled scan there is simply nothing to read yet.
      // Say that, rather than implying something is broken.
      $('#modeBanner').className = 'banner';
      $('#modeBanner').innerHTML =
        '<b>Данных пока нет.</b> Первый плановый скан ещё не отработал — он запускается ' +
        'в GitHub Actions и коммитит результат в <code>data/</code>. ' +
        'Можно запустить его вручную: Actions → «Скан рынка» → Run workflow.';
      $('#modeBanner').classList.remove('hidden');
      $('#openEmpty').classList.remove('hidden');
      return;
    }
    // A missing section must not take the whole page down with it.
    for (const load of [loadSignals, loadMarket, loadPrices]) {
      try { await load(); } catch { /* section stays empty */ }
    }
    connectFeed();

    setInterval(loadPrices, state.mode === 'static' ? 15_000 : 30_000);
    setInterval(loadSignals, 60_000);
    setInterval(loadStatus, 180_000);
  })();
})();
