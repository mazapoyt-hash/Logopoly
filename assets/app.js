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
    prices: {}, pricesAt: null, priceSource: null, chart: null, analytics: null,
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
  const fmtAge = (mins) => {
    if (mins < 60) return `${mins} мин`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  };
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
    // The deep report is produced by a scheduled job and committed as a file;
    // the server build reads the same file rather than recomputing it.
    analytics: () => getJson('data/analytics.json').catch(() => null),
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
    analytics: () => getJson('data/analytics.json').catch(() => null),

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
      if (tab.dataset.view === 'analytics') loadAnalytics();
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
      /*
       * GitHub drops scheduled runs, and on this repository it drops most of
       * them: measured over the first 9.5 hours, 1 scheduled run out of ~35
       * slots actually fired. So this banner is not an edge case, it is the
       * normal way the user finds out — the threshold is two missed hourly
       * slots, past which the data is genuinely behind rather than merely late.
       */
      const stale = mins != null && mins > 150;
      modeBanner.className = 'banner' + (stale ? ' error' : '');
      modeBanner.innerHTML = stale
        ? `<b>Данные устарели:</b> последний пересчёт был ${fmtAge(mins)} назад. ` +
          'Плановый прогон в GitHub Actions, видимо, не отработал — сигналы ниже могли ' +
          'уже закрыться. Запустить вручную: Actions → «Скан рынка» → Run workflow.'
        : `<b>Сайт работает без сервера.</b> Сигналы пересчитываются по расписанию в GitHub Actions` +
          (mins == null ? '' : `, последний прогон ${mins < 1 ? 'только что' : fmtAge(mins) + ' назад'}`) +
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

    renderEdgeWarning(portfolio, s.live, minSample);
  }

  /**
   * The signals tab is the one people actually look at, and a card with an
   * entry, a stop and a target reads as a recommendation. If the measured
   * result of this same logic is negative, that has to be visible there — not
   * buried on the statistics tab behind a click nobody makes.
   */
  function renderEdgeWarning(backtest, live, minSample) {
    const box = $('#edgeWarning');
    if (!box) return;

    const bad = (st) => st && st.trades > 0 &&
      (st.totalR < 0 || (st.profitFactor != null && st.profitFactor < 1));

    const parts = [];
    if (bad(backtest)) {
      parts.push(`на истории (${backtest.trades} сделок) — ${fmtR(backtest.totalR)} суммарно` +
        (backtest.profitFactor == null ? '' : `, profit factor ${fmtNum(backtest.profitFactor)}`));
    }
    if (bad(live)) {
      parts.push(`по выданным сигналам (${live.trades} шт.) — ${fmtR(live.totalR)} суммарно`);
    }

    if (!parts.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    const thin = backtest && backtest.trades < minSample;
    box.innerHTML =
      '<b>Измеренное преимущество отрицательное.</b> ' +
      `Эта же логика в проверке даёт минус: ${parts.join('; ')}. ` +
      'Сигналы ниже показаны как есть — они не «отобранные удачные», а всё, ' +
      'что выдал движок. Торговать по ним сейчас значит терять деньги.' +
      (thin ? ` Выборка при этом мала (меньше ${minSample} сделок), так что и сам минус ещё не доказан.` : '') +
      ' Подробности — на вкладке «Статистика».';
    box.classList.remove('hidden');
  }

  /* ----------------------------- Analytics ---------------------------- */
  const pctOf = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%');
  const signCls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');

  function mcHtml(mc) {
    if (!mc || !mc.tested) {
      return '<div class="low-sample">Групп, набравших достаточную выборку, пока нет.</div>';
    }
    /*
     * The measured floor beats the arithmetic one wherever they disagree, and
     * they do: the 5% rule assumes independent trades, and consecutive trades
     * share a market regime. So the verdict is decided by what the pipeline
     * actually reports on data with no relationship in it.
     */
    const m = mc.measured;
    const clears = m ? mc.flagged > m.p95 : mc.surplus > 2;
    const cls = clears ? 'ok' : 'bad';
    const label = clears ? 'Выше уровня шума' : 'В пределах шума';
    const verdict = m
      ? (clears
        ? `Найдено ${mc.flagged} групп при измеренном потолке шума ${fmtNum(m.p95, 1)} ` +
          `(95-й процентиль по ${m.replicates} прогонам на данных, где связи нет по построению). ` +
          'Это повод изучить разрезы ниже — но не основание торговать: находку ещё нужно ' +
          'проверить на данных, по которым её не искали.'
        : `Найдено ${mc.flagged} групп, а тот же конвейер на данных без всякой связи выдаёт ` +
          `до ${fmtNum(m.p95, 1)} (медиана ${fmtNum(m.median, 1)}, максимум ${fmtNum(m.max, 1)}). ` +
          'Найденное не выходит за пределы шума. Читать отдельные группы ниже как открытия — ' +
          'значит обманывать себя.')
      : 'Уровень шума ещё не измерен — выборки не хватает.';
    const arith = m
      ? `<p class="muted small">Арифметическая оценка «5% от ${mc.tested} групп» дала бы
         ${fmtNum(mc.expected, 1)}. Измеренная выше, потому что сделки не независимы:
         соседние идут в одном рыночном режиме. Верить надо измеренной.</p>`
      : '';
    /*
     * The control dimension is the sharpest reading available, and it is a
     * comparison of RATES, not counts: day of week cannot possibly drive
     * results, so however often it flags is the noise floor. A real dimension
     * has to beat that floor to mean anything — and if it does not, no amount
     * of confidence intervals makes its flags into findings.
     */
    const all = state.analytics?.breakdowns || [];
    const ctl = all.find((b) => b.key === 'weekday');
    let control = '';
    if (ctl?.tested) {
      const rest = all.filter((b) => b.key !== 'weekday');
      const restTested = rest.reduce((s, b) => s + b.tested, 0);
      const restFlagged = rest.reduce((s, b) => s + b.flagged, 0);
      const ctlRate = ctl.flagged / ctl.tested;
      const restRate = restTested ? restFlagged / restTested : 0;
      const beats = restRate > ctlRate * 1.5;
      control =
        `<p class="analytics-note"><b>Контроль — день недели.</b> Связи между днём недели и ` +
        `результатом быть не может, поэтому как часто помечается он — это и есть уровень шума. ` +
        `Контроль: ${ctl.flagged} из ${ctl.tested} (${pctOf(ctlRate, 0)}). ` +
        `Остальные разрезы: ${restFlagged} из ${restTested} (${pctOf(restRate, 0)}). ` +
        (beats
          ? 'Осмысленные разрезы помечаются заметно чаще контрольного — значит, там есть что изучать.'
          : '<b>Осмысленные разрезы помечаются не чаще заведомо бессмысленного.</b> ' +
            'Это значит, что ни одна из групп ниже не выделяется сильнее, чем выделяется чистый шум. ' +
            'Читать их как открытия нельзя.') +
        '</p>';
    }
    return `
      <div class="mc-row">
        <div class="metric"><div class="k">Проверено групп</div><div class="v">${mc.tested}</div></div>
        <div class="metric"><div class="k">Найдено</div><div class="v">${mc.flagged}</div></div>
        <div class="metric"><div class="k">Потолок шума</div>
          <div class="v">${m ? fmtNum(m.p95, 1) : '—'}</div>
          <div class="note">измерено, 95-й процентиль</div></div>
        <div class="metric"><div class="k">Медиана шума</div>
          <div class="v">${m ? fmtNum(m.median, 1) : '—'}</div></div>
      </div>
      <div class="verdict-head"><span class="badge ${cls}">${label}</span></div>
      <p class="analytics-note">${verdict}</p>${arith}${control}`;
  }

  function randomEntryHtml(re) {
    if (!re) return '<div class="low-sample">Сравнение со случайными входами не считалось.</div>';
    const V = { beats: ['ok', 'Входы лучше случайных'], same: ['bad', 'Входы неотличимы от случайных'],
      worse: ['bad', 'Входы хуже случайных'] };
    const [cls, label] = V[re.verdict] || ['neutral', '—'];
    return `
      <div class="verdict-head"><span class="badge ${cls}">${label}</span></div>
      <div class="mc-row">
        <div class="metric"><div class="k">Стратегия</div>
          <div class="v ${signCls(re.real.avgR)}">${fmtR(re.real.avgR)}</div>
          <div class="note">винрейт ${pctOf(re.real.winRate, 0)}</div></div>
        <div class="metric"><div class="k">Случайные входы</div>
          <div class="v ${signCls(re.nullModel.p50)}">${fmtR(re.nullModel.p50)}</div>
          <div class="note">медиана; винрейт ${pctOf(re.nullModel.medianWinRate, 0)}</div></div>
        <div class="metric"><div class="k">Разброс случайных</div>
          <div class="v">${fmtNum(re.nullModel.p05)} … ${fmtNum(re.nullModel.p95)}</div>
          <div class="note">5–95%, ${re.replicates} прогонов</div></div>
        <div class="metric"><div class="k">Процентиль</div>
          <div class="v">${(re.percentile * 100).toFixed(0)}</div>
          <div class="note">место среди случайных</div></div>
      </div>
      <p class="analytics-note">${esc(re.text)}</p>`;
  }

  function costsHtml(c) {
    if (!c) return '<div class="low-sample">Расчёт по издержкам не делался.</div>';
    const rows = c.rows.map((r) => `
      <tr${r.label === 'Текущие' ? ' class="current"' : ''}>
        <td>${esc(r.label)}</td>
        <td class="num ${signCls(r.avgR)}">${fmtR(r.avgR)}</td>
        <td class="num ${signCls(r.totalR)}">${fmtNum(r.totalR, 1)}R</td>
        <td class="num opt">${pctOf(r.winRate, 0)}</td>
      </tr>`).join('');
    return `
      <p class="analytics-note">${esc(c.text || '')}</p>
      <div class="table-wrap">
        <table class="grid mini">
          <thead><tr><th>Уровень издержек</th><th class="num">Средний R</th>
            <th class="num">Сумма</th><th class="num opt">Винрейт</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function vaultHtml(v) {
    if (!v) return '<div class="low-sample">Сейф в этом отчёте не заведён.</div>';
    const times = v.opened ? v.timesOpenedBefore + 1 : v.timesOpenedBefore;
    // The count is the whole point: a vault opened once is a fair test, opened
    // repeatedly it is a training set that still calls itself a holdout.
    const cls = times === 0 ? 'ok' : times === 1 ? 'warn' : 'bad';
    const label = times === 0 ? 'Запечатан'
      : times === 1 ? 'Открыт один раз' : `Открыт ${times} раз(а) — израсходован`;
    let body;
    if (v.opened && v.result) {
      const r = v.result;
      body = `
        <div class="mc-row">
          <div class="metric"><div class="k">Сделок</div><div class="v">${r.trades}</div></div>
          <div class="metric"><div class="k">Средний R</div>
            <div class="v ${signCls(r.avgR)}">${fmtR(r.avgR)}</div></div>
          <div class="metric"><div class="k">Сумма</div>
            <div class="v ${signCls(r.totalR)}">${fmtNum(r.totalR, 1)}R</div></div>
          <div class="metric"><div class="k">Винрейт</div><div class="v">${pctOf(r.winRate, 0)}</div></div>
        </div>
        <p class="analytics-note">${times > 1
          ? 'Открывается не впервые. Как честная проверка «на невиданных данных» сейф уже израсходован: ' +
            'решения принимались с оглядкой на прошлые открытия.'
          : 'Открыт впервые — это и есть та единственная честная проверка, ради которой он лежал закрытым.'}</p>`;
    } else {
      body = `<p class="analytics-note">Последние 20% истории не участвуют ни в одном числе на этой
        вкладке. ${times > 0 ? `Ранее сейф открывали ${times} раз(а), и это уже снизило его ценность.`
          : 'Ни разу не открывался.'}</p>`;
    }
    return `<div class="verdict-head"><span class="badge ${cls}">${label}</span></div>${body}`;
  }

  function bucketRows(b) {
    return b.buckets.map((x) => {
      const ci = x.avgLow == null ? '—'
        : `${fmtR(x.avgR)} <span class="ci">${fmtNum(x.avgLow)} … ${fmtNum(x.avgHigh)}</span>`;
      const win = x.winLow == null ? pctOf(x.winRate)
        : `${pctOf(x.winRate, 0)} <span class="ci">${pctOf(x.winLow, 0)} … ${pctOf(x.winHigh, 0)}</span>`;
      return `<tr class="${x.enough ? '' : 'thin'}">
        <td>${esc(String(x.key))}${x.significant
          ? ` <span class="flag" title="Отличается от остальных групп на ${fmtR(x.vsRest)} на сделку">⚑</span>` : ''}</td>
        <td class="num">${x.trades}</td>
        <td class="num">${win}</td>
        <td class="num ${signCls(x.avgR)}">${ci}</td>
        <td class="num opt ${signCls(x.totalR)}">${fmtNum(x.totalR, 1)}R</td>
      </tr>`;
    }).join('');
  }

  function renderBreakdowns(list, minBucket) {
    $('#breakdowns').innerHTML = list.map((b) => `
      <div class="panel">
        <h2>${esc(b.label)}</h2>
        <p class="panel-sub">${esc(b.question)}</p>
        <div class="table-wrap">
          <table class="grid mini">
            <thead><tr>
              <th>Группа</th><th class="num">Сделок</th><th class="num">Винрейт</th>
              <th class="num">Средний R</th><th class="num opt">Сумма</th>
            </tr></thead>
            <tbody>${bucketRows(b)}</tbody>
          </table>
        </div>
        <p class="muted small">
          Серым под числом — 95% доверительный интервал: с такой выборкой истина лежит где-то там.
          ⚑ означает, что группа отличается <b>от остальных групп</b>, а не просто отличается от нуля:
          иначе при общем минусе помечалось бы почти всё подряд.
          Групп с достаточной выборкой: ${b.tested}. Помечено ⚑: ${b.flagged}.
          Случайность дала бы ${fmtNum(b.expectedByChance, 1)}.
          Строки бледнее — меньше ${minBucket} сделок, они показаны для полноты и ничего не доказывают.
        </p>
      </div>`).join('');
  }

  function excursionHtml(e) {
    if (!e) return '<div class="low-sample">Данных о ходе цены нет.</div>';
    const rows = e.reach.map((l) => `
      <tr><td>+${l.level}R</td>
        <td class="num">${pctOf(l.all, 0)}</td>
        <td class="num">${pctOf(l.losers, 0)}</td></tr>`).join('');
    // The diagnosis, stated plainly, because this is the one table that says
    // WHY the win rate is what it is.
    const near = e.medianLoserMfeR != null && e.medianLoserMfeR >= e.currentTargetR * 0.6;
    const diagnosis = near
      ? `Убыточные сделки в среднем доходили до ${fmtNum(e.medianLoserMfeR)}R при цели ` +
        `${fmtNum(e.currentTargetR)}R — то есть цена шла в нашу сторону и разворачивалась ` +
        'у самой цели. Проблема в выходе, а не во входе.'
      : `Убыточные сделки доходили в среднем лишь до ${fmtNum(e.medianLoserMfeR)}R при цели ` +
        `${fmtNum(e.currentTargetR)}R — цена почти не шла в нашу сторону. Это проблема входа, ` +
        'и переносом цели она не лечится.';
    return `
      <div class="mc-row">
        <div class="metric"><div class="k">Медианный максимум</div><div class="v">${fmtNum(e.medianMfeR)}R</div>
          <div class="note">по всем сделкам</div></div>
        <div class="metric"><div class="k">У убыточных</div><div class="v">${fmtNum(e.medianLoserMfeR)}R</div>
          <div class="note">насколько дошли до цели</div></div>
        <div class="metric"><div class="k">Просадка выигрышных</div><div class="v">${fmtNum(e.medianWinnerMaeR)}R</div>
          <div class="note">медиана; 90-й перцентиль ${fmtNum(e.p90WinnerMaeR)}R</div></div>
        <div class="metric"><div class="k">Цель сейчас</div><div class="v">${fmtNum(e.currentTargetR)}R</div></div>
      </div>
      <p class="analytics-note">${diagnosis}</p>
      <div class="table-wrap">
        <table class="grid mini">
          <thead><tr><th>Дошла до</th><th class="num">Все</th><th class="num">Убыточные</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="muted small">
        Колонка «все сделки» занижена по построению: выигрышная сделка закрывается на цели,
        и куда цена пошла бы дальше — неизвестно. Честный ответ на вопрос «а если цель
        подвинуть» даёт не эта таблица, а перезапуск стратегии с другой целью — он ниже,
        в блоке подбора настроек.
      </p>`;
  }

  function calibrationHtml(c) {
    if (!c || !c.sample) {
      return '<div class="low-sample">Закрытых сигналов с заявленной вероятностью пока нет. ' +
        'Проверять калибровку не на чем — и выдумывать её мы не будем.</div>';
    }
    const V = { calibrated: ['ok', 'Заявленное совпадает с фактом'],
      mixed: ['warn', 'Совпадает не везде'], off: ['bad', 'Заявленное не подтверждается'],
      unknown: ['neutral', 'Выборки не хватает'] };
    const [cls, label] = V[c.verdict] || V.unknown;
    const rows = c.rows.map((r) => `
      <tr class="${r.trades >= c.minBucket ? '' : 'thin'}">
        <td>${esc(r.key)}</td>
        <td class="num">${r.trades}</td>
        <td class="num">${pctOf(r.stated, 0)}</td>
        <td class="num">${pctOf(r.actual, 0)}${r.low == null ? ''
          : ` <span class="ci">${pctOf(r.low, 0)} … ${pctOf(r.high, 0)}</span>`}</td>
        <td>${r.consistent === null ? '<span class="muted">мало данных</span>'
          : r.consistent ? '<span class="up">сходится</span>' : '<span class="down">не сходится</span>'}</td>
      </tr>`).join('');
    return `
      <div class="verdict-head"><span class="badge ${cls}">${label}</span></div>
      <div class="table-wrap">
        <table class="grid mini">
          <thead><tr><th>Заявляли</th><th class="num">Сигналов</th><th class="num">Обещано</th>
            <th class="num">Вышло (95% ДИ)</th><th>Итог</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="muted small">Всего закрытых сигналов с оценкой: ${c.sample}.
        Строка считается проверенной от ${c.minBucket} сигналов.</p>`;
  }

  function tuningHtml(t) {
    if (!t) return '<div class="low-sample">Подбор не запускался.</div>';
    const V = { holds: ['ok', 'Улучшение сохранилось'], decays: ['bad', 'Улучшение не пережило проверку'],
      nothing: ['bad', 'Подбирать нечего'], unknown: ['neutral', 'Судить не о чем'] };
    const [cls, label] = V[t.verdict] || V.unknown;
    const p = t.best?.params;
    const cmp = (a, b) => `
      <tr><td>${esc(a)}</td>
        <td class="num ${signCls(b?.in)}">${b?.in == null ? '—' : b.fmt(b.in)}</td>
        <td class="num ${signCls(b?.out)}">${b?.out == null ? '—' : b.fmt(b.out)}</td></tr>`;
    const bi = t.best?.inSample;
    const bo = t.best?.outOfSample;
    const table = !bi ? '' : `
      <div class="table-wrap">
        <table class="grid mini">
          <thead><tr><th>Метрика</th>
            <th class="num">Обучающая</th><th class="num">Проверочная</th></tr></thead>
          <tbody>
            ${cmp('Сделок', { in: bi.trades, out: bo?.trades, fmt: (v) => v })}
            ${cmp('Винрейт', { in: bi.winRate, out: bo?.winRate, fmt: (v) => pctOf(v, 0) })}
            ${cmp('Средний R', { in: bi.avgR, out: bo?.avgR, fmt: (v) => fmtR(v) })}
            ${cmp('Сумма', { in: bi.totalR, out: bo?.totalR, fmt: (v) => fmtNum(v, 1) + 'R' })}
          </tbody>
        </table>
      </div>`;
    const params = p ? `<p class="muted small">Набор: score ≥ ${p.minScore}, стоп ${p.atrStopMult}×ATR,
      соотношение 1:${p.rewardRisk}. Рассмотрено наборов: ${t.cellsConsidered}.
      Он намеренно НЕ применяется как настройка — именно это превращает подбор в подгонку.</p>` : '';
    return `
      <div class="verdict-head"><span class="badge ${cls}">${label}</span></div>
      <p class="analytics-note">${esc(t.text)}</p>
      ${table}${params}`;
  }

  async function loadAnalytics() {
    const box = $('#analyticsBody');
    const empty = $('#analyticsEmpty');
    let rep = null;
    try { rep = await API.analytics(); } catch { rep = null; }

    if (!rep || !rep.overall) {
      box.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    box.classList.remove('hidden');
    // Stored before rendering: the multiple-comparisons panel reads the control
    // dimension out of the same report to say how loose the flagging is.
    state.analytics = rep;

    $('#randomEntryBox').innerHTML = randomEntryHtml(rep.randomEntry);
    $('#costsBox').innerHTML = costsHtml(rep.costs);
    $('#vaultBox').innerHTML = vaultHtml(rep.vault);
    $('#mcBox').innerHTML = mcHtml(rep.multipleComparisons);
    $('#tuningBox').innerHTML = tuningHtml(rep.tuning);
    $('#excursionBox').innerHTML = excursionHtml(rep.excursions);
    $('#calibrationBox').innerHTML = calibrationHtml(rep.calibration);
    renderBreakdowns(rep.breakdowns || [], rep.minBucket ?? 25);

    const s = rep.sample || {};
    $('#analyticsMeta').textContent =
      `Отчёт от ${fmtTime(rep.generatedAt)} · период ${fmtTime(s.from)} — ${fmtTime(s.to)} · ` +
      `${s.trades} сделок на ${(rep.history?.quality || []).length || '—'} монетах ` +
      `по ${(rep.history?.quality?.[0]?.bars ?? '—')} свечей.`;
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
    // loadStats runs here, not only when the statistics tab is opened, because
    // the negative-edge warning on the signals tab is computed from it.
    for (const load of [loadSignals, loadMarket, loadPrices, loadStats]) {
      try { await load(); } catch { /* section stays empty */ }
    }
    connectFeed();

    setInterval(loadPrices, state.mode === 'static' ? 15_000 : 30_000);
    setInterval(loadSignals, 60_000);
    setInterval(loadStatus, 180_000);
  })();
})();
