// Scénarios de synchronisation : deux « appareils » (A et B) partagent un dépôt git nu local qui joue GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "../crypto.js";
import * as X from "../search.js";

const TOOL = fileURLToPath(new URL("../tools/sync.mjs", import.meta.url));
const PASS = "phrase de passe de test suffisamment longue";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-test-"));
  const remote = path.join(root, "remote.git");
  spawnSync("git", ["init", "--bare", "--quiet", remote]);
  return { root, remote };
}

function device(env, name, files = {}) {
  const home = path.join(env.root, name, "home");
  const vault = path.join(env.root, name, "vault");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"),
    JSON.stringify({ vault, remote: env.remote, author: { name: "carnet", email: "carnet@test" } }));
  for (const [p, c] of Object.entries(files)) write(vault, p, c);
  const run = (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], {
      env: { ...process.env, CARNET_HOME: home, CARNET_TEST_PASSPHRASE: PASS, CARNET_ALLOW_WEAK: "1", ...extraEnv },
      encoding: "utf8",
    });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  return { home, vault, run, init: () => run(["init", "--iterations", "1000"]), sync: (...a) => run(["sync", ...a]) };
}

const abs = (vault, p) => path.join(vault, ...p.split("/"));
function write(vault, p, c) { fs.mkdirSync(path.dirname(abs(vault, p)), { recursive: true }); fs.writeFileSync(abs(vault, p), c); }
const read = (vault, p) => fs.readFileSync(abs(vault, p));
const has = (vault, p) => fs.existsSync(abs(vault, p));
function listMd(dir, rel = "") {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(listMd(path.join(dir, e.name), r));
    else if (e.name.endsWith(".md")) out.push(r);
  }
  return out.sort();
}
const ok = (r) => { assert.equal(r.code, 0, r.out); return r; };
const remoteGit = (env, ...args) => spawnSync("git", ["--git-dir", env.remote, ...args], { encoding: "utf8" }).stdout;

