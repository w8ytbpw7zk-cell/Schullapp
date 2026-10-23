/* Schulapp – Offline-Zwischenspeicher (neu, V72)
 * - Nur Dateien der App selbst (gleiche Adresse) werden zwischengespeichert.
 *   Anfragen an den eigenen Server (Tailscale), an andere Seiten oder von
 *   Browser-Erweiterungen (chrome-extension://) werden nie angefasst.
 * - Erst Netz, dann Zwischenspeicher: Ist man online, kommt immer die neueste
 *   Version; offline öffnet sich die zuletzt geladene.
 * - Es wird immer eine gültige Antwort geliefert (behebt „Failed to convert value to 'Response'“).
 */
const CACHE = 'schulapp-v72';
const START = ['./', './index.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(START)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const kopie = res.clone();
        caches.open(CACHE).then((c) => c.put(req, kopie)).catch(() => {});
      }
      return res;
    } catch (err) {
      const treffer = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (treffer) return treffer;
      if (req.mode === 'navigate') {
        const start = (await caches.match('./index.html')) || (await caches.match('./'));
        if (start) return start;
      }
      return new Response('Offline – diese Datei ist nicht zwischengespeichert.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
