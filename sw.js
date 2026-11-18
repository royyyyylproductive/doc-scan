const CACHE = 'doc-scan-v4';
const VENDOR_CACHE = 'doc-scan-vendor-v1';
const shell = [
  './', './index.html', './css/style.css', './js/app.js', './js/db.js',
  './js/detect.js', './js/warp.js', './js/filters.js', './js/text.js', './js/ocr.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/maskable-512.png', './apple-touch-icon.png'
];
const vendor = [
  './vendor/tesseract/tesseract.min.js', './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-lstm.wasm.js', './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './vendor/tessdata/chi_tra.traineddata.gz', './vendor/tessdata/eng.traineddata.gz',
  './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/pdf-lib/pdf-lib.min.js', './vendor/pdf-lib/fontkit.umd.min.js',
  './vendor/fonts/NotoSansTC-Regular.ttf', './vendor/docx/docx.iife.js'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(shell)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('doc-scan-') && name !== CACHE && name !== VENDOR_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const isVendor = url.pathname.includes('/vendor/');
    const cache = await caches.open(isVendor ? VENDOR_CACHE : CACHE);
    const cached = await cache.match(event.request);
    if (event.request.mode === 'navigate' && !isVendor) {
      try { const response = await fetch(event.request); if (response.ok) await cache.put('./index.html', response.clone()); return response; }
      catch { return cached || await cache.match('./index.html'); }
    }
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'prepare' || event.data === 'checkOffline') event.waitUntil((async () => {
    const cache = await caches.open(VENDOR_CACHE);
    try {
      let count = 0;
      for (const file of vendor) {
        if (event.data === 'prepare' && !(await cache.match(file))) await cache.add(file);
        if (await cache.match(file)) count++;
        if (event.data === 'prepare') event.source.postMessage({ type: 'offline-progress', count, total: vendor.length });
      }
      event.source.postMessage({ type: 'offline-ready', ready: count === vendor.length, count, total: vendor.length });
    } catch { event.source.postMessage({ type: 'offline-error' }); }
  })());
});