test("init puis premier sync d'un 2e appareil ; exclusions ; rien en clair côté dépôt", () => {
  const env = setup();
  const A = device(env, "A", {
    "02 Notes/Bureau.md": "# Compte rendu du Bureau\nConfidentiel.",
    "racine.md": "[[02 Notes/Bureau]]",
    "Rubbish/vieux.md": "à exclure",
    ".obsidian/x.md": "à exclure",
    "02 Notes/02_06 Personnel/API.md": "token=secret",
    "note.sync-conflict-20260101-000000-ABC.md": "à exclure",
    "image.png": "pas du markdown",
  });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  assert.deepEqual(listMd(B.vault), ["02 Notes/Bureau.md", "racine.md"]);
  assert.equal(read(B.vault, "02 Notes/Bureau.md").toString(), "# Compte rendu du Bureau\nConfidentiel.");

  const tree = remoteGit(env, "ls-tree", "-r", "--name-only", "data").trim().split("\n");
  assert.ok(tree.every((f) => /^(vault\.json|manifest\.bin|[nx]\/[0-9a-f]{32}\.bin)$/.test(f)), tree.join(","));
  const messages = remoteGit(env, "log", "--format=%s%n%an <%ae>", "data");
  assert.ok(!/Bureau|Notes|racine/.test(messages), messages);
  assert.ok(tree.filter((f) => f.startsWith("x/")).length > 200, "index de recherche présent");
  for (const f of tree.filter((f) => /^[nx]\//.test(f))) {
    const blob = spawnSync("git", ["--git-dir", env.remote, "cat-file", "blob", `data:${f}`]).stdout.toString("latin1");
    assert.ok(!/confidentiel|bureau/i.test(blob), f);
  }
});

test("modification locale puis distante ; status ne modifie rien", () => {
  const env = setup();
  const A = device(env, "A", { "n1.md": "v1" });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  write(A.vault, "n1.md", "v2 depuis A");
  const before = remoteGit(env, "rev-parse", "data");
  const st = ok(A.run(["status"]));
  assert.match(st.out, /envoyées vers GitHub : 1/);
  assert.equal(remoteGit(env, "rev-parse", "data"), before, "status ne doit rien envoyer");
  ok(A.sync());
  ok(B.sync());
  assert.equal(read(B.vault, "n1.md").toString(), "v2 depuis A");
  write(B.vault, "n1.md", "v3 depuis B");
  ok(B.sync());
  ok(A.sync());
  assert.equal(read(A.vault, "n1.md").toString(), "v3 depuis B");
});

test("conflit : les deux versions sont conservées des deux côtés", () => {
  const env = setup();
  const A = device(env, "A", { "dossier/n.md": "base" });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  write(B.vault, "dossier/n.md", "version B");
  ok(B.sync());
  write(A.vault, "dossier/n.md", "version A");
  const r = ok(A.sync());
  assert.match(r.out, /conflit web/);
  assert.equal(read(A.vault, "dossier/n.md").toString(), "version A");
  const copy = listMd(A.vault).find((p) => p.startsWith("dossier/n (conflit web"));
  assert.ok(copy, listMd(A.vault).join(","));
  assert.equal(read(A.vault, copy).toString(), "version B");
  ok(B.sync());
  assert.equal(read(B.vault, "dossier/n.md").toString(), "version A");
  assert.equal(read(B.vault, copy).toString(), "version B");
  // Une nouvelle synchronisation ne crée pas de copie supplémentaire.
  ok(A.sync()); ok(B.sync());
  assert.equal(listMd(A.vault).filter((p) => p.includes("conflit")).length, 1);
});

test("suppression : propagée, et la note supprimée à distance part dans la corbeille", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a", "b.md": "b" });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  fs.rmSync(abs(A.vault, "a.md"));
  ok(A.sync());
  ok(B.sync());
  assert.ok(!has(B.vault, "a.md"));
  assert.deepEqual(listMd(path.join(B.home, "corbeille")).map((p) => p.split("/").pop()), ["a.md"]);
});

test("frein de sécurité : aucune modification au-delà de 20 suppressions, sauf autorisation", () => {
  const env = setup();
  const files = {};
  for (let i = 0; i < 30; i++) files[`notes/n${i}.md`] = `note ${i}`;
  const A = device(env, "A", files);
  ok(A.init());
  const before = remoteGit(env, "rev-parse", "data");
  for (let i = 0; i < 25; i++) fs.rmSync(abs(A.vault, `notes/n${i}.md`));
  const r = A.sync();
  assert.equal(r.code, 1);
  assert.match(r.out, /Frein de sécurité/);
  assert.equal(remoteGit(env, "rev-parse", "data"), before, "rien ne doit être envoyé");
  ok(A.sync("--autoriser-suppressions"));
  const B = device(env, "B");
  ok(B.sync());
  assert.equal(listMd(B.vault).length, 5);
});

test("vault vide ou introuvable : arrêt sans rien supprimer", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a" });
  ok(A.init());
  const before = remoteGit(env, "rev-parse", "data");
  fs.rmSync(abs(A.vault, "a.md"));
  const r = A.sync();
  assert.equal(r.code, 1);
  assert.match(r.out, /vide ou introuvable/);
  assert.equal(remoteGit(env, "rev-parse", "data"), before);
});

