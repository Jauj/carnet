// Carnet — données de la page : accès à GitHub, déchiffrement, cache, enregistrements, index de recherche.
// Tout le déchiffrement se fait ici, dans le navigateur. GitHub ne reçoit que des fichiers chiffrés.
import cfg from "./config.js";
import * as C from "./crypto.js";
import * as N from "./notes.js";
import * as X from "./search.js";

const TOKEN_KEY = "carnet.token";
const DRAFTS_KEY = "carnet.drafts";
const PRIVATE_KEY = "carnet.private";
const HEAD_KEY = "carnet.head"; // dernier commit connu (public), pour ouvrir hors ligne

export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
export const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const fold = X.fold;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const events = new EventTarget();
const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

// ---------- état de la session (effacé au verrouillage) ----------
export let S = blank();
function blank() {
  return {
    header: null, keys: null, ref: null, head: null, fallback: false, offline: false,
    manifest: null, byName: new Map(), token: null, cache: new Map(), parts: new Map(),
    backlinks: null, tags: null,
  };
}
export function forget() { S = blank(); }

// ---------- accès à GitHub ----------
let dataRepo = cfg.repo;
export const repoName = () => `${cfg.owner}/${dataRepo}`;
const repoPath = () => `/repos/${cfg.owner}/${dataRepo}`;

async function resolveDataRepo() {
  if (!cfg.dataRepo || cfg.dataRepo === cfg.repo) return;
  try {
    const r = await fetch(`${cfg.raw}/${cfg.owner}/${cfg.dataRepo}/${cfg.branch}/vault.json`, { cache: "no-store" });
    dataRepo = r.ok ? cfg.dataRepo : cfg.repo;
  } catch { dataRepo = cfg.dataRepo; } // hors ligne : le cache décidera
}

