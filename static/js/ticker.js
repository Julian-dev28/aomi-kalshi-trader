// ticker.js — polls /api/hl/price and /api/hl/account, dispatches CustomEvents
(function () {
  'use strict';

  var priceHistory = [];
  var MAX_HISTORY = 300;
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

  // Init
  fetchPrice();
  fetchAccount();
  setInterval(fetchPrice, 2000);
  setInterval(fetchAccount, 5000);
  setInterval(updateClock, 1000);
  updateClock();
})();
