import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../crypto.js";

const IT = 1000; // itérations réduites pour les tests uniquement

test("aller-retour : texte Unicode, fichier vide, gros fichier", async () => {
  const { header, keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  const samples = [
    C.utf8("# Réunion du Bureau\n\n> [!info] Ordre du jour\n- Étudiants, Пролетарии всех стран\r\n"),
    new Uint8Array(0),
    C.utf8("Le Capital, livre IV. ".repeat(150000)), // ~3 Mo
    new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xe9]),   // octets non UTF-8, restitués à l'identique
  ];
  for (const plain of samples) {
    const blob = await C.encryptBytes(keys.enc, plain, "n/abc");
    const back = await C.decryptBytes(keys.enc, blob, "n/abc");
    assert.deepEqual(back, plain);
  }
  const again = await C.unlock(header, "phrase de passe de test assez longue");
  const blob = await C.encryptBytes(keys.enc, C.utf8("x"), "n/z");
  assert.equal(C.fromUtf8(await C.decryptBytes(again.enc, blob, "n/z")), "x");
});

test("contrôle d'échec : mauvaise phrase de passe refusée", async () => {
  const { header } = await C.createVaultHeader("la bonne phrase de passe, très longue", IT);
  await assert.rejects(C.unlock(header, "la mauvaise phrase de passe, très longue"), /incorrecte/);
});

test("contrôle d'échec : un octet modifié est détecté", async () => {
  const { keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  const blob = await C.encryptBytes(keys.enc, C.utf8("compte rendu confidentiel"), "n/abc");
  for (const pos of [5, 20, blob.length - 1]) {
    const bad = blob.slice();
    bad[pos] ^= 0x01;
    await assert.rejects(C.decryptBytes(keys.enc, bad, "n/abc"));
  }
});

test("contrôle d'échec : un fichier déplacé (autre AAD) est refusé", async () => {
  const { keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  const blob = await C.encryptBytes(keys.enc, C.utf8("note A"), "n/aaaa");
  await assert.rejects(C.decryptBytes(keys.enc, blob, "n/bbbb"));
  await assert.rejects(C.decryptBytes(keys.enc, blob, "manifest"));
});

test("contrôle d'échec : format inconnu refusé", async () => {
  const { keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  await assert.rejects(C.decryptBytes(keys.enc, C.utf8("pas un fichier chiffré du tout, juste du texte"), "n/x"), /format/);
});

test("le chiffré ne contient ni le texte ni le chemin en clair", async () => {
  const { keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  const secret = "CONFIDENTIEL Bureau CPS";
  const m = C.emptyManifest();
  m.notes["02 Notes/02_01 Réunion/Bureau.md"] = { id: "x", sha: "y", size: 1, mtime: 1 };
  const blobs = [
    await C.encryptBytes(keys.enc, C.utf8(secret.repeat(50)), "n/x"),
    await C.encryptManifest(keys.enc, m),
  ];
  for (const b of blobs) {
    const latin = Buffer.from(b).toString("latin1");
    assert.ok(!latin.includes("CONFIDENTIEL") && !latin.includes("Bureau") && !latin.includes("Réunion"));
  }
});

test("noteId : déterministe, dépend de la clé et du chemin normalisé", async () => {
  const a = await C.createVaultHeader("phrase de passe numéro un, assez longue", IT);
  const b = await C.createVaultHeader("phrase de passe numéro deux, assez longue", IT);
  const p = "02 Notes\\Réunion.md";
  const id1 = await C.noteId(a.keys.name, p);
  assert.match(id1, /^[0-9a-f]{32}$/);
  assert.equal(id1, await C.noteId(a.keys.name, "02 Notes/Réunion.md")); // NFD -> NFC
  assert.notEqual(id1, await C.noteId(b.keys.name, p));
  assert.notEqual(id1, await C.noteId(a.keys.name, "02 Notes/Reunion.md"));
});

test("manifeste : aller-retour", async () => {
  const { keys } = await C.createVaultHeader("phrase de passe de test assez longue", IT);
  const m = C.emptyManifest();
  m.notes["a/b.md"] = { id: "0".repeat(32), sha: "f".repeat(64), size: 3, mtime: 123 };
  const back = await C.decryptManifest(keys.enc, await C.encryptManifest(keys.enc, m));
  assert.deepEqual(back.notes, m.notes);
});

test("conflictPath", () => {
  const d = new Date(2026, 9, 26, 14, 3);
  assert.equal(C.conflictPath("a/Note.md", "conflit web", d), "a/Note (conflit web 2026-10-26 14h03).md");
  assert.equal(C.conflictPath("Note", "conflit", d), "Note (conflit 2026-10-26 14h03)");
});

test("base64 : aller-retour sur un grand tableau", () => {
  const b = C.randomBytes(200000);
  assert.deepEqual(C.fromBase64(C.toBase64(b)), b);
});

test("secret maître : mêmes clés que la phrase de passe ; un faux secret est refusé", async () => {
  const pass = "phrase de passe de test assez longue";
  const { header, keys } = await C.createVaultHeader(pass, IT);
  const master = await C.masterFor(header, pass);
  assert.equal(master.length, 32);
  const viaMaster = await C.unlockMaster(header, master);
  const blob = await C.encryptBytes(keys.enc, C.utf8("note"), "n/a");
  assert.equal(C.fromUtf8(await C.decryptBytes(viaMaster.enc, blob, "n/a")), "note");
  assert.equal(await C.noteId(viaMaster.name, "a.md"), await C.noteId(keys.name, "a.md"));
  await assert.rejects(C.unlockMaster(header, C.randomBytes(32)), /incorrecte/);
});