test("course : B pousse pendant la synchronisation de A, A réessaie et réussit", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a", "b.md": "b" });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  write(B.vault, "b.md", "b modifiée par B");
  write(A.vault, "a.md", "a modifiée par A");
  // Le crochet lance la synchronisation de B (avec SON dossier) juste avant l'envoi de A.
  // Script Node plutôt que .cmd : le test tourne aussi hors de Windows.
  const hookScript = path.join(env.root, "hook.mjs");
  fs.writeFileSync(hookScript, `import { spawnSync } from "node:child_process";
spawnSync(process.execPath, [${JSON.stringify(TOOL)}, "sync"], { env: { ...process.env, CARNET_HOME: ${JSON.stringify(B.home)} }, stdio: "inherit" });
`);
  const r = ok(A.run(["sync"], { CARNET_TEST_HOOK_BEFORE_PUSH: `"${process.execPath}" "${hookScript}"` }));
  assert.match(r.out, /nouvelle tentative/);
  ok(B.sync());
  assert.equal(read(A.vault, "b.md").toString(), "b modifiée par B");
  assert.equal(read(B.vault, "a.md").toString(), "a modifiée par A");
});

test("chemin de plus de 260 caractères et octets non UTF-8 restitués à l'identique", () => {
  const env = setup();
  let long = "01 Ressources";
  while (long.length < 280) long += "/01_01_01_03_05 Oeuvres russes, sous-dossier très long";
  const bytes = Buffer.from([0x23, 0x20, 0xe9, 0x74, 0xe9, 0x0d, 0x0a, 0xff, 0x00]);
  const A = device(env, "A", { [`${long}/Наша первая революция.md`]: "Текст", "latin1.md": bytes });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  assert.equal(read(B.vault, `${long}/Наша первая революция.md`).toString(), "Текст");
  assert.deepEqual(read(B.vault, "latin1.md"), bytes);
});

test("collision de casse : rien n'est écrasé et l'état se stabilise", () => {
  const env = setup();
  const A = device(env, "A", { "x/autre.md": "autre" });
  ok(A.init());
  const B = device(env, "B");
  ok(B.sync());
  write(B.vault, "x/fiche.md", "version B");
  ok(B.sync());
  write(A.vault, "x/Fiche.md", "version A");
  ok(A.sync());
  assert.equal(read(A.vault, "x/Fiche.md").toString(), "version A");
  const copy = listMd(A.vault).find((p) => p.includes("conflit web"));
  assert.ok(copy && read(A.vault, copy).toString() === "version B", listMd(A.vault).join(","));
  ok(B.sync()); ok(A.sync()); ok(B.sync());
  for (const D of [A, B]) {
    const all = listMd(D.vault);
    assert.equal(all.filter((p) => p.includes("conflit")).length, 1, all.join(","));
    assert.ok(all.some((p) => p.toLowerCase() === "x/fiche.md"));
  }
  assert.equal(read(B.vault, "x/Fiche.md").toString(), "version A");
});

test("mauvaise phrase de passe : refus, rien de modifié", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a" });
  ok(A.init());
  write(A.vault, "a.md", "modifiée");
  const before = remoteGit(env, "rev-parse", "data");
  const r = A.run(["sync"], { CARNET_TEST_PASSPHRASE: "une autre phrase de passe bien longue" });
  assert.equal(r.code, 1);
  assert.match(r.out, /incorrecte/);
  assert.equal(remoteGit(env, "rev-parse", "data"), before);
});

