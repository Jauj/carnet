// Carnet — recherche plein texte, partagée par la page (requêtes) et l'outil du PC (construction de l'index).
//
// L'index est chiffré comme les notes et découpé pour ne télécharger que le nécessaire :
//   - base  : un en-tête (liste des notes indexées et leur empreinte) et SHARDS morceaux « mot -> notes » ;
//             un mot est rangé dans le morceau de ses deux premières lettres ;
//   - delta : un seul fichier pour les notes modifiées depuis la base, réécrit à chaque synchronisation.
// Les noms de fichiers sont des HMAC (voir indexFile) : ils ne révèlent rien.

export const INDEX_VERSION = 1;
export const SHARDS = 256;

// Minuscules, sans accents ni ligatures : « Œuvre » et « oeuvre », « Élan » et « elan » se rejoignent.
export function fold(s) {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss");
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

export function tokens(text, out = new Set()) {
  for (const m of fold(text).matchAll(WORD_RE)) {
    const t = m[0];
    if (t.length >= 2) out.add(t.length > 32 ? t.slice(0, 32) : t);
  }
  return out;
}

export function shardOf(token) {
  let h = 2166136261;
  for (let i = 0; i < Math.min(2, token.length); i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % SHARDS;
}

// Nom du fichier chiffré d'une partie de l'index. Le préfixe \0 ne peut pas être un chemin de note.
export async function indexFile(noteId, nameKey, label) {
  const id = await noteId(nameKey, "\u0000index/" + label);
  return { file: `x/${id}.bin`, aad: `x/${id}` };
}

// Morceaux « mot -> indices croissants de notes ». Construits note par note (addPostings) : on ne garde
// jamais en mémoire les mots de toutes les notes à la fois.
export const emptyShards = () => Array.from({ length: SHARDS }, () => ({}));

export function addPostings(shards, set, i) {
  for (const t of set) (shards[shardOf(t)][t] ||= []).push(i);
}

export function buildPostings(tokenSets) {
  const shards = emptyShards();
  tokenSets.forEach((set, i) => addPostings(shards, set, i));
  return shards;
}

// ---------- requêtes ----------
// mots · "expression exacte" · -exclu · tag:x · dossier:x · prop:clé=valeur (ou prop:clé)

export function parseQuery(q) {
  const out = { terms: [], phrases: [], exclude: [], tags: [], folders: [], props: [] };
  const re = /(-?)(?:(tag|dossier|prop|chemin):)?(?:"([^"]*)"?|(\S+))/giu;
  for (const m of q.matchAll(re)) {
    const neg = m[1] === "-", op = m[2]?.toLowerCase(), val = (m[3] ?? m[4] ?? "").trim();
    if (!val) continue;
    if (op === "tag") out.tags.push({ neg, v: fold(val.replace(/^#/, "")) });
    else if (op === "dossier" || op === "chemin") out.folders.push({ neg, v: fold(val.replace(/^\/|\/$/g, "")) });
    else if (op === "prop") {
      const i = val.indexOf("=");
      out.props.push({ neg, k: fold(i < 0 ? val : val.slice(0, i)), v: i < 0 ? null : fold(val.slice(i + 1)) });
    } else if (neg) out.exclude.push(...tokens(val));
    else if (m[3] !== undefined) {
      const words = [...tokens(val)];
      if (words.length > 1) out.phrases.push(fold(val).match(WORD_RE).join(" "));
      out.terms.push(...words);
    } else out.terms.push(...tokens(val));
  }
  out.terms = [...new Set(out.terms)];
  return out;
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

// Filtres sur les métadonnées du manifeste (sans rien télécharger).
export function metaFilter(q) {
  return (path, entry) => {
    const meta = entry.meta || {};
    for (const t of q.tags) {
      const has = (meta.tags || []).some((x) => { const f = fold(x); return f === t.v || f.startsWith(t.v + "/"); });
      if (has === t.neg) return false;
    }
    for (const f of q.folders) {
      const p = fold(path);
      if ((p.startsWith(f.v + "/") || p.includes("/" + f.v + "/")) === f.neg) return false;
    }
    for (const pr of q.props) {
      const key = Object.keys(meta.props || {}).find((k) => fold(k) === pr.k);
      let ok = key !== undefined && meta.props[key] !== null && meta.props[key] !== "";
      if (ok && pr.v !== null) {
        const vals = Array.isArray(meta.props[key]) ? meta.props[key] : [meta.props[key]];
        ok = vals.some((v) => fold(String(v)).includes(pr.v));
      }
      if (ok === pr.neg) return false;
    }
    return true;
  };
}

const matchesTerm = (token, term) => (term.length < 3 ? token === term : token.startsWith(term));

// Exécute une requête. src fournit l'accès aux données (la page télécharge, les tests passent des objets) :
//   notes            manifeste.notes (chemin -> { sha, mtime, meta })
//   loadHead()       en-tête de la base, ou null si l'index n'existe pas encore
//   loadShard(n)     morceau n de la base
//   loadDelta()      delta, ou null
//   maxScan          nombre maximal de notes non indexées à lire directement (défaut 150)
//   readText(path)   texte d'une note (pour les notes non indexées)
// Renvoie { query, results: [{ path, score }], unindexed, skipped } ; la vérification des expressions
// exactes et les extraits se font ensuite, note par note, avec matchRanges.
export async function runSearch(qText, src) {
  const q = parseQuery(qText);
  const filter = metaFilter(q);
  const cands = Object.entries(src.notes).filter(([p, e]) => filter(p, e)).map(([p]) => p);
  if (!q.terms.length) {
    cands.sort((a, b) => (src.notes[b].mtime || 0) - (src.notes[a].mtime || 0));
    return { query: q, results: cands.map((path) => ({ path, score: 0 })), unindexed: 0, skipped: 0 };
  }

  // Quelles notes l'index couvre-t-il encore (même empreinte qu'au moment de l'indexation) ?
  const head = await src.loadHead();
  const delta = head ? await src.loadDelta() : null;
  const baseOk = new Map(), deltaOk = new Map();
  if (head) head.notes.forEach((p, i) => { if (src.notes[p]?.sha === head.shas[i]) baseOk.set(i, p); });
  if (delta) delta.notes.forEach((p, i) => { if (src.notes[p]?.sha === delta.shas[i]) deltaOk.set(i, p); });
  const covered = new Set([...baseOk.values(), ...deltaOk.values()]);

  // Pour chaque mot cherché : notes qui le contiennent, et finesse de la correspondance (mot exact > préfixe).
  const perTerm = [];
  const shardCache = new Map();
  for (const term of q.terms) {
    const hits = new Map();
    const add = (path, tok) => { const w = tok === term ? 2 : 1; if ((hits.get(path) || 0) < w) hits.set(path, w); };
    if (head) {
      const n = shardOf(term);
      if (!shardCache.has(n)) shardCache.set(n, await src.loadShard(n));
      for (const [tok, list] of Object.entries(shardCache.get(n))) {
        if (!matchesTerm(tok, term)) continue;
        for (const i of list) { const p = baseOk.get(i); if (p) add(p, tok); }
      }
    }
    if (delta) {
      for (const [tok, list] of Object.entries(delta.postings)) {
        if (!matchesTerm(tok, term)) continue;
        for (const i of list) { const p = deltaOk.get(i); if (p) add(p, tok); }
      }
    }
    perTerm.push(hits);
  }

  // Notes non couvertes (modifiées sur le web depuis la dernière synchro, ou index absent) : lues directement.
  const toScan = cands.filter((p) => !covered.has(p))
    .sort((a, b) => (src.notes[b].mtime || 0) - (src.notes[a].mtime || 0));
  const maxScan = src.maxScan ?? 150;
  for (const p of toScan.slice(0, maxScan)) {
    const set = tokens(baseName(p), tokens(await src.readText(p)));
    q.terms.forEach((term, k) => {
      let w = 0;
      for (const tok of set) if (matchesTerm(tok, term)) { w = Math.max(w, tok === term ? 2 : 1); if (w === 2) break; }
      if (w) perTerm[k].set(p, w);
    });
  }

  const excluded = new Set();
  if (q.exclude.length) {
    for (const ex of q.exclude) {
      const n = shardOf(ex);
      const shard = head ? (shardCache.get(n) ?? await src.loadShard(n)) : {};
      for (const i of shard[ex] || []) { const p = baseOk.get(i); if (p) excluded.add(p); }
      for (const i of delta?.postings[ex] || []) { const p = deltaOk.get(i); if (p) excluded.add(p); }
    }
  }

  const candSet = new Set(cands);
  const results = [];
  for (const [p, w0] of perTerm[0]) {
    if (!candSet.has(p) || excluded.has(p)) continue;
    let score = w0, ok = true;
    for (let k = 1; k < perTerm.length && ok; k++) { const w = perTerm[k].get(p); if (w) score += w; else ok = false; }
    if (!ok) continue;
    const title = fold(baseName(p));
    for (const term of q.terms) if (title.includes(term)) score += 6;
    results.push({ path: p, score });
  }
  results.sort((a, b) => b.score - a.score || (src.notes[b.path].mtime || 0) - (src.notes[a.path].mtime || 0));
  return { query: q, results, unindexed: Math.min(toScan.length, maxScan), skipped: Math.max(0, toScan.length - maxScan) };
}

// ---------- correspondances dans le texte (extraits, surlignage, expressions exactes) ----------

// Texte replié avec, pour chaque position repliée, sa position dans le texte d'origine.
// Parcours par codes de caractère : l'ASCII est traité directement, le reste passe par fold() une seule
// fois par caractère distinct (cache). Environ 20 ms pour 1 Mo, au lieu de 600 ms caractère par caractère.
const FOLD_CACHE = new Map();
const FOLD_ONE = new Int32Array(65536); // 0 : inconnu ; > 0 : caractère replié ; 0xffff : vide ; -1 : plusieurs
export function foldWithMap(text) {
  const n = text.length;
  let cap = n + 16;
  let codes = new Uint16Array(cap);
  let map = new Uint32Array(cap + 1);
  let j = 0;
  const grow = () => {
    cap *= 2;
    const c2 = new Uint16Array(cap); c2.set(codes); codes = c2;
    const m2 = new Uint32Array(cap + 1); m2.set(map); map = m2;
  };
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i);
    if (c < 128) {
      if (c >= 65 && c <= 90) c += 32;
      if (j >= cap) grow();
      codes[j] = c; map[j++] = i;
      continue;
    }
    // Caractère du plan de base qui se replie en un seul caractère : table directe.
    let one = FOLD_ONE[c];
    if (one === 0 && !(c >= 0xd800 && c <= 0xdfff)) {
      const g = fold(String.fromCharCode(c));
      one = FOLD_ONE[c] = g.length === 1 ? g.charCodeAt(0) : g.length === 0 ? 0xffff : -1;
    }
    if (one > 0 && one !== 0xffff) {
      if (j >= cap) grow();
      codes[j] = one; map[j++] = i;
      continue;
    }
    if (one === 0xffff) continue; // signe diacritique isolé : disparaît
    const start = i;
    let ch = text[i];
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) { ch = text.slice(i, i + 2); i++; }
    let g = FOLD_CACHE.get(ch);
    if (g === undefined) { g = fold(ch); if (FOLD_CACHE.size < 5000) FOLD_CACHE.set(ch, g); }
    for (let k = 0; k < g.length; k++) {
      if (j >= cap) grow();
      codes[j] = g.charCodeAt(k); map[j++] = start;
    }
  }
  map[j] = n;
  let f = "";
  for (let k = 0; k < j; k += 8192) f += String.fromCharCode.apply(null, codes.subarray(k, Math.min(j, k + 8192)));
  return { f, map };
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Plages [début, fin) dans le texte d'origine qui correspondent aux mots (début de mot) ou aux expressions.
// Renvoie null si une expression exacte demandée est absente.
export function matchRanges(text, q, limit = 200) {
  return matchFolded(foldWithMap(text), q, limit);
}

// Même chose sur un texte déjà replié (foldWithMap), pour ne pas refaire ce travail sur une longue note.
export function matchFolded({ f, map }, q, limit = 200) {
  const ranges = [];
  for (const ph of q.phrases) {
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + ph.split(" ").map(escapeRe).join("[^\\p{L}\\p{N}]+"), "gu");
    let found = false;
    for (const m of f.matchAll(re)) { found = true; ranges.push([map[m.index], map[m.index + m[0].length]]); if (ranges.length > limit) break; }
    if (!found) return null;
  }
  for (const term of q.terms) {
    let from = 0, n = 0;
    while (n < limit) {
      const at = f.indexOf(term, from);
      if (at < 0) break;
      from = at + term.length;
      if (isWordChar(f[at - 1])) continue;
      if (term.length < 3 && isWordChar(f[at + term.length])) continue;
      let end = at + term.length;
      while (isWordChar(f[end])) end++;
      ranges.push([map[at], map[end]]);
      n++;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  return merged;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Extraits autour des premières correspondances : [{ text, marks: [[début, fin], …] }] (positions locales).
export function snippets(text, ranges, { max = 2, radius = 80 } = {}) {
  const out = [];
  let lastEnd = -1;
  for (const [a, b] of ranges) {
    if (a < lastEnd) continue;
    let s = Math.max(0, a - radius), e = Math.min(text.length, b + radius);
    while (s > 0 && isWordChar(text[s - 1])) s--;
    while (e < text.length && isWordChar(text[e])) e++;
    const marks = ranges.filter(([x, y]) => x >= s && y <= e).map(([x, y]) => [x - s, y - s]);
    out.push({ text: text.slice(s, e), marks, head: s > 0, tail: e < text.length });
    lastEnd = e;
    if (out.length >= max) break;
  }
  return out;
}
