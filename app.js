// Carnet — application de lecture et d'écriture du vault chiffré.
// Tout le déchiffrement se fait ici, dans le navigateur. GitHub ne reçoit que des fichiers chiffrés.
import cfg from "./config.js";
import * as C from "./crypto.js";
import { Marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

const $ = (id) => document.getElementById(id);
const DATA_REPO = cfg.dataRepo || cfg.repo;
const REPO = `/repos/${cfg.owner}/${DATA_REPO}`;
const TOKEN_KEY = "carnet.token";
const DRAFT_KEY = "carnet.draft";
const ATTACH_RE = /\.(png|jpe?g|gif|svg|webp|bmp|pdf|mp3|m4a|wav|ogg|mp4|webm|docx?|xlsx?|pptx?|odt|epub|zip|canvas)$/i;

// ---------- état de la session (effacé au verrouillage) ----------
let S = blankState();
function blankState() {
  return {
    header: null, keys: null, ref: null, head: null, fallback: false,
    manifest: null, byName: new Map(), token: null, cache: new Map(),
    current: null, editing: false, dirty: false, history: [],
  };
}

// ---------- utilitaires ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function status(msg, kind = "") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// ---------- accès à GitHub ----------
function headers(json = false) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (S.token) h.Authorization = `Bearer ${S.token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function api(path, { method = "GET", body, ok = [] } = {}) {
  const r = await fetch(cfg.api + REPO + path, {
    method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  });
  if (r.ok || ok.includes(r.status)) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  if (r.status === 401) throw new Error("Jeton GitHub refusé (expiré ou révoqué ?). « Oublier le jeton » puis réessayer.");
  if (r.status === 403 || r.status === 404) {
    throw new Error(method === "GET" ? `Accès refusé par GitHub (${r.status}).`
      : "Ce jeton n'a pas le droit d'écrire dans le dépôt (Contents : lecture et écriture).");
  }
  throw new Error(`GitHub a répondu ${r.status}.`);
}

// SHA du dernier commit de la branche de données, ou null si l'API refuse (limite de requêtes sans jeton).
async function latestHead() {
  const r = await fetch(`${cfg.api}${REPO}/git/ref/heads/${cfg.branch}`, { headers: headers(), cache: "no-store" });
  if (r.ok) return (await r.json()).object.sha;
  if (r.status === 404) throw new Error("Carnet introuvable sur GitHub (branche « data » absente).");
  if (r.status === 401) throw new Error("Jeton GitHub refusé (expiré ou révoqué ?).");
  return null;
}

// Fichier brut à un commit précis (immuable, donc toujours à jour). Quelques secondes de délai
// sont possibles juste après un enregistrement : on réessaie.
async function raw(ref, path) {
  const url = `${cfg.raw}/${cfg.owner}/${DATA_REPO}/${ref}/${path}`;
  for (let i = 0; ; i++) {
    const r = await fetch(url, { cache: ref === cfg.branch ? "no-store" : "default" });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    if (r.status !== 404 || i >= 5) throw new Error(`Lecture impossible (${r.status}).`);
    await sleep(800 * (i + 1));
  }
}

// ---------- déverrouillage ----------
async function unlockWith(pass) {
  const head = await latestHead();
  const ref = head || cfg.branch;
  const header = JSON.parse(C.fromUtf8(await raw(ref, "vault.json")));
  const keys = await C.unlock(header, pass);
  const manifest = await C.decryptManifest(keys.enc, await raw(ref, "manifest.bin"));
  S = blankState();
  Object.assign(S, { header, keys, ref, head, fallback: !head });
  setManifest(manifest);
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) {
    try { S.token = C.fromUtf8(await C.decryptBytes(keys.local, C.fromBase64(stored), "token")); }
    catch { localStorage.removeItem(TOKEN_KEY); }
  }
  // Lecture limitée sans jeton (réseau partagé) : avec le jeton mémorisé, on relit la version la plus récente.
  if (!head && S.token) {
    const h = await latestHead().catch(() => null);
    if (h) {
      setManifest(await C.decryptManifest(keys.enc, await raw(h, "manifest.bin")));
      Object.assign(S, { ref: h, head: h, fallback: false });
    }
  }
}

function setManifest(m) {
  S.manifest = m;
  S.byName = new Map();
  for (const p of Object.keys(m.notes)) {
    const k = fold(baseName(p));
    if (!S.byName.has(k)) S.byName.set(k, []);
    S.byName.get(k).push(p);
  }
}

// GitHub Pages ne permet pas l'en-tête frame-ancestors : la page refuse elle-même d'être affichée
// dans le cadre d'un autre site (qui pourrait piéger la saisie de la phrase de passe).
if (window.top === window.self) $("lock").hidden = false;
else {
  document.body.textContent = "Le carnet ne s'affiche pas dans le cadre d'un autre site. Ouvre-le directement.";
  throw new Error("Affichage dans un cadre refusé.");
}

$("unlock-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("lock-msg");
  const pass = $("pass").value;
  msg.className = "msg";
  msg.textContent = "Déverrouillage… (quelques secondes)";
  $("unlock-form").querySelector("button").disabled = true;
  try {
    await unlockWith(pass);
    $("pass").value = "";
    msg.textContent = "";
    $("lock").hidden = true;
    $("app").hidden = false;
    renderSide();
    showHome();
    if (S.fallback) banner("GitHub limite les lectures sans jeton depuis ce réseau : les données peuvent avoir quelques minutes de retard.");
    if (S.header.kdf.iterations < C.MIN_SAFE_ITERATIONS) banner("Attention : ce carnet utilise une dérivation de clé faible (mode test).");
    await offerDraft();
    touch();
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = err.message;
  } finally {
    $("unlock-form").querySelector("button").disabled = false;
  }
});

// ---------- verrouillage (manuel ou après inactivité) ----------
let lastActivity = Date.now();
function touch() { lastActivity = Date.now(); }
for (const ev of ["keydown", "pointerdown", "scroll", "touchstart"]) document.addEventListener(ev, touch, { passive: true, capture: true });
setInterval(() => {
  if (S.keys && Date.now() - lastActivity > cfg.lockMinutes * 60000) lock("Verrouillé après inactivité.");
}, 20000);

// Onglet en arrière-plan (téléphone rangé, autre application) : verrouillage plus rapide.
// Le minuteur peut être suspendu par le navigateur, d'où le contrôle aussi au retour.
const HIDDEN_LOCK_MS = (cfg.hiddenLockMinutes ?? 5) * 60000;
let hiddenSince = 0, hiddenTimer = 0;
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenSince = Date.now();
    hiddenTimer = setTimeout(() => { if (S.keys) lock("Verrouillé après un passage en arrière-plan."); }, HIDDEN_LOCK_MS);
  } else if (S.keys && hiddenSince && Date.now() - hiddenSince >= HIDDEN_LOCK_MS) {
    lock("Verrouillé après un passage en arrière-plan.");
  }
});

async function lock(message = "") {
  if (S.keys && S.editing && S.dirty) {
    const draft = { path: S.current.path, text: $("editor").value, baseSha: S.current.sha, isNew: !!S.current.isNew };
    const blob = await C.encryptBytes(S.keys.local, C.utf8(JSON.stringify(draft)), "draft");
    localStorage.setItem(DRAFT_KEY, C.toBase64(blob));
    message += " Ton brouillon est gardé (chiffré) et te sera proposé au déverrouillage.";
  }
  S = blankState();
  $("editor").value = "";
  $("view").innerHTML = "";
  $("tree").innerHTML = "";
  $("recents").innerHTML = "";
  $("filter").value = "";
  $("banner").hidden = true;
  $("banner").textContent = "";
  $("app").hidden = true;
  $("lock").hidden = false;
  $("lock-msg").className = "msg";
  $("lock-msg").textContent = message.trim();
  $("pass").focus();
}
// Maj + clic : oublie aussi le jeton GitHub mémorisé sur cet appareil.
$("btn-lock").addEventListener("click", (ev) => {
  if (ev.shiftKey && localStorage.getItem(TOKEN_KEY) && confirm("Oublier le jeton GitHub mémorisé sur cet appareil ?")) {
    localStorage.removeItem(TOKEN_KEY);
  }
  if (S.editing && S.dirty && !confirm("Modifications non enregistrées : elles seront gardées en brouillon chiffré. Verrouiller ?")) return;
  lock();
});

async function offerDraft() {
  const stored = localStorage.getItem(DRAFT_KEY);
  if (!stored) return;
  let draft;
  try { draft = JSON.parse(C.fromUtf8(await C.decryptBytes(S.keys.local, C.fromBase64(stored), "draft"))); }
  catch { localStorage.removeItem(DRAFT_KEY); return; }
  const choice = await ask("Brouillon non enregistré", `<p>Un brouillon de « ${esc(baseName(draft.path))} » n'a pas été enregistré.</p>`,
    [["drop", "Le jeter"], ["open", "Le reprendre", true]]);
  localStorage.removeItem(DRAFT_KEY);
  if (choice !== "open") return;
  S.current = { path: draft.path, sha: draft.baseSha, text: draft.text, isNew: draft.isNew };
  showNote();
  startEdit(draft.text);
  S.dirty = true;
}

