// Carnet — service worker : appli installable et lecture hors ligne.
//   - le code de la page : réseau d'abord (toujours la dernière version), cache si hors ligne ;
//   - les fichiers chiffrés lus à un commit précis (immuables) : cache d'abord.
// Le cache ne contient que ce que GitHub sert déjà publiquement : du code et des fichiers chiffrés.
const SHELL = "carnet-page-v1";
const DATA = "carnet-donnees";
const FILES = ["./", "index.html", "style.css", "app.js", "store.js", "render.js", "panels.js", "editor.js", "tts.js",
  "notes.js", "search.js", "crypto.js", "config.js", "vendor/marked.esm.js", "vendor/purify.es.mjs", "icon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest"];
const MAX_DATA = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Fichier lu à un commit précis (le faux GitHub des tests sert les mêmes chemins sous /raw/).
const immutable = (url) => (url.hostname === "raw.githubusercontent.com" || url.pathname.startsWith("/raw/"))
  && /\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(url.pathname);

async function trim() {
  const c = await caches.open(DATA);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DATA))) await c.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (immutable(url)) {
    e.respondWith(caches.open(DATA).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { await c.put(req, res.clone()); if (Math.random() < 0.05) trim(); }
      return res;
    }));
  } else if (url.origin === self.location.origin && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/raw/")) {
    e.respondWith(fetch(req).then(async (res) => {
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("index.html") : Response.error())));
  }
});