function headers(json = false) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (S.token) h.Authorization = `Bearer ${S.token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export async function api(path, { method = "GET", body, ok = [] } = {}) {
  const r = await fetch(cfg.api + repoPath() + path, {
    method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  if (r.ok || ok.includes(r.status)) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  if (r.status === 401) throw new Error("Jeton GitHub refusé (expiré ou révoqué ?). « Oublier le jeton » puis réessayer.");
  if (r.status === 403 || r.status === 404) {
    if (method === "GET") throw new Error(`Accès refusé par GitHub (${r.status}).`);
    // Jeton sans droit d'écriture sur ce dépôt (par exemple l'ancien, après la migration) : on l'oublie,
    // le prochain enregistrement en demandera un autre.
    S.token = null;
    localStorage.removeItem(TOKEN_KEY);
    throw new Error(`Ce jeton n'a pas le droit d'écrire dans ${repoName()} : il est oublié. Enregistre à nouveau pour en saisir un autre.`);
  }
  throw new Error(`GitHub a répondu ${r.status}.`);
}

// SHA du dernier commit de la branche de données ; null si l'API refuse (limite sans jeton) ;
// « offline » si le réseau est coupé.
async function latestHead() {
  let r;
  try { r = await fetch(`${cfg.api}${repoPath()}/git/ref/heads/${cfg.branch}`, { headers: headers(), cache: "no-store" }); }
  catch { return "offline"; }
  if (r.ok) return (await r.json()).object.sha;
  if (r.status === 404) throw new Error("Carnet introuvable sur GitHub (branche « data » absente).");
  if (r.status === 401) throw new Error("Jeton GitHub refusé (expiré ou révoqué ?).");
  return null;
}

// Fichier brut à un commit précis (immuable, donc gardé en cache par le service worker).
// Quelques secondes de délai sont possibles juste après un enregistrement : on réessaie.
async function raw(ref, path) {
  const url = `${cfg.raw}/${cfg.owner}/${dataRepo}/${ref}/${path}`;
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(url, { cache: ref === cfg.branch ? "no-store" : "default" }); }
    catch { throw new Error("Hors ligne : ce fichier n'a pas encore été lu sur cet appareil."); }
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    if (r.status !== 404 || i >= 5) throw new Error(`Lecture impossible (${r.status}).`);
    await sleep(800 * (i + 1));
  }
}

// ---------- déverrouillage ----------
export async function unlock(pass) {
  await resolveDataRepo();
  let head = await latestHead();
  let offline = false;
  if (head === "offline") {
    const saved = JSON.parse(localStorage.getItem(HEAD_KEY) || "null");
    if (!saved || saved.repo !== dataRepo) throw new Error("Hors ligne, et ce carnet n'a encore jamais été ouvert sur cet appareil.");
    head = saved.sha;
    offline = true;
  }
  const ref = head || cfg.branch;
  const header = JSON.parse(C.fromUtf8(await raw(ref, "vault.json")));
  const keys = await C.unlock(header, pass);
  const manifest = await C.decryptManifest(keys.enc, await raw(ref, "manifest.bin"));
  S = blank();
  Object.assign(S, { header, keys, ref, head, fallback: !head, offline });
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) {
    try { S.token = C.fromUtf8(await C.decryptBytes(keys.local, C.fromBase64(stored), "token")); }
    catch { localStorage.removeItem(TOKEN_KEY); }
  }
  // Lecture limitée sans jeton (réseau partagé) : avec le jeton mémorisé, on relit la version la plus récente.
  if (!head && S.token) {
    const h = await latestHead().catch(() => null);
    if (h && h !== "offline") return reload(h);
  }
  setManifest(manifest);
  rememberHead();
}

export async function reload(knownHead) {
  const h = knownHead || await latestHead();
  if (h === "offline") throw new Error("Hors ligne : impossible de recharger.");
  const ref = h || cfg.branch;
  const m = await C.decryptManifest(S.keys.enc, await raw(ref, "manifest.bin"));
  Object.assign(S, { ref, head: h, fallback: !h, offline: false });
  setManifest(m);
  rememberHead();
}

// Dernier commit dont le manifeste a été lu depuis GitHub (donc gardé par le service worker) :
// c'est lui qu'on rouvre hors ligne.
function rememberHead() {
  if (S.head && !S.offline) localStorage.setItem(HEAD_KEY, JSON.stringify({ repo: dataRepo, sha: S.head }));
}

function setManifest(m) {
  S.manifest = m;
  S.byName = new Map();
  S.backlinks = null;
  S.tags = null;
  for (const p of Object.keys(m.notes)) {
    const k = fold(baseName(p));
    if (!S.byName.has(k)) S.byName.set(k, []);
    S.byName.get(k).push(p);
    for (const a of m.notes[p].meta?.aliases || []) {
      const ka = fold(a);
      if (!S.byName.has(ka)) S.byName.set(ka, []);
      S.byName.get(ka).push(p);
    }
  }
  emit("manifest");
}

export const notes = () => S.manifest.notes;
export const exists = (p) => !!S.manifest?.notes[p];

// ---------- lecture ----------
export async function readNote(path) {
  const e = S.manifest.notes[path];
  if (!e) throw new Error("Note introuvable.");
  const cached = S.cache.get(path);
  if (cached && cached.sha === e.sha) return cached;
  const bytes = await C.decryptBytes(S.keys.enc, await raw(S.ref, C.noteFile(e.id)), C.noteAad(e.id));
  let text, valid = true;
  try { text = C.fromUtf8(bytes, { fatal: true }); } catch { valid = false; text = C.fromUtf8(bytes); }
  const note = { path, sha: e.sha, valid, text };
  S.cache.set(path, note);
  return note;
}

// ---------- liens, rétroliens, tags ----------
// Cible d'un lien [[…]] (nom, alias, chemin partiel) ou d'un lien Markdown ("/chemin complet").
export function resolveLink(target, from = "") {
  if (!target) return from;
  if (target.startsWith("/")) { const p = target.slice(1) + ".md"; return S.manifest.notes[p] ? p : undefined; }
  const t = C.normPath(target).replace(/\.md$/i, "");
  const cands = S.byName.get(fold(baseName(t))) || [];
  if (t.includes("/")) {
    const want = fold(t + ".md");
    return cands.find((p) => fold(p) === want || fold(p).endsWith("/" + want));
  }
  if (cands.length <= 1) return cands[0];
  const dir = dirName(from) + "/";
  return cands.find((p) => p.startsWith(dir)) || [...cands].sort((a, b) => a.length - b.length)[0];
}

export function backlinksOf(path) {
  if (!S.backlinks) {
    S.backlinks = new Map();
    for (const [p, e] of Object.entries(S.manifest.notes)) {
      for (const l of e.meta?.links || []) {
        const t = resolveLink(l, p);
        if (!t || t === p) continue;
        if (!S.backlinks.has(t)) S.backlinks.set(t, new Set());
        S.backlinks.get(t).add(p);
      }
    }
  }
  return [...(S.backlinks.get(path) || [])].sort((a, b) => (notes()[b].mtime || 0) - (notes()[a].mtime || 0));
}

// Tags -> nombre de notes (la casse de la première occurrence est gardée pour l'affichage).
export function allTags() {
  if (!S.tags) {
    const m = new Map();
    for (const e of Object.values(S.manifest.notes)) {
      for (const t of e.meta?.tags || []) {
        const k = fold(t);
        const cur = m.get(k) || { name: t, n: 0 };
        cur.n++;
        m.set(k, cur);
      }
    }
    S.tags = m;
  }
  return S.tags;
}

// ---------- index de recherche ----------
async function indexPart(label, version) {
  const key = `${label}@${version}`;
  if (S.parts.has(key)) return S.parts.get(key);
  const p = (async () => {
    const f = await X.indexFile(C.noteId, S.keys.name, label);
    return JSON.parse(C.fromUtf8(await C.decryptBytes(S.keys.enc, await raw(S.ref, f.file), f.aad)));
  })();
  S.parts.set(key, p);
  p.catch(() => S.parts.delete(key));
  return p;
}

export function search(q, { maxScan } = {}) {
  const ix = S.manifest.index;
  const ok = ix?.v === X.INDEX_VERSION;
  return X.runSearch(q, {
    notes: S.manifest.notes,
    loadHead: () => (ok ? indexPart("base/head", ix.built) : null),
    loadShard: (n) => indexPart("base/" + n, ix.built),
    loadDelta: () => (ok ? indexPart("delta", ix.deltaSha) : null),
    readText: async (p) => (await readNote(p)).text,
    maxScan,
  });
}

// ---------- jeton ----------
export async function setToken(token, remember) {
  S.token = token;
  try { await api(""); } catch (err) { S.token = null; throw err; }
  if (remember) {
    const blob = await C.encryptBytes(S.keys.local, C.utf8(token), "token");
    localStorage.setItem(TOKEN_KEY, C.toBase64(blob));
  }
}
export function forgetToken() { localStorage.removeItem(TOKEN_KEY); S.token = null; }
export const hasStoredToken = () => !!localStorage.getItem(TOKEN_KEY);

// ---------- enregistrements ----------
// Un enregistrement = un commit (notes + manifeste), accepté seulement s'il prolonge la branche.
//   put : [{ path, text, base }]   base = empreinte de la version ouverte (undefined : nouvelle note)
//   del : [{ path, base }]
//   onConflict(path, isNew) -> "copy" | "overwrite" | null (annuler)
// Renvoie { paths: { demandé -> enregistré }, copied: [chemins] } ou null si annulé.
export async function commit({ put = [], del = [] }, onConflict, message = "web") {
  const targets = put.map((x) => ({ ...x, target: x.path, expected: x.base, bytes: C.utf8(x.text) }));
  const copied = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = (await api(`/git/ref/heads/${cfg.branch}`)).data.object.sha;
    const treeSha = (await api(`/git/commits/${head}`)).data.tree.sha;
    const manifest = head === S.head && S.manifest
      ? structuredClone(S.manifest)
      : await C.decryptManifest(S.keys.enc, await raw(head, "manifest.bin"));

    let restart = false;
    for (const t of targets) {
      const cur = manifest.notes[t.target]?.sha;
      if (cur === t.expected || cur === await C.sha256Hex(t.bytes)) continue;
      const choice = await onConflict(t.target, t.expected === undefined);
      if (choice === "copy") {
        let n = 1;
        do { t.target = C.conflictPath(t.path, n === 1 ? "conflit" : `conflit ${n}`); n++; } while (manifest.notes[t.target]);
        t.expected = undefined;
        copied.push(t.target);
        restart = true;
      } else if (choice === "overwrite") t.expected = cur;
      else return null;
    }
    if (restart) continue;
    for (const d of del) {
      const cur = manifest.notes[d.path]?.sha;
      if (cur !== undefined && cur !== d.base && !(await onConflict(d.path, false) === "overwrite")) return null;
    }

    const tree = [];
    for (const t of targets) {
      const id = await C.noteId(S.keys.name, t.target);
      const sha = await C.sha256Hex(t.bytes);
      const old = manifest.notes[t.target];
      if (old && old.id !== id) tree.push({ path: C.noteFile(old.id), mode: "100644", type: "blob", sha: null });
      manifest.notes[t.target] = {
        id, sha, size: t.bytes.length, mtime: Date.now(),
        meta: N.parseNote(t.text, t.target), mv: N.META_VERSION,
      };
      const blob = await C.encryptBytes(S.keys.enc, t.bytes, C.noteAad(id));
      const b = (await api("/git/blobs", { method: "POST", body: { content: C.toBase64(blob), encoding: "base64" } })).data.sha;
      tree.push({ path: C.noteFile(id), mode: "100644", type: "blob", sha: b });
    }
    for (const d of del) {
      const e = manifest.notes[d.path];
      if (!e) continue;
      tree.push({ path: C.noteFile(e.id), mode: "100644", type: "blob", sha: null });
      delete manifest.notes[d.path];
    }
    const mb = await C.encryptManifest(S.keys.enc, manifest);
    const b2 = (await api("/git/blobs", { method: "POST", body: { content: C.toBase64(mb), encoding: "base64" } })).data.sha;
    tree.push({ path: "manifest.bin", mode: "100644", type: "blob", sha: b2 });
    const newTree = (await api("/git/trees", { method: "POST", body: { base_tree: treeSha, tree } })).data.sha;
    const date = new Date().toISOString();
    const who = { ...cfg.author, date };
    const n = targets.length + del.length;
    const c = (await api("/git/commits", { method: "POST",
      body: { message: `${message} : ${n} note${n > 1 ? "s" : ""}`, tree: newTree, parents: [head], author: who, committer: who } })).data.sha;
    const upd = await api(`/git/refs/heads/${cfg.branch}`, { method: "PATCH", body: { sha: c, force: false }, ok: [409, 422] });
    if (upd.status === 409 || upd.status === 422) { emit("status", "Le carnet a changé entre-temps, nouvelle tentative…"); continue; }
    S.head = S.ref = c;
    S.fallback = false;
    for (const t of targets) S.cache.set(t.target, { path: t.target, sha: manifest.notes[t.target].sha, valid: true, text: t.text });
    setManifest(manifest);
    return { paths: Object.fromEntries(targets.map((t) => [t.path, t.target])), copied };
  }
  throw new Error("Le carnet change trop vite sur GitHub : réessaie dans un instant.");
}

// ---------- données locales chiffrées (brouillons, préférences privées) ----------
async function saveLocal(key, aad, obj) {
  if (!S.keys) return;
  if (obj == null) { localStorage.removeItem(key); return; }
  const blob = await C.encryptBytes(S.keys.local, C.utf8(JSON.stringify(obj)), aad);
  localStorage.setItem(key, C.toBase64(blob));
}
async function loadLocal(key, aad) {
  const stored = localStorage.getItem(key);
  if (!stored || !S.keys) return null;
  try { return JSON.parse(C.fromUtf8(await C.decryptBytes(S.keys.local, C.fromBase64(stored), aad))); }
  catch { localStorage.removeItem(key); return null; }
}
export const saveDrafts = (d) => saveLocal(DRAFTS_KEY, "drafts", d && Object.keys(d).length ? d : null);
export const loadDrafts = () => loadLocal(DRAFTS_KEY, "drafts");
export const savePrivate = (p) => saveLocal(PRIVATE_KEY, "private", p);
export const loadPrivate = () => loadLocal(PRIVATE_KEY, "private");