// ---------- boîte de dialogue ----------
function ask(title, html, buttons, { input } = {}) {
  const dlg = $("dlg");
  $("dlg-title").textContent = title;
  $("dlg-body").innerHTML = html;
  const box = $("dlg-buttons");
  box.innerHTML = "";
  // Ordre inversé dans le document (le bouton principal en premier, donc choisi par Entrée),
  // rétabli à l'écran par flex-direction: row-reverse.
  for (const [value, label, primary] of [...buttons].reverse()) {
    const b = document.createElement("button");
    b.value = value; b.textContent = label;
    if (primary) b.className = "primary";
    box.append(b);
  }
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const vals = input ? Object.fromEntries([...dlg.querySelectorAll("input")].map((i) => [i.name, i.type === "checkbox" ? i.checked : i.value])) : null;
      resolve(input ? { choice: dlg.returnValue, ...vals } : dlg.returnValue);
    };
    dlg.returnValue = "";
    dlg.showModal();
    (dlg.querySelector("input") || box.querySelector(".primary"))?.focus();
  });
}

function banner(text) {
  const b = $("banner");
  const line = document.createElement("div");
  line.textContent = text;
  b.append(line);
  b.hidden = false;
}

// ---------- liste des notes ----------
function renderSide() {
  renderRecents();
  renderTree();
}

