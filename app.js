// Carnet — interface : panneaux, onglets, notes, édition, recherche, réglages.
// Les données (GitHub, chiffrement) sont dans store.js ; le rendu dans render.js ; les panneaux dans panels.js.
import cfg from "./config.js";
import * as C from "./crypto.js";
import * as store from "./store.js";
import { renderMarkdown, renderChunks, renderChunk, decorate, esc, toggleTask } from "./render.js";
import * as P from "./panels.js";
import { attachEditor, buildToolbar } from "./editor.js";
import * as TTS from "./tts.js";
import { parseQuery, matchRanges } from "./search.js";
import * as Night from "./night.js";

const { baseName, dirName, fold } = store;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const icon = (name) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-" + name); s.append(u); return s; };
const iconBtn = (name, title, cls = "") => { const b = el("button", { className: "icon " + cls, title, type: "button" }); b.setAttribute("aria-label", title); b.append(icon(name)); return b; };
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
const narrow = () => matchMedia("(max-width: 900px)").matches;

// GitHub Pages ne permet pas l'en-tête frame-ancestors : la page refuse elle-même d'être affichée
// dans le cadre d'un autre site (qui pourrait piéger la saisie de la phrase de passe).
if (window.top !== window.self) {
  document.body.textContent = "Le carnet ne s'affiche pas dans le cadre d'un autre site. Ouvre-le directement.";
  throw new Error("Affichage dans un cadre refusé.");
}

// ---------- préférences d'affichage (en clair : appliquées avant le déverrouillage) ----------
const PREFS_KEY = "carnet.prefs";
const DEFAULT_PREFS = {
  theme: "auto", font: "sans", size: 17, width: 760, line: 1.65,
  lockMinutes: cfg.lockMinutes ?? 30, hiddenLockMinutes: cfg.hiddenLockMinutes ?? 5,
  voice: "", rate: 1, pitch: 1, ttsEngine: "", piperVoice: "fr_FR-siwis-medium", piperSpeaker: 0, onlineVoiceOk: false,
  nightAuto: false, nightFrom: "21:00", nightTo: "07:00", nightDim: 0, nightOverride: null,
  right: true, side: true, sideView: "files", editPreview: false,
};
let prefs = { ...DEFAULT_PREFS };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch {}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} applyPrefs(); }
const THEME_COLORS = { light: "#8a2b1e", dark: "#1c1c1f", sepia: "#8a3a1e", night: "#000000" };
function applyPrefs() {
  const r = document.documentElement;
  const theme = Night.effectiveTheme(prefs);
  r.dataset.theme = theme;
  r.style.setProperty("--night-dim", theme === "night" ? String(prefs.nightDim || 0) : "0");
  const dark = theme === "dark" || theme === "night" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme] || (dark ? THEME_COLORS.dark : THEME_COLORS.light));
  document.querySelector('.rb[data-cmd="night"]')?.classList.toggle("on", theme === "night");
  r.dataset.font = prefs.font;
  r.style.setProperty("--read-size", prefs.size + "px");
  r.style.setProperty("--read-width", prefs.width + "px");
  r.style.setProperty("--read-line", String(prefs.line));
  document.body.classList.toggle("no-side", !prefs.side);
  document.body.classList.toggle("no-right", !prefs.right);
}
applyPrefs();
// Mode nuit programmé : vérifié chaque minute et au retour sur l'onglet.
setInterval(applyPrefs, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) applyPrefs(); });
function toggleNight() {
  Object.assign(prefs, Night.toggledOverride(prefs));
  savePrefs();
}

// ---------- préférences privées (chiffrées avec la clé locale, après déverrouillage) ----------
let priv = null;
const DEFAULT_PRIV = () => ({ favorites: [], daily: { folder: "Journal", format: "AAAA-MM-JJ", template: "" }, views: [], searches: [], session: null });
let privTimer = 0;
function savePriv() { clearTimeout(privTimer); privTimer = setTimeout(() => store.savePrivate(priv), 400); }

// ---------- état de l'interface ----------
let panes = [];
let activePane = null;
let tabSeq = 0;
const reader = new TTS.Reader((state) => updateTtsBar(state));
reader.onError = (err) => status("Lecture à voix haute : " + err.message, "error");
let readerTab = null;

function status(msg, kind = "") {
  const s = $("status-msg");
  s.textContent = msg || "";
  s.className = kind;
}
store.events.addEventListener("status", (e) => status(e.detail));

// ---------- boîtes de dialogue ----------
function ask(title, html, buttons, { input, wide } = {}) {
  const dlg = $("dlg");
  dlg.classList.toggle("wide", !!wide);
  $("dlg-title").textContent = title;
  $("dlg-body").innerHTML = html;
  const box = $("dlg-buttons");
  box.innerHTML = "";
  // Ordre inversé dans le document (le bouton principal en premier, donc choisi par Entrée),
  // rétabli à l'écran par flex-direction: row-reverse.
  for (const [value, label, primary] of [...buttons].reverse()) {
    const b = el("button", { value, textContent: label });
    if (primary) b.className = "primary";
    box.append(b);
  }
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const vals = input ? Object.fromEntries([...dlg.querySelectorAll("input, select, textarea")].filter((i) => i.name)
        .map((i) => [i.name, i.type === "checkbox" ? i.checked : i.value])) : null;
      resolve(input ? { choice: dlg.returnValue, ...vals } : dlg.returnValue);
    };
    dlg.returnValue = "";
    dlg.showModal();
    (dlg.querySelector("input:not([type=checkbox]), select") || box.querySelector(".primary"))?.focus();
  });
}
const confirmBox = async (title, html, okLabel = "Confirmer") => (await ask(title, html, [["cancel", "Annuler"], ["ok", okLabel, true]])) === "ok";

function onConflict(path, isNew) {
  return ask("Modifiée ailleurs", `
    <p>« ${esc(baseName(path))} » ${isNew ? "existe déjà" : "a été modifiée ailleurs depuis que tu l'as ouverte"}.</p>
    <p>Le plus sûr : enregistrer ta version comme copie, puis comparer.</p>`,
  [["cancel", "Annuler"], ["overwrite", "Écraser l'autre version"], ["copy", "Enregistrer une copie", true]]);
}

async function ensureToken() {
  if (store.S.token) return true;
  const res = await ask("Jeton GitHub", `
    <p>Pour enregistrer, la page a besoin d'un jeton GitHub « fine-grained » limité au dépôt
    <b>${esc(store.repoName())}</b>, avec la permission <i>Contents : Read and write</i>.</p>
    <label for="tok">Jeton</label><input id="tok" name="token" type="password" autocomplete="off" spellcheck="false">
    <label class="check"><input name="remember" type="checkbox"> Mémoriser sur cet appareil (chiffré avec ta phrase de passe)</label>`,
  [["cancel", "Annuler"], ["ok", "Valider", true]], { input: true });
  if (res.choice !== "ok" || !res.token.trim()) return false;
  try { await store.setToken(res.token.trim(), res.remember); return true; }
  catch (err) { status(err.message, "error"); return false; }
}

// ---------- déverrouillage ----------
// Appli installable et lecture hors ligne (https, ou localhost pour les tests).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

$("lock").hidden = false;
$("unlock-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("lock-msg");
  const btn = $("unlock-form").querySelector("button");
  msg.className = "msg";
  msg.textContent = "Déverrouillage… (quelques secondes)";
  btn.disabled = true;
  try {
    await store.unlock($("pass").value);
    $("pass").value = "";
    msg.textContent = "";
    priv = { ...DEFAULT_PRIV(), ...(await store.loadPrivate() || {}) };
    $("lock").hidden = true;
    $("app").hidden = false;
    buildUi();
    if (store.S.offline) status("Hors ligne : seules les notes déjà lues sur cet appareil sont disponibles.", "warn");
    else if (store.S.fallback) status("GitHub limite les lectures sans jeton depuis ce réseau : les données peuvent avoir quelques minutes de retard.", "warn");
    if (store.S.header.kdf.iterations < C.MIN_SAFE_ITERATIONS) status("Attention : ce carnet utilise une dérivation de clé faible (mode test).", "warn");
    await restoreSession();
    await offerDrafts();
    touch();
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- verrouillage (manuel, inactivité, arrière-plan) ----------
let lastActivity = Date.now();
function touch() { lastActivity = Date.now(); }
for (const ev of ["keydown", "pointerdown", "scroll", "touchstart"]) document.addEventListener(ev, touch, { passive: true, capture: true });
setInterval(() => {
  if (store.S.keys && reader.state !== "playing" && Date.now() - lastActivity > prefs.lockMinutes * 60000) lock("Verrouillé après inactivité.");
}, 20000);
let hiddenSince = 0, hiddenTimer = 0;
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  const ms = prefs.hiddenLockMinutes * 60000;
  if (document.hidden) {
    hiddenSince = Date.now();
    hiddenTimer = setTimeout(() => { if (store.S.keys && reader.state !== "playing") lock("Verrouillé après un passage en arrière-plan."); }, ms);
  } else if (store.S.keys && hiddenSince && reader.state !== "playing" && Date.now() - hiddenSince >= ms) {
    lock("Verrouillé après un passage en arrière-plan.");
  }
});

async function lock(message = "") {
  reader.stop();
  if (store.S.keys) {
    await saveDraftsNow();
    if (allTabs().some((t) => t.dirty)) message += " Tes brouillons sont gardés (chiffrés) et te seront proposés au déverrouillage.";
    clearTimeout(sessTimer);
    snapshotSession();
    await store.savePrivate(priv);
  }
  clearTimeout(privTimer);
  store.forget();
  priv = null;
  for (const t of allTabs()) t.completion?.destroy();
  panes = [];
  activePane = null;
  $("panes").innerHTML = "";
  $("files").innerHTML = "";
  for (const v of document.querySelectorAll(".side-view:not([data-view=files])")) v.innerHTML = "";
  for (const id of ["r-outline", "r-backlinks", "r-infos"]) $(id).innerHTML = "";
  $("filter").value = "";
  $("app").hidden = true;
  $("lock").hidden = false;
  $("lock-msg").className = "msg";
  $("lock-msg").textContent = message.trim();
  if ($("dlg").open) $("dlg").close();
  if ($("qs").open) $("qs").close();
  $("pass").focus();
}

// ---------- construction de l'interface ----------
let side = {};
function buildUi() {
  side.search = P.searchPanel(document.querySelector('.side-view[data-view=search]'), {
    rememberSearch, recentSearches: () => priv.searches, searchFor,
  });
  side.tags = P.tagsPanel(document.querySelector('.side-view[data-view=tags]'), { searchFor });
  renderFiles();
  renderBaseList();
  showSide(prefs.sideView || "files", { keep: true });
  activePane = makePane();
  updateSyncInfo();
}