test("init refuse une phrase trop courte et un dataDir dans le vault", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a" });
  const r = A.run(["init", "--iterations", "1000"], { CARNET_TEST_PASSPHRASE: "trop courte" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Trop courte/);
  const cfgPath = path.join(A.home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.dataDir = path.join(A.vault, "data");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r2 = A.init();
  assert.equal(r2.code, 1);
  assert.match(r2.out, /dataDir/);
  assert.equal(read(A.vault, "a.md").toString(), "a");
});

test("le manifeste déchiffré contient les bons chemins et empreintes", async () => {
  const env = setup();
  const A = device(env, "A", { "é/n.md": "contenu" });
  ok(A.init());
  const header = JSON.parse(remoteGit(env, "show", "data:vault.json"));
  const keys = await C.unlock(header, PASS);
  const blob = spawnSync("git", ["--git-dir", env.remote, "cat-file", "blob", "data:manifest.bin"]).stdout;
  const m = await C.decryptManifest(keys.enc, new Uint8Array(blob));
  assert.deepEqual(Object.keys(m.notes), ["é/n.md"]);
  assert.equal(m.notes["é/n.md"].sha, await C.sha256Hex(C.utf8("contenu")));
  assert.equal(m.notes["é/n.md"].id, await C.noteId(keys.name, "é/n.md"));
});

test("clé mémorisée : sync sans phrase de passe, puis oubli ; clé périmée après un init --force", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a" });
  ok(A.init());
  const fake = { CARNET_TEST_FAKE_DPAPI: "1" };
  const noPass = { ...fake, CARNET_TEST_PASSPHRASE: "" }; // toute demande de phrase échoue (entrée fermée)
  assert.match(A.run(["sync"], noPass).out, /Saisie interrompue/);
  assert.match(ok(A.run(["sync", "--memoriser"], fake)).out, /Clé mémorisée/);
  write(A.vault, "b.md", "b");
  assert.match(ok(A.run(["sync"], noPass)).out, /envoyées vers GitHub : 1/);
  assert.match(ok(A.run(["oublier"])).out, /effacée/);
  assert.match(A.run(["sync"], noPass).out, /Saisie interrompue/);

  // Une clé qui ne correspond plus au carnet est oubliée, et la phrase est redemandée.
  ok(A.run(["sync", "--memoriser"], fake));
  fs.writeFileSync(path.join(A.home, "cle.dpapi"), C.toBase64(C.randomBytes(32)));
  const r = ok(A.run(["sync"], fake));
  assert.match(r.out, /ne correspond plus/);
  assert.ok(!fs.existsSync(path.join(A.home, "cle.dpapi")));
});

test("migrer : l'historique passe dans un dépôt de données à part, la synchro continue dessus", () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "a" });
  ok(A.init());
  const target = path.join(env.root, "remote-data.git");
  assert.match(A.run(["migrer"]).out, /introuvable/); // dépôt pas encore créé : rien ne bouge
  spawnSync("git", ["init", "--bare", "--quiet", target]);
  ok(A.run(["migrer"]));                                // adresse par défaut : <dépôt>-data
  const cfg = JSON.parse(fs.readFileSync(path.join(A.home, "config.json"), "utf8"));
  assert.equal(cfg.remote, target);
  assert.equal(cfg.author.email, "carnet@test");        // le reste de la configuration est gardé
  assert.equal(remoteGit({ remote: target }, "rev-parse", "data"), remoteGit(env, "rev-parse", "data"));
  assert.match(ok(A.run(["migrer"])).out, /Déjà fait/);   // relancer ne fait rien de mal
  write(A.vault, "b.md", "b");
  assert.match(ok(A.sync()).out, /envoyées vers GitHub : 1/);
  assert.notEqual(remoteGit({ remote: target }, "rev-parse", "data"), remoteGit(env, "rev-parse", "data"));
});

// ---------- métadonnées et index de recherche ----------

const blobAt = (env, f) => new Uint8Array(spawnSync("git", ["--git-dir", env.remote, "cat-file", "blob", `data:${f}`]).stdout);
async function openRemote(env) {
  const keys = await C.unlock(JSON.parse(remoteGit(env, "show", "data:vault.json")), PASS);
  const manifest = await C.decryptManifest(keys.enc, blobAt(env, "manifest.bin"));
  const part = async (label) => {
    const f = await X.indexFile(C.noteId, keys.name, label);
    return JSON.parse(C.fromUtf8(await C.decryptBytes(keys.enc, blobAt(env, f.file), f.aad)));
  };
  // Mêmes accès que la page : rien d'autre que les fichiers chiffrés du dépôt.
  const src = {
    notes: manifest.notes, loadHead: () => part("base/head"), loadShard: (n) => part("base/" + n), loadDelta: () => part("delta"),
    readText: async (p) => { const e = manifest.notes[p]; return C.fromUtf8(await C.decryptBytes(keys.enc, blobAt(env, C.noteFile(e.id)), C.noteAad(e.id))); },
  };
  return { keys, manifest, src };
}
const found = async (src, q) => (await X.runSearch(q, src)).results.map((r) => r.path);