function noteLink(p, label = baseName(p), sub = "") {
  const a = document.createElement("a");
  a.href = "#";
  a.dataset.path = p;
  a.textContent = label;
  if (sub) { const s = document.createElement("span"); s.className = "path"; s.textContent = sub; a.append(s); }
  if (S.current?.path === p) a.classList.add("active");
  return a;
}

function renderRecents() {
  const box = $("recents");
  box.innerHTML = "<h3>Récents</h3>";
  const list = Object.entries(S.manifest.notes).sort((a, b) => b[1].mtime - a[1].mtime).slice(0, 12);
  for (const [p] of list) box.append(noteLink(p, baseName(p), dirName(p)));
}

function renderTree() {
  const root = { dirs: new Map(), notes: [] };
  for (const p of Object.keys(S.manifest.notes)) {
    const parts = p.split("/");
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), notes: [] });
      node = node.dirs.get(d);
    }
    node.notes.push(p);
  }
  const build = (node, container, prefix = "") => {
    for (const [name, child] of [...node.dirs].sort((a, b) => collator.compare(a[0], b[0]))) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      const folder = prefix ? `${prefix}/${name}` : name;
      sum.append(Object.assign(document.createElement("span"), { textContent: name }), menuButton(folder));
      const inner = document.createElement("div");
      det.append(sum, inner);
      // Contenu construit à la première ouverture : l'arborescence reste légère.
      det.addEventListener("toggle", () => { if (det.open && !inner.childElementCount) build(child, inner, folder); });
      container.append(det);
    }
    for (const p of node.notes.sort((a, b) => collator.compare(baseName(a), baseName(b)))) container.append(noteLink(p));
  };
  const tree = $("tree");
  tree.innerHTML = "";
  const h = document.createElement("h3");
  h.textContent = `Toutes les notes (${Object.keys(S.manifest.notes).length})`;
  h.append(menuButton(""));
  tree.append(h);
  build(root, tree);
}

// ---------- menu déroulant « ⋯ » des dossiers ----------
function menuButton(folder) {
  const b = document.createElement("button");
  b.className = "menu-btn";
  b.textContent = "⋯";
  b.title = "Actions sur ce dossier";
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openMenu(b, folder); });
  return b;
}