function showSide(view, { keep = false, focus = false } = {}) {
  const same = prefs.sideView === view && prefs.side;
  if (narrow() && same && !keep && !focus && document.body.classList.contains("side-open")) { document.body.classList.remove("side-open"); return; }
  if (same && !keep && !focus && !narrow()) { prefs.side = false; savePrefs(); return; }
  prefs.sideView = view;
  prefs.side = true;
  savePrefs();
  for (const v of document.querySelectorAll(".side-view")) v.hidden = v.dataset.view !== view;
  for (const b of document.querySelectorAll(".rb[data-view]")) b.classList.toggle("on", b.dataset.view === view);
  if (view === "tags") side.tags.render();
  if (view === "base") renderBaseList();
  if (narrow() && !keep) document.body.classList.add("side-open");
  if (view === "search" && (focus || !keep)) side.search.focus();
}

function searchFor(q) { showSide("search", { focus: true }); side.search.set(q); }
function rememberSearch(q) {
  priv.searches = [q, ...priv.searches.filter((x) => x !== q)].slice(0, 12);
  savePriv();
}

for (const b of document.querySelectorAll(".rb[data-view]")) b.addEventListener("click", () => showSide(b.dataset.view));
for (const b of document.querySelectorAll(".rb[data-cmd]")) b.addEventListener("click", (ev) => runCommand(b.dataset.cmd, ev));
$("btn-side").addEventListener("click", () => document.body.classList.toggle("side-open"));
$("status-sync").addEventListener("click", () => runCommand("reload"));

store.events.addEventListener("manifest", () => {
  if (!priv) return;
  renderFiles();
  updateSyncInfo();
  if (prefs.sideView === "tags") side.tags?.render();
  for (const t of allTabs()) if (t.kind === "base") t.base?.refresh();
  updateRight();
});

function updateSyncInfo() {
  const ix = store.S.manifest?.index;
  const n = Object.keys(store.notes()).length;
  $("status-sync").textContent = `${n.toLocaleString("fr-FR")} notes` + (ix ? "" : " · index absent") + (store.S.offline ? " · hors ligne" : "");
  $("status-sync").title = (ix ? `Index de recherche construit le ${new Date(ix.built).toLocaleString("fr-FR")}` : "Index de recherche pas encore construit (synchronisation du PC)") + "\nCliquer pour recharger le carnet.";
}

// ---------- fichiers : favoris, arborescence, récents ----------
function renderFiles() {
  const box = $("files");
  box.innerHTML = "";
  const q = fold($("filter").value.trim());
  const notes = store.notes();
  if (q) {
    const words = q.split(/\s+/);
    const hits = Object.keys(notes).filter((p) => { const f = fold(p); return words.every((w) => f.includes(w)); });
    hits.sort((a, b) => collator.compare(baseName(a), baseName(b)));
    box.append(el("h3", { textContent: `${hits.length} résultat${hits.length > 1 ? "s" : ""}` }));
    for (const p of hits.slice(0, 300)) box.append(P.noteLink(p, { sub: dirName(p) }));
    if (hits.length > 300) box.append(el("div", { className: "hint", textContent: "… précise le filtre pour voir la suite." }));
    if (!hits.length) box.append(el("button", { className: "linkish", textContent: `Chercher « ${$("filter").value.trim()} » dans le contenu`, onclick: () => searchFor($("filter").value.trim()) }));
    return;
  }
  const favs = priv.favorites.filter((p) => notes[p]);
  if (favs.length) {
    box.append(el("h3", { textContent: "Favoris" }));
    for (const p of favs) box.append(P.noteLink(p, { cls: "fav" }));
  }
  const tree = el("div", { className: "tree" });
  const h = el("h3", { textContent: `Toutes les notes (${Object.keys(notes).length})` });
  h.append(menuButton(""));
  box.append(h, tree);
  const root = { dirs: new Map(), notes: [] };
  for (const p of Object.keys(notes)) {
    let node = root;
    for (const d of p.split("/").slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), notes: [] });
      node = node.dirs.get(d);
    }
    node.notes.push(p);
  }
  const build = (node, container, prefix = "") => {
    for (const [name, child] of [...node.dirs].sort((a, b) => collator.compare(a[0], b[0]))) {
      const det = el("details");
      const folder = prefix ? `${prefix}/${name}` : name;
      const sum = el("summary", {}, el("span", { textContent: name }), menuButton(folder));
      const inner = el("div");
      det.append(sum, inner);
      // Contenu construit à la première ouverture : l'arborescence reste légère.
      det.addEventListener("toggle", () => { if (det.open && !inner.childElementCount) build(child, inner, folder); });
      container.append(det);
    }
    for (const p of node.notes.sort((a, b) => collator.compare(baseName(a), baseName(b)))) container.append(P.noteLink(p));
  };
  build(root, tree);
  box.append(el("h3", { textContent: "Récentes" }));
  const recent = Object.entries(notes).sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0)).slice(0, 12);
  for (const [p] of recent) box.append(P.noteLink(p, { sub: dirName(p) }));
  markActiveLinks();
}
$("filter").addEventListener("input", () => renderFiles());
$("filter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const a = $("files").querySelector("a[data-path]"); if (a) openPath(a.dataset.path); }
});

function menuButton(folder) {
  const b = el("button", { className: "menu-btn", textContent: "⋯", title: "Actions sur ce dossier", type: "button" });
  b.addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    popMenu(b, folder || "la racine", [
      ["Nouvelle note ici", () => offerCreate("", folder, { lockFolder: true })],
      ["Nouveau dossier ici", () => offerFolder(folder)],
      ["Rechercher dans ce dossier", () => searchFor(`dossier:"${folder}" `)],
      ["Tableau de ce dossier", () => openBase({ ...P.defaultView(folder || "Racine"), q: folder ? `dossier:"${folder}"` : "" })],
    ]);
  });
  return b;
}

function popMenu(anchor, head, items) {
  closeMenu();
  const m = el("div", { id: "menu", className: "menu", role: "menu" });
  if (head) m.append(el("div", { className: "menu-head", textContent: head }));
  for (const [label, fn, opts = {}] of items) {
    if (!label) { m.append(el("hr")); continue; }
    const it = el("button", { textContent: label, type: "button", className: opts.danger ? "danger" : "" });
    it.addEventListener("click", () => { closeMenu(); fn(); });
    m.append(it);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.max(8, Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8))}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
function closeMenu() { $("menu")?.remove(); }

// ---------- panneaux et onglets ----------
const allTabs = () => panes.flatMap((p) => p.tabs);
const activeTab = () => activePane?.active || null;

function makePane() {
  const pane = { tabs: [], active: null };
  pane.el = el("section", { className: "pane" });
  pane.tabsEl = el("div", { className: "tabbar", role: "tablist" });
  pane.bodyEl = el("div", { className: "pane-body" });
  pane.el.append(pane.tabsEl, pane.bodyEl);
  pane.el.addEventListener("pointerdown", () => setActivePane(pane), true);
  pane.el.addEventListener("focusin", () => setActivePane(pane));
  $("panes").append(pane.el);
  panes.push(pane);
  document.body.classList.toggle("split", panes.length > 1);
  openHome(pane);
  return pane;
}

function setActivePane(pane) {
  if (activePane === pane) return;
  activePane = pane;
  for (const p of panes) p.el.classList.toggle("active", p === pane);
  updateRight();
  updateStatusNote();
  markActiveLinks();
}

function otherPane() {
  if (narrow()) return activePane;
  if (panes.length < 2) { const p = makePane(); return p; }
  return panes.find((p) => p !== activePane);
}

function newTab(pane, kind, props = {}) {
  const tab = { id: ++tabSeq, pane, kind, back: [], fwd: [], dirty: false, editing: false, ...props };
  tab.el = el("div", { className: "tabview" });
  pane.bodyEl.append(tab.el);
  // Un onglet d'accueil vide est remplacé par le nouveau.
  const home = pane.tabs.find((t) => t.kind === "home");
  if (home && kind !== "home") closeTab(home, { force: true, keepPane: true });
  const i = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length;
  pane.tabs.splice(i, 0, tab);
  return tab;
}

function activateTab(tab) {
  const pane = tab.pane;
  pane.active = tab;
  for (const t of pane.tabs) t.el.hidden = t !== tab;
  setActivePane(pane);
  renderTabbar(pane);
  updateRight();
  updateStatusNote();
  markActiveLinks();
  saveSession();
  // Les onglets restaurés ne sont lus qu'à leur première ouverture.
  if (tab.pendingLoad) { tab.pendingLoad = false; loadInto(tab, tab.path); }
}

function tabTitle(t) {
  if (t.kind === "home") return "Accueil";
  if (t.kind === "base") return t.view?.name || "Base";
  return t.path ? baseName(t.path) : "Nouvelle note";
}

