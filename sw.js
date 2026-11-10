// NoelEvents · service worker: la app funciona sin conexión. Los datos los sincroniza Firestore por su cuenta.
const CACHE = "noelevents-v27";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./img/hero.jpg", "./img/dj.jpg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
const CDN = ["https://www.gstatic.com/firebasejs/", "https://cdnjs.cloudflare.com/", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === location.origin, cdn = CDN.some(p => req.url.startsWith(p));
  if (!same && !cdn) return;
  // La web de ejemplos (/dossier/) va por libre: vídeos por streaming, sin caché de la app
  if (same && url.pathname.includes("/dossier/")) return;
  // La página: primero red (para recibir actualizaciones), si no hay, la copia guardada
  if (req.mode === "navigate") {
    e.respondWith(fetch(req.url, { cache: "no-store", credentials: "same-origin" }).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", cp)); return r; }).catch(() => caches.match("./index.html")));
    return;
  }
  // Resto: copia guardada al instante y actualización en segundo plano
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});

// Notificaciones push (enviadas por los avisos automáticos)
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(_) {}
  const n = d.notification || {}, url = (d.data && d.data.url) || "./";
  e.waitUntil(self.registration.showNotification(n.title || "NoelEvents", { body: n.body || "", icon: n.icon || "./icons/icon-192.png", badge: "./icons/icon-192.png", data: { url } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  const id = (url.match(/#evento-(.+)$/) || [])[1];
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    const w = ws.find(c => c.url.startsWith(self.registration.scope));
    if (w) { if (id) w.postMessage({ abrir: decodeURIComponent(id) }); return w.focus(); }
    return clients.openWindow(url);
  }));
});