function openMenu(anchor, folder) {
  closeMenu();
  const m = document.createElement("div");
  m.id = "menu";
  m.className = "menu";
  const where = folder || "la racine";
  const items = [
    ["📝 Nouvelle note ici", () => offerCreate("", folder, { lockFolder: true })],
    ["📁 Nouveau dossier ici", () => offerFolder(folder)],
  ];
  m.append(Object.assign(document.createElement("div"), { className: "menu-head", textContent: where }));
  for (const [label, fn] of items) {
    const it = document.createElement("button");
    it.textContent = label;
    it.addEventListener("click", () => { closeMenu(); fn(); });
    m.append(it);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`;
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
function closeMenu() { $("menu")?.remove(); }

async function offerFolder(parent) {
  const res = await ask("Nouveau dossier", `
    <p>Dans : <b>${esc(parent || "racine")}</b></p>
    <label for="fd">Nom du dossier</label><input id="fd" name="dir" type="text">
    <label for="fn">Première note</label><input id="fn" name="name" type="text" value="Index">
    <p class="hint">Un dossier existe dès qu'il contient une note.</p>`,
  [["cancel", "Annuler"], ["ok", "Créer", true]], { input: true });
  if (res.choice !== "ok" || !res.dir.trim()) return;
  if (/[\\:*?"<>|/]/.test(res.dir) || res.dir.trim().startsWith(".")) return status("Nom de dossier invalide.", "error");
  startNew((parent ? parent + "/" : "") + res.dir.trim(), res.name || "Index");
}

$("filter").addEventListener("input", () => {
  const q = fold($("filter").value.trim());
  const tree = $("tree");
  if (!q) { $("recents").hidden = false; renderTree(); return; }
  $("recents").hidden = true;
  const words = q.split(/\s+/);
  const hits = Object.keys(S.manifest.notes).filter((p) => { const f = fold(p); return words.every((w) => f.includes(w)); });
  hits.sort((a, b) => collator.compare(baseName(a), baseName(b)));
  tree.innerHTML = `<h3>${hits.length} résultat${hits.length > 1 ? "s" : ""}</h3>`;
  for (const p of hits.slice(0, 300)) tree.append(noteLink(p, baseName(p), dirName(p)));
  if (hits.length > 300) tree.insertAdjacentHTML("beforeend", `<div class="hint">… précise le filtre pour voir la suite.</div>`);
});

$("side").addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-path]");
  if (!a) return;
  ev.preventDefault();
  openNote(a.dataset.path);
  document.body.classList.remove("side-open");
});
$("btn-side").addEventListener("click", () => document.body.classList.toggle("side-open"));

// ---------- lecture ----------
async function readNote(path) {
  const e = S.manifest.notes[path];
  const cached = S.cache.get(path);
  if (cached && cached.sha === e.sha) return cached;
  const bytes = await C.decryptBytes(S.keys.enc, await raw(S.ref, C.noteFile(e.id)), C.noteAad(e.id));
  const note = { path, sha: e.sha, valid: C.isValidUtf8(bytes), text: C.fromUtf8(bytes) };
  S.cache.set(path, note);
  return note;
}

async function openNote(path, { push = true } = {}) {
  if (S.editing && S.dirty && !confirm("Modifications non enregistrées. Les abandonner ?")) return;
  if (!S.manifest.notes[path]) return offerCreate(path);
  status("Ouverture…");
  try {
    const note = await readNote(path);
    if (push && S.current?.path !== path) history.pushState({ path }, "", location.pathname);
    S.current = { path, sha: note.sha, text: note.text, readOnly: !note.valid };
    stopEdit();
    showNote();
    status(note.valid ? "" : "Fichier qui n'est pas en UTF-8 : lecture seule sur la page.");
  } catch (err) {
    status(err.message, "error");
  }
}

// Le chemin des notes n'apparaît jamais dans l'adresse ni dans l'historique visible du navigateur.
window.addEventListener("popstate", (ev) => {
  if (!S.keys) return;
  if (ev.state?.path) openNote(ev.state.path, { push: false });
  else if (!(S.editing && S.dirty)) showHome();
});

function showHome() {
  S.current = null;
  stopEdit();
  $("crumb").textContent = "";
  $("note-title").textContent = "Carnet";
  $("btn-edit").hidden = true;
  $("view").innerHTML = `<p class="empty">Choisis une note à gauche, filtre par nom, ou crée-en une avec ＋.</p>`;
  history.replaceState({}, "", location.pathname);
}