function renderTabbar(pane) {
  const bar = pane.tabsEl;
  bar.innerHTML = "";
  for (const t of pane.tabs) {
    const b = el("div", { className: "tab" + (t === pane.active ? " on" : "") + (t.dirty ? " dirty" : ""), role: "tab", title: t.path || tabTitle(t), tabIndex: 0 });
    b.setAttribute("aria-selected", String(t === pane.active));
    const kindIcon = t.kind === "base" ? icon("table") : t.kind === "home" ? icon("files") : null;
    if (kindIcon) b.append(kindIcon);
    b.append(el("span", { className: "tab-t", textContent: tabTitle(t) }));
    const x = iconBtn("x", "Fermer l'onglet (Alt+W)", "tab-x");
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
    b.append(x);
    b.addEventListener("click", () => activateTab(t));
    b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    b.addEventListener("keydown", (e) => { if (e.key === "Enter") activateTab(t); });
    bar.append(b);
  }
  const plus = iconBtn("plus", "Nouvel onglet (Ctrl+K)", "tab-new");
  plus.addEventListener("click", () => { setActivePane(pane); openQuickSwitcher({ where: "tab" }); });
  bar.append(plus);
  if (panes.length > 1) {
    const x = iconBtn("x", "Fermer ce panneau", "pane-x");
    x.addEventListener("click", () => closePane(pane));
    bar.append(x);
  }
  bar.querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function closeTab(tab, { force = false, keepPane = false } = {}) {
  if (!force && tab.dirty && !(await confirmBox("Modifications non enregistrées", `<p>Fermer « ${esc(tabTitle(tab))} » sans enregistrer ? Le brouillon sera supprimé.</p>`, "Fermer sans enregistrer"))) return;
  if (readerTab === tab) reader.stop();
  tab.completion?.destroy();
  tab.cleanup?.();
  const pane = tab.pane;
  const i = pane.tabs.indexOf(tab);
  pane.tabs.splice(i, 1);
  tab.el.remove();
  if (tab.dirty) saveDraftsNow();
  if (pane.active === tab) pane.active = null;
  if (!pane.tabs.length) {
    if (!keepPane && panes.length > 1) return closePane(pane);
    if (!keepPane) openHome(pane);
  } else if (!pane.active) activateTab(pane.tabs[Math.min(i, pane.tabs.length - 1)]);
  renderTabbar(pane);
  saveSession();
}

function closePane(pane) {
  if (panes.length < 2) return;
  const other = panes.find((p) => p !== pane);
  // Les onglets passent dans l'autre panneau (rien n'est perdu).
  for (const t of pane.tabs.filter((t) => t.kind !== "home")) { t.pane = other; other.bodyEl.append(t.el); t.el.hidden = true; other.tabs.push(t); }
  other.tabs = other.tabs.filter((t) => t.kind !== "home" || other.tabs.length === 1);
  pane.el.remove();
  panes = panes.filter((p) => p !== pane);
  document.body.classList.toggle("split", panes.length > 1);
  activePane = null;
  activateTab(other.active && other.tabs.includes(other.active) ? other.active : other.tabs[other.tabs.length - 1]);
  for (const p of panes) renderTabbar(p);
}

function toggleSplit() {
  if (narrow()) return status("Vue scindée : écran trop étroit.");
  if (panes.length > 1) return closePane(panes[1]);
  const cur = activeTab();
  const p = makePane();
  if (cur?.kind === "note" && cur.path && store.exists(cur.path)) openPath(cur.path, { pane: p, where: "here" });
}

// ---------- accueil ----------
function openHome(pane) {
  const t = newTab(pane, "home");
  const notes = store.notes();
  const recent = Object.entries(notes).sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0)).slice(0, 10).map(([p]) => p);
  const favs = (priv?.favorites || []).filter((p) => notes[p]);
  const box = el("div", { className: "home" });
  box.innerHTML = `<h1>Carnet</h1><p class="hint">${Object.keys(notes).length.toLocaleString("fr-FR")} notes chiffrées.</p>`;
  const acts = el("div", { className: "home-actions" });
  for (const [label, cmd, ic, kbd] of [["Aller à une note", "switcher", "search", "Ctrl+K"], ["Rechercher", "search", "search", "Ctrl+Maj+F"],
    ["Note du jour", "daily", "today", "Ctrl+Maj+D"], ["Nouvelle note", "new", "plus", "Ctrl+Maj+N"], ["Tableau des notes", "base", "table", ""]]) {
    const b = el("button", { className: "home-act", type: "button" }, icon(ic), el("span", { textContent: label }), kbd ? el("kbd", { textContent: kbd }) : "");
    b.addEventListener("click", (e) => runCommand(cmd, e));
    acts.append(b);
  }
  box.append(acts);
  const cols = el("div", { className: "home-cols" });
  if (favs.length) cols.append(el("div", {}, el("h3", { textContent: "Favoris" }), ...favs.map((p) => P.noteLink(p, { sub: dirName(p) }))));
  cols.append(el("div", {}, el("h3", { textContent: "Modifiées récemment" }), ...recent.map((p) => P.noteLink(p, { sub: dirName(p) }))));
  box.append(cols);
  t.el.append(el("div", { className: "doc-scroll" }, box));
  activateTab(t);
  return t;
}

// ---------- notes ----------
function buildNoteView(tab) {
  const head = el("header", { className: "doc-head" });
  const nav = el("div", { className: "doc-nav" });
  const back = iconBtn("back", "Précédente (Alt+←)"), fwd = iconBtn("fwd", "Suivante (Alt+→)");
  back.addEventListener("click", () => goHistory(tab, -1));
  fwd.addEventListener("click", () => goHistory(tab, 1));
  nav.append(back, fwd);
  const crumbs = el("div", { className: "crumbs" });
  const actions = el("div", { className: "doc-actions" });
  const bEdit = el("button", { type: "button", className: "b-edit", title: "Modifier (Ctrl+E)" }, icon("edit"), el("span", { textContent: "Modifier" }));
  const bSave = el("button", { type: "button", className: "primary b-save", textContent: "Enregistrer", title: "Ctrl+S", hidden: true });
  const bCancel = el("button", { type: "button", className: "b-cancel", textContent: "Annuler", hidden: true });
  const bPrev = iconBtn("eye", "Aperçu à côté du texte", "b-prev");
  bPrev.hidden = true;
  const bTts = iconBtn("speak", "Lire à voix haute", "b-tts");
  const bFav = iconBtn("star", "Favori", "b-fav");
  const bMore = iconBtn("more", "Autres actions", "b-more");
  actions.append(bEdit, bSave, bCancel, bPrev, bTts, bFav, bMore);
  head.append(nav, crumbs, actions);

  const ttsBar = el("div", { className: "tts-bar", hidden: true, role: "toolbar" });
  ttsBar.setAttribute("aria-label", "Lecture à voix haute");
  const tb = (ic, title, fn) => { const b = iconBtn(ic, title); b.addEventListener("click", fn); return b; };
  const tPlay = tb("pause", "Pause / reprise (Alt+P)", () => reader.toggle());
  const tVoice = el("select", { className: "tts-voice", title: "Voix" });
  const tRate = el("select", { title: "Vitesse" });
  for (const r of RATES) tRate.append(el("option", { value: r, textContent: `×${r}`, selected: r === prefs.rate }));
  ttsBar.append(
    el("span", { className: "tts-label", textContent: "Lecture" }),
    tb("prev", "Paragraphe précédent (Alt+Maj+J) — Maj+clic : section", (e) => reader.skip(-1, e.shiftKey ? "section" : "block")),
    tb("back", "Phrase précédente (Alt+J)", () => reader.skip(-1)),
    tPlay,
    tb("fwd", "Phrase suivante (Alt+L)", () => reader.skip(1)),
    tb("next", "Paragraphe suivant (Alt+Maj+L) — Maj+clic : section", (e) => reader.skip(1, e.shiftKey ? "section" : "block")),
    tb("stop", "Arrêter (Alt+K)", () => reader.stop()),
    tVoice, tRate,
    el("span", { className: "tts-hint hint", textContent: "Clic sur un paragraphe : y aller" }));
  tRate.addEventListener("change", () => { prefs.rate = Number(tRate.value); savePrefs(); reader.setRate(prefs.rate); syncRateSelects(); });
  tVoice.addEventListener("focus", () => fillVoiceSelect(tVoice));
  tVoice.addEventListener("change", () => changeVoice(tVoice.value));
  const banner = el("div", { className: "doc-banner", hidden: true });
  const toolbar = el("div", { className: "toolbar", hidden: true, role: "toolbar" });
  toolbar.setAttribute("aria-label", "Mise en forme");
  const main = el("div", { className: "doc-main" });
  const scroll = el("div", { className: "doc-scroll" });
  const view = el("article", { className: "note" });
  scroll.append(view);
  const editor = el("textarea", { className: "editor", hidden: true, spellcheck: true });
  editor.setAttribute("aria-label", "Texte de la note");
  const pscroll = el("div", { className: "doc-scroll preview-scroll", hidden: true });
  const preview = el("article", { className: "note preview" });
  pscroll.append(preview);
  main.append(scroll, editor, pscroll);
  tab.el.append(head, ttsBar, banner, toolbar, main);
  Object.assign(tab, { ui: { back, fwd, crumbs, bEdit, bSave, bCancel, bPrev, bTts, bFav, bMore, ttsBar, tPlay, tVoice, tRate, banner, toolbar, scroll, view, editor, pscroll, preview } });

  buildToolbar(toolbar, () => editor);
  tab.completion = attachEditor(editor, { suggest: linkSuggestions });
  let pv = 0;
  editor.addEventListener("input", () => {
    if (!tab.dirty) { tab.dirty = true; renderTabbar(tab.pane); updateEditButtons(tab); }
    if (!pscroll.hidden) { clearTimeout(pv); pv = setTimeout(() => renderPreview(tab), 250); }
  });
  bEdit.addEventListener("click", () => startEdit(tab));
  bSave.addEventListener("click", () => save(tab));
  bCancel.addEventListener("click", () => cancelEdit(tab));
  bPrev.addEventListener("click", () => { prefs.editPreview = pscroll.hidden; savePrefs(); setPreview(tab, prefs.editPreview); });
  bTts.title = "Lire à voix haute : depuis l'endroit affiché, ou la sélection. Alt+clic sur un paragraphe : lire à partir de là.";
  bTts.addEventListener("click", () => {
    if (readerTab === tab && reader.state !== "stopped") return reader.stop();
    const sel = getSelection();
    const range = sel.rangeCount && !sel.isCollapsed && view.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    startReading(tab, range ? { range } : {});
  });
  // Pendant la lecture, un clic sur un paragraphe y fait sauter ; Alt+clic lance la lecture à partir de là.
  view.addEventListener("click", (e) => {
    if (e.target.closest("a, input, button, summary, label") || !getSelection().isCollapsed) return;
    const reading = readerTab === tab && reader.state !== "stopped";
    if (!reading && !e.altKey) return;
    e.preventDefault();
    if (reading) reader.jumpToElement(e.target);
    else startReading(tab, { from: e.target });
  });
  bFav.addEventListener("click", () => toggleFavorite(tab.path));
  bMore.addEventListener("click", () => noteMenu(tab, bMore));
  view.addEventListener("change", (e) => { if (e.target.matches("input[data-task]")) toggleTaskBox(tab, e.target); });
}

function linkSuggestions(q) {
  const notes = store.notes();
  const h = q.indexOf("#");
  if (h >= 0) {
    const p = store.resolveLink(q.slice(0, h).trim(), activeTab()?.path || "");
    if (!p) return [];
    const want = fold(q.slice(h + 1));
    return (notes[p].meta?.heads || []).filter(([, t]) => fold(t).includes(want)).map(([lvl, t]) => ({ label: t, sub: "#".repeat(lvl), insert: `${q.slice(0, h)}#${t}` }));
  }
  return quickMatches(q, 12).map(({ path, alias }) => {
    const name = baseName(path);
    // Nom seul s'il est unique, sinon chemin (comme Obsidian).
    const unique = (store.S.byName.get(fold(name)) || []).length <= 1;
    const target = unique ? name : path.replace(/\.md$/i, "");
    return { label: alias || name, sub: alias ? `→ ${name}` : dirName(path), insert: alias ? `${target}|${alias}` : target };
  });
}

// Ouvre une note.
//   where : "here" (onglet courant), "tab" (nouvel onglet), "other" (autre panneau)
//   anchor : titre à atteindre ; highlight : requête à surligner
async function openPath(path, { where = "here", pane, anchor, highlight, push = true } = {}) {
  if (!store.exists(path)) return offerCreate(path);
  let target = pane || (where === "other" ? otherPane() : activePane);
  let tab = target.active;
  const existing = target.tabs.find((t) => t.kind === "note" && t.path === path && !t.isNew);
  if (where === "tab" && existing) tab = existing;
  else if (where === "tab" || !tab || tab.kind !== "note" || tab.editing || where === "other" && tab.path !== path) {
    if (existing && where !== "here") tab = existing;
    else { tab = newTab(target, "note"); buildNoteView(tab); push = false; }
  }
  if (push && tab.path && tab.path !== path) { tab.back.push({ path: tab.path, scroll: tab.ui.scroll.scrollTop }); tab.fwd = []; }
  activateTab(tab);
  await loadInto(tab, path, { anchor, highlight });
  if (narrow()) document.body.classList.remove("side-open");
}

