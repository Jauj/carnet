// Carnet — rendu Markdown avec les spécificités d'Obsidian (liens [[…]], intégrations, callouts, tags, ==surlignage==).
import { Marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import * as N from "./notes.js";
import * as store from "./store.js";

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const md = new Marked({ gfm: true, breaks: false });
md.use({
  extensions: [
    {
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
        if (N.ATTACH_RE.test(t.target)) return `<span class="att">📎 ${esc(t.alias || t.target)} <small>(pièce jointe, non synchronisée)</small></span>`;
        if (t.embed) return `<span class="embed" data-target="${esc(t.target)}" data-anchor="${esc(t.anchor)}"></span>`;
        const label = t.alias || (t.target ? t.target + (t.anchor ? " › " + t.anchor : "") : t.anchor);
        return `<a href="#" class="wl" data-target="${esc(t.target)}" data-anchor="${esc(t.anchor)}">${esc(label)}</a>`;
      },
    },
    {
      name: "highlight",
      level: "inline",
      start(src) { const i = src.indexOf("=="); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==(?=\S)([^\n]*?\S)==(?!=)/.exec(src);
        return m ? { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
      },
      renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
    },
    {
      name: "tag",
      level: "inline",
      start(src) { const m = /(^|[\s(])#[\p{L}\p{N}_/-]*[\p{L}_/-]/u.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) {
        const m = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u.exec(src);
        return m ? { type: "tag", raw: m[0], tag: m[1] } : undefined;
      },
      renderer(t) { return `<a href="#" class="tag" data-tag="${esc(t.tag)}">#${esc(t.tag)}</a>`; },
    },
  ],
  renderer: {
    image({ text }) { return `<span class="att">🖼 ${esc(text || "image")} <small>(non affichée)</small></span>`; },
  },
});

// Commentaires Obsidian %% … %% : non affichés.
const stripComments = (s) => s.replace(/%%[\s\S]*?%%/g, "");

function propValue(k, v) {
  const one = (x) => {
    const s = String(x);
    if (k === "tags") return `<a href="#" class="tag" data-tag="${esc(s.replace(/^#/, ""))}">#${esc(s.replace(/^#/, ""))}</a>`;
    const wl = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(s);
    if (wl) return `<a href="#" class="wl" data-target="${esc(wl[1])}" data-anchor="">${esc(wl[2] || wl[1])}</a>`;
    if (/^https?:\/\/\S+$/.test(s)) return `<a href="${esc(s)}">${esc(s)}</a>`;
    if (typeof x === "boolean") return x ? "☑" : "☐";
    return `<span class="chip">${esc(s)}</span>`;
  };
  if (v === null || v === "") return `<span class="empty">—</span>`;
  return Array.isArray(v) ? v.map(one).join(" ") : one(v);
}

// Propriétés (frontmatter) mises en forme. Renvoie "" s'il n'y en a pas.
export function renderProps(yaml) {
  if (yaml === null) return "";
  let props;
  try { props = N.parseYaml(yaml); } catch { props = null; }
  if (!props || !Object.keys(props).length) {
    return yaml.trim() ? `<details class="props"><summary>Propriétés</summary><pre>${esc(yaml)}</pre></details>` : "";
  }
  const rows = Object.entries(props).map(([k, v]) =>
    `<div class="prop"><span class="prop-k">${esc(k)}</span><span class="prop-v">${propValue(k, v)}</span></div>`);
  return `<div class="props">${rows.join("")}</div>`;
}

export const renderChunk = (markdown) =>
  DOMPurify.sanitize(md.parse(markdown), { FORBID_ATTR: ["style"], FORBID_TAGS: ["style", "img"] });

export function renderMarkdown(text, { props = true } = {}) {
  const { yaml, body } = N.splitFrontmatter(text);
  return (props ? renderProps(yaml) : "") + renderChunk(stripComments(body));
}

// Très longue note : propriétés + morceaux de Markdown à afficher l'un après l'autre (voir app.js),
// pour que la page ne se fige pas pendant le rendu.
export function renderChunks(text, size = 60000) {
  const { yaml, body } = N.splitFrontmatter(text);
  return { props: renderProps(yaml), chunks: splitMarkdown(stripComments(body), size) };
}

// Coupe de préférence avant un titre ; à défaut (texte sans titres), sur une ligne vide hors liste
// et hors citation. Jamais dans un bloc de code.
export function splitMarkdown(body, size = 60000) {
  if (body.length <= size * 1.5) return [body];
  const out = [];
  let cur = [], len = 0, fence = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
    }
    if (!fence && len >= size && cur.length) {
      const next = lines[i + 1] ?? "";
      const heading = /^#{1,6}[ \t]/.test(line);
      const blank = !line.trim() && len >= size * 2 && !/^([ \t]|[-*+>][ \t]|\d+[.)][ \t]|\|)/.test(next);
      if (heading || blank) { out.push(cur.join("\n")); cur = []; len = 0; }
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

// Section d'une note (pour ![[Note#Section]]) : du titre jusqu'au titre suivant de même niveau ou plus haut.
export function sectionOf(text, anchor) {
  if (!anchor) return N.splitFrontmatter(text).body;
  const want = store.fold(anchor.replace(/^\^/, ""));
  const lines = text.split("\n");
  let start = -1, level = 7;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (start < 0) { if (h && store.fold(h[2]) === want) { start = i; level = h[1].length; } }
    else if (h && h[1].length <= level) return lines.slice(start, i).join("\n");
  }
  return start < 0 ? `*Section « ${anchor} » introuvable.*` : lines.slice(start).join("\n");
}

const CALLOUT_ICONS = {
  note: "✎", info: "ⓘ", todo: "☐", tip: "💡", hint: "💡", important: "💡", success: "✓", check: "✓", done: "✓",
  question: "?", help: "?", faq: "?", warning: "⚠", caution: "⚠", attention: "⚠", failure: "✗", fail: "✗",
  missing: "✗", danger: "⚡", error: "⚡", bug: "🐞", example: "≡", quote: "❝", cite: "❝", abstract: "≡", summary: "≡", tldr: "≡",
};
const CALLOUT_FAMILY = {
  tip: "tip", hint: "tip", important: "tip", success: "ok", check: "ok", done: "ok", question: "warn", help: "warn",
  faq: "warn", warning: "warn", caution: "warn", attention: "warn", failure: "bad", fail: "bad", missing: "bad",
  danger: "bad", error: "bad", bug: "bad", example: "ex", quote: "quote", cite: "quote", abstract: "tip", summary: "tip", tldr: "tip",
};

// Liens résolus, liens externes, callouts, cases à cocher numérotées, intégrations.
// depth : profondeur d'intégration (une note intégrée n'intègre pas à son tour).
// Renvoie le numéro de la prochaine case à cocher (taskStart : numéro de la première de ce morceau).
export function decorate(root, from, { depth = 0, taskStart = 0 } = {}) {
  for (const a of root.querySelectorAll("a.wl")) {
    const p = store.resolveLink(a.dataset.target, from);
    if (p) a.dataset.path = p; else { a.classList.add("missing"); a.title = "Note absente : cliquer pour la créer"; }
  }
  for (const a of root.querySelectorAll("a[href]:not(.wl):not(.tag)")) {
    const href = a.getAttribute("href");
    if (/^https?:\/\//i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; a.classList.add("ext"); continue; }
    if (href.startsWith("#")) continue;
    if (/\.md(#.*)?$/i.test(href)) {
      const p = N.resolveRelative(from, href.split("#")[0]);
      a.className = "wl";
      a.dataset.target = p.replace(/\.md$/i, "");
      if (store.exists(p)) a.dataset.path = p; else a.classList.add("missing");
      a.setAttribute("href", "#");
    } else {
      a.replaceWith(Object.assign(document.createElement("span"), { className: "att", textContent: `📎 ${a.textContent} (non synchronisé)` }));
    }
  }
  for (const bq of root.querySelectorAll("blockquote")) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== "P") continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n([\s\S]*))?$/.exec(p.innerHTML);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const box = document.createElement(m[2] ? "details" : "div");
    box.className = `callout callout-${CALLOUT_FAMILY[type] || "info"}`;
    box.dataset.type = type;
    if (m[2] === "+") box.open = true;
    const title = document.createElement(m[2] ? "summary" : "div");
    title.className = "callout-title";
    title.innerHTML = `<span class="callout-icon">${CALLOUT_ICONS[type] || "ⓘ"}</span> ` + (m[3] || esc(type[0].toUpperCase() + type.slice(1)));
    if (m[4]) p.innerHTML = m[4]; else p.remove();
    const content = document.createElement("div");
    content.className = "callout-body";
    content.append(...bq.childNodes);
    box.append(title, content);
    bq.replaceWith(box);
  }
  // Cases à cocher : numérotées dans l'ordre du texte source (hors notes intégrées), pour pouvoir les cocher.
  let i = taskStart;
  if (depth === 0) {
    for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
      if (cb.closest(".embed")) continue;
      cb.disabled = false;
      cb.dataset.task = String(i++);
      cb.closest("li")?.classList.add("task", cb.checked ? "done" : "open");
    }
  } else {
    for (const cb of root.querySelectorAll('input[type="checkbox"]')) cb.disabled = true;
  }
  for (const h of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) h.classList.add("heading");
  for (const t of root.querySelectorAll("table")) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.append(t);
  }
  for (const e of root.querySelectorAll("span.embed")) fillEmbed(e, from, depth);
  return i;
}

