// Carnet — format et cryptographie, partagés par la page (navigateur) et l'outil du PC (Node).
// Aucune dépendance : WebCrypto (PBKDF2, HKDF, AES-GCM, HMAC, SHA-256) et CompressionStream (gzip).
//
// Format d'un fichier chiffré : "CV1\0" (4 octets) | IV (12 octets) | AES-256-GCM(gzip(clair)) avec tag.
// Les données authentifiées associées (AAD) lient chaque fichier à sa place : "n/<id>", "manifest", "check".

export const FORMAT_VERSION = 1;
export const DEFAULT_ITERATIONS = 1000000;
export const MIN_SAFE_ITERATIONS = 100000;

const MAGIC = new Uint8Array([0x43, 0x56, 0x31, 0x00]);
const CHECK_TEXT = "carnet-ok";
const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;

// ---------- utilitaires ----------

export function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, i + 65536));
  return b;
}

export function utf8(s) { return te.encode(s); }

export function fromUtf8(bytes, { fatal = false } = {}) {
  return new TextDecoder("utf-8", { fatal }).decode(bytes);
}

export function isValidUtf8(bytes) {
  try { fromUtf8(bytes, { fatal: true }); return true; } catch { return false; }
}

export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function pipeThrough(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const gzip = (b) => pipeThrough(b, new CompressionStream("gzip"));
export const gunzip = (b) => pipeThrough(b, new DecompressionStream("gzip"));

export async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

// Chemins : séparateur "/", Unicode NFC, sans "./" ni "/" de tête.
export function normPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.?\/+/, "").normalize("NFC");
}

// ---------- clés ----------

// Phrase de passe -> PBKDF2-SHA256 -> secret maître -> HKDF -> trois clés indépendantes :
// enc (AES-GCM, fichiers), name (HMAC, noms de fichiers), local (AES-GCM, jeton et brouillons du navigateur).
export async function deriveKeys(passphrase, salt, iterations) {
  const base = await subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const master = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
  const hk = await subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const sub = (info, alg, usages) => subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("carnet/v1/" + info) },
    hk, alg, false, usages);
  return {
    enc: await sub("enc", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    name: await sub("name", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    local: await sub("local", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
  };
}

// ---------- chiffrement ----------

export async function encryptBytes(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad) }, key, await gzip(plain)));
  return concat(MAGIC, iv, ct);
}

// Lève une erreur si la clé est fausse, si un octet a été modifié ou si le fichier n'est pas à sa place.
export async function decryptBytes(key, blob, aad) {
  if (blob.length < 4 + 12 + 16 || MAGIC.some((b, i) => blob[i] !== b)) {
    throw new Error("Fichier chiffré illisible (format inconnu).");
  }
  const plainGz = await subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(4, 16), additionalData: utf8(aad) }, key, blob.subarray(16));
  return gunzip(new Uint8Array(plainGz));
}

export async function noteId(nameKey, path) {
  const sig = new Uint8Array(await subtle.sign("HMAC", nameKey, utf8(normPath(path))));
  return toHex(sig.subarray(0, 16));
}

export const noteFile = (id) => `n/${id}.bin`;
export const noteAad = (id) => `n/${id}`;

// ---------- vault.json ----------

export async function createVaultHeader(passphrase, iterations = DEFAULT_ITERATIONS) {
  const salt = randomBytes(16);
  const keys = await deriveKeys(passphrase, salt, iterations);
  const check = await encryptBytes(keys.enc, utf8(CHECK_TEXT), "check");
  const header = {
    format: "carnet", version: FORMAT_VERSION,
    kdf: { name: "PBKDF2-SHA256", iterations, salt: toBase64(salt) },
    check: toBase64(check),
  };
  return { header, keys };
}

// Renvoie les clés, ou lève "Phrase de passe incorrecte."
export async function unlock(header, passphrase) {
  if (header.format !== "carnet" || header.version !== FORMAT_VERSION) {
    throw new Error("vault.json : format non reconnu.");
  }
  const keys = await deriveKeys(passphrase, fromBase64(header.kdf.salt), header.kdf.iterations);
  let ok = false;
  try {
    ok = fromUtf8(await decryptBytes(keys.enc, fromBase64(header.check), "check")) === CHECK_TEXT;
  } catch { ok = false; }
  if (!ok) throw new Error("Phrase de passe incorrecte.");
  return keys;
}

// ---------- manifeste ----------
// { version, updated, notes: { "<chemin>": { id, sha, size, mtime } } }

export function emptyManifest() {
  return { version: FORMAT_VERSION, updated: new Date().toISOString(), notes: {} };
}

export async function encryptManifest(key, manifest) {
  manifest.updated = new Date().toISOString();
  return encryptBytes(key, utf8(JSON.stringify(manifest)), "manifest");
}

export async function decryptManifest(key, blob) {
  const m = JSON.parse(fromUtf8(await decryptBytes(key, blob, "manifest")));
  if (m.version !== FORMAT_VERSION || typeof m.notes !== "object") throw new Error("Manifeste illisible.");
  return m;
}

// Nom de la copie de conflit : "dossier/Note (conflit web 2026-10-26 14h03).md"
export function conflictPath(path, label, date = new Date()) {
  const p = normPath(path);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}`;
  const dot = p.toLowerCase().endsWith(".md") ? p.length - 3 : p.length;
  return `${p.slice(0, dot)} (${label} ${stamp})${p.slice(dot)}`;
}