async function loadInto(tab, path, { anchor, highlight, scroll } = {}) {
  tab.path = path;
  tab.isNew = false;
  renderTabbar(tab.pane);
  status("Ouverture…");
  try {
    const note = await store.readNote(path);
    if (tab.path !== path) return;
    tab.note = note;
    tab.readOnly = !note.valid;
    stopEditUi(tab);
    renderNote(tab, { anchor, highlight, scroll: scroll || 0 });
    if (!note.valid) status("Fichier qui n'est pas en UTF-8 : lecture seule sur la page.");
    else if ($("status-msg").textContent === "Ouverture…") status("");
  } catch (err) {
    status(err.message, "error");
  }
  updateRight();
  updateStatusNote();
  saveSession();
}

// Affiche la note. Une très longue note est affichée par morceaux (le début tout de suite, la suite
// quand le navigateur est libre) ; tab.rendered se résout quand tout est là.
//   anchor / highlight / scroll / scrollRatio : position à atteindre (dès que le morceau voulu est affiché)
function renderNote(tab, { anchor, highlight, scroll, scrollRatio } = {}) {
  const u = tab.ui;
  u.crumbs.innerHTML = "";
  const parts = dirName(tab.path) ? dirName(tab.path).split("/") : [];
  parts.forEach((d, i) => {
    const folder = parts.slice(0, i + 1).join("/");
    const b = el("button", { className: "crumb", textContent: d, type: "button", title: `Tableau du dossier « ${folder} »` });
    b.addEventListener("click", () => openBase({ ...P.defaultView(folder), q: `dossier:"${folder}"` }));
    u.crumbs.append(b, el("span", { className: "sep", textContent: "›" }));
  });
  u.crumbs.append(el("span", { className: "doc-title", textContent: baseName(tab.path) }));
  const token = (tab.renderToken = (tab.renderToken || 0) + 1);
  const { props, chunks } = renderChunks(tab.note.text);
  u.view.innerHTML = props;
  const q = highlight ? parseQuery(highlight) : null;
  let task = 0, marks = 0, placed = !anchor && !q?.terms.length;
  const add = (markdown) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = renderChunk(markdown);
    task = decorate(tmp, tab.path, { taskStart: task });
    if (q?.terms.length && marks < 300) marks += highlightNodes(tmp, q, 300 - marks);
    u.view.append(...tmp.childNodes);
    if (!placed) {
      const target = q?.terms.length ? u.view.querySelector("mark.hit") : findHeading(tab, anchor);
      if (target) {
        placed = true;
        target.classList.add("first");
        requestAnimationFrame(() => target.scrollIntoView({ block: q?.terms.length ? "center" : "start" }));
      }
    }
  };
  add(chunks[0]);
  if (!anchor && !q) u.scroll.scrollTop = scrollRatio !== undefined ? scrollRatio * u.scroll.scrollHeight : scroll || 0;
  tab.rendered = (async () => {
    for (let i = 1; i < chunks.length; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (token !== tab.renderToken) return;
      add(chunks[i]);
    }
    if (token !== tab.renderToken) return;
    if (!u.view.textContent.trim()) u.view.innerHTML = `<p class="empty">Note vide.</p>`;
    if (chunks.length > 1) {
      if (!anchor && !q && (scroll || scrollRatio)) u.scroll.scrollTop = scrollRatio !== undefined ? scrollRatio * u.scroll.scrollHeight : scroll;
      if (activeTab() === tab) updateRight();
    }
  })();
  u.bFav.classList.toggle("on", priv.favorites.includes(tab.path));
  u.back.disabled = !tab.back.length;
  u.fwd.disabled = !tab.fwd.length;
  updateEditButtons(tab);
  markActiveLinks();
}

function goHistory(tab, dir) {
  const from = dir < 0 ? tab.back : tab.fwd, to = dir < 0 ? tab.fwd : tab.back;
  if (!from.length || tab.editing) return;
  const it = from.pop();
  to.push({ path: tab.path, scroll: tab.ui.scroll.scrollTop });
  if (store.exists(it.path)) loadInto(tab, it.path, { scroll: it.scroll });
}

function findHeading(tab, anchor) {
  const want = fold(anchor.replace(/^\^/, ""));
  return [...tab.ui.view.querySelectorAll(".heading")].find((e) => fold(e.textContent) === want);
}
async function scrollToHeading(tab, anchor) {
  let h = findHeading(tab, anchor);
  if (!h) { await tab.rendered; h = findHeading(tab, anchor); }
  h?.scrollIntoView({ block: "start" });
}

// Surligne dans root les mots d'une recherche (au plus max marques). Renvoie le nombre de marques.
function highlightNodes(root, q, max = 300) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest("mark, .props, script") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  let count = 0;
  const qq = { ...q, phrases: [] };
  for (const n of nodes) {
    if (count >= max) break;
    const ranges = matchRanges(n.data, qq, max - count);
    if (!ranges?.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [a, b] of ranges) {
      frag.append(n.data.slice(at, a), el("mark", { className: "hit", textContent: n.data.slice(a, b) }));
      at = b;
      count++;
    }
    frag.append(n.data.slice(at));
    n.replaceWith(frag);
  }
  return count;
}

// ---------- édition ----------
function updateEditButtons(tab) {
  const u = tab.ui;
  if (!u) return;
  u.bEdit.hidden = tab.editing;
  u.bEdit.disabled = !!tab.readOnly;
  u.bSave.hidden = !tab.editing;
  u.bCancel.hidden = !tab.editing;
  u.bPrev.hidden = !tab.editing || narrow();
  u.bPrev.classList.toggle("on", !u.pscroll.hidden);
  u.bTts.hidden = tab.editing;
  u.bSave.disabled = tab.saving || (!tab.dirty && !tab.isNew);
}

function startEdit(tab, text = tab.note?.text ?? "") {
  if (tab.readOnly) return;
  if (readerTab === tab) reader.stop();
  const u = tab.ui;
  tab.editing = true;
  tab.editScrollRatio = u.scroll.scrollTop / Math.max(1, u.scroll.scrollHeight);
  u.editor.value = text;
  u.editor.hidden = false;
  u.toolbar.hidden = false;
  u.scroll.hidden = true;
  setPreview(tab, prefs.editPreview && !narrow());
  updateEditButtons(tab);
  u.editor.focus();
  u.editor.setSelectionRange(0, 0);
  u.editor.scrollTop = tab.editScrollRatio * u.editor.scrollHeight;
}

function setPreview(tab, on) {
  const u = tab.ui;
  u.pscroll.hidden = !on;
  tab.el.classList.toggle("with-preview", on);
  if (on) renderPreview(tab);
  updateEditButtons(tab);
}

function renderPreview(tab) {
  const u = tab.ui;
  u.preview.innerHTML = renderMarkdown(u.editor.value);
  decorate(u.preview, tab.path, { depth: 1 });
}

function stopEditUi(tab) {
  const u = tab.ui;
  tab.editing = false;
  tab.dirty = false;
  u.editor.hidden = true;
  u.toolbar.hidden = true;
  u.pscroll.hidden = true;
  tab.el.classList.remove("with-preview");
  u.scroll.hidden = false;
  tab.completion?.close();
  updateEditButtons(tab);
  renderTabbar(tab.pane);
}

async function cancelEdit(tab) {
  if (tab.dirty && !(await confirmBox("Abandonner les modifications ?", "<p>Le texte modifié sera perdu.</p>", "Abandonner"))) return;
  tab.dirty = false;
  saveDraftsNow();
  if (tab.isNew) return closeTab(tab, { force: true });
  stopEditUi(tab);
  renderNote(tab);
}

async function save(tab) {
  if (!tab.editing || tab.saving) return;
  if (!(await ensureToken())) return;
  const text = tab.ui.editor.value;
  tab.saving = true;
  updateEditButtons(tab);
  status("Chiffrement et enregistrement…");
  try {
    const res = await store.commit({ put: [{ path: tab.path, text, base: tab.isNew ? undefined : tab.note?.sha }] }, onConflict);
    if (!res) { status("Enregistrement annulé."); return; }
    const path = res.paths[tab.path];
    tab.path = path;
    tab.isNew = false;
    tab.note = await store.readNote(path);
    tab.dirty = false;
    saveDraftsNow();
    stopEditUi(tab);
    renderNote(tab, { scrollRatio: tab.editScrollRatio || 0 });
    updateRight();
    status(res.copied.length ? `Enregistré comme copie : « ${baseName(path)} ».` : "Enregistré.");
  } catch (err) {
    status(err.message, "error");
  } finally {
    tab.saving = false;
    updateEditButtons(tab);
  }
}

// Case à cocher cliquée en lecture : la note est modifiée et enregistrée tout de suite.
async function toggleTaskBox(tab, cb) {
  const text = toggleTask(tab.note.text, Number(cb.dataset.task), cb.checked);
  if (text === null || tab.saving) { cb.checked = !cb.checked; return; }
  if (!(await ensureToken())) { cb.checked = !cb.checked; return; }
  tab.saving = true;
  cb.closest("li")?.classList.toggle("done", cb.checked);
  status("Enregistrement de la case…");
  try {
    const res = await store.commit({ put: [{ path: tab.path, text, base: tab.note.sha }] }, onConflict, "web case");
    if (!res) { cb.checked = !cb.checked; status("Annulé."); return; }
    tab.note = await store.readNote(res.paths[tab.path]);
    tab.path = res.paths[tab.path];
    status("Case enregistrée.");
    updateRight();
  } catch (err) {
    cb.checked = !cb.checked;
    status(err.message, "error");
  } finally { tab.saving = false; }
}

// ---------- brouillons (chiffrés, enregistrés toutes les 5 secondes) ----------
async function saveDraftsNow() {
  if (!store.S.keys) return;
  const drafts = {};
  for (const t of allTabs()) {
    if (t.kind === "note" && t.editing && t.dirty) drafts[t.path] = { text: t.ui.editor.value, base: t.isNew ? null : t.note?.sha, isNew: !!t.isNew, at: Date.now() };
  }
  await store.saveDrafts(drafts);
}
setInterval(() => { if (store.S.keys && allTabs().some((t) => t.dirty)) saveDraftsNow(); }, 5000);
window.addEventListener("beforeunload", (ev) => {
  if (allTabs().some((t) => t.dirty)) { saveDraftsNow(); ev.preventDefault(); ev.returnValue = ""; }
});