function showNote() {
  const c = S.current;
  $("crumb").textContent = dirName(c.path).replaceAll("/", " › ");
  $("note-title").textContent = baseName(c.path);
  $("btn-edit").hidden = false;
  $("btn-edit").disabled = !!c.readOnly;
  $("view").innerHTML = renderMarkdown(c.text);
  decorate($("view"), c.path);
  $("main").scrollTop = 0;
  for (const a of document.querySelectorAll("#side a.active")) a.classList.remove("active");
  for (const a of document.querySelectorAll(`#side a[data-path="${CSS.escape(c.path)}"]`)) a.classList.add("active");
}

// ---------- rendu Markdown (avec les spécificités d'Obsidian) ----------
const md = new Marked({ gfm: true, breaks: false });
md.use({
  extensions: [{
    name: "wikilink",
    level: "inline",
    start(src) { const i = src.indexOf("[["); return i < 0 ? undefined : i > 0 && src[i - 1] === "!" ? i - 1 : i; },
    tokenizer(src) {
      const m = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
      if (!m) return undefined;
      const [targetPart, alias] = m[2].split("|");
      const h = targetPart.indexOf("#");
      return {
        type: "wikilink", raw: m[0], embed: !!m[1],
        target: (h >= 0 ? targetPart.slice(0, h) : targetPart).trim(),
        anchor: h >= 0 ? targetPart.slice(h + 1).trim() : "",
        alias: alias?.trim(),
      };
    },
    renderer(t) {
      if (ATTACH_RE.test(t.target)) return `<span class="att">📎 ${esc(t.alias || t.target)} (pièce jointe, non synchronisée)</span>`;
      const label = t.alias || (t.target ? t.target + (t.anchor ? " › " + t.anchor : "") : t.anchor);
      return `<a href="#" class="wl" data-target="${esc(t.target)}" data-anchor="${esc(t.anchor)}">${esc(label)}</a>`;
    },
  }],
  renderer: {
    image({ text }) { return `<span class="att">🖼 ${esc(text || "image")} (non affichée)</span>`; },
  },
});

function renderMarkdown(text) {
  let body = text.replace(/^﻿/, "");
  let props = "";
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    props = `<details class="props"><summary>Propriétés</summary><pre>${esc(fm[1])}</pre></details>`;
    body = body.slice(fm[0].length);
  }
  const html = md.parse(body);
  return props + DOMPurify.sanitize(html, { FORBID_ATTR: ["style"], FORBID_TAGS: ["style", "img"] });
}

function resolveLink(target, from) {
  if (!target) return from;
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

function decorate(root, from) {
  for (const a of root.querySelectorAll("a.wl")) {
    const p = resolveLink(a.dataset.target, from);
    if (p) a.dataset.path = p; else { a.classList.add("missing"); a.title = "Note absente : cliquer pour la créer"; }
  }
  for (const a of root.querySelectorAll("a[href]:not(.wl)")) {
    const href = a.getAttribute("href");
    if (/^https?:\/\//i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; continue; }
    if (href.startsWith("#")) continue;
    let rel;
    try { rel = decodeURIComponent(href.split("#")[0]); } catch { rel = href; }
    if (/\.md$/i.test(rel)) {
      const parts = (dirName(from) ? dirName(from) + "/" + rel : rel).split("/");
      const out = [];
      for (const seg of parts) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
      const p = C.normPath(out.join("/"));
      a.className = "wl";
      a.dataset.target = p;
      if (S.manifest.notes[p]) a.dataset.path = p; else a.classList.add("missing");
      a.setAttribute("href", "#");
    } else {
      a.replaceWith(Object.assign(document.createElement("span"), { className: "att", textContent: `📎 ${a.textContent} (non synchronisé)` }));
    }
  }
  for (const bq of root.querySelectorAll("blockquote")) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== "P") continue;
    const m = /^\[!([\w-]+)\][+-]?[ \t]*([^\n]*)(?:\n([\s\S]*))?$/.exec(p.innerHTML);
    if (!m) continue;
    bq.classList.add("callout", `callout-${m[1].toLowerCase()}`);
    const title = document.createElement("div");
    title.className = "callout-title";
    title.innerHTML = m[2] || esc(m[1]);
    if (m[3]) p.innerHTML = m[3]; else p.remove();
    bq.prepend(title);
  }
}