test("index : construit à l'init, delta après une modification, base reconstruite au-delà du seuil", async () => {
  const env = setup();
  const A = device(env, "A", {
    "Histoire/Commune.md": "---\ntags: [histoire]\n---\n# La Commune\nLa Commune de Paris, 1871. Voir [[Révolution]].",
    "Révolution.md": "# Révolution\nÉcrits sur la révolution russe.",
  });
  ok(A.init());
  let { manifest, src } = await openRemote(env);
  assert.deepEqual(manifest.notes["Histoire/Commune.md"].meta.tags, ["histoire"]);
  assert.deepEqual(manifest.notes["Histoire/Commune.md"].meta.links, ["Révolution"]);
  assert.equal(manifest.index.base, 2);
  assert.deepEqual(await found(src, "commune paris"), ["Histoire/Commune.md"]);

  write(A.vault, "Révolution.md", "# Révolution\nÉcrits sur la révolution chinoise.");
  ok(A.sync());
  ({ manifest, src } = await openRemote(env));
  assert.equal(manifest.index.delta, 1);
  assert.deepEqual(await found(src, "chinoise"), ["Révolution.md"]);
  assert.deepEqual(await found(src, "russe"), []);        // l'ancienne version n'est plus trouvée
  assert.equal(manifest.notes["Révolution.md"].meta.heads[0][1], "Révolution");

  for (let i = 0; i < 205; i++) write(A.vault, `Lot/n${i}.md`, `note numéro ${i} mot${i}`);
  const r = ok(A.sync());
  assert.match(r.out, /Construction de l'index/);
  ({ manifest, src } = await openRemote(env));
  assert.equal(manifest.index.delta, 0);
  assert.equal(manifest.index.base, 207);
  assert.deepEqual(await found(src, "mot42"), ["Lot/n42.md"]);
  assert.deepEqual(await found(src, "chinoise tag:histoire"), []);
});

test("ancien carnet sans métadonnées ni index : complété à la première synchro", async () => {
  const env = setup();
  const A = device(env, "A", { "a.md": "#projet alpha", "b.md": "beta" });
  ok(A.init());
  // On remet le carnet dans l'état d'avant : manifeste sans métadonnées, pas d'index.
  const { keys, manifest } = await openRemote(env);
  for (const e of Object.values(manifest.notes)) { delete e.meta; delete e.mv; }
  delete manifest.index;
  const work = path.join(env.root, "old");
  spawnSync("git", ["clone", "--quiet", "--branch", "data", env.remote, work]);
  fs.rmSync(path.join(work, "x"), { recursive: true, force: true });
  fs.writeFileSync(path.join(work, "manifest.bin"), await C.encryptManifest(keys.enc, manifest));
  spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "ancien"]);
  spawnSync("git", ["-C", work, "push", "-q", "origin", "HEAD:data"]);

  const r = ok(A.sync());
  assert.match(r.out, /2 notes, dont 0 avec des propriétés et 1 avec des tags/);
  const { manifest: m2, src } = await openRemote(env);
  assert.deepEqual(m2.notes["a.md"].meta.tags, ["projet"]);
  assert.deepEqual(await found(src, "alpha"), ["a.md"]);
  assert.match(remoteGit(env, "log", "-1", "--format=%s", "data"), /sync : index/);
  assert.match(ok(A.sync()).out, /envoyées vers GitHub : 0/);
  assert.match(remoteGit(env, "log", "-1", "--format=%s", "data"), /sync : index/); // rien de plus à envoyer
  assert.equal(remoteGit(env, "rev-list", "--count", "data").trim(), "3");
});