async function offerDrafts() {
  const drafts = await store.loadDrafts();
  if (!drafts || !Object.keys(drafts).length) return;
  const list = Object.entries(drafts);
  const choice = await ask("Brouillons non enregistrés",
    `<p>${list.length > 1 ? `${list.length} brouillons n'ont` : "Un brouillon n'a"} pas été enregistré${list.length > 1 ? "s" : ""} :</p><ul>${list.map(([p, d]) =>
      `<li><b>${esc(baseName(p))}</b> <span class="hint">${esc(dirName(p))} · ${new Date(d.at).toLocaleString("fr-FR")}</span></li>`).join("")}</ul>`,
    [["drop", "Les jeter"], ["open", "Les reprendre", true]]);
  if (choice !== "open") { await store.saveDrafts(null); return; }
  for (const [path, d] of list) {
    let tab = allTabs().find((t) => t.kind === "note" && t.path === path);
    if (!tab) { tab = newTab(activePane, "note"); buildNoteView(tab); }
    tab.pendingLoad = false;
    Object.assign(tab, { path, isNew: d.isNew });
    tab.note = !d.isNew && store.exists(path) ? await store.readNote(path).catch(() => null) : null;
    if (tab.note && d.base && tab.note.sha !== d.base) status(`« ${baseName(path)} » a changé depuis le brouillon : l'enregistrement proposera une copie.`, "warn");
    if (tab.note) tab.note = { ...tab.note, sha: d.base || tab.note.sha };
    activateTab(tab);
    if (tab.note) renderNote(tab); else renderNewHeader(tab);
    startEdit(tab, d.text);
    tab.dirty = true;
    renderTabbar(tab.pane);
    updateEditButtons(tab);
  }
}

