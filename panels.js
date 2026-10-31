// Carnet — panneaux : recherche plein texte, tags, plan, rétroliens, vue « Base ».
import * as store from "./store.js";
import * as X from "./search.js";
import { esc } from "./render.js";

const { baseName, dirName, fold } = store;
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "");

// Lien vers une note (ouvert par le gestionnaire de clics global de l'application).
export function noteLink(p, { label = baseName(p), sub, cls = "" } = {}) {
  const a = el("a", { href: "#", className: "nl " + cls });
  a.dataset.path = p;
  a.append(el("span", { className: "nl-t", textContent: label }));
  if (sub) a.append(el("span", { className: "nl-s", textContent: sub }));
  return a;
}

function marked(text, marks) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of marks) {
    if (a > at) frag.append(text.slice(at, a));
    frag.append(el("mark", { textContent: text.slice(a, b) }));
    at = b;
  }
  frag.append(text.slice(at));
  return frag;
}

// Texte lisible pour les extraits : sans frontmatter ni syntaxe Markdown.
function plain(text) {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/!?\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g, (m, t, a) => a || t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]?)+(?:\[![\w-]+\][+-]?[ \t]*)?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?/gm, "")
    .replace(/(\*\*|__|==|~~|`)/g, "")
    .replace(/%%[\s\S]*?%%/g, "");
}

// Texte lisible et replié des dernières notes consultées (extraits sans recalcul).
const foldCache = new Map();
async function foldedPlain(path) {
  const note = await store.readNote(path);
  const hit = foldCache.get(path);
  if (hit && hit.sha === note.sha) { foldCache.delete(path); foldCache.set(path, hit); return hit.folded; }
  const text = plain(note.text);
  const folded = { ...X.foldWithMap(text), text };
  foldCache.set(path, { sha: note.sha, folded });
  if (foldCache.size > 30) foldCache.delete(foldCache.keys().next().value);
  return folded;
}

// ---------- recherche ----------
export function searchPanel(root, ui) {
  root.innerHTML = `
    <div class="panel-head">
      <input class="search-input" type="search" placeholder="Rechercher dans les notes…" autocomplete="off" spellcheck="false" aria-label="Rechercher">
      <details class="search-help"><summary>Syntaxe</summary>
        <div><code>mots</code> toutes les notes qui contiennent ces mots (début de mot)<br>
        <code>"expression exacte"</code> · <code>-exclu</code><br>
        <code>tag:projet</code> · <code>dossier:"02 Notes"</code> · <code>prop:statut=fait</code><br>
        Accents et majuscules indifférents.</div></details>
    </div>
    <div class="search-info hint"></div>
    <div class="search-results"></div>`;
  const input = root.querySelector("input");
  const info = root.querySelector(".search-info");
  const list = root.querySelector(".search-results");
  let run = 0, timer = 0, stopSnippets = () => {};

  async function go() {
    const q = input.value.trim();
    const me = ++run;
    stopSnippets();
    list.innerHTML = "";
    info.textContent = "";
    if (!q) { renderRecentSearches(); return; }
    info.textContent = "Recherche…";
    let res;
    try { res = await store.search(q); } catch (err) { if (me === run) info.textContent = err.message; return; }
    if (me !== run) return;
    ui.rememberSearch(q);
    const { results, query, unindexed, skipped } = res;
    const needText = query.terms.length > 0;
    const parts = [`${results.length} note${results.length > 1 ? "s" : ""}${query.phrases.length ? " (avant vérification des expressions)" : ""}`];
    if (!store.S.manifest.index) parts.push("index pas encore construit : lance une synchronisation sur le PC");
    else if (unindexed) parts.push(`${unindexed} note${unindexed > 1 ? "s" : ""} récente${unindexed > 1 ? "s" : ""} lue${unindexed > 1 ? "s" : ""} directement`);
    if (skipped) parts.push(`${skipped} autres non lues (pas encore indexées)`);
    info.textContent = parts.join(" · ");
    let shown = 0;
    const more = el("button", { className: "more", textContent: "Plus de résultats", hidden: true });
    more.addEventListener("click", () => page());
    list.after(more);
    root.querySelectorAll(".more").forEach((b) => b !== more && b.remove());

    // Extraits : seulement pour les résultats visibles, deux notes à la fois, en rendant la main entre deux.
    const queue = [];
    let active = 0;
    const observer = needText ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        observer.unobserve(en.target);
        queue.push(en.target);
      }
      pump();
    }, { root: root.closest("#side") || null, rootMargin: "200px" }) : null;
    stopSnippets = () => observer?.disconnect();
    async function pump() {
      while (active < 2 && queue.length && me === run) {
        active++;
        const item = queue.shift();
        snippetFor(item).finally(() => { active--; pump(); });
      }
    }
    async function snippetFor(item) {
      const path = item.dataset.path;
      const box = item.querySelector(".snip.pending");
      const e = store.notes()[path];
      if (!e) return;
      if (e.size > 3_000_000) { box.textContent = "(très longue note : extrait non affiché)"; box.classList.remove("pending"); return; }
      try {
        const folded = await foldedPlain(path);
        if (me !== run) return;
        await new Promise((r) => setTimeout(r, 0));
        const ranges = X.matchFolded(folded, query, 8);
        if (ranges === null) { item.remove(); return; } // expression exacte absente
        box.remove();
        for (const sn of X.snippets(folded.text, ranges)) {
          const d = el("div", { className: "snip" });
          if (sn.head) d.append("… ");
          d.append(marked(sn.text.replace(/\s+/g, " "), remap(sn.text, sn.marks)));
          if (sn.tail) d.append(" …");
          item.append(d);
        }
      } catch (err) { box.textContent = err.message; box.classList.remove("pending"); }
    }

    function page() {
      more.hidden = true;
      const end = Math.min(results.length, shown + 50);
      const frag = document.createDocumentFragment();
      for (; shown < end; shown++) {
        const { path } = results[shown];
        const item = el("div", { className: "hit" });
        item.dataset.path = path;
        item.append(noteLink(path, { sub: dirName(path) }));
        if (needText) { item.append(el("div", { className: "snip pending", textContent: "…" })); }
        frag.append(item);
      }
      list.append(frag);
      if (observer) for (const it of list.querySelectorAll(".hit:has(.snip.pending)")) observer.observe(it);
      more.hidden = shown >= results.length;
    }
    page();
  }

  // Les extraits ont leurs espaces compactés : on recalcule les positions des marques.
  function remap(text, marks) {
    const map = [];
    let out = 0, prevSpace = false;
    for (let i = 0; i < text.length; i++) {
      const sp = /\s/.test(text[i]);
      map[i] = out;
      if (!(sp && prevSpace)) out++;
      prevSpace = sp;
    }
    map[text.length] = out;
    return marks.map(([a, b]) => [map[a], map[b]]);
  }
  function renderRecentSearches() {
    const recent = ui.recentSearches();
    if (!recent.length) { info.textContent = "Astuce : Ctrl+Maj+F ouvre la recherche depuis n'importe où."; return; }
    list.append(el("h3", { textContent: "Recherches récentes" }));
    for (const q of recent) {
      const b = el("button", { className: "linkish", textContent: q });
      b.addEventListener("click", () => set(q));
      list.append(b);
    }
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (v && v.length < 2) return;
    timer = setTimeout(go, 450);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); go(); } });
  list.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-path]");
    if (a) a.dataset.highlight = input.value.trim();
  }, true);
  function set(q) { input.value = q; go(); }
  return { focus: () => { input.focus(); input.select(); }, set, refresh: () => input.value.trim() && go() };
}

// ---------- tags ----------
export function tagsPanel(root, ui) {
  root.innerHTML = `<div class="panel-head"><input class="tag-filter" type="search" placeholder="Filtrer les tags…" autocomplete="off">
    <div class="seg"><button data-sort="n" class="on">Fréquence</button><button data-sort="a">A → Z</button></div></div><div class="tag-list"></div>`;
  let sort = "n";
  const list = root.querySelector(".tag-list");
  const filter = root.querySelector(".tag-filter");
  function render() {
    const f = fold(filter.value.trim());
    const tags = [...store.allTags().values()].filter((t) => !f || fold(t.name).includes(f));
    tags.sort(sort === "n" ? (a, b) => b.n - a.n || collator.compare(a.name, b.name) : (a, b) => collator.compare(a.name, b.name));
    list.innerHTML = "";
    if (!tags.length) { list.append(el("p", { className: "hint", textContent: "Aucun tag." })); return; }
    for (const t of tags) {
      const b = el("button", { className: "tagrow" }, el("span", { textContent: "#" + t.name }), el("span", { className: "count", textContent: t.n }));
      b.addEventListener("click", () => ui.searchFor(`tag:${t.name.includes(" ") ? `"${t.name}"` : t.name}`));
      list.append(b);
    }
  }
  filter.addEventListener("input", render);
  root.querySelector(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    sort = b.dataset.sort;
    root.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  return { render };
}

// ---------- panneau droit : plan, rétroliens, infos ----------
export function outline(root, view, scroller, onRead) {
  root.innerHTML = "";
  const hs = [...view.querySelectorAll(":scope > .heading, :scope > .callout .heading")].filter((h) => !h.closest(".embed"));
  if (!hs.length) { root.append(el("p", { className: "hint", textContent: "Pas de titres dans cette note." })); return () => {}; }
  const min = Math.min(...hs.map((h) => Number(h.tagName[1])));
  const items = hs.map((h) => {
    const b = el("button", { className: "ol-item", textContent: h.textContent, title: h.textContent });
    b.style.paddingLeft = `${(Number(h.tagName[1]) - min) * 12 + 6}px`;
    b.addEventListener("click", () => { h.scrollIntoView({ behavior: "smooth", block: "start" }); });
    const row = el("div", { className: "ol-row" }, b);
    if (onRead) {
      const r = el("button", { className: "ol-read", textContent: "▶", title: "Lire à voix haute à partir de ce titre", type: "button" });
      r.addEventListener("click", () => onRead(h));
      row.append(r);
    }
    root.append(row);
    return b;
  });
  // Section en cours, suivie au défilement.
  const onScroll = () => {
    const top = scroller.getBoundingClientRect().top + 60;
    let cur = 0;
    hs.forEach((h, i) => { if (h.getBoundingClientRect().top < top) cur = i; });
    items.forEach((b, i) => b.classList.toggle("cur", i === cur));
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return () => scroller.removeEventListener("scroll", onScroll);
}

export async function backlinks(root, path) {
  root.innerHTML = "";
  const list = store.backlinksOf(path);
  if (!list.length) { root.append(el("p", { className: "hint", textContent: "Aucune note ne renvoie ici." })); return; }
  const names = new Set([fold(baseName(path)), ...(store.notes()[path]?.meta?.aliases || []).map(fold), fold(path.replace(/\.md$/i, ""))]);
  for (const [i, p] of list.entries()) {
    const item = el("div", { className: "bl" }, noteLink(p, { sub: dirName(p) }));
    root.append(item);
    if (i >= 15 || store.notes()[p].size > 400_000) continue;
    store.readNote(p).then(({ text }) => {
      // Ligne qui contient le lien, pour le contexte.
      for (const line of text.split("\n")) {
        for (const m of line.matchAll(/\[\[([^\]|#]+)/g)) {
          const t = fold(m[1].trim());
          if (names.has(t) || names.has(fold(baseName(t)))) {
            item.append(el("div", { className: "snip", textContent: line.replace(/^[\s>*+-]+/, "").slice(0, 220) }));
            return;
          }
        }
      }
    }).catch(() => {});
  }
}

export function infos(root, path) {
  const e = store.notes()[path];
  root.innerHTML = "";
  if (!e) return;
  const m = e.meta || {};
  const rows = [
    ["Dossier", dirName(path) || "racine"],
    ["Modifiée", fmtDate(e.mtime)],
    ["Mots", m.words != null ? m.words.toLocaleString("fr-FR") + ` · ${Math.max(1, Math.round(m.words / 230))} min de lecture` : "—"],
    ["Taille", e.size > 1e6 ? (e.size / 1e6).toFixed(1) + " Mo" : Math.ceil(e.size / 1000) + " Ko"],
  ];
  if (m.tasks) rows.push(["Tâches", `${m.tasks[1]} faite${m.tasks[1] > 1 ? "s" : ""} sur ${m.tasks[0] + m.tasks[1]}`]);
  for (const [k, v] of rows) root.append(el("div", { className: "info" }, el("span", { textContent: k }), el("span", { textContent: v })));
  if (m.tags?.length) {
    const t = el("div", { className: "info-tags" });
    for (const tag of m.tags) { const a = el("a", { href: "#", className: "tag", textContent: "#" + tag }); a.dataset.tag = tag; t.append(a); }
    root.append(t);
  }
}

// ---------- vue « Base » : tableau des notes ----------
const FIXED_COLS = {
  "file.name": { label: "Note", get: (p) => baseName(p) },
  "file.folder": { label: "Dossier", get: (p) => dirName(p) },
  "file.mtime": { label: "Modifiée", get: (p, e) => e.mtime || 0, fmt: fmtDate },
  "file.words": { label: "Mots", get: (p, e) => e.meta?.words ?? 0, num: true },
  "file.tasks": { label: "Tâches ouvertes", get: (p, e) => e.meta?.tasks?.[0] ?? 0, num: true },
  "file.tags": { label: "Tags", get: (p, e) => (e.meta?.tags || []).join(", ") },
  "file.links": { label: "Rétroliens", get: (p) => store.backlinksOf(p).length, num: true },
};

export function propertyKeys() {
  const keys = new Map();
  for (const e of Object.values(store.notes())) for (const k of Object.keys(e.meta?.props || {})) keys.set(k, (keys.get(k) || 0) + 1);
  return [...keys].sort((a, b) => b[1] - a[1]);
}

function cellValue(col, p, e) {
  if (FIXED_COLS[col]) return FIXED_COLS[col].get(p, e);
  const v = e.meta?.props?.[col];
  return Array.isArray(v) ? v.join(", ") : v ?? "";
}

// view = { name, q, cols: [...], sort: { col, dir } }. onChange(view) enregistre la vue.
export function baseView(root, view, ui) {
  const keys = propertyKeys();
  root.innerHTML = "";
  const bar = el("div", { className: "base-bar" });
  const q = el("input", { type: "search", value: view.q || "", placeholder: "Filtre : mots du titre, tag:x, dossier:x, prop:clé=valeur", className: "base-q" });
  const colsBtn = el("button", { textContent: "Colonnes ▾" });
  const csv = el("button", { textContent: "Exporter (CSV)" });
  const count = el("span", { className: "hint" });
  bar.append(q, colsBtn, csv, count);
  const colsBox = el("div", { className: "base-cols", hidden: true });
  const wrap = el("div", { className: "table-wrap base-table" });
  root.append(bar, colsBox, wrap);
  if (!keys.length) root.append(el("p", { className: "hint", textContent: "Aucune propriété (frontmatter) trouvée dans les notes : les colonnes se limitent aux informations des fichiers." }));

  const allCols = [...Object.keys(FIXED_COLS), ...keys.map(([k]) => k)];
  for (const c of allCols) {
    const label = FIXED_COLS[c]?.label || c;
    const n = keys.find(([k]) => k === c)?.[1];
    const cb = el("input", { type: "checkbox", checked: view.cols.includes(c) });
    cb.addEventListener("change", () => {
      view.cols = cb.checked ? [...view.cols, c] : view.cols.filter((x) => x !== c);
      ui.saveView(view); draw();
    });
    colsBox.append(el("label", {}, cb, ` ${label}`, n ? el("small", { textContent: ` (${n})` }) : ""));
  }
  colsBtn.addEventListener("click", () => { colsBox.hidden = !colsBox.hidden; });

  let rows = [];
  function draw() {
    const parsed = X.parseQuery(q.value);
    const filter = X.metaFilter(parsed);
    const notes = store.notes();
    rows = Object.entries(notes).filter(([p, e]) => filter(p, e)
      && parsed.terms.every((t) => fold(baseName(p)).includes(t)) && !parsed.exclude.some((t) => fold(baseName(p)).includes(t)));
    const { col = "file.mtime", dir = -1 } = view.sort || {};
    rows.sort(([pa, ea], [pb, eb]) => {
      const a = cellValue(col, pa, ea), b = cellValue(col, pb, eb);
      const c = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
      return c * dir;
    });
    count.textContent = `${rows.length} note${rows.length > 1 ? "s" : ""}`;
    const table = el("table");
    const tr = el("tr");
    for (const c of view.cols) {
      const th = el("th", { textContent: FIXED_COLS[c]?.label || c, title: "Trier" });
      if (c === col) th.append(dir > 0 ? " ▲" : " ▼");
      th.addEventListener("click", () => { view.sort = { col: c, dir: c === col ? -dir : 1 }; ui.saveView(view); draw(); });
      tr.append(th);
    }
    table.append(el("thead", {}, tr));
    const tb = el("tbody");
    for (const [p, e] of rows.slice(0, 1000)) {
      const r = el("tr");
      for (const c of view.cols) {
        const v = cellValue(c, p, e);
        const td = el("td");
        if (c === "file.name") td.append(noteLink(p));
        else td.textContent = FIXED_COLS[c]?.fmt ? FIXED_COLS[c].fmt(v) : typeof v === "boolean" ? (v ? "☑" : "☐") : String(v);
        if (FIXED_COLS[c]?.num) td.className = "num";
        r.append(td);
      }
      tb.append(r);
    }
    table.append(tb);
    wrap.replaceChildren(table);
    if (rows.length > 1000) wrap.append(el("p", { className: "hint", textContent: "1 000 premières lignes affichées : précise le filtre." }));
  }
  let t = 0;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { view.q = q.value; ui.saveView(view); draw(); }, 250); });
  csv.addEventListener("click", () => {
    const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [view.cols.map((c) => cell(FIXED_COLS[c]?.label || c)).join(";")];
    for (const [p, e] of rows) lines.push(view.cols.map((c) => { const v = cellValue(c, p, e); return cell(FIXED_COLS[c]?.fmt ? FIXED_COLS[c].fmt(v) : v); }).join(";"));
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" })), download: `${view.name || "base"}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  draw();
  return { refresh: draw };
}

export const defaultView = (name = "Toutes les notes") => ({
  id: Math.random().toString(36).slice(2, 10), name, q: "", cols: ["file.name", "file.folder", "file.mtime", "file.words"], sort: { col: "file.mtime", dir: -1 },
});
