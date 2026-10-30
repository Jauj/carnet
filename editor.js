// Carnet — confort d'édition sur un simple <textarea> : barre d'outils, raccourcis, complétion des liens [[…]],
// continuation des listes, indentation. Les modifications passent par execCommand pour garder Ctrl+Z.

export const TOOLS = [
  ["B", "Gras (Ctrl+B)", (ed) => wrap(ed, "**", "**", "texte en gras"), "b"],
  ["I", "Italique (Ctrl+I)", (ed) => wrap(ed, "*", "*", "texte en italique"), "i"],
  ["S", "Barré", (ed) => wrap(ed, "~~", "~~", "texte barré")],
  ["==", "Surligné (Ctrl+Maj+H)", (ed) => wrap(ed, "==", "==", "texte surligné")],
  ["H1", "Titre 1", (ed) => linePrefix(ed, "# ")],
  ["H2", "Titre 2", (ed) => linePrefix(ed, "## ")],
  ["H3", "Titre 3", (ed) => linePrefix(ed, "### ")],
  ["•", "Liste à puces", (ed) => linePrefix(ed, "- ")],
  ["1.", "Liste numérotée", (ed) => linePrefix(ed, "1. ")],
  ["☐", "Case à cocher (Ctrl+L)", (ed) => linePrefix(ed, "- [ ] ")],
  ["❝", "Citation", (ed) => linePrefix(ed, "> ")],
  ["[[ ]]", "Lien vers une note (Ctrl+K dans l'éditeur)", (ed) => wrap(ed, "[[", "]]", "")],
  ["🔗", "Lien web", (ed) => wrap(ed, "[", "](https://)", "texte du lien")],
  ["</>", "Code", (ed) => wrap(ed, "`", "`", "code")],
  ["ⓘ", "Encadré (callout)", (ed) => linePrefix(ed, "> [!info] ")],
  ["―", "Ligne de séparation", (ed) => insert(ed, "\n---\n")],
  ["▦", "Tableau", (ed) => insert(ed, "\n| Colonne | Colonne |\n|---|---|\n|  |  |\n")],
];

function replaceRange(ed, a, b, text, selA, selB) {
  ed.focus();
  ed.setSelectionRange(a, b);
  if (!document.execCommand?.("insertText", false, text)) {
    ed.setRangeText(text, a, b, "end");
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selA !== undefined) ed.setSelectionRange(selA, selB ?? selA);
}

export function wrap(ed, pre, post, placeholder) {
  const a = ed.selectionStart, b = ed.selectionEnd;
  const sel = ed.value.slice(a, b) || placeholder;
  replaceRange(ed, a, b, pre + sel + post, a + pre.length, a + pre.length + sel.length);
}

export function linePrefix(ed, prefix) {
  const v = ed.value, a = ed.selectionStart, b = ed.selectionEnd;
  const start = v.lastIndexOf("\n", a - 1) + 1;
  const lines = v.slice(start, b).split("\n");
  const all = lines.every((l) => l.startsWith(prefix));
  const out = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l.replace(/^(#{1,6} |- \[[ x]\] |- |1\. |> (\[![\w-]+\] )?)/, ""))).join("\n");
  replaceRange(ed, start, b, out, start, start + out.length);
}

export function insert(ed, text) {
  const a = ed.selectionStart, b = ed.selectionEnd;
  replaceRange(ed, a, b, text, a + text.length);
}

// ---------- listes et indentation ----------
const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+\[[ xX]\])?\s+/;

function onEnter(ed, ev) {
  const v = ed.value, a = ed.selectionStart;
  if (a !== ed.selectionEnd) return;
  const start = v.lastIndexOf("\n", a - 1) + 1;
  const line = v.slice(start, a);
  const m = LIST_RE.exec(line);
  const quote = /^((?:>\s?)+)/.exec(line);
  if (!m && !quote) return;
  ev.preventDefault();
  if (m) {
    // Puce vide : fin de liste, avec une ligne vide pour que le texte suivant n'y soit pas rattaché.
    if (line.length === m[0].length) { replaceRange(ed, start, a, m[1] ? "" : "\n", m[1] ? start : start + 1); return; }
    const marker = m[2] ? m[2] : `${Number(m[3]) + 1}${m[4]}`;
    insert(ed, "\n" + m[1] + marker + (m[5] ? " [ ]" : "") + " ");
  } else {
    if (line.trim() === quote[1].trim()) { replaceRange(ed, start, a, "", start); return; }
    insert(ed, "\n" + quote[1]);
  }
}

function onTab(ed, ev) {
  const v = ed.value, a = ed.selectionStart, b = ed.selectionEnd;
  const start = v.lastIndexOf("\n", a - 1) + 1;
  const multi = v.slice(a, b).includes("\n");
  const inList = LIST_RE.test(v.slice(start));
  if (!multi && !inList && !ev.shiftKey) { ev.preventDefault(); insert(ed, "\t"); return; }
  ev.preventDefault();
  const end = b > a && v[b - 1] === "\n" ? b - 1 : b;
  const lines = v.slice(start, end).split("\n");
  const out = lines.map((l) => (ev.shiftKey ? l.replace(/^(\t| {1,4})/, "") : "\t" + l)).join("\n");
  replaceRange(ed, start, end, out, multi ? start : a + (out.length - (end - start)), multi ? start + out.length : undefined);
}

// ---------- position du curseur à l'écran (pour placer la liste de complétion) ----------
function caretXY(ed) {
  const div = document.createElement("div");
  const st = getComputedStyle(ed);
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize", "paddingTop",
    "paddingLeft", "paddingRight", "borderLeftWidth", "boxSizing", "whiteSpace", "wordWrap", "overflowWrap"]) div.style[p] = st[p];
  Object.assign(div.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", top: "0", left: "-9999px", width: ed.clientWidth + "px" });
  div.textContent = ed.value.slice(0, ed.selectionStart);
  const mark = document.createElement("span");
  mark.textContent = "​";
  div.append(mark);
  document.body.append(div);
  const r = ed.getBoundingClientRect();
  const out = { x: r.left + mark.offsetLeft - ed.scrollLeft, y: r.top + mark.offsetTop - ed.scrollTop + parseFloat(st.lineHeight || 20) };
  div.remove();
  return out;
}

