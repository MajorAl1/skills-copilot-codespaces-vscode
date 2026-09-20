/* Senior Financial Resources service worker.
   Shell (index.html): stale-while-revalidate, so the app opens instantly and offline.
   Data (content.json, manifest.json): network-first, so a returning visitor always sees
   the newest data file when online, and the last good copy when offline.
   Cache name is stamped by tools/build.js; a new build evicts the previous cache. */
var CACHE = 'sfr-1.6.3-2026-09-20';
var SHELL = ['./', './index.html', './content.json', './manifest.json'];
var NETWORK_FIRST = /\/(content\.json|manifest\.json)$/;

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (NETWORK_FIRST.test(url.pathname)) {
    event.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req); }));
    return;
  }
  event.respondWith(caches.match(req).then(function (cached) {
    var network = fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return cached; });
    return cached || network;
  }));
});