// ---------- nouvelle note, dossier, note du jour ----------
function cleanNewPath(folder, name) {
  const n = name.trim().replace(/\.md$/i, "");
  if (!n || /[\\:*?"<>|]/.test(n) || n.includes("/")) return null;
  const f = C.normPath(folder.trim()).replace(/\/+$/, "");
  if (f.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;
  return (f ? f + "/" : "") + n + ".md";
}

async function offerCreate(target, folder, { lockFolder = false } = {}) {
  const t = target?.startsWith("/") ? target.slice(1) : target;
  const defFolder = folder ?? (t?.includes("/") ? dirName(t) : activeTab()?.path ? dirName(activeTab().path) : "");
  const res = await ask("Nouvelle note", `
    <label for="nf">Dossier</label><input id="nf" name="folder" type="text" list="dl-folders" value="${esc(defFolder)}" spellcheck="false"${lockFolder ? " readonly" : ""}>
    <datalist id="dl-folders">${[...new Set(Object.keys(store.notes()).map(dirName))].sort().slice(0, 500).map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
    <label for="nn">Nom</label><input id="nn" name="name" type="text" value="${esc(t ? baseName(t) : "")}">`,
  [["cancel", "Annuler"], ["ok", "Créer", true]], { input: true });
  if (res.choice !== "ok") return;
  startNew(res.folder, res.name);
}

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

function startNew(folder, name, text) {
  const path = cleanNewPath(folder, name);
  if (!path) return status("Nom ou dossier invalide (caractères interdits, ou dossier caché).", "error");
  const existing = Object.keys(store.notes()).find((p) => p.toLowerCase() === path.toLowerCase());
  if (existing) return openPath(existing, { where: "tab" });
  const tab = newTab(activePane, "note");
  buildNoteView(tab);
  Object.assign(tab, { path, isNew: true, note: null });
  activateTab(tab);
  renderNewHeader(tab);
  startEdit(tab, text ?? `# ${baseName(path)}\n\n`);
  tab.ui.editor.setSelectionRange(tab.ui.editor.value.length, tab.ui.editor.value.length);
}

function renderNewHeader(tab) {
  tab.ui.crumbs.innerHTML = "";
  if (dirName(tab.path)) tab.ui.crumbs.append(el("span", { className: "crumb", textContent: dirName(tab.path).replaceAll("/", " › ") }), el("span", { className: "sep", textContent: "›" }));
  tab.ui.crumbs.append(el("span", { className: "doc-title", textContent: baseName(tab.path) + " (nouvelle)" }));
  renderTabbar(tab.pane);
}

function dailyPath(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const jours = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const f = (priv.daily.format || "AAAA-MM-JJ")
    .replace(/AAAA|YYYY/g, date.getFullYear()).replace(/MM/g, pad(date.getMonth() + 1)).replace(/JJ|DD/g, pad(date.getDate()))
    .replace(/jour/g, jours[date.getDay()]).replace(/mois/g, mois[date.getMonth()]);
  return { folder: priv.daily.folder || "", name: f };
}

function openDaily() {
  const { folder, name } = dailyPath();
  const path = cleanNewPath(folder, name);
  if (!path) return status("Format de la note du jour invalide (voir Réglages).", "error");
  const existing = Object.keys(store.notes()).find((p) => p.toLowerCase() === path.toLowerCase());
  if (existing) return openPath(existing, { where: "tab" });
  const tpl = priv.daily.template && store.resolveLink(priv.daily.template);
  const make = (t) => startNew(folder, name, t);
  if (tpl) store.readNote(tpl).then((n) => make(n.text.replace(/\{\{date\}\}/g, name).replace(/\{\{titre\}\}/g, name))).catch(() => make());
  else make(`# ${name}\n\n`);
}

// ---------- menu d'une note : renommer, supprimer, ouvrir à côté ----------
function noteMenu(tab, anchor) {
  if (!tab.path) return;
  const items = [
    ...(narrow() ? [["Plan, rétroliens, infos", () => { document.body.classList.add("right-open"); updateRight(); }]] : [["Ouvrir dans l'autre panneau", () => openPath(tab.path, { where: "other" })]]),
    ["Copier le lien [[…]]", () => navigator.clipboard?.writeText(`[[${baseName(tab.path)}]]`).then(() => status("Lien copié."))],
    ["Rechercher les mentions", () => searchFor(`"${baseName(tab.path)}"`)],
    [],
    ["Renommer ou déplacer…", () => renameNote(tab)],
    ["Supprimer…", () => deleteNote(tab), { danger: true }],
  ];
  if (tab.isNew) items.splice(0, items.length, ["Abandonner cette nouvelle note", () => cancelEdit(tab)]);
  popMenu(anchor, baseName(tab.path), items.map((x) => (x.length ? x : [null])));
}

async function renameNote(tab) {
  if (tab.dirty) return status("Enregistre ou annule d'abord ta modification.", "error");
  const res = await ask("Renommer ou déplacer", `
    <label for="rf">Dossier</label><input id="rf" name="folder" type="text" list="dl-folders2" value="${esc(dirName(tab.path))}" spellcheck="false">
    <datalist id="dl-folders2">${[...new Set(Object.keys(store.notes()).map(dirName))].sort().slice(0, 500).map((d) => `<option value="${esc(d)}">`).join("")}</datalist>
    <label for="rn">Nom</label><input id="rn" name="name" type="text" value="${esc(baseName(tab.path))}">
    <p class="hint">Les liens des autres notes vers celle-ci ne sont pas modifiés (${store.backlinksOf(tab.path).length} rétrolien${store.backlinksOf(tab.path).length > 1 ? "s" : ""}). Obsidian, sur le PC, peut les mettre à jour.</p>`,
  [["cancel", "Annuler"], ["ok", "Renommer", true]], { input: true });
  if (res.choice !== "ok") return;
  const path = cleanNewPath(res.folder, res.name);
  if (!path || path === tab.path) return;
  if (store.exists(path)) return status("Une note porte déjà ce nom.", "error");
  if (!(await ensureToken())) return;
  status("Déplacement…");
  try {
    const r = await store.commit({ put: [{ path, text: tab.note.text, base: undefined }], del: [{ path: tab.path, base: tab.note.sha }] }, onConflict, "web déplacement");
    if (!r) return status("Annulé.");
    priv.favorites = priv.favorites.map((p) => (p === tab.path ? r.paths[path] : p));
    savePriv();
    await loadInto(tab, r.paths[path]);
    status("Note déplacée.");
  } catch (err) { status(err.message, "error"); }
}

async function deleteNote(tab) {
  if (!(await confirmBox("Supprimer la note", `<p>Supprimer « ${esc(baseName(tab.path))} » ?</p>
    <p class="hint">Sur le PC, la prochaine synchronisation la mettra dans la corbeille du carnet (<code>.carnet\\corbeille</code>), pas à la poubelle. Elle reste aussi dans l'historique.</p>`, "Supprimer"))) return;
  if (!(await ensureToken())) return;
  status("Suppression…");
  try {
    const r = await store.commit({ del: [{ path: tab.path, base: tab.note.sha }] }, onConflict, "web suppression");
    if (!r) return status("Annulé.");
    priv.favorites = priv.favorites.filter((p) => p !== tab.path);
    savePriv();
    tab.dirty = false;
    closeTab(tab, { force: true });
    status("Note supprimée.");
  } catch (err) { status(err.message, "error"); }
}

function toggleFavorite(path) {
  if (!path || !store.exists(path)) return;
  const on = !priv.favorites.includes(path);
  priv.favorites = on ? [...priv.favorites, path] : priv.favorites.filter((p) => p !== path);
  savePriv();
  for (const t of allTabs()) if (t.path === path) t.ui?.bFav.classList.toggle("on", on);
  renderFiles();
  status(on ? "Ajoutée aux favoris." : "Retirée des favoris.");
}

// ---------- lecture à voix haute ----------
const RATES = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

// Réglages de voix courants, sous forme de clé : "piper:<voix>:<locuteur>" ou "browser:<nom>".
const voiceKey = () => (prefs.ttsEngine === "piper" ? `piper:${prefs.piperVoice}:${prefs.piperSpeaker}` : `browser:${prefs.voice}`);
function voiceSettings() {
  return { engine: prefs.ttsEngine === "piper" ? "piper" : "browser", voice: prefs.piperVoice, speaker: prefs.piperSpeaker, voiceName: prefs.voice, rate: prefs.rate, pitch: prefs.pitch };
}

let piperState = null; // { engine, voices: { id: téléchargée? }, sizes, engineSize }
async function refreshPiperState() {
  try { piperState = await TTS.piperStatus(); } catch { piperState = null; }
  return piperState;
}
const mo = (n) => `${Math.round(n / 1e6)} Mo`;

function fillVoiceSelect(sel) {
  const cur = voiceKey();
  sel.innerHTML = "";
  const g1 = el("optgroup", { label: "Voix neuronales (Piper, hors ligne, privées)" });
  for (const v of TTS.PIPER_VOICES) {
    const ready = piperState?.voices?.[v.id];
    const size = piperState ? ` · ${ready ? "téléchargée" : "à télécharger, " + mo((piperState.sizes[v.id] || 0) + (piperState.engine ? 0 : piperState.engineSize))}` : "";
    for (const [spk, name] of v.speakers || [["0", v.label]]) {
      g1.append(el("option", { value: `piper:${v.id}:${spk}`, textContent: (v.speakers ? `${v.label} – ${name}` : name) + size, selected: cur === `piper:${v.id}:${spk}` }));
    }
  }
  sel.append(g1);
  const voices = TTS.browserVoices();
  if (voices.length) {
    const g2 = el("optgroup", { label: "Voix du navigateur" });
    g2.append(el("option", { value: "browser:", textContent: "Voix française par défaut", selected: cur === "browser:" }));
    for (const v of voices) g2.append(el("option", { value: `browser:${v.name}`, textContent: `${v.name} (${v.lang})${TTS.isOnline(v) ? " · en ligne" : ""}`, selected: cur === `browser:${v.name}` }));
    sel.append(g2);
  }
}

// Accepter (une fois) qu'une voix en ligne reçoive le texte lu ; télécharger une voix Piper au besoin.
async function confirmVoice(key) {
  if (key.startsWith("browser:")) {
    const v = TTS.browserVoices().find((x) => x.name === key.slice(8));
    if (v && TTS.isOnline(v) && !prefs.onlineVoiceOk) {
      if (!(await confirmBox("Voix en ligne", `<p>« ${esc(v.name)} » est une voix <b>en ligne</b> : le texte lu est envoyé au service de l'éditeur du navigateur (Microsoft, Google…).</p>
        <p>Les voix neuronales Piper, elles, fonctionnent entièrement sur cet appareil.</p>`, "Utiliser quand même"))) return false;
      prefs.onlineVoiceOk = true;
    }
    return true;
  }
  const id = key.split(":")[1];
  await refreshPiperState();
  if (piperState?.voices?.[id]) return true;
  const total = (piperState?.sizes?.[id] || 0) + (piperState && !piperState.engine ? piperState.engineSize : 0);
  return confirmBox("Télécharger la voix", `<p>Cette voix neuronale doit être téléchargée une seule fois (<b>${mo(total)}</b>), puis elle fonctionne hors ligne.</p>
    <p class="hint">Fichiers figés et vérifiés par empreinte : moteur depuis jsDelivr, voix depuis le dépôt officiel Piper (Hugging Face). Le texte des notes n'est jamais envoyé.</p>`, "Télécharger");
}

function applyVoiceKey(key) {
  if (key.startsWith("piper:")) { const [, id, spk] = key.split(":"); Object.assign(prefs, { ttsEngine: "piper", piperVoice: id, piperSpeaker: Number(spk || 0) }); }
  else Object.assign(prefs, { ttsEngine: "browser", voice: key.slice(8) });
  savePrefs();
}

const progressStatus = (label) => (loaded, total) => status(`${label} : ${Math.round((loaded / total) * 100)} %`);

async function changeVoice(key) {
  if (!(await confirmVoice(key))) { for (const t of allTabs()) if (t.ui?.tVoice) fillVoiceSelect(t.ui.tVoice); return; }
  applyVoiceKey(key);
  await reader.changeVoice(voiceSettings(), progressStatus("Préparation de la voix"));
  await refreshPiperState();
  status("");
  for (const t of allTabs()) if (t.ui?.tVoice) fillVoiceSelect(t.ui.tVoice);
}

function syncRateSelects() { for (const t of allTabs()) if (t.ui?.tRate) t.ui.tRate.value = String(prefs.rate); }

// Premier usage : choisir entre la voix neuronale (meilleure, à télécharger) et celle du navigateur.
async function chooseEngineOnce() {
  if (prefs.ttsEngine) return true;
  await refreshPiperState();
  const size = piperState ? mo(piperState.sizes["fr_FR-siwis-medium"] + (piperState.engine ? 0 : piperState.engineSize)) : "≈ 90 Mo";
  const c = await ask("Lecture à voix haute", `<p><b>Voix neuronale</b> (Piper) : bien plus naturelle, entièrement hors ligne et privée. Téléchargement unique de ${size}.</p>
    <p><b>Voix du navigateur</b> : immédiate, qualité variable selon l'appareil.</p><p class="hint">Modifiable à tout moment dans la barre de lecture ou les Réglages.</p>`,
  [["cancel", "Annuler"], ["browser", "Voix du navigateur"], ["piper", "Voix neuronale", true]]);
  if (c === "piper") { applyVoiceKey(`piper:${prefs.piperVoice}:${prefs.piperSpeaker}`); return true; }
  if (c === "browser") { applyVoiceKey(`browser:${prefs.voice}`); return true; }
  return false;
}

// Lit la note : depuis l'endroit affiché, un élément (from) ou une sélection (range).
async function startReading(tab, opts = {}) {
  if (!(await chooseEngineOnce())) return;
  if (!(await confirmVoice(voiceKey()))) return;
  if (tab.rendered) await tab.rendered;
  reader.configure(voiceSettings());
  try { await reader.prepare(progressStatus("Téléchargement de la voix")); }
  catch (err) { status(err.message, "error"); return; }
  if (readerTab && readerTab !== tab && readerTab.ui) readerTab.ui.ttsBar.hidden = true;
  readerTab = tab;
  fillVoiceSelect(tab.ui.tVoice);
  tab.ui.tRate.value = String(prefs.rate);
  if ($("status-msg").textContent.startsWith("Téléchargement de la voix")) status("");
  reader.start(tab.ui.view, { scroller: tab.ui.scroll, title: baseName(tab.path), ...opts });
}

function updateTtsBar(state) {
  if (!readerTab?.ui) return;
  const u = readerTab.ui;
  u.ttsBar.hidden = state === "stopped";
  u.bTts.classList.toggle("on", state !== "stopped");
  u.tPlay.replaceChildren(icon(state === "playing" ? "pause" : "play"));
}

// ---------- vue Base ----------
function renderBaseList() {
  const box = document.querySelector('.side-view[data-view=base]');
  if (!box || !priv) return;
  box.innerHTML = "";
  box.append(el("div", { className: "panel-head" }, el("p", { className: "hint", textContent: "Tableaux de notes filtrés par dossier, tag ou propriété, triables par colonne." })));
  const add = el("button", { className: "primary", textContent: "＋ Nouveau tableau", type: "button" });
  add.addEventListener("click", () => openBase(P.defaultView(`Tableau ${priv.views.length + 1}`)));
  box.append(add);
  if (priv.views.length) box.append(el("h3", { textContent: "Tableaux enregistrés" }));
  for (const v of priv.views) {
    const row = el("div", { className: "view-row" });
    const a = el("button", { className: "linkish", textContent: v.name, type: "button" });
    a.addEventListener("click", () => openBase(v));
    const del = iconBtn("x", "Supprimer ce tableau");
    del.addEventListener("click", async () => {
      if (!(await confirmBox("Supprimer le tableau", `<p>Supprimer « ${esc(v.name)} » ? Les notes ne sont pas touchées.</p>`, "Supprimer"))) return;
      priv.views = priv.views.filter((x) => x.id !== v.id); savePriv(); renderBaseList();
    });
    row.append(a, del);
    box.append(row);
  }
  const keys = P.propertyKeys();
  if (keys.length) {
    box.append(el("h3", { textContent: "Propriétés les plus utilisées" }));
    for (const [k, n] of keys.slice(0, 15)) {
      const b = el("button", { className: "tagrow", type: "button" }, el("span", { textContent: k }), el("span", { className: "count", textContent: n }));
      b.addEventListener("click", () => openBase({ ...P.defaultView(k), q: `prop:${k}`, cols: ["file.name", k, "file.folder", "file.mtime"] }));
      box.append(b);
    }
  }
}

function openBase(view) {
  const existing = allTabs().find((t) => t.kind === "base" && t.view.id === view.id);
  if (existing) return activateTab(existing);
  const tab = newTab(activePane, "base", { view: structuredClone(view) });
  const head = el("header", { className: "doc-head" });
  const name = el("input", { className: "base-name", value: tab.view.name, title: "Nom du tableau" });
  const saveBtn = el("button", { type: "button", textContent: priv.views.some((v) => v.id === view.id) ? "Enregistré" : "Enregistrer le tableau" });
  head.append(icon("table"), name, saveBtn);
  const body = el("div", { className: "doc-scroll base" });
  tab.el.append(head, body);
  const persist = () => {
    const i = priv.views.findIndex((v) => v.id === tab.view.id);
    if (i >= 0) { priv.views[i] = structuredClone(tab.view); savePriv(); }
  };
  name.addEventListener("change", () => { tab.view.name = name.value.trim() || "Tableau"; persist(); renderTabbar(tab.pane); renderBaseList(); });
  saveBtn.addEventListener("click", () => {
    if (!priv.views.some((v) => v.id === tab.view.id)) { priv.views.push(structuredClone(tab.view)); savePriv(); renderBaseList(); }
    saveBtn.textContent = "Enregistré";
  });
  tab.base = P.baseView(body, tab.view, { saveView: persist });
  activateTab(tab);
}

// ---------- panneau de droite ----------
let outlineCleanup = () => {};
function updateRight() {
  outlineCleanup();
  outlineCleanup = () => {};
  const t = activeTab();
  const o = $("r-outline"), b = $("r-backlinks"), i = $("r-infos");
  if (!t || t.kind !== "note" || !t.path || !store.exists(t.path) || !t.note) {
    for (const x of [o, b, i]) x.innerHTML = `<p class="hint">—</p>`;
    $("r-bl-count").textContent = "";
    return;
  }
  if (!document.body.classList.contains("no-right")) {
    outlineCleanup = P.outline(o, t.ui.view, t.ui.scroll, (h) => startReading(t, { from: h }));
    P.backlinks(b, t.path);
    P.infos(i, t.path);
  }
  const n = store.backlinksOf(t.path).length;
  $("r-bl-count").textContent = n ? String(n) : "";
}

function updateStatusNote() {
  const t = activeTab();
  const e = t?.kind === "note" && t.path ? store.notes()[t.path] : null;
  $("status-note").textContent = e?.meta?.words != null
    ? `${e.meta.words.toLocaleString("fr-FR")} mots · ${Math.max(1, Math.round(e.meta.words / 230))} min · modifiée le ${new Date(e.mtime).toLocaleDateString("fr-FR")}` : "";
}

function markActiveLinks() {
  const p = activeTab()?.path;
  for (const a of document.querySelectorAll("#side a.active, .home a.active")) a.classList.remove("active");
  if (p) for (const a of document.querySelectorAll(`#side a[data-path="${CSS.escape(p)}"]`)) a.classList.add("active");
}

// ---------- session (onglets ouverts, chiffrés) ----------
let sessTimer = 0;
function snapshotSession() {
  const keep = (t) => (t.kind === "note" && t.path && !t.isNew) || t.kind === "base";
  priv.session = {
    panes: panes.map((p) => ({
      tabs: p.tabs.filter(keep).map((t) => (t.kind === "base" ? { base: t.view } : { path: t.path })),
      active: p.tabs.filter(keep).indexOf(p.active),
    })),
  };
}
function saveSession() {
  if (!priv) return;
  clearTimeout(sessTimer);
  sessTimer = setTimeout(() => { snapshotSession(); savePriv(); }, 500);
}

async function restoreSession() {
  const s = priv.session;
  if (!s?.panes?.length) return;
  const specs = narrow() ? [{ tabs: s.panes.flatMap((p) => p.tabs), active: 0 }] : s.panes.slice(0, 2);
  for (const [i, ps] of specs.entries()) {
    const pane = i === 0 ? activePane : makePane();
    const tabs = ps.tabs.filter((t) => t.base || store.exists(t.path)).slice(0, 15);
    let toActivate = null;
    for (const [k, t] of tabs.entries()) {
      if (t.base) { setActivePane(pane); openBase(t.base); if (k === ps.active) toActivate = pane.active; continue; }
      const tab = newTab(pane, "note", { path: t.path });
      buildNoteView(tab);
      tab.pendingLoad = true;
      if (k === ps.active || !toActivate && k === tabs.length - 1) toActivate = tab;
    }
    renderTabbar(pane);
    if (toActivate) {
      activateTab(toActivate);
    }
  }
  setActivePane(panes[0]);
}

// ---------- aller à (Ctrl+K) et commandes ----------
function fuzzy(q, s) {
  // Lettres de q dans l'ordre ; bonus pour les débuts de mot et les suites.
  let score = 0, i = 0, prev = -2;
  for (let k = 0; k < s.length && i < q.length; k++) {
    if (s[k] === q[i]) {
      score += (k === prev + 1 ? 3 : 1) + (k === 0 || /[\s/_\-.(]/.test(s[k - 1]) ? 4 : 0);
      prev = k; i++;
    }
  }
  return i === q.length ? score - s.length * 0.02 : -1;
}

function quickMatches(qRaw, limit = 30) {
  const q = fold(qRaw.trim());
  const notes = store.notes();
  if (!q) {
    const recent = [...new Set([...allTabs().filter((t) => t.path).map((t) => t.path), ...priv.favorites])].filter((p) => notes[p]);
    const more = Object.entries(notes).sort((a, b) => (b[1].mtime || 0) - (a[1].mtime || 0)).map(([p]) => p);
    return [...new Set([...recent, ...more])].slice(0, limit).map((path) => ({ path }));
  }
  const out = [];
  for (const [p, e] of Object.entries(notes)) {
    const name = fold(baseName(p));
    let best = fuzzy(q, name) * 2, alias;
    if (name.includes(q)) best += 20 + (name.startsWith(q) ? 10 : 0);
    for (const a of e.meta?.aliases || []) { const s = fuzzy(q, fold(a)) * 2 + (fold(a).includes(q) ? 20 : 0); if (s > best) { best = s; alias = a; } }
    const ps = fuzzy(q, fold(p));
    if (ps > best) best = ps;
    if (best > 0) out.push({ path: p, score: best, alias });
  }
  out.sort((a, b) => b.score - a.score || (notes[b.path].mtime || 0) - (notes[a.path].mtime || 0));
  return out.slice(0, limit);
}

const COMMANDS = [
  ["new", "Nouvelle note", "Ctrl+Maj+N"], ["daily", "Note du jour", "Ctrl+Maj+D"], ["search", "Rechercher dans le contenu", "Ctrl+Maj+F"],
  ["base", "Nouveau tableau (Base)", ""], ["split", "Vue scindée", "Ctrl+\\"], ["edit", "Modifier / lire la note", "Ctrl+E"],
  ["read", "Lire à voix haute", "Alt+P"], ["night", "Mode nuit (activer / désactiver)", ""], ["fav", "Ajouter / retirer des favoris", ""], ["close", "Fermer l'onglet", "Alt+W"],
  ["right", "Afficher / masquer le panneau de droite", ""], ["side", "Afficher / masquer la barre latérale", ""],
  ["reload", "Recharger le carnet", ""], ["settings", "Réglages", ""], ["keys", "Raccourcis clavier", "?"], ["lock", "Verrouiller", ""],
];

let qsWhere = "here", qsItems = [], qsSel = 0;
function openQuickSwitcher({ where = "here", commands = false } = {}) {
  qsWhere = where;
  const input = $("qs-input");
  input.value = commands ? ">" : "";
  $("qs").showModal();
  input.focus();
  drawQs();
}
function drawQs() {
  const raw = $("qs-input").value;
  const list = $("qs-list");
  list.innerHTML = "";
  if (raw.startsWith(">")) {
    const q = fold(raw.slice(1).trim());
    qsItems = COMMANDS.filter(([, label]) => !q || fuzzy(q, fold(label)) > 0).map(([cmd, label, kbd]) => ({ cmd, label, kbd }));
  } else {
    qsItems = quickMatches(raw, 30).map((m) => ({ path: m.path, label: m.alias || baseName(m.path), sub: m.alias ? `→ ${baseName(m.path)} · ${dirName(m.path)}` : dirName(m.path) }));
    if (raw.trim() && !qsItems.some((i) => fold(i.label) === fold(raw.trim()))) qsItems.push({ create: raw.trim(), label: `Créer « ${raw.trim()} »`, sub: "nouvelle note" });
    if (raw.trim()) qsItems.push({ search: raw.trim(), label: `Rechercher « ${raw.trim()} » dans le contenu`, sub: "Ctrl+Maj+F" });
  }
  qsSel = 0;
  qsItems.forEach((it, i) => {
    const d = el("div", { className: "qs-item" + (i === 0 ? " sel" : ""), role: "option" },
      el("span", { className: "qs-l", textContent: it.label }), el("span", { className: "qs-s", textContent: it.sub || it.kbd || "" }));
    d.addEventListener("mousedown", (e) => { e.preventDefault(); qsSel = i; chooseQs(e); });
    list.append(d);
  });
}
function chooseQs(ev) {
  const it = qsItems[qsSel];
  if (!it) return;
  $("qs").close();
  const where = ev.shiftKey ? "other" : ev.ctrlKey || ev.metaKey ? "tab" : qsWhere;
  if (it.cmd) runCommand(it.cmd, ev);
  else if (it.create) offerCreate(it.create);
  else if (it.search) searchFor(it.search);
  else openPath(it.path, { where });
}
$("qs-input").addEventListener("input", drawQs);
$("qs-input").addEventListener("keydown", (e) => {
  const items = $("qs-list").children;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[qsSel]?.classList.remove("sel");
    qsSel = (qsSel + (e.key === "ArrowDown" ? 1 : -1) + qsItems.length) % Math.max(1, qsItems.length);
    items[qsSel]?.classList.add("sel");
    items[qsSel]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") { e.preventDefault(); chooseQs(e); }
});
$("qs").addEventListener("click", (e) => { if (e.target === $("qs")) $("qs").close(); });

async function runCommand(cmd, ev = {}) {
  const t = activeTab();
  switch (cmd) {
    case "switcher": return openQuickSwitcher();
    case "new": return offerCreate("");
    case "daily": return openDaily();
    case "search": return showSide("search", { focus: true });
    case "base": return openBase(P.defaultView(`Tableau ${priv.views.length + 1}`));
    case "split": return toggleSplit();
    case "edit": if (t?.kind === "note") { if (t.editing) { if (!t.dirty) { stopEditUi(t); renderNote(t); } } else startEdit(t); } return;
    case "read": if (t?.kind === "note" && !t.editing) startReading(t); return;
    case "night": return toggleNight();
    case "fav": return toggleFavorite(t?.path);
    case "close": return t && closeTab(t);
    case "right": prefs.right = !prefs.right; savePrefs(); updateRight(); if (narrow()) document.body.classList.toggle("right-open", prefs.right); return;
    case "side": prefs.side = !prefs.side; savePrefs(); return;
    case "settings": return openSettings();
    case "keys": return showKeys();
    case "lock":
      if (ev.shiftKey && store.hasStoredToken() && await confirmBox("Oublier le jeton", "<p>Oublier le jeton GitHub mémorisé sur cet appareil ?</p>", "Oublier")) store.forgetToken();
      return lock();
    case "reload":
      if (allTabs().some((x) => x.dirty)) return status("Enregistre ou annule d'abord tes modifications.", "error");
      status("Rechargement…");
      try {
        await store.reload();
        for (const x of allTabs()) if (x.kind === "note" && x.path && store.exists(x.path) && !x.editing) await loadInto(x, x.path, { scroll: x.ui.scroll.scrollTop });
        status("Carnet à jour.");
      } catch (err) { status(err.message, "error"); }
  }
}

function showKeys() {
  const rows = [
    ["Ctrl+K", "Aller à une note (et commandes avec « > »)"], ["Ctrl+Maj+F", "Rechercher dans le contenu"], ["Ctrl+Maj+P", "Commandes"],
    ["Ctrl+E", "Modifier / lire"], ["Ctrl+S", "Enregistrer"], ["Ctrl+Maj+N", "Nouvelle note"], ["Ctrl+Maj+D", "Note du jour"],
    ["Ctrl+\\", "Vue scindée"], ["Alt+W", "Fermer l'onglet"], ["Alt+, / Alt+;", "Onglet précédent / suivant"], ["Alt+← / Alt+→", "Note précédente / suivante"],
    ["Ctrl+clic, clic molette", "Ouvrir dans un nouvel onglet"], ["Maj+clic", "Ouvrir dans l'autre panneau"],
    ["Alt+P", "Lecture à voix haute : lire / pause"], ["Alt+J / Alt+L", "Phrase précédente / suivante (avec Maj : paragraphe)"], ["Alt+K", "Arrêter la lecture"],
    ["Alt+clic", "Lire à partir de ce paragraphe (pendant la lecture, un simple clic suffit)"],
    ["Dans l'éditeur", "Ctrl+B gras · Ctrl+I italique · Ctrl+L case · Ctrl+K lien · [[ complétion · Tab indenter · Entrée continue la liste"],
  ];
  ask("Raccourcis clavier", `<table class="keys">${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>`, [["ok", "Fermer", true]], { wide: true });
}

// ---------- réglages ----------
async function openSettings() {
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  await refreshPiperState();
  const pending = ask("Réglages", `
    <div class="settings">
      <fieldset><legend>Apparence (cet appareil)</legend>
        <label>Thème <select name="theme">${[["auto", "Selon le système"], ["light", "Clair"], ["dark", "Sombre"], ["sepia", "Sépia"], ["night", "Nuit"]].map(([v, l]) => opt(v, l, prefs.theme)).join("")}</select></label>
        <div class="night-row"><label class="check"><input type="checkbox" name="nightAuto"${prefs.nightAuto ? " checked" : ""}> Nuit automatique</label>
          <span>de <input name="nightFrom" type="time" value="${esc(prefs.nightFrom)}" aria-label="Début de la nuit"> à <input name="nightTo" type="time" value="${esc(prefs.nightTo)}" aria-label="Fin de la nuit"></span></div>
        <label>Luminosité la nuit <input name="nightDim" type="range" min="0" max="0.6" step="0.05" value="${prefs.nightDim}"></label>
        <label>Police de lecture <select name="font">${[["sans", "Sans empattement"], ["serif", "Avec empattement"], ["mono", "Machine à écrire"]].map(([v, l]) => opt(v, l, prefs.font)).join("")}</select></label>
        <label>Taille du texte <input name="size" type="number" min="12" max="28" value="${prefs.size}"> px</label>
        <label>Largeur de lecture <select name="width">${[[620, "Étroite"], [760, "Normale"], [920, "Large"], [4000, "Pleine largeur"]].map(([v, l]) => opt(v, l, prefs.width)).join("")}</select></label>
        <label>Interligne <select name="line">${[[1.45, "Serré"], [1.65, "Normal"], [1.9, "Aéré"]].map(([v, l]) => opt(v, l, prefs.line)).join("")}</select></label>
      </fieldset>
      <fieldset><legend>Note du jour</legend>
        <label>Dossier <input name="dfolder" type="text" value="${esc(priv.daily.folder)}"></label>
        <label>Nom <input name="dformat" type="text" value="${esc(priv.daily.format)}"></label>
        <p class="hint">AAAA année, MM mois, JJ jour ; « jour » et « mois » en toutes lettres. Exemple : <code>AAAA-MM-JJ</code>, <code>JJ mois AAAA</code>.</p>
        <label>Modèle (nom d'une note, facultatif) <input name="dtemplate" type="text" value="${esc(priv.daily.template || "")}" placeholder="Modèles/Journal"></label>
        <p class="hint">Dans le modèle, <code>{{date}}</code> est remplacé par le nom de la note.</p>
      </fieldset>
      <fieldset class="tts-settings"><legend>Lecture à voix haute</legend>
        <label>Voix <select name="ttsVoice" class="set-voice"></select></label>
        <label>Vitesse <select name="rate">${RATES.map((r) => opt(r, "×" + r, prefs.rate)).join("")}</select></label>
        <label>Tonalité (voix du navigateur) <select name="pitch">${[[0.8, "Plus grave"], [0.9, "Un peu grave"], [1, "Normale"], [1.1, "Un peu aiguë"], [1.2, "Plus aiguë"]].map(([v, l]) => opt(v, l, prefs.pitch)).join("")}</select></label>
        <div class="piper-list"><p class="hint">Voix neuronales…</p></div>
        <p class="hint">Les voix neuronales sont calculées sur cet appareil. Les voix du navigateur marquées « en ligne » envoient le texte à l'éditeur du navigateur.</p>
        <button type="button" class="try-voice">▶ Écouter un exemple</button>
      </fieldset>
      <fieldset><legend>Sécurité (cet appareil)</legend>
        <label>Verrouiller après <input name="lockMinutes" type="number" min="1" max="600" value="${prefs.lockMinutes}"> min d'inactivité</label>
        <label>ou après <input name="hiddenLockMinutes" type="number" min="0" max="600" value="${prefs.hiddenLockMinutes}"> min en arrière-plan</label>
        <label class="check"><input type="checkbox" name="forgetToken"${store.hasStoredToken() ? "" : " disabled"}> Oublier le jeton GitHub mémorisé</label>
        <label class="check"><input type="checkbox" name="clearCache"> Vider le cache hors ligne (fichiers chiffrés)</label>
      </fieldset>
    </div>`, [["cancel", "Annuler"], ["ok", "Appliquer", true]], { input: true, wide: true });
  wireTtsSettings();
  const res = await pending;
  if (res.choice !== "ok") return;
  const num = (v, d, a, b) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
  Object.assign(prefs, {
    theme: res.theme, font: res.font, size: num(res.size, 17, 12, 28), width: Number(res.width), line: Number(res.line),
    lockMinutes: num(res.lockMinutes, 30, 1, 600), hiddenLockMinutes: num(res.hiddenLockMinutes, 5, 0, 600),
    rate: Number(res.rate ?? prefs.rate), pitch: Number(res.pitch ?? prefs.pitch),
    nightAuto: res.nightAuto, nightFrom: res.nightFrom || "21:00", nightTo: res.nightTo || "07:00", nightDim: Number(res.nightDim || 0), nightOverride: null,
  });
  if (res.ttsVoice && res.ttsVoice !== voiceKey() && await confirmVoice(res.ttsVoice)) applyVoiceKey(res.ttsVoice);
  savePrefs();
  syncRateSelects();
  reader.configure(voiceSettings());
  priv.daily = { folder: res.dfolder.trim(), format: res.dformat.trim() || "AAAA-MM-JJ", template: res.dtemplate.trim() };
  savePriv();
  if (res.forgetToken) store.forgetToken();
  if (res.clearCache && "caches" in window) { await caches.delete("carnet-donnees"); status("Cache hors ligne vidé."); }
  else status("Réglages appliqués.");
}
TTS.onVoicesChanged(() => { for (const t of allTabs()) if (t.ui?.tVoice) fillVoiceSelect(t.ui.tVoice); });

// Réglages ouverts : liste des voix Piper (télécharger, supprimer) et bouton d'essai.
function wireTtsSettings() {
  const box = $("dlg-body");
  const sel = box.querySelector(".set-voice");
  fillVoiceSelect(sel);
  const list = box.querySelector(".piper-list");
  const draw = () => {
    list.innerHTML = "";
    for (const v of TTS.PIPER_VOICES) {
      const ready = piperState?.voices?.[v.id];
      const row = el("div", { className: "piper-row" }, el("span", { textContent: v.label + (v.speakers ? " (Jessica, Pierre)" : "") }),
        el("span", { className: "hint", textContent: ready ? "téléchargée" : piperState ? mo(piperState.sizes[v.id]) : "" }));
      const b = el("button", { type: "button", textContent: ready ? "Supprimer" : "Télécharger" });
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          if (ready) await TTS.piperCall({ type: "delete", voice: v.id });
          else await TTS.piperCall({ type: "load", voice: v.id }, (l, t) => { b.textContent = `${Math.round((l / t) * 100)} %`; });
        } catch (err) { status(err.message, "error"); }
        await refreshPiperState();
        draw();
        fillVoiceSelect(sel);
      });
      row.append(b);
      list.append(row);
    }
  };
  draw();
  box.querySelector(".try-voice").addEventListener("click", async () => {
    const key = sel.value;
    if (!(await confirmVoice(key))) return;
    const keep = voiceKey();
    applyVoiceKey(key);
    const sample = el("div", {}, el("p", { textContent: "Bonjour. Voici un exemple de lecture à voix haute du carnet, en 2026." }));
    reader.configure({ ...voiceSettings(), rate: Number(box.querySelector('select[name="rate"]').value), pitch: Number(box.querySelector('select[name="pitch"]').value) });
    try { await reader.prepare(progressStatus("Téléchargement de la voix")); } catch (err) { status(err.message, "error"); return; }
    await refreshPiperState(); draw();
    applyVoiceKey(keep);
    if (readerTab?.ui) readerTab.ui.ttsBar.hidden = true;
    readerTab = null;
    reader.start(sample, { title: "Essai" });
  });
}

// ---------- clics sur les liens, tags, raccourcis ----------
function linkWhere(ev) { return ev.shiftKey ? "other" : ev.ctrlKey || ev.metaKey || ev.button === 1 ? "tab" : "here"; }
function onLink(ev) {
  const tag = ev.target.closest("a.tag[data-tag]");
  if (tag) { ev.preventDefault(); searchFor(`tag:${tag.dataset.tag}`); return; }
  const a = ev.target.closest("a.wl, a.nl");
  if (!a) return;
  ev.preventDefault();
  if (a.dataset.path) {
    const cur = activeTab();
    if (a.dataset.path === cur?.path && a.dataset.anchor && linkWhere(ev) === "here") return scrollToHeading(cur, a.dataset.anchor);
    openPath(a.dataset.path, { where: linkWhere(ev), anchor: a.dataset.anchor || undefined, highlight: a.dataset.highlight || undefined });
  } else if (a.dataset.target !== undefined) offerCreate(a.dataset.target);
}
document.addEventListener("click", (ev) => { if (ev.button === 0) onLink(ev); });
// Petit écran : toucher à côté d'un tiroir ouvert le referme.
document.addEventListener("pointerdown", (ev) => {
  if (!narrow()) return;
  const b = document.body.classList;
  if (b.contains("side-open") && !ev.target.closest("#side, #ribbon, #btn-side, dialog, .menu")) b.remove("side-open");
  if (b.contains("right-open") && !ev.target.closest("#right, dialog, .menu")) b.remove("right-open");
}, true);
document.addEventListener("auxclick", (ev) => { if (ev.button === 1 && ev.target.closest("a.wl[data-path], a.nl[data-path]")) onLink(ev); });

document.addEventListener("keydown", (ev) => {
  if (!store.S.keys || $("dlg").open) return;
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  const t = activeTab();
  const inField = ev.target.closest("input, textarea, select");
  if (mod && !ev.shiftKey && k === "k") { ev.preventDefault(); if (!$("qs").open) openQuickSwitcher(); }
  else if (mod && ev.shiftKey && k === "p") { ev.preventDefault(); openQuickSwitcher({ commands: true }); }
  else if (mod && ev.shiftKey && k === "f") { ev.preventDefault(); showSide("search", { focus: true }); }
  else if (mod && ev.shiftKey && k === "d") { ev.preventDefault(); openDaily(); }
  else if (mod && ev.shiftKey && k === "n") { ev.preventDefault(); offerCreate(""); }
  else if (mod && k === "s") { ev.preventDefault(); if (t?.editing) save(t); }
  else if (mod && k === "e") { ev.preventDefault(); runCommand("edit"); }
  else if (mod && k === "\\") { ev.preventDefault(); toggleSplit(); }
  else if (ev.altKey && k === "w") { ev.preventDefault(); if (t) closeTab(t); }
  else if (ev.altKey && (ev.key === "," || ev.key === ";")) {
    ev.preventDefault();
    const tabs = activePane.tabs, i = tabs.indexOf(t);
    if (tabs.length > 1) activateTab(tabs[(i + (ev.key === ";" ? 1 : -1) + tabs.length) % tabs.length]);
  }
  else if (ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight") && !inField) { ev.preventDefault(); if (t?.kind === "note") goHistory(t, ev.key === "ArrowLeft" ? -1 : 1); }
  else if (ev.altKey && !mod && !inField && ["p", "j", "l", "k"].includes(k)) {
    ev.preventDefault();
    if (k === "p") { if (reader.state === "stopped") { if (t?.kind === "note" && !t.editing) startReading(t); } else reader.toggle(); }
    else if (k === "k") reader.stop();
    else reader.skip(k === "j" ? -1 : 1, ev.shiftKey ? "block" : "sentence");
  }
  else if (ev.key === "?" && !inField) showKeys();
  else if (ev.key === "Escape") { document.body.classList.remove("side-open", "right-open"); closeMenu(); }
});

window.addEventListener("pageshow", () => { if (!store.S.keys) $("pass")?.focus(); });
matchMedia("(max-width: 900px)").addEventListener("change", () => { if (narrow() && panes.length > 1) closePane(panes[1]); });