// ---------- complétion [[…]] ----------
// suggest(query) -> [{ label, sub, insert }] ; query = texte tapé après « [[ » (peut contenir « # »).
function attachCompletion(ed, suggest) {
  const box = document.createElement("div");
  box.className = "complete";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  document.body.append(box);
  let items = [], sel = 0, from = -1;

  const close = () => { box.hidden = true; items = []; from = -1; };
  const accept = (i) => {
    const it = items[i];
    if (!it) return;
    const a = ed.selectionStart;
    const after = ed.value.slice(a, a + 2) === "]]" ? 2 : 0;
    replaceRange(ed, from, a + after, it.insert + "]]", from + it.insert.length + 2);
    close();
  };
  const draw = () => {
    box.innerHTML = "";
    items.forEach((it, i) => {
      const d = document.createElement("div");
      d.className = "complete-item" + (i === sel ? " sel" : "");
      d.setAttribute("role", "option");
      d.append(Object.assign(document.createElement("span"), { textContent: it.label }));
      if (it.sub) d.append(Object.assign(document.createElement("small"), { textContent: it.sub }));
      d.addEventListener("mousedown", (e) => { e.preventDefault(); accept(i); });
      box.append(d);
    });
    box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const update = () => {
    const v = ed.value, a = ed.selectionStart;
    const open = v.lastIndexOf("[[", a);
    if (open < 0 || a !== ed.selectionEnd) return close();
    const q = v.slice(open + 2, a);
    if (/[\]\n|]/.test(q) || q.length > 80) return close();
    from = open + 2;
    items = suggest(q).slice(0, 12);
    if (!items.length) return close();
    sel = 0;
    draw();
    const { x, y } = caretXY(ed);
    box.hidden = false;
    box.style.left = Math.min(x, innerWidth - box.offsetWidth - 8) + "px";
    box.style.top = (y + box.offsetHeight > innerHeight ? y - box.offsetHeight - 24 : y) + "px";
  };
  ed.addEventListener("input", update);
  ed.addEventListener("blur", () => setTimeout(close, 100));
  ed.addEventListener("keydown", (ev) => {
    if (box.hidden) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); sel = (sel + 1) % items.length; draw(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); sel = (sel - 1 + items.length) % items.length; draw(); }
    else if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); ev.stopImmediatePropagation(); accept(sel); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); close(); }
  }, true);
  return { close, isOpen: () => !box.hidden, destroy: () => box.remove() };
}

// Branche le confort d'édition sur un textarea.
export function attachEditor(ed, { suggest }) {
  const completion = attachCompletion(ed, suggest);
  ed.addEventListener("keydown", (ev) => {
    if (completion.isOpen()) return;
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.isComposing) onEnter(ed, ev);
    else if (ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) onTab(ed, ev);
    else if (ev.ctrlKey || ev.metaKey) {
      const k = ev.key.toLowerCase();
      if (k === "b") { ev.preventDefault(); wrap(ed, "**", "**", "texte en gras"); }
      else if (k === "i") { ev.preventDefault(); wrap(ed, "*", "*", "texte en italique"); }
      else if (k === "l") { ev.preventDefault(); linePrefix(ed, "- [ ] "); }
      else if (k === "h" && ev.shiftKey) { ev.preventDefault(); wrap(ed, "==", "==", "texte surligné"); }
      else if (k === "k" && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); wrap(ed, "[[", "]]", ""); ed.dispatchEvent(new Event("input")); }
    }
  });
  return completion;
}

export function buildToolbar(bar, getEditor) {
  for (const [label, title, fn] of TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = label; btn.title = title;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => { const ed = getEditor(); if (ed) fn(ed); });
    bar.append(btn);
  }
}
