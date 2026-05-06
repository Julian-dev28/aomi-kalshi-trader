// agent.js — full auto-cycle loop, verdict detection, trade execution, trade log
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var HOLD_MS = 900000;   // 15 min
  var SCAN_MS = 300000;   //  5 min

  var HL_TOOL_LABELS = {
    get_all_mids:            'Fetching price',
    get_l2_book:             'Order book depth',
    get_clearinghouse_state: 'Reading position',
    get_open_orders:         'Open orders',
    get_user_fills:          'Trade history',
    get_funding_history:     'Funding rate',
    get_candle_snapshot:     'Candle data',
    get_meta:                'Exchange info',
    brave_search:            'Web search',
  };

  var AUTO_PROMPT = 'You are evaluating a BTC-PERP swing trade. Call tools in this order:\n' +
    '1. get_clearinghouse_state — CHECK IF IN A POSITION FIRST. Note side, size, entry price, unrealized PnL.\n' +
    '2. get_candle_snapshot interval="4h" count=8 — 4h trend structure (this is the anchor — determine uptrend/downtrend/ranging)\n' +
    '3. get_candle_snapshot interval="1h" count=12 — 1h momentum and entry/exit timing\n' +
    '4. get_l2_book — bid vs ask pressure and depth\n' +
    '5. get_all_mids — confirm current BTC price\n' +
    '6. get_funding_history — funding rate (extreme rates affect hold cost)\n\n' +
    'Decision rules:\n' +
    '- If IN A POSITION: default is PASS (hold). Only output CLOSE if 4h structure has clearly broken or hard stop hit.\n' +
    '- If FLAT: only enter if 4h trend is unambiguous AND 1h setup is clean. Otherwise PASS.\n' +
    '- Never close based on short-term noise. Let the 4h trend be your guide.';

  // ── State ──────────────────────────────────────────────────────────────────
  var btcPrice   = null;
  var account    = null;
  var autoMode   = false;
  var processing = false;
  var autoCycles = 0;
  var tradesPlaced = 0;
  var riskPct    = 5;
  var leverage   = 5;
  var lastVerdict = null;
  var tradeLog   = [];
  var openTrade  = null;
  var lastAnalysis = 0;
  var lastTraded   = 0;
  var autoWaitUntil = 0;
  var autoWaitLabel = '';
  var mounted    = false;
  var abortCtrl  = null;
  var autoLoopId = null;
  var autoLoopCancelled = false;
  var editingRisk = false;

  // ── sessionStorage helpers ─────────────────────────────────────────────────
  function ss(k, v) {
    if (v === undefined) {
      try { return sessionStorage.getItem(k); } catch(e) { return null; }
    }
    try { sessionStorage.setItem(k, String(v)); } catch(e) {}
  }
  function ssJson(k, v) {
    if (v === undefined) {
      try { var s = sessionStorage.getItem(k); return s ? JSON.parse(s) : null; } catch(e) { return null; }
    }
    try { sessionStorage.setItem(k, JSON.stringify(v)); } catch(e) {}
  }
  function ls(k, v) {
    if (v === undefined) {
      try { return localStorage.getItem(k); } catch(e) { return null; }
    }
    try { localStorage.setItem(k, String(v)); } catch(e) {}
  }

  // ── Session ID ─────────────────────────────────────────────────────────────
  var env = (window.location.hostname === 'localhost') ? 'local' : 'prod';
  var sessionKey = 'aomi-agent-session-' + env;
  var sessionId = ls(sessionKey);
  if (!sessionId) {
    sessionId = genUUID();
    ls(sessionKey, sessionId);
  }

  function genUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, function () {
      return (Math.random() * 16 | 0).toString(16);
    });
  }

  // ── Load persisted state ───────────────────────────────────────────────────
  function loadState() {
    var storedRisk = ls('aomi-risk-pct');
    if (storedRisk) riskPct = Number(storedRisk);
    var storedLev = ls('aomi-leverage');
    if (storedLev) leverage = Number(storedLev);

    var storedAuto = ss('aomi-auto');
    if (storedAuto === '1') autoMode = true;

    var storedCycles = ss('aomi-auto-cycles');
    if (storedCycles) autoCycles = Number(storedCycles);
    var storedTrades = ss('aomi-trades-placed');
    if (storedTrades) tradesPlaced = Number(storedTrades);
    lastAnalysis = Number(ss('aomi-last-analysis') || 0);
    lastTraded   = Number(ss('aomi-last-traded')   || 0);

    var storedVerdict = ss('aomi-last-verdict');
    if (storedVerdict) lastVerdict = storedVerdict;

    var storedLog = ssJson('aomi-trade-log');
    if (storedLog) tradeLog = storedLog;

    openTrade = ssJson('aomi-open-trade');

    // Reconcile: if openTrade loaded but not in tradeLog, add it
    if (openTrade && tradeLog.length === 0) {
      tradeLog = [openTrade];
    }
    // If openTrade exists and IS in tradeLog, ensure it's the last open one
    if (openTrade && tradeLog.length > 0 && !tradeLog.find(function (t) { return t.id === openTrade.id; })) {
      tradeLog.push(openTrade);
    }

    var storedText = ss('aomi-last-analysis-text');
    if (storedText) {
      lastAnalysisText = storedText;
    }

    mounted = true;
  }

  var lastAnalysisText = null;

  // ── UI update helpers ──────────────────────────────────────────────────────
  function updateBalanceCard() {
    if (!account) return;
    var pnl     = (account.position && account.position.unrealizedPnl) || 0;
    var balance = (account.spotUSDC || 0) + pnl;
    var pnlColor = pnl > 0 ? 'var(--green-dark)' : pnl < 0 ? 'var(--pink-dark)' : 'var(--text-muted)';

    var amtEl   = document.getElementById('balance-amount');
    var detEl   = document.getElementById('balance-detail');
    if (amtEl) amtEl.textContent = '$' + balance.toFixed(2);
    if (detEl) {
      var inner = 'USDC $' + (account.spotUSDC || 0).toFixed(2);
      if (pnl !== 0) inner += '<span style="color:' + pnlColor + '"> ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' PnL</span>';
      if (btcPrice)  inner += ' · BTC $' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 });
      detEl.innerHTML = inner;
    }

    // Notional preview
    var notEl = document.getElementById('risk-notional');
    if (notEl && account.spotUSDC) {
      notEl.textContent = '≈ $' + (account.spotUSDC * riskPct / 100).toFixed(2) + ' · ' + leverage + '× = $' + (account.spotUSDC * riskPct / 100 * leverage).toFixed(2) + ' notional';
    }
  }

  function updatePositionCard() {
    if (!account) return;
    var pos = account.position;
    var flatEl  = document.getElementById('position-flat');
    var openEl  = document.getElementById('position-open');
    var card    = document.getElementById('position-card');

    if (!pos) {
      if (flatEl) flatEl.style.display = 'block';
      if (openEl) openEl.style.display = 'none';
      if (card)   card.style.border = '1px solid var(--border)';
    } else {
      if (flatEl) flatEl.style.display = 'none';
      if (openEl) openEl.style.display = 'block';
      if (card) {
        card.style.border = '1px solid ' + (pos.side === 'long' ? 'rgba(58,158,104,0.25)' : 'rgba(190,74,64,0.25)');
      }
      var badgeEl = document.getElementById('pos-side-badge');
      var sizeEl  = document.getElementById('pos-size');
      var entryEl = document.getElementById('pos-entry');
      var pnlEl   = document.getElementById('pos-pnl');

      var pnlPos = (pos.unrealizedPnl || 0) >= 0;
      if (badgeEl) {
        badgeEl.textContent = pos.side === 'long' ? '↑ LONG' : '↓ SHORT';
        badgeEl.style.background = pos.side === 'long' ? 'rgba(58,158,104,0.12)' : 'rgba(190,74,64,0.12)';
        badgeEl.style.color = pos.side === 'long' ? 'var(--green-dark)' : 'var(--pink-dark)';
        badgeEl.style.border = '1px solid ' + (pos.side === 'long' ? 'rgba(58,158,104,0.3)' : 'rgba(190,74,64,0.3)');
      }
      if (sizeEl) sizeEl.textContent = (pos.sizeBTC || 0).toFixed(4);
      if (entryEl) entryEl.textContent = '$' + (pos.entryPx || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
      if (pnlEl) {
        pnlEl.textContent = (pnlPos ? '+' : '') + (pos.unrealizedPnl || 0).toFixed(2);
        pnlEl.style.color = pnlPos ? 'var(--green-dark)' : 'var(--pink-dark)';
      }
    }
  }

  function updateStats() {
    var closedTrades = tradeLog.filter(function (t) { return t.closedAt; });
    var wins = closedTrades.filter(function (t) { return (t.pnl || 0) > 0; }).length;
    var sessionPnL = closedTrades.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);

    var pnlEl = document.getElementById('session-pnl');
    if (pnlEl) {
      pnlEl.textContent = (sessionPnL > 0 ? '+' : '') + (closedTrades.length === 0 ? '+$0.00' : '$' + sessionPnL.toFixed(2));
      pnlEl.style.color = sessionPnL > 0 ? 'var(--green-dark)' : sessionPnL < 0 ? 'var(--pink-dark)' : 'var(--text-primary)';
    }
    var winrateEl = document.getElementById('session-winrate');
    if (winrateEl) {
      if (closedTrades.length > 0) {
        winrateEl.style.display = 'block';
        winrateEl.textContent = (wins > 0 ? '+' + ((wins / closedTrades.length) * 100).toFixed(0) + '%' : '0%') + ' win rate';
      } else {
        winrateEl.style.display = 'none';
      }
    }

    el('stat-cycles').textContent = String(autoCycles);
    el('stat-trades').textContent = String(tradesPlaced);
    el('stat-wins').textContent   = closedTrades.length > 0 ? wins + ' / ' + closedTrades.length : '—';

    var pnlValues = tradeLog.filter(function (t) { return t.pnl != null; }).map(function (t) { return t.pnl; });
    if (pnlValues.length > 0) {
      var best  = Math.max.apply(null, pnlValues);
      var worst = Math.min.apply(null, pnlValues);
      el('stat-best').textContent  = best  > 0 ? '+$' + best.toFixed(2)  : '—';
      el('stat-worst').textContent = worst < 0 ? '$'  + worst.toFixed(2) : '—';
    } else {
      el('stat-best').textContent  = '—';
      el('stat-worst').textContent = '—';
    }

    var badge = document.getElementById('trades-placed-badge');
    if (badge) {
      if (tradesPlaced > 0) {
        badge.style.display = 'inline';
        badge.textContent = tradesPlaced + ' trade' + (tradesPlaced !== 1 ? 's' : '');
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function el(id) {
    return document.getElementById(id) || { textContent: '', style: {}, innerHTML: '' };
  }

  function updateTradeLog() {
    var emptyEl = document.getElementById('trade-log-empty');
    var tableEl = document.getElementById('trade-log-table');
    var rowsEl  = document.getElementById('trade-log-rows');

    if (!mounted || tradeLog.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      if (tableEl) tableEl.style.display = 'none';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (tableEl) tableEl.style.display = 'flex';
    if (!rowsEl) return;

    var html = '';
    var reversed = tradeLog.slice().reverse();
    reversed.forEach(function (t, revIdx) {
      var isWin  = (t.pnl || 0) > 0;
      var isOpen = !t.closedAt;
      var num    = tradeLog.length - revIdx;
      var sideColor = t.side === 'long' ? 'var(--green-dark)' : 'var(--pink-dark)';
      var pnlColor  = isOpen ? 'var(--text-muted)' : isWin ? 'var(--green-dark)' : 'var(--pink-dark)';
      var statusColor = isOpen ? 'var(--amber)' : isWin ? 'var(--green-dark)' : 'var(--pink-dark)';
      var exitPart = t.exitPrice ? ' → $' + t.exitPrice.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
      html +=
        '<div style="display:grid;grid-template-columns:32px 70px 90px 1fr 80px 70px;gap:0;padding:7px 10px;border-bottom:1px solid var(--border);align-items:center;">' +
          '<span style="font-family:monospace;font-size:10px;color:var(--text-muted);font-weight:600;">#' + num + '</span>' +
          '<span style="display:inline-flex;align-items:center;gap:4px;">' +
            '<span style="width:6px;height:6px;border-radius:50%;background:' + sideColor + ';flex-shrink:0;"></span>' +
            '<span style="font-size:11px;font-weight:700;color:' + sideColor + ';">' + (t.side === 'long' ? 'Long' : 'Short') + '</span>' +
          '</span>' +
          '<span style="font-family:monospace;font-size:11px;color:var(--text-secondary);font-weight:600;">' + (t.sizeBTC || 0).toFixed(4) + '</span>' +
          '<span style="font-family:monospace;font-size:11px;color:var(--text-muted);">$' + (t.entryPrice || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) + exitPart + '</span>' +
          '<span style="font-family:monospace;font-size:12px;font-weight:800;color:' + pnlColor + ';">' +
            (isOpen ? '—' : (isWin ? '+' : '') + '$' + (t.pnl || 0).toFixed(2)) +
          '</span>' +
          '<span style="font-size:10px;font-weight:600;color:' + statusColor + ';">' + (isOpen ? 'Open' : isWin ? 'Win' : 'Loss') + '</span>' +
        '</div>';
    });
    rowsEl.innerHTML = html;
  }

  function updateVerdictCard() {
    var verdictEl     = document.getElementById('verdict-text');
    var bulletsEl     = document.getElementById('verdict-bullets');
    var placeholderEl = document.getElementById('verdict-placeholder');
    var autoBadge     = document.getElementById('auto-badge');
    var cycleBadge    = document.getElementById('cycle-badge-center');
    var stateEl       = document.getElementById('agent-state-text');
    var processDots   = document.getElementById('processing-dots');
    var card          = document.getElementById('verdict-card');

    var verdictColors = {
      LONG:  ['#2E9E68', 'rgba(46,158,104,0.08)', 'rgba(46,158,104,0.3)'],
      SHORT: ['#BE4A40', 'rgba(190,74,64,0.08)',  'rgba(190,74,64,0.3)'],
      CLOSE: ['#3C6EA0', 'rgba(60,110,160,0.08)', 'rgba(60,110,160,0.3)'],
      PASS:  ['#C2956B', 'rgba(194,149,107,0.08)','rgba(194,149,107,0.3)'],
    };

    var displayVerdict = lastVerdict || deriveVerdict(lastAnalysisText);

    if (verdictEl) {
      verdictEl.textContent = displayVerdict || '—';
      var vc = displayVerdict ? verdictColors[displayVerdict] : null;
      verdictEl.style.color = vc ? vc[0] : 'var(--text-muted)';
    }
    if (card) {
      var vc2 = displayVerdict ? verdictColors[displayVerdict] : null;
      card.style.borderColor = vc2 ? vc2[2] : 'var(--border)';
      card.style.background = vc2 ? vc2[1] : 'var(--bg-card)';
    }
    if (cycleBadge) {
      if (autoCycles > 0) { cycleBadge.style.display = 'inline'; cycleBadge.textContent = 'cycle ' + autoCycles; }
      else { cycleBadge.style.display = 'none'; }
    }

    if (lastAnalysisText) {
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (bulletsEl) {
        var lines = lastAnalysisText.split('\n').filter(function (l) { return l.trim(); }).slice(0, 5);
        bulletsEl.innerHTML = lines.map(function (line) {
          var clean = line.replace(/^[•\-*]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/^(CLOSE|LONG|SHORT|PASS)\s*[—–\-]?\s*/i, '').trim();
          if (!clean || /^(CLOSE|LONG|SHORT|PASS)$/i.test(clean)) return '';
          return '<div style="display:flex;gap:7px;">' +
            '<span style="color:var(--text-muted);font-size:13px;line-height:1.3;flex-shrink:0;margin-top:1px;">·</span>' +
            '<span style="font-size:12px;font-weight:500;color:var(--text-secondary);line-height:1.5;">' + esc(clean) + '</span>' +
            '</div>';
        }).join('');
      }
    } else {
      if (placeholderEl) {
        placeholderEl.style.display = 'block';
        placeholderEl.style.fontFamily = 'monospace';
        placeholderEl.style.fontSize = '11px';
        placeholderEl.style.color = 'var(--text-muted)';
        if (autoMode && autoWaitUntil > Date.now() && !processing) {
          var secs = Math.max(0, Math.ceil((autoWaitUntil - Date.now()) / 1000));
          placeholderEl.textContent = '// ' + secs + 's until next analysis';
        } else {
          placeholderEl.textContent = autoMode ? '// awaiting first cycle…' : '// start the agent to begin';
        }
      }
      if (bulletsEl) bulletsEl.innerHTML = '';
    }

    if (stateEl) {
      stateEl.textContent = processing ? 'analyzing' : autoMode ? 'live' : 'idle';
      stateEl.style.color = processing ? 'var(--blue)' : autoMode ? 'var(--green-dark)' : 'var(--text-muted)';
    }
    if (processDots) processDots.style.display = processing ? 'flex' : 'none';
  }

  function updateStatusBar() {
    var statusBar  = document.getElementById('status-bar');
    var candleScan = document.getElementById('candle-scan');
    var mainEl     = document.getElementById('status-main');
    var subEl      = document.getElementById('status-sub');
    var dotEl      = document.getElementById('status-dot-el');
    var liveTag    = document.getElementById('live-badge-24h');

    if (processing) {
      if (statusBar)  statusBar.style.display  = 'none';
      if (candleScan) candleScan.style.display = 'block';
      renderCandleSvg();
    } else {
      if (statusBar)  statusBar.style.display  = 'flex';
      if (candleScan) candleScan.style.display = 'none';

      if (dotEl) {
        dotEl.style.background = autoMode ? 'var(--green-dark)' : 'var(--text-muted)';
        dotEl.style.animation  = autoMode ? 'pulse-live 2s ease-in-out infinite' : 'none';
      }
      if (statusBar) {
        statusBar.style.background = autoMode ? 'rgba(46,158,104,0.04)' : 'var(--bg-card)';
        statusBar.style.borderColor = autoMode ? 'rgba(46,158,104,0.14)' : 'var(--border)';
      }
      if (mainEl) {
        if (autoMode) {
          mainEl.style.color = 'var(--green-dark)';
          mainEl.textContent = (autoWaitLabel === 'Holding position') ? 'holding position' : 'monitoring';
        } else {
          mainEl.style.color = 'var(--text-muted)';
          mainEl.textContent = 'agent paused';
        }
      }
      if (subEl) {
        if (autoMode) {
          if (autoWaitUntil > Date.now()) {
            var secs = Math.max(0, Math.ceil((autoWaitUntil - Date.now()) / 1000));
            subEl.textContent = autoWaitLabel === 'Holding position'
              ? secs + 's cooldown · watching for reversal'
              : 'next analysis in ' + secs + 's';
          } else {
            subEl.textContent = 'cycle ' + autoCycles + ' complete · queuing next scan…';
          }
        } else {
          subEl.textContent = 'start agent for 24/7 autonomous trading';
        }
      }
      if (liveTag) liveTag.style.display = autoMode ? 'inline' : 'none';
    }
  }

  var candleData = [
    { h: 88, l: 18, o: 28, c: 82, bull: true  },
    { h: 82, l: 44, o: 78, c: 48, bull: false },
    { h: 74, l: 28, o: 46, c: 70, bull: true  },
    { h: 94, l: 52, o: 68, c: 90, bull: true  },
    { h: 86, l: 38, o: 83, c: 52, bull: false },
    { h: 68, l: 32, o: 36, c: 63, bull: true  },
    { h: 78, l: 40, o: 74, c: 44, bull: false },
    { h: 90, l: 55, o: 58, c: 86, bull: true  },
    { h: 84, l: 48, o: 80, c: 60, bull: false },
    { h: 97, l: 62, o: 65, c: 94, bull: true  },
  ];

  function renderCandleSvg() {
    var svg = document.getElementById('candle-svg');
    if (!svg) return;
    var W = 200, H = 72, spacing = W / candleData.length, bw = 9;
    var html = '';
    candleData.forEach(function (c, i) {
      var x = i * spacing + spacing / 2;
      var color = c.bull ? '#2E9E68' : '#BE4A40';
      var yH = H - (c.h / 100) * H, yL = H - (c.l / 100) * H;
      var yO = H - (c.o / 100) * H, yC = H - (c.c / 100) * H;
      var byTop = Math.min(yO, yC), byH = Math.max(2, Math.abs(yO - yC));
      html +=
        '<g style="animation:bar-rise 0.45s ease-out ' + (i * 0.055) + 's both;transform-origin:' + x + 'px ' + H + 'px;">' +
          '<line x1="' + x + '" y1="' + yH + '" x2="' + x + '" y2="' + yL + '" stroke="' + color + '" stroke-width="1" opacity="0.45"/>' +
          '<rect x="' + (x - bw / 2) + '" y="' + byTop + '" width="' + bw + '" height="' + byH + '" fill="' + color + '" opacity="0.88" rx="1"/>' +
        '</g>';
    });
    svg.innerHTML = html;
  }

  function updateAgentStatusPill() {
    var pill = document.getElementById('agent-status-pill');
    if (!pill) return;
    if (autoMode) {
      pill.style.background = 'rgba(46,158,104,0.12)';
      pill.style.color = 'var(--green-dark)';
      pill.style.border = '1px solid rgba(46,158,104,0.3)';
      pill.innerHTML = '<span style="width:5px;height:5px;border-radius:50%;background:var(--green-dark);display:inline-block;animation:pulse-live 1s infinite;"></span> LIVE';
    } else {
      pill.style.background = 'var(--bg-secondary)';
      pill.style.color = 'var(--text-muted)';
      pill.style.border = '1px solid var(--border)';
      pill.textContent = 'IDLE';
    }
  }

  function updateStartStopBtn() {
    var btn = document.getElementById('start-stop-btn');
    if (!btn) return;
    if (autoMode) {
      btn.textContent = '⏹ Stop Agent';
      btn.style.background = 'rgba(190,74,64,0.10)';
      btn.style.color = 'var(--pink-dark)';
      btn.style.outline = '1px solid rgba(190,74,64,0.3)';
    } else {
      btn.textContent = '▶ Start Agent';
      btn.style.background = 'var(--text-primary)';
      btn.style.color = 'var(--bg-card)';
      btn.style.outline = 'none';
    }
  }

  function updateCycleBadge() {
    var el = document.getElementById('header-cycle');
    if (el) el.textContent = '#' + autoCycles;
  }

  function updateLeverageBtns() {
    var btns = document.querySelectorAll('.lev-btn');
    btns.forEach(function (btn) {
      var lv = Number(btn.getAttribute('data-lev'));
      if (lv === leverage) {
        btn.classList.add('lev-active');
      } else {
        btn.classList.remove('lev-active');
      }
    });
    var infoLev = document.getElementById('info-leverage');
    if (infoLev) {
      var valEl = infoLev.querySelector('.info-val');
      if (valEl) valEl.textContent = leverage + '×';
    }
  }

  function updateRiskDisplay() {
    var pctEl    = document.getElementById('risk-pct-display');
    var sliderEl = document.getElementById('risk-slider');
    if (pctEl) {
      pctEl.textContent = riskPct + '%';
      pctEl.style.color = riskPct > 50 ? 'var(--pink-dark)' : riskPct > 25 ? 'var(--amber)' : 'var(--text-primary)';
    }
    if (sliderEl) sliderEl.value = riskPct;
    updateBalanceCard();
  }

  function fullUpdate() {
    updateBalanceCard();
    updatePositionCard();
    updateStats();
    updateTradeLog();
    updateVerdictCard();
    updateStatusBar();
    updateAgentStatusPill();
    updateStartStopBtn();
    updateCycleBadge();
    updateLeverageBtns();
    updateRiskDisplay();
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function deriveVerdict(text) {
    if (!text) return null;
    var raw = text.split('\n').find(function (l) { return l.trim(); });
    if (!raw) return null;
    var first = raw.trim().replace(/^[^a-zA-Z]+/, '').trim();
    if (/^CLOSE\b/i.test(first)) return 'CLOSE';
    if (/^LONG\b/i.test(first))  return 'LONG';
    if (/^SHORT\b/i.test(first)) return 'SHORT';
    if (/^PASS\b/i.test(first))  return 'PASS';
    return null;
  }

  function buildHint() {
    if (!btcPrice) return undefined;
    var pos = account && account.position;
    return [
      'BTC-PERP mid price: $' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 1 }),
      'Available capital: $' + ((account && account.spotUSDC) || 0).toFixed(2) +
        ' spot USDC (auto-transfers to perp on execution)',
      pos
        ? 'Position: ' + pos.side.toUpperCase() + ' ' + (pos.sizeBTC || 0).toFixed(4) +
          ' BTC @ $' + (pos.entryPx || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) +
          ' · PnL: ' + ((pos.unrealizedPnl || 0) >= 0 ? '+' : '') + (pos.unrealizedPnl || 0).toFixed(2)
        : 'Position: FLAT',
    ].join('\n');
  }

  // ── Trade execution ────────────────────────────────────────────────────────
  function closePosition() {
    fetch('/api/hl/close-position', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && openTrade) {
          var exitPrice = data.midPrice || 0;
          var pnl = openTrade.side === 'long'
            ? (exitPrice - openTrade.entryPrice) * openTrade.sizeBTC
            : (openTrade.entryPrice - exitPrice) * openTrade.sizeBTC;
          tradeLog = tradeLog.map(function (t) {
            return t.id === openTrade.id ? Object.assign({}, t, { exitPrice: exitPrice, pnl: pnl, closedAt: Date.now() }) : t;
          });
          ssJson('aomi-trade-log', tradeLog);
          openTrade = null;
          try { sessionStorage.removeItem('aomi-open-trade'); } catch(e) {}
        }
        try { window.refreshAccount && window.refreshAccount(); } catch(e) {}
        fullUpdate();
      })
      .catch(function () {});
  }
  window.closePosition = closePosition;

  function executeTrade(side) {
    return fetch('/api/hl/place-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: side, riskPct: riskPct, leverage: leverage }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          var record = {
            id:         genUUID(),
            side:       side,
            sizeBTC:    data.sizeBTC    || 0,
            entryPrice: data.midPrice   || 0,
            openedAt:   Date.now(),
          };
          openTrade = record;
          ssJson('aomi-open-trade', record);
          tradeLog = tradeLog.concat([record]);
          ssJson('aomi-trade-log', tradeLog);
        }
        try { window.refreshAccount && window.refreshAccount(); } catch(e) {}
        fullUpdate();
        return data.ok;
      })
      .catch(function () { return false; });
  }

  // ── Send (SSE streaming) ──────────────────────────────────────────────────
  function send(text, opts) {
    if (!text || !text.trim() || processing) return Promise.resolve(false);

    processing = true;
    ss('aomi-processing', '1');
    fullUpdate();

    var hint = buildHint();
    var autoExecute = opts && opts.autoExecute;
    var silent = opts && opts.silent;
    var currentActiveTool = null;

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    return fetch('/api/aomi/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:    text.trim(),
        hint:       hint,
        sessionId:  sessionId,
        marketData: btcPrice ? { btc_price: btcPrice, equity: (account && account.equity) || 0, position: (account && account.position) || null } : undefined,
        riskPct:    riskPct,
      }),
      signal: abortCtrl.signal,
    })
    .then(function (res) {
      if (!res.ok || !res.body) throw new Error('Request failed (' + res.status + ')');
      var reader = res.body.getReader();
      var dec    = new TextDecoder();
      var buf = '', finalText = '', assistantStarted = false;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return null;
          buf += dec.decode(result.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop() || '';
          parts.forEach(function (part) {
            if (!part.startsWith('data: ')) return;
            try {
              var ev = JSON.parse(part.slice(6));
              if (ev.type === 'tool') {
                currentActiveTool = ev.status === 'running' ? ev.name : null;
                var toolLabel = HL_TOOL_LABELS[ev.name] || ev.name;
                var scanText = document.getElementById('scan-tool-text');
                if (scanText) scanText.textContent = (ev.status === 'running' ? toolLabel : 'scanning market') + '…';
              }
              if (ev.type === 'message') {
                finalText = ev.text;
                lastAnalysisText = ev.text;
                ss('aomi-last-analysis-text', ev.text);
                updateVerdictCard();
              }
              if (ev.type === 'error') throw new Error(ev.text);
            } catch (e) {
              if (e.name !== 'SyntaxError') {
                // ignore
              }
            }
          });
          return pump();
        });
      }

      return pump().then(function () { return finalText; });
    })
    .then(function (finalText) {
      ss('aomi-last-analysis-text', finalText || '');

      if (autoExecute && finalText) {
        var rawLine = (finalText.split('\n').find(function (l) { return l.trim(); }) || '').trim();
        var firstLine = rawLine.replace(/^[^a-zA-Z]+/, '').trim();
        var isLong  = /^LONG\b/i.test(firstLine);
        var isShort = /^SHORT\b/i.test(firstLine);
        var isClose = /^CLOSE\b/i.test(firstLine);
        var confMatch = finalText.match(/confidence[^:]*:\s*(\d+)%/i);
        var confNum   = confMatch ? parseInt(confMatch[1]) : 0;

        var v = isClose ? 'CLOSE' : isLong ? 'LONG' : isShort ? 'SHORT' : 'PASS';
        lastVerdict = v;
        ss('aomi-last-verdict', v);

        if (isClose && !isLong && !isShort) {
          processing = false; procDone();
          closePosition();
          if (silent) { autoCycles++; ss('aomi-auto-cycles', autoCycles); lastTraded = 0; ss('aomi-last-traded', '0'); }
          return true;
        }
        if ((isLong || isShort) && confNum >= 60) {
          processing = false; procDone();
          return executeTrade(isLong ? 'long' : 'short').then(function (ok) {
            if (silent) {
              autoCycles++;
              ss('aomi-auto-cycles', autoCycles);
              if (ok) { tradesPlaced++; ss('aomi-trades-placed', tradesPlaced); lastTraded = Date.now(); ss('aomi-last-traded', String(lastTraded)); }
            }
            fullUpdate();
            return ok;
          });
        }
      }

      if (silent) { autoCycles++; ss('aomi-auto-cycles', autoCycles); }
      processing = false; procDone();
      fullUpdate();
      return false;
    })
    .catch(function (err) {
      if (err && err.name === 'AbortError') {
        processing = false; procDone();
        fullUpdate();
        return false;
      }
      processing = false; procDone();
      fullUpdate();
      return false;
    });
  }

  function procDone() {
    try { sessionStorage.removeItem('aomi-processing'); } catch(e) {}
    abortCtrl = null;
  }

  // ── Interrupt ──────────────────────────────────────────────────────────────
  function interruptAgent() {
    if (abortCtrl) abortCtrl.abort();
    fetch('/api/aomi/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    }).catch(function () {});
  }

  // ── Auto loop ─────────────────────────────────────────────────────────────
  function startAutoLoop() {
    autoLoopCancelled = false;
    autoLoopTick();
  }

  function stopAutoLoop() {
    autoLoopCancelled = true;
    autoWaitUntil = 0;
    autoWaitLabel = '';
  }

  function autoLoopTick() {
    if (autoLoopCancelled || !autoMode) return;

    if (ss('aomi-processing') === '1' && !processing) {
      setTimeout(autoLoopTick, 2000);
      return;
    }

    var now = Date.now();
    var msSinceTrade = now - lastTraded;

    if (lastTraded > 0 && msSinceTrade < HOLD_MS) {
      var waitHold = HOLD_MS - msSinceTrade;
      autoWaitUntil = now + waitHold;
      autoWaitLabel = 'Holding position';
      updateVerdictCard(); updateStatusBar();
      autoLoopId = setTimeout(function () {
        if (!autoLoopCancelled && autoMode) autoLoopTick();
      }, waitHold);
      return;
    }

    var msSinceLast = now - lastAnalysis;
    if (msSinceLast < SCAN_MS && lastAnalysis > 0) {
      var waitScan = SCAN_MS - msSinceLast;
      autoWaitUntil = now + waitScan;
      autoWaitLabel = 'Next analysis';
      updateVerdictCard(); updateStatusBar();
      autoLoopId = setTimeout(function () {
        if (!autoLoopCancelled && autoMode) autoLoopTick();
      }, waitScan);
      return;
    }

    if (!processing) {
      autoWaitUntil = 0;
      autoWaitLabel = '';
      lastAnalysis = Date.now();
      ss('aomi-last-analysis', lastAnalysis);
      updateStatusBar();

      send(AUTO_PROMPT, { silent: true, autoExecute: true }).then(function (traded) {
        if (autoLoopCancelled || !autoMode) return;
        if (traded) {
          autoWaitUntil = Date.now() + HOLD_MS;
          autoWaitLabel = 'Holding position';
          updateVerdictCard(); updateStatusBar();
          autoLoopId = setTimeout(function () {
            if (!autoLoopCancelled && autoMode) autoLoopTick();
          }, HOLD_MS);
        } else {
          autoWaitUntil = Date.now() + SCAN_MS;
          autoWaitLabel = 'Next analysis';
          updateVerdictCard(); updateStatusBar();
          autoLoopId = setTimeout(function () {
            if (!autoLoopCancelled && autoMode) autoLoopTick();
          }, SCAN_MS);
        }
      });
    } else {
      setTimeout(autoLoopTick, 2000);
    }
  }

  // Ticker for live countdown
  setInterval(function () {
    if (autoMode || processing) {
      updateVerdictCard();
      updateStatusBar();
    }
  }, 1000);

  // ── UI bindings ────────────────────────────────────────────────────────────
  window.toggleAutoMode = function () {
    if (processing) interruptAgent();
    autoMode = !autoMode;
    ss('aomi-auto', autoMode ? '1' : '0');
    if (autoMode) {
      startAutoLoop();
    } else {
      stopAutoLoop();
      if (autoLoopId) { clearTimeout(autoLoopId); autoLoopId = null; }
    }
    fullUpdate();
  };

  window.runOnce = function () {
    if (!processing) send(AUTO_PROMPT, { autoExecute: true });
  };

  window.setRisk = function (val) {
    riskPct = Number(val);
    ls('aomi-risk-pct', riskPct);
    updateRiskDisplay();
  };

  window.setLeverage = function (lv) {
    leverage = lv;
    ls('aomi-leverage', lv);
    updateLeverageBtns();
    updateRiskDisplay();
  };

  window.toggleRiskEdit = function () {
    editingRisk = !editingRisk;
    var sliderRow = document.getElementById('risk-slider-row');
    var editBtn   = document.getElementById('risk-edit-btn');
    if (sliderRow) sliderRow.style.display = editingRisk ? 'flex' : 'none';
    if (editBtn)   editBtn.textContent = editingRisk ? 'editing' : 'edit';
  };

  window.resetSession = function () {
    ls(sessionKey, null);
    try { localStorage.removeItem(sessionKey); } catch(e) {}
    var keys = ['aomi-auto','aomi-last-analysis','aomi-last-traded','aomi-trades-placed','aomi-processing',
      'aomi-last-verdict','aomi-auto-cycles','aomi-trade-log','aomi-last-analysis-text','aomi-open-trade'];
    keys.forEach(function (k) { try { sessionStorage.removeItem(k); } catch(e) {} });
    sessionId = genUUID();
    ls(sessionKey, sessionId);
    window.location.reload();
  };

  // ── Events ────────────────────────────────────────────────────────────────
  document.addEventListener('btctick', function (e) {
    btcPrice = e.detail.price;
    updateBalanceCard();
  });

  document.addEventListener('accounttick', function (e) {
    account = e.detail.account;
    // Bootstrap trade log from live position if needed
    if (account && account.position && tradeLog.length === 0 && !openTrade) {
      var p = account.position;
      var rec = { id: genUUID(), side: p.side, sizeBTC: p.sizeBTC || 0, entryPrice: p.entryPx || 0, openedAt: Date.now() };
      openTrade = rec;
      ssJson('aomi-open-trade', rec);
      tradeLog = [rec];
      ssJson('aomi-trade-log', tradeLog);
    }
    fullUpdate();
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    loadState();

    // Set risk slider initial value
    var sliderEl = document.getElementById('risk-slider');
    if (sliderEl) sliderEl.value = riskPct;

    fullUpdate();

    // If was in auto mode, restart loop
    if (autoMode) {
      startAutoLoop();
    }

    // Show stored analysis text immediately
    if (lastAnalysisText) {
      lastVerdict = deriveVerdict(lastAnalysisText) || lastVerdict;
      updateVerdictCard();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
