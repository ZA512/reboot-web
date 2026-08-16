const CACHE_NAME = 'reboot-shell-v49';
const SHELL = [
  './app.html',
  './version.txt',
  './app.css',
  './brand-theme.css',
  './app-shell.css',
  './data-page.css',
  './app.js',
  './budget-engine.js',
  './entry.js',
  './secure-storage.js',
  './archive.js',
  './drive.js',
  './icons/favicon.ico',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/brand-96.png',
  './icons/pwa-192.png',
  './icons/pwa-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './pictures/happy-face.png',
  './pictures/smily.png',
  './pictures/thinking.png',
  './pictures/very%20sad.png',
  './pictures/dead.png',
  './pictures/zen.png',
  './pictures/sleepy.png',
  './pictures/happy-face-money.png',
  './pictures/decontracted.png',
  './pictures/braging.png',
  './pictures/questionning.png',
  './historique.html',
  './verifier.html',
  './sauvegarde.html',
  './sauvegarder.html',
  './restaurer.html',
  './drive.html',
  './manifest.webmanifest',
  './index.html',
  './calculateur.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