$("view").addEventListener("click", (ev) => {
  const a = ev.target.closest("a.wl");
  if (!a) return;
  ev.preventDefault();
  if (a.dataset.path) {
    if (a.dataset.path === S.current?.path && a.dataset.anchor) return scrollToHeading(a.dataset.anchor);
    openNote(a.dataset.path);
  } else {
    offerCreate(a.dataset.target);
  }
});

function scrollToHeading(anchor) {
  const want = fold(anchor);
  const h = [...$("view").querySelectorAll("h1,h2,h3,h4,h5,h6")].find((e) => fold(e.textContent) === want);
  h?.scrollIntoView();
}

// ---------- édition ----------
// ---------- barre d'outils Markdown ----------
const TOOLS = [
  ["B", "Gras", () => wrap("**", "**", "texte en gras")],
  ["I", "Italique", () => wrap("*", "*", "texte en italique")],
  ["S", "Barré", () => wrap("~~", "~~", "texte barré")],
  ["H1", "Titre 1", () => linePrefix("# ")],
  ["H2", "Titre 2", () => linePrefix("## ")],
  ["H3", "Titre 3", () => linePrefix("### ")],
  ["•", "Liste à puces", () => linePrefix("- ")],
  ["1.", "Liste numérotée", () => linePrefix("1. ")],
  ["☐", "Case à cocher", () => linePrefix("- [ ] ")],
  ["❝", "Citation", () => linePrefix("> ")],
  ["[[ ]]", "Lien vers une note", () => wrap("[[", "]]", "Note")],
  ["🔗", "Lien web", () => wrap("[", "](https://)", "texte du lien")],
  ["</>", "Code", () => wrap("`", "`", "code")],
  ["ⓘ", "Encadré (callout)", () => linePrefix("> [!info] ")],
  ["―", "Ligne de séparation", () => insert("\n---\n")],
  ["▦", "Tableau", () => insert("\n| Colonne | Colonne |\n|---|---|\n| | |\n")],
];
function edState() { const ed = $("editor"); return { ed, a: ed.selectionStart, b: ed.selectionEnd, v: ed.value }; }
function commit(ed, v, selA, selB) {
  ed.focus();
  ed.setSelectionRange(0, ed.value.length);
  // execCommand garde l'annulation (Ctrl+Z) ; repli si indisponible.
  if (!document.execCommand?.("insertText", false, v)) ed.value = v;
  ed.setSelectionRange(selA, selB);
  S.dirty = true;
}
function wrap(pre, post, placeholder) {
  const { ed, a, b, v } = edState();
  const sel = v.slice(a, b) || placeholder;
  commit(ed, v.slice(0, a) + pre + sel + post + v.slice(b), a + pre.length, a + pre.length + sel.length);
}
function linePrefix(prefix) {
  const { ed, a, b, v } = edState();
  const start = v.lastIndexOf("\n", a - 1) + 1;
  const block = v.slice(start, b);
  const lines = block.split("\n");
  const all = lines.every((l) => l.startsWith(prefix));
  const out = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l.replace(/^(#{1,6} |- \[ \] |- |1\. |> )/, ""))).join("\n");
  commit(ed, v.slice(0, start) + out + v.slice(b), start, start + out.length);
}
function insert(text) {
  const { ed, a, b, v } = edState();
  commit(ed, v.slice(0, a) + text + v.slice(b), a + text.length, a + text.length);
}
(() => {
  const bar = $("toolbar");
  for (const [label, title, fn] of TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = label; btn.title = title;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", fn);
    bar.append(btn);
  }
})();
const SHORTCUTS = {
  b: () => wrap("**", "**", "texte en gras"),
  i: () => wrap("*", "*", "texte en italique"),
  k: () => wrap("[[", "]]", "Note"),
  s: () => save(),
};
document.addEventListener("keydown", (ev) => {
  if (!S.editing || !(ev.ctrlKey || ev.metaKey)) return;
  const fn = SHORTCUTS[ev.key.toLowerCase()];
  if (fn) { ev.preventDefault(); fn(); }
});

function startEdit(text) {
  S.editing = true;
  S.dirty = false;
  const ed = $("editor");
  ed.value = text;
  ed.hidden = false;
  $("toolbar").hidden = false;
  $("view").hidden = true;
  $("btn-edit").hidden = true;
  $("btn-save").hidden = false;
  $("btn-cancel").hidden = false;
  ed.focus();
}

function stopEdit() {
  S.editing = false;
  S.dirty = false;
  $("editor").hidden = true;
  $("toolbar").hidden = true;
  $("view").hidden = false;
  $("btn-save").hidden = true;
  $("btn-cancel").hidden = true;
  $("btn-edit").hidden = !S.current;
}

$("btn-edit").addEventListener("click", () => { if (S.current && !S.current.readOnly) startEdit(S.current.text); });
$("editor").addEventListener("input", () => { S.dirty = true; });
$("btn-cancel").addEventListener("click", () => {
  if (S.dirty && !confirm("Abandonner les modifications ?")) return;
  if (S.current?.isNew) return showHome();
  stopEdit();
  showNote();
});
$("btn-save").addEventListener("click", () => save());
window.addEventListener("beforeunload", (ev) => { if (S.editing && S.dirty) { ev.preventDefault(); ev.returnValue = ""; } });

async function ensureToken() {
  if (S.token) return true;
  const res = await ask("Jeton GitHub", `
    <p>Pour enregistrer, la page a besoin d'un jeton GitHub « fine-grained » limité au dépôt
    <b>${esc(cfg.owner)}/${esc(DATA_REPO)}</b>, avec la permission <i>Contents : Read and write</i>.</p>
    <label for="tok">Jeton</label><input id="tok" name="token" type="password" autocomplete="off" spellcheck="false">
    <label><input name="remember" type="checkbox"> Mémoriser sur cet appareil (chiffré avec ta phrase de passe)</label>`,
  [["cancel", "Annuler"], ["ok", "Valider", true]], { input: true });
  if (res.choice !== "ok" || !res.token.trim()) return false;
  S.token = res.token.trim();
  try {
    await api("");
  } catch (err) {
    S.token = null;
    status(err.message, "error");
    return false;
  }
  if (res.remember) {
    const blob = await C.encryptBytes(S.keys.local, C.utf8(S.token), "token");
    localStorage.setItem(TOKEN_KEY, C.toBase64(blob));
  }
  return true;
}

async function save() {
  if (!S.editing || !S.current) return;
  if (!(await ensureToken())) return;
  const text = $("editor").value;
  const wanted = S.current.path;
  const known = !!S.manifest.notes[wanted];
  $("btn-save").disabled = true;
  status("Chiffrement et enregistrement…");
  try {
    const res = await commitNote(wanted, C.utf8(text), S.current.sha, !!S.current.isNew);
    if (!res) { status("Enregistrement annulé."); return; }
    S.cache.set(res.path, { path: res.path, sha: res.sha, valid: true, text });
    S.current = { path: res.path, sha: res.sha, text };
    stopEdit();
    renderRecents();
    if (!known || res.copied) renderTree();   // l'arborescence ne change que si une note apparaît
    showNote();
    status(res.copied ? `Enregistré comme copie : « ${baseName(res.path)} ».` : "Enregistré.");
  } catch (err) {
    status(err.message, "error");
  } finally {
    $("btn-save").disabled = false;
  }
}

// Un enregistrement = un commit (note + manifeste), accepté seulement s'il prolonge la branche.
async function commitNote(path, bytes, baseSha, isNew) {
  let target = path;
  let expected = isNew ? undefined : baseSha;
  let copied = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = (await api(`/git/ref/heads/${cfg.branch}`)).data.object.sha;
    const treeSha = (await api(`/git/commits/${head}`)).data.tree.sha;
    const manifest = head === S.head && S.manifest
      ? structuredClone(S.manifest)
      : await C.decryptManifest(S.keys.enc, await raw(head, "manifest.bin"));
    const cur = manifest.notes[target]?.sha;
    if (cur !== expected && cur !== await C.sha256Hex(bytes)) {
      const choice = await ask("Modifiée ailleurs", `
        <p>« ${esc(baseName(target))} » ${isNew ? "existe déjà" : "a été modifiée ailleurs depuis que tu l'as ouverte"}.</p>
        <p>Le plus sûr : enregistrer ta version comme copie, puis comparer.</p>`,
      [["cancel", "Annuler"], ["overwrite", "Écraser l'autre version"], ["copy", "Enregistrer une copie", true]]);
      if (choice === "copy") {
        let n = 1;
        do { target = C.conflictPath(path, n === 1 ? "conflit" : `conflit ${n}`); n++; } while (manifest.notes[target]);
        copied = true;
        expected = undefined;
        continue;
      }
      if (choice !== "overwrite") return null;
      expected = cur;
    }
    const id = await C.noteId(S.keys.name, target);
    const sha = await C.sha256Hex(bytes);
    manifest.notes[target] = { id, sha, size: bytes.length, mtime: Date.now() };
    const noteBlob = await C.encryptBytes(S.keys.enc, bytes, C.noteAad(id));
    const manifestBlob = await C.encryptManifest(S.keys.enc, manifest);
    const b1 = (await api("/git/blobs", { method: "POST", body: { content: C.toBase64(noteBlob), encoding: "base64" } })).data.sha;
    const b2 = (await api("/git/blobs", { method: "POST", body: { content: C.toBase64(manifestBlob), encoding: "base64" } })).data.sha;
    const tree = (await api("/git/trees", { method: "POST", body: { base_tree: treeSha, tree: [
      { path: C.noteFile(id), mode: "100644", type: "blob", sha: b1 },
      { path: "manifest.bin", mode: "100644", type: "blob", sha: b2 },
    ] } })).data.sha;
    const date = new Date().toISOString();
    const who = { ...cfg.author, date };
    const commit = (await api("/git/commits", { method: "POST",
      body: { message: "web : 1 note", tree, parents: [head], author: who, committer: who } })).data.sha;
    const upd = await api(`/git/refs/heads/${cfg.branch}`, { method: "PATCH", body: { sha: commit, force: false }, ok: [409, 422] });
    if (upd.status === 409 || upd.status === 422) { status("Le carnet a changé entre-temps, nouvelle tentative…"); continue; }
    S.head = S.ref = commit;
    S.fallback = false;
    setManifest(manifest);
    return { path: target, sha, copied };
  }
  throw new Error("Le carnet change trop vite sur GitHub : réessaie dans un instant.");
}

// ---------- nouvelle note ----------
function cleanNewPath(folder, name) {
  const n = name.trim().replace(/\.md$/i, "");
  if (!n || /[\\:*?"<>|]/.test(n) || n.includes("/")) return null;
  const f = C.normPath(folder.trim()).replace(/\/+$/, "");
  if (f.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;
  return (f ? f + "/" : "") + n + ".md";
}

async function offerCreate(target, folder, { lockFolder = false } = {}) {
  const defFolder = folder ?? (S.current ? dirName(S.current.path) : "");
  const res = await ask("Nouvelle note", `
    <label for="nf">Dossier</label><input id="nf" name="folder" type="text" value="${esc(defFolder)}" spellcheck="false"${lockFolder ? " readonly" : ""}>
    <label for="nn">Nom</label><input id="nn" name="name" type="text" value="${esc(target ? baseName(target) : "")}">`,
  [["cancel", "Annuler"], ["ok", "Créer", true]], { input: true });
  if (res.choice !== "ok") return;
  startNew(res.folder, res.name);
}

function startNew(folder, name) {
  const path = cleanNewPath(folder, name);
  if (!path) return status("Nom ou dossier invalide (caractères interdits, ou dossier caché).", "error");
  const existing = Object.keys(S.manifest.notes).find((p) => p.toLowerCase() === path.toLowerCase());
  if (existing) return openNote(existing);
  if (S.current) history.pushState({ path }, "", location.pathname);
  S.current = { path, sha: undefined, text: `# ${baseName(path)}\n\n`, isNew: true };
  showNote();
  startEdit(S.current.text);
}
$("btn-new").addEventListener("click", () => offerCreate(""));

// ---------- rechargement ----------
$("btn-refresh").addEventListener("click", async () => {
  if (S.editing && S.dirty) return status("Enregistre ou annule d'abord ta modification.", "error");
  status("Rechargement…");
  try {
    const head = await latestHead();
    const ref = head || cfg.branch;
    setManifest(await C.decryptManifest(S.keys.enc, await raw(ref, "manifest.bin")));
    Object.assign(S, { ref, head, fallback: !head });
    renderSide();
    if (S.current && S.manifest.notes[S.current.path]) await openNote(S.current.path, { push: false });
    else showHome();
    status("Carnet à jour.");
  } catch (err) {
    status(err.message, "error");
  }
});

// ---------- divers ----------
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") document.body.classList.remove("side-open");
});
window.addEventListener("pageshow", () => { if (!S.keys) $("pass")?.focus(); });
