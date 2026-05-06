// dashboard.js — dashboard page: account card, orderbook, AI analysis SSE
(function () {
  'use strict';

  var btcPrice    = null;
  var account     = null;
  var analyzing   = false;
  var abortCtrl   = null;

  // ── Account card ─────────────────────────────────────────────────────────

  function renderAccount(acct) {
    var el = document.getElementById('account-info');
    var priceEl = document.getElementById('btc-price-display');
    var headerPrice = document.getElementById('header-price');

    if (priceEl && btcPrice) {
      priceEl.textContent = '$' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    if (headerPrice && btcPrice) {
      headerPrice.textContent = '$' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    if (!el || !acct) return;

    var pos = acct.position;
    var posHtml = pos
      ? '<div style="margin-top:6px;padding:8px 10px;border-radius:8px;background:' +
        (pos.side === 'long' ? 'rgba(46,158,104,0.08)' : 'rgba(190,74,64,0.08)') +
        ';border:1px solid ' + (pos.side === 'long' ? 'rgba(46,158,104,0.25)' : 'rgba(190,74,64,0.25)') + ';">' +
        '<div style="font-size:10px;font-weight:700;color:' + (pos.side === 'long' ? 'var(--green-dark)' : 'var(--pink-dark)') + ';">' +
        (pos.side === 'long' ? '↑ LONG' : '↓ SHORT') + ' · ' + (pos.sizeBTC || 0).toFixed(4) + ' BTC</div>' +
        '<div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-top:2px;">Entry $' +
        (pos.entryPx || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' · PnL ' +
        ((pos.unrealizedPnl || 0) >= 0 ? '+' : '') + (pos.unrealizedPnl || 0).toFixed(2) + '</div>' +
        '</div>'
      : '<div style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-top:4px;">FLAT</div>';

    var pnl      = (pos && pos.unrealizedPnl) || 0;
    var balance  = (acct.spotUSDC || 0) + pnl;
    var pnlColor = pnl > 0 ? 'var(--green-dark)' : pnl < 0 ? 'var(--pink-dark)' : 'var(--text-muted)';
    var detail   = 'USDC $' + (acct.spotUSDC || 0).toFixed(2) +
      (pnl !== 0 ? ' <span style="color:' + pnlColor + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' PnL</span>' : '');

    el.innerHTML =
      '<div style="font-size:9px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Balance</div>' +
      '<div style="font-family:monospace;font-size:22px;font-weight:800;color:var(--text-primary);letter-spacing:-0.02em;">$' + balance.toFixed(2) + '</div>' +
      '<div style="font-family:monospace;font-size:10px;color:var(--text-muted);margin-top:2px;margin-bottom:2px;">' + detail + '</div>' +
      posHtml;
  }

  // ── Orderbook ─────────────────────────────────────────────────────────────

  function renderOrderbook(bids, asks) {
    var asksEl = document.getElementById('orderbook-asks');
    var bidsEl = document.getElementById('orderbook-bids');
    if (!asksEl || !bidsEl) return;

    var maxSize = 0;
    bids.concat(asks).forEach(function (l) {
      var sz = parseFloat(l.sz) || 0;
      if (sz > maxSize) maxSize = sz;
    });

    function row(level, side) {
      var px = parseFloat(level.px) || 0;
      var sz = parseFloat(level.sz) || 0;
      var pct = maxSize > 0 ? (sz / maxSize) * 100 : 0;
      var color = side === 'bid' ? 'var(--green)' : 'var(--pink)';
      var bg    = side === 'bid' ? 'rgba(46,158,104,0.07)' : 'rgba(190,74,64,0.07)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;position:relative;">' +
        '<div style="position:absolute;right:0;top:0;bottom:0;background:' + bg + ';width:' + pct.toFixed(1) + '%;border-radius:2px;"></div>' +
        '<span style="font-family:monospace;font-size:11px;font-weight:700;color:' + color + ';position:relative;">' + px.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</span>' +
        '<span style="font-family:monospace;font-size:11px;color:var(--text-muted);position:relative;">' + sz.toFixed(4) + '</span>' +
        '</div>';
    }

    asksEl.innerHTML = '<div style="font-size:9px;font-weight:700;color:var(--pink-dark);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px;">Asks</div>' +
      asks.slice().reverse().map(function (l) { return row(l, 'ask'); }).join('');

    bidsEl.innerHTML = '<div style="font-size:9px;font-weight:700;color:var(--green-dark);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px;">Bids</div>' +
      bids.map(function (l) { return row(l, 'bid'); }).join('');
  }

  function fetchOrderbook() {
    fetch('/api/hl/orderbook')
      .then(function (r) { return r.json(); })
      .then(function (d) { renderOrderbook(d.bids || [], d.asks || []); })
      .catch(function () {});
  }

  // ── AI Analysis ───────────────────────────────────────────────────────────

  function buildHint() {
    if (!btcPrice) return undefined;
    var pos = account && account.position;
    var lines = [
      'BTC-PERP mid price: $' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 1 }),
      'Available trading capital: $' + ((account && account.totalEquity) || 0).toFixed(2),
      pos
        ? 'Current position: ' + pos.side.toUpperCase() + ' ' + (pos.sizeBTC || 0).toFixed(4) +
          ' BTC @ $' + (pos.entryPx || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) +
          ' · unrealized PnL: ' + ((pos.unrealizedPnl || 0) >= 0 ? '+' : '') + (pos.unrealizedPnl || 0).toFixed(2)
        : 'Current position: FLAT',
    ];
    return lines.join('\n');
  }

  function renderAnalysisLine(text) {
    var clean = text.replace(/^[•\-*]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
    if (!clean) return '';
    var verdict = /^CLOSE\b/i.test(clean) ? 'CLOSE' :
                  /^LONG\b/i.test(clean)  ? 'LONG'  :
                  /^SHORT\b/i.test(clean) ? 'SHORT' :
                  /^PASS\b/i.test(clean)  ? 'PASS'  : null;

    if (verdict) {
      var colors = {
        LONG:  ['var(--green-dark)', 'rgba(58,158,104,0.10)', 'rgba(58,158,104,0.25)'],
        SHORT: ['var(--pink-dark)',  'rgba(224,111,160,0.10)', 'rgba(224,111,160,0.25)'],
        CLOSE: ['var(--blue)',       'rgba(74,127,165,0.10)',  'rgba(74,127,165,0.25)'],
        PASS:  ['var(--amber)',      'rgba(212,135,44,0.08)',  'rgba(212,135,44,0.25)'],
      };
      var vc = colors[verdict];
      var rest = clean.replace(/^(LONG|SHORT|CLOSE|PASS)\s*[—–\-]?\s*/i, '');
      return '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:12px;background:' + vc[1] + ';border:1px solid ' + vc[2] + ';margin-bottom:6px;">' +
        '<span style="padding:2px 10px;border-radius:20px;background:' + vc[0] + ';color:#fff;font-size:11px;font-weight:800;letter-spacing:0.04em;flex-shrink:0;margin-top:2px;">' + verdict + '</span>' +
        '<span style="font-size:13px;line-height:1.5;color:var(--text-primary);font-weight:500;">' + esc(rest) + '</span>' +
        '</div>';
    }
    return '<div style="display:flex;gap:8px;padding:2px 0;">' +
      '<span style="color:var(--text-muted);font-size:16px;line-height:1.4;flex-shrink:0;">·</span>' +
      '<span style="font-size:13px;line-height:1.6;color:var(--text-secondary);">' + esc(clean) + '</span>' +
      '</div>';
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.runAnalysis = function () {
    if (analyzing) return;
    analyzing = true;

    var btn = document.getElementById('analyze-btn');
    var dots = document.getElementById('analysis-dots');
    var placeholder = document.getElementById('analysis-placeholder');
    var output = document.getElementById('analysis-output');
    var errEl  = document.getElementById('analysis-error');

    if (btn)         { btn.textContent = 'Analyzing…'; btn.disabled = true; btn.style.background = 'var(--bg-secondary)'; btn.style.color = 'var(--text-muted)'; }
    if (dots)        { dots.style.display = 'flex'; }
    if (placeholder) { placeholder.style.display = 'none'; }
    if (output)      { output.style.display = 'none'; output.innerHTML = ''; }
    if (errEl)       { errEl.style.display = 'none'; }

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    var hint = buildHint();
    var prompt = 'Check live BTC price and order book on Hyperliquid. Check my current position. ' +
      'Call get_candle_snapshot for the last 10 1-hour candles and last 6 4-hour candles. ' +
      'Give me a direct LONG / SHORT / CLOSE / PASS verdict with confidence and 3-4 bullet points of reasoning.';

    fetch('/api/aomi/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, hint: hint, riskPct: 5 }),
      signal: abortCtrl.signal,
    })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('Request failed (' + res.status + ')');
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '', text = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              analyzing = false;
              if (btn) { btn.textContent = 'Analyze'; btn.disabled = false; btn.style.background = 'var(--blue)'; btn.style.color = '#fff'; }
              if (dots) dots.style.display = 'none';
              return;
            }
            buf += dec.decode(result.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop() || '';
            parts.forEach(function (part) {
              if (!part.startsWith('data: ')) return;
              try {
                var ev = JSON.parse(part.slice(6));
                if (ev.type === 'message') {
                  text = ev.text;
                  if (dots)   dots.style.display = 'none';
                  if (output) {
                    output.style.display = 'flex';
                    var lines = text.split('\n').filter(function (l) { return l.trim(); });
                    output.innerHTML = lines.map(renderAnalysisLine).join('');
                  }
                }
                if (ev.type === 'error') throw new Error(ev.text);
              } catch (e) {
                if (e.name !== 'SyntaxError') {
                  if (errEl) { errEl.style.display = 'block'; errEl.textContent = e.message || String(e); }
                }
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) {
        analyzing = false;
        if (err.name === 'AbortError') return;
        if (btn) { btn.textContent = 'Analyze'; btn.disabled = false; btn.style.background = 'var(--blue)'; btn.style.color = '#fff'; }
        if (dots) dots.style.display = 'none';
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = String(err); }
      });
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  document.addEventListener('btctick', function (e) {
    btcPrice = e.detail.price;
    var priceEl = document.getElementById('btc-price-display');
    var headerPrice = document.getElementById('header-price');
    var fmt = '$' + btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (priceEl) priceEl.textContent = fmt;
    if (headerPrice) headerPrice.textContent = fmt;
  });

  document.addEventListener('accounttick', function (e) {
    account = e.detail.account;
    renderAccount(account);
  });

  fetchOrderbook();
  setInterval(fetchOrderbook, 3000);
})();
