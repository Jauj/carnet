// Carnet — analyse d'une note Obsidian, partagée par la page et l'outil du PC.
// Produit les métadonnées gardées (chiffrées) dans le manifeste : propriétés, tags, liens, titres, tâches.

export const META_VERSION = 1;
export const ATTACH_RE = /\.(png|jpe?g|gif|svg|webp|bmp|pdf|mp3|m4a|wav|ogg|mp4|webm|docx?|xlsx?|pptx?|odt|epub|zip|canvas|base)$/i;

const MAX = { links: 300, heads: 80, list: 30, str: 300 };

// ---------- frontmatter (sous-ensemble de YAML utilisé par les propriétés d'Obsidian) ----------

export function splitFrontmatter(text) {
  const t = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { yaml: null, body: t, offset: text.length - t.length };
  return { yaml: m[1], body: t.slice(m[0].length), offset: text.length - t.length + m[0].length };
}

function scalar(s) {
  s = s.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === "[" && s.endsWith("]")) return splitInline(s.slice(1, -1)).map(scalar).filter((v) => v !== null);
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

// "a, 'b, c', d" -> ["a", "'b, c'", "d"]
function splitInline(s) {
  const out = [];
  let cur = "", q = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = ""; }
    else if (c === '"' || c === "'") { cur += c; q = c; }
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseYaml(src) {
  const out = {};
  let key = null, block = null;
  for (const line of src.split(/\r?\n/)) {
    if (block !== null) {
      if (/^\s+\S/.test(line) || !line.trim()) { out[key] += (out[key] ? block : "") + line.trim(); continue; }
      block = null;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$|^\s*-$/.exec(line);
    if (key && item) {
      if (!Array.isArray(out[key])) out[key] = out[key] == null ? [] : [out[key]];
      const v = scalar(item[1] ?? "");
      if (v !== null) out[key].push(v);
      continue;
    }
    const kv = /^([^\s:#-][^:]*?|"[^"]+"|'[^']+'):(?:[ \t]+(.*))?$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      key = kv[1].replace(/^["']|["']$/g, "").trim();
      const v = (kv[2] ?? "").trim();
      if (/^[|>][+-]?$/.test(v)) { block = v[0] === "|" ? "\n" : " "; out[key] = ""; }
      else out[key] = scalar(v);
      continue;
    }
    // Sous-clés (objet imbriqué) : gardées comme texte, sans les interpréter.
    if (key && /^\s+\S/.test(line)) {
      const cur = out[key];
      out[key] = (typeof cur === "string" && cur ? cur + "\n" : "") + line.trim();
    }
  }
  return out;
}

// ---------- corps de la note ----------

// Le code (blocs et `en ligne`) est remplacé par des espaces : ni tags, ni liens, ni titres dedans.
export function maskCode(body) {
  return body
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
}

export function listOf(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

const cleanTag = (t) => t.replace(/^#/, "").trim();
const TAG_RE = /(?:^|[\s(,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const WIKI_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MDLINK_RE = /\[[^\]\n]*\]\(<?([^)>\s]+?\.md)(?:#[^)>\s]*)?>?(?:\s+"[^"]*")?\)/gi;
const HEAD_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm;
const TASK_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\]/gm;

// Lien Markdown relatif -> chemin dans le vault.
export function resolveRelative(from, href) {
  let rel;
  try { rel = decodeURIComponent(href); } catch { rel = href; }
  if (rel.startsWith("/")) rel = rel.slice(1);
  else {
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    rel = dir ? `${dir}/${rel}` : rel;
  }
  const out = [];
  for (const seg of rel.split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
  return out.join("/").normalize("NFC");
}

function capValue(v) {
  if (typeof v === "string") return v.length > MAX.str ? v.slice(0, MAX.str) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, MAX.list).map(capValue);
  return v;
}

// Métadonnées d'une note. Les champs vides sont omis pour garder le manifeste compact.
export function parseNote(text, path = "") {
  const { yaml, body } = splitFrontmatter(text);
  let props = null;
  if (yaml !== null) { try { props = parseYaml(yaml); } catch { props = null; } }
  const tags = new Set();
  const aliases = [];
  if (props) {
    for (const t of listOf(props.tags ?? props.tag)) tags.add(cleanTag(t));
    for (const a of listOf(props.aliases ?? props.alias)) aliases.push(a);
    // Les alias peuvent contenir des espaces : la forme liste YAML est la seule fiable.
    if (typeof (props.aliases ?? props.alias) === "string") aliases.splice(0, aliases.length, String(props.aliases ?? props.alias).trim());
    delete props.tags; delete props.tag; delete props.aliases; delete props.alias;
  }
  const code = maskCode(body);
  for (const m of code.matchAll(TAG_RE)) tags.add(cleanTag(m[1]));

  const links = new Set();
  for (const m of code.matchAll(WIKI_RE)) {
    const target = m[2].split("|")[0].split("#")[0].trim();
    if (target && !ATTACH_RE.test(target)) links.add(target.replace(/\.md$/i, ""));
    if (links.size >= MAX.links) break;
  }
  for (const m of code.matchAll(MDLINK_RE)) {
    if (/^[a-z]+:/i.test(m[1]) || links.size >= MAX.links) continue;
    links.add("/" + resolveRelative(path, m[1]).replace(/\.md$/i, "")); // "/" : chemin complet, pas un nom
  }

  const heads = [];
  for (const m of code.matchAll(HEAD_RE)) {
    heads.push([m[1].length, m[2].replace(/\s+\^[\w-]+$/, "")]);
    if (heads.length >= MAX.heads) break;
  }
  let open = 0, done = 0;
  for (const m of code.matchAll(TASK_RE)) { if (m[1] === " ") open++; else done++; }
  const words = (body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  const dataview = (body.match(/^```dataview(js)?\b/gm) || []).length;

  const meta = { words };
  if (props && Object.keys(props).length) {
    meta.props = {};
    for (const [k, v] of Object.entries(props)) meta.props[k] = capValue(v);
  }
  if (tags.size) meta.tags = [...tags].filter(Boolean).slice(0, MAX.list * 2);
  if (aliases.length) meta.aliases = aliases.slice(0, MAX.list);
  if (links.size) meta.links = [...links];
  if (heads.length) meta.heads = heads;
  if (open || done) meta.tasks = [open, done];
  if (dataview) meta.dataview = dataview;
  return meta;
}
