// chart.js — canvas price chart using requestAnimationFrame
(function () {
  'use strict';

  var PAD = { t: 16, r: 80, b: 28, l: 52 };
  var C = {
    green: '#2E9E68',
    red:   '#BE4A40',
    blue:  '#3C6EA0',
    grid:  'rgba(0,0,0,0.04)',
    label: '#A09D99',
    bg:    '#F9F8F6',
  };

  var live = {
    candles:      [],
    priceHistory: [],
    entryPrice:   0,
    currentPrice: 0,
    windowMs:     60 * 60 * 1000,
    candleMs:     60 * 1000,
    pulseT:       0,
    cssW:         600,
    cssH:         280,
    positionSide: null,
  };

  var rafId = null;
  var canvas = null;
  var ctx = null;
  var container = null;
  var dpr = window.devicePixelRatio || 1;

  function fmtPrice(p) {
    return p >= 1000 ? (p / 1000).toFixed(1) + 'k' : p.toFixed(0);
  }

  function niceStep(range) {
    var raw  = range / 4;
    var mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  }

  function resize() {
    if (!canvas || !container) return;
    var rect = container.getBoundingClientRect();
    live.cssW = rect.width  || 600;
    live.cssH = rect.height || 280;
    canvas.width  = live.cssW * dpr;
    canvas.height = live.cssH * dpr;
    canvas.style.width  = live.cssW + 'px';
    canvas.style.height = live.cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fetchCandles() {
    fetch('/api/hl/candles?window=1h', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.candles && d.candles.length) {
          live.candles = d.candles;
        }
      })
      .catch(function () {});
  }

  var prevNow = null;

  function draw(ts) {
    if (!canvas || !ctx) return;

    if (prevNow === null) prevNow = ts;
    var dt = Math.min((ts - prevNow) / 1000, 0.05);
    prevNow = ts;

    var s = live;
    var W = s.cssW, H = s.cssH;
    ctx.clearRect(0, 0, W, H);
    s.pulseT = (s.pulseT + dt * 0.6) % 1;

    var iW = W - PAD.l - PAD.r;
    var iH = H - PAD.t - PAD.b;
    var tNow   = Date.now();
    var tStart = tNow - s.windowMs;

    // Build points
    var hist = s.candles.filter(function (c) { return c.t >= tStart; });
    var points = hist.map(function (c) { return { t: c.t + s.candleMs / 2, p: c.c }; });

    s.priceHistory.forEach(function (pt) {
      if (pt.timestamp >= tStart) points.push({ t: pt.timestamp, p: pt.price });
    });
    if (s.currentPrice > 0) points.push({ t: tNow, p: s.currentPrice });

    points.sort(function (a, b) { return a.t - b.t; });

    // Y range
    var allP = points.map(function (pt) { return pt.p; });
    if (s.entryPrice > 0) allP.push(s.entryPrice);
    var pMin = allP.length > 0 ? Math.min.apply(null, allP) : (s.currentPrice || 95000) - 200;
    var pMax = allP.length > 0 ? Math.max.apply(null, allP) : (s.currentPrice || 95000) + 200;
    var pRng = Math.max(pMax - pMin, 50);
    var pad  = pRng * 0.15;
    var yMin = pMin - pad;
    var yMax = pMax + pad;

    function toX(t) { return PAD.l + ((t - tStart) / s.windowMs) * iW; }
    function toY(p) { return PAD.t + iH - ((p - yMin) / (yMax - yMin)) * iH; }

    var lineColor = points.length < 2 ? C.blue
      : s.currentPrice >= points[0].p ? C.green : C.red;

    // Background
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(PAD.l, PAD.t, iW, iH, 6);
    } else {
      ctx.rect(PAD.l, PAD.t, iW, iH);
    }
    ctx.fill();

    // Grid lines
    var step = niceStep(yMax - yMin);
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth   = 1;
    for (var p = Math.ceil(yMin / step) * step; p <= yMax; p += step) {
      var y = toY(p);
      if (y < PAD.t || y > PAD.t + iH) continue;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + iW, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Entry price line
    if (s.entryPrice > 0) {
      var ey = toY(s.entryPrice);
      var isProfit = s.currentPrice >= s.entryPrice;
      var ec = isProfit ? C.green : C.red;
      ctx.strokeStyle = ec + '70';
      ctx.lineWidth   = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(PAD.l, ey); ctx.lineTo(PAD.l + iW, ey); ctx.stroke();
      ctx.setLineDash([]);

      var cW = PAD.r - 8, cH = 18, cX = PAD.l + iW + 4;
      var cY = Math.max(PAD.t + cH / 2, Math.min(PAD.t + iH - cH / 2, ey));
      ctx.fillStyle = ec + '20';
      ctx.strokeStyle = ec + '60';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cX, cY - cH / 2, cW, cH, 4);
      else ctx.rect(cX, cY - cH / 2, cW, cH);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = ec;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var delta = s.currentPrice - s.entryPrice;
      ctx.fillText((isProfit ? '+' : '') + '$' + Math.abs(delta).toFixed(0), cX + cW / 2, cY);
    }

    // Price line + fill
    if (points.length >= 2) {
      var grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + iH);
      grad.addColorStop(0, lineColor + '28');
      grad.addColorStop(1, lineColor + '00');

      ctx.beginPath();
      ctx.moveTo(toX(points[0].t), toY(points[0].p));
      for (var i = 1; i < points.length; i++) ctx.lineTo(toX(points[i].t), toY(points[i].p));
      ctx.lineTo(toX(points[points.length - 1].t), PAD.t + iH);
      ctx.lineTo(toX(points[0].t), PAD.t + iH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(toX(points[0].t), toY(points[0].p));
      for (var j = 1; j < points.length; j++) ctx.lineTo(toX(points[j].t), toY(points[j].p));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth   = 1.5;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    }

    // Live price dot + chip
    if (s.currentPrice > 0) {
      var ly = toY(s.currentPrice);

      for (var ring = 0; ring < 2; ring++) {
        var phase = (s.pulseT + ring * 0.5) % 1;
        ctx.beginPath();
        ctx.arc(PAD.l + iW, ly, 4 + phase * 14, 0, Math.PI * 2);
        ctx.strokeStyle = lineColor + Math.round((1 - phase) * 0.35 * 255).toString(16).padStart(2, '0');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(PAD.l + iW, ly, 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor; ctx.fill();
      ctx.beginPath(); ctx.arc(PAD.l + iW, ly, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();

      var chipW = PAD.r - 8, chipH = 20, chipX = PAD.l + iW + 6;
      var chipY = Math.max(PAD.t + chipH / 2, Math.min(PAD.t + iH - chipH / 2, ly));
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(chipX, chipY - chipH / 2, chipW, chipH, 4);
      else ctx.rect(chipX, chipY - chipH / 2, chipW, chipH);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$' + s.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 }), chipX + chipW / 2, chipY);
    }

    // Y-axis labels
    ctx.fillStyle = C.label;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var gp = Math.ceil(yMin / step) * step; gp <= yMax; gp += step) {
      var gy = toY(gp);
      if (gy < PAD.t + 6 || gy > PAD.t + iH - 6) continue;
      ctx.fillText('$' + fmtPrice(gp), PAD.l - 6, gy);
    }

    // X-axis labels
    ctx.fillStyle = C.label;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var xi = 0; xi <= 4; xi++) {
      var xt = tStart + (xi / 4) * s.windowMs;
      var xx = toX(xt);
      if (xx < PAD.l || xx > PAD.l + iW) continue;
      ctx.fillText(
        new Date(xt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        xx, PAD.t + iH + 6
      );
    }

    // Hide loading overlay
    var loadingEl = document.getElementById('chart-loading');
    if (loadingEl && s.currentPrice > 0) loadingEl.style.display = 'none';

    rafId = requestAnimationFrame(draw);
  }

  function init() {
    canvas    = document.getElementById('price-chart');
    container = document.getElementById('chart-container');
    if (!canvas || !container) return;

    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;
    resize();

    var ro = new ResizeObserver(resize);
    ro.observe(container);

    fetchCandles();
    setInterval(fetchCandles, 60000);

    prevNow = null;
    rafId = requestAnimationFrame(draw);
  }

  // Listen for price/account updates
  document.addEventListener('btctick', function (e) {
    live.currentPrice = e.detail.price;
    live.priceHistory = e.detail.priceHistory;

    // Update chart price display
    var chartPrice = document.getElementById('chart-price');
    if (chartPrice) {
      chartPrice.textContent = '$' + e.detail.price.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
  });

  document.addEventListener('accounttick', function (e) {
    var acct = e.detail.account;
    if (acct && acct.position) {
      live.entryPrice   = acct.position.entryPx   || 0;
      live.positionSide = acct.position.side       || null;
    } else {
      live.entryPrice   = 0;
      live.positionSide = null;
    }
  });

  // Init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose setChartWindow for button click
  window.setChartWindow = function (w) {
    var ms = { '15m': 15 * 60000, '30m': 30 * 60000, '1h': 60 * 60000 };
    live.windowMs = ms[w] || ms['1h'];
    fetchCandles();
  };
})();
