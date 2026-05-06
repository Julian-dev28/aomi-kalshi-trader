// ticker.js — polls /api/hl/price and /api/hl/account, dispatches CustomEvents
(function () {
  'use strict';

  var priceHistory = [];
  var MAX_HISTORY = 7200; // 4h of 2s ticks
  var lastPrice = 0;
  var lastAccount = null;

  function fetchPrice() {
    fetch('/api/hl/price')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var price = data.price || 0;
        if (price > 0) {
          lastPrice = price;
          priceHistory.push({ timestamp: Date.now(), price: price });
          if (priceHistory.length > MAX_HISTORY) {
            priceHistory = priceHistory.slice(priceHistory.length - MAX_HISTORY);
          }
          document.dispatchEvent(new CustomEvent('btctick', {
            detail: { price: price, priceHistory: priceHistory.slice() }
          }));
        }
      })
      .catch(function () {});
  }

  function fetchAccount() {
    fetch('/api/hl/account')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.error) {
          lastAccount = data;
          document.dispatchEvent(new CustomEvent('accounttick', {
            detail: { account: data }
          }));
        }
      })
      .catch(function () {});
  }

  // Start clock
  function updateClock() {
    var el = document.getElementById('header-clock');
    if (el) {
      el.textContent = new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC'
      }) + ' UTC';
    }
  }

  // Expose refresh function globally for manual refresh
  window.refreshAccount = function () {
    fetchAccount();
  };

  function prefillHistory() {
    fetch('/api/hl/candles?window=4h')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var candles = data.candles || [];
        candles.forEach(function (c) {
          if (c.c > 0) {
            priceHistory.push({ timestamp: c.t, price: c.c });
          }
        });
        if (priceHistory.length > MAX_HISTORY) {
          priceHistory = priceHistory.slice(priceHistory.length - MAX_HISTORY);
        }
        if (priceHistory.length > 0) {
          lastPrice = priceHistory[priceHistory.length - 1].price;
          document.dispatchEvent(new CustomEvent('btctick', {
            detail: { price: lastPrice, priceHistory: priceHistory.slice() }
          }));
        }
      })
      .catch(function () {});
  }

  // Init
  prefillHistory();
  fetchPrice();
  fetchAccount();
  setInterval(fetchPrice, 2000);
  setInterval(fetchAccount, 5000);
  setInterval(updateClock, 1000);
  updateClock();
})();