async function fillEmbed(el, from, depth) {
  const p = store.resolveLink(el.dataset.target, from);
  const label = el.dataset.target + (el.dataset.anchor ? " › " + el.dataset.anchor : "");
  const head = `<div class="embed-head"><a href="#" class="wl" data-target="${esc(el.dataset.target)}" data-anchor="${esc(el.dataset.anchor)}"${p ? ` data-path="${esc(p)}"` : ""}>${esc(label)}</a></div>`;
  if (!p) { el.innerHTML = head + `<div class="embed-body empty">Note absente.</div>`; el.querySelector("a").classList.add("missing"); return; }
  if (depth >= 1 || p === from) { el.innerHTML = head; return; }
  el.innerHTML = head + `<div class="embed-body empty">…</div>`;
  try {
    const note = await store.readNote(p);
    const body = el.querySelector(".embed-body");
    body.classList.remove("empty");
    body.innerHTML = renderMarkdown(sectionOf(note.text, el.dataset.anchor), { props: false });
    decorate(body, p, { depth: depth + 1 });
  } catch (err) {
    el.querySelector(".embed-body").textContent = err.message;
  }
}

// Lignes des tâches dans le texte source, dans l'ordre de rendu (le texte des blocs de code est ignoré).
export function taskLines(text) {
  const { body, offset } = N.splitFrontmatter(text);
  const code = N.maskCode(stripCommentsKeepLength(body));
  const out = [];
  const re = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\]/gm;
  for (const m of code.matchAll(re)) out.push(offset + m.index + m[0].length - 2); // position du caractère entre [ ]
  return out;
}
const stripCommentsKeepLength = (s) => s.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, " "));

// Bascule la tâche n dans le texte : renvoie le nouveau texte, ou null si elle n'existe pas.
export function toggleTask(text, n, checked) {
  const at = taskLines(text)[n];
  if (at === undefined) return null;
  return text.slice(0, at) + (checked ? "x" : " ") + text.slice(at + 1);
}
