#!/usr/bin/env node
// Carnet — synchronisation du vault Obsidian (en clair, sur le PC) avec la branche chiffrée du dépôt GitHub.
//
//   node sync.mjs init [--generer] [--force]   crée le carnet chiffré à partir du vault (une seule fois)
//   node sync.mjs sync [--autoriser-suppressions]
//   node sync.mjs status                       ce que ferait sync, sans rien modifier
//
// Synchronisation à trois états : L (vault), R (manifeste distant), S (dernier état commun, state.json).
// Rien n'est jamais perdu : en cas de double modification, la version web est gardée en copie « conflit » ;
// une note supprimée sur le web part dans la corbeille locale, pas à la poubelle.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "../crypto.js";

const HOME = process.env.CARNET_HOME || path.join(os.homedir(), ".carnet");
const CONFIG_FILE = path.join(HOME, "config.json");
const STATE_FILE = path.join(HOME, "state.json");
const LOCK_FILE = path.join(HOME, "sync.lock");
const LOG_FILE = path.join(HOME, "sync.log");
const MIN_PASSPHRASE = 25;

const DEFAULTS = {
  vault: null,
  remote: null,
  branch: "data",
  dataDir: path.join(HOME, "data"),
  trashDir: path.join(HOME, "corbeille"),
  exclude: [".obsidian/", ".trash/", "Rubbish/", "02 Notes/02_06 Personnel/API.md"],
  excludePatterns: ["\\.sync-conflict-"],
  author: { name: "carnet", email: "carnet@localhost" },
  deleteBrake: { max: 20, ratio: 0.05 },
};

// ---------- configuration et état ----------

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const cfg = { ...DEFAULTS, ...user };
  if (!cfg.vault || !cfg.remote) {
    throw new Error(`Configuration incomplète : indique "vault" et "remote" dans ${CONFIG_FILE}.`);
  }
  if (!fs.existsSync(cfg.vault)) throw new Error(`Vault introuvable : ${cfg.vault}`);
  return cfg;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { files: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function log(line) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

function acquireLock() {
  fs.mkdirSync(HOME, { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
  } catch {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age < 15 * 60 * 1000) throw new Error("Une synchronisation est déjà en cours (sync.lock).");
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  }
  const release = () => fs.rmSync(LOCK_FILE, { force: true });
  process.once("exit", release); // même en cas de sortie imprévue, le verrou ne reste pas
  return release;
}

// ---------- vault local ----------

function makeExcluder(cfg) {
  const prefixes = cfg.exclude.map((e) => C.normPath(e).toLowerCase());
  const patterns = cfg.excludePatterns.map((p) => new RegExp(p, "i"));
  return (rel) => {
    const low = rel.toLowerCase();
    if (rel.split("/").some((seg) => seg.startsWith("."))) return true;
    if (prefixes.some((e) => (e.endsWith("/") ? low.startsWith(e) : low === e))) return true;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return patterns.some((re) => re.test(base));
  };
}

// L : { chemin: { sha, size, mtimeMs, abs } }. Réutilise l'empreinte de state.json si taille et date sont identiques.
async function scanVault(cfg, isExcluded, cache) {
  const out = {};
  const walk = async (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isExcluded(C.normPath(rel) + "/")) await walk(abs, rel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        const p = C.normPath(rel);
        if (isExcluded(p)) continue;
        const st = fs.statSync(abs);
        const c = cache[p];
        const sha = c && c.size === st.size && c.mtimeMs === st.mtimeMs
          ? c.sha : await C.sha256Hex(fs.readFileSync(abs));
        out[p] = { sha, size: st.size, mtimeMs: st.mtimeMs, abs };
      }
    }
  };
  await walk(cfg.vault, "");
  return out;
}

function vaultPath(cfg, p) { return path.join(cfg.vault, ...p.split("/")); }

// Le dossier du clone chiffré est effacé par init : on vérifie qu'il ne s'agit ni du vault ni d'un dossier étranger.
function assertSafeDataDir(cfg) {
  const d = path.resolve(cfg.dataDir).toLowerCase(), v = path.resolve(cfg.vault).toLowerCase();
  if (d === v || d.startsWith(v + path.sep) || v.startsWith(d + path.sep)) {
    throw new Error("dataDir ne doit pas être dans le vault (ni le contenir).");
  }
  if (fs.existsSync(cfg.dataDir)) {
    const names = fs.readdirSync(cfg.dataDir);
    const ours = names.length === 0 || (names.includes(".git") && names.every((n) => [".git", "n", "vault.json", "manifest.bin"].includes(n)));
    if (!ours) throw new Error(`Le dossier ${cfg.dataDir} contient autre chose qu'un clone du carnet : rien n'a été effacé.`);
  }
}

function atomicWrite(abs, bytes) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.carnet-tmp`);
  fs.writeFileSync(tmp, bytes);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, abs); return; } catch (err) {
      if (i >= 5) { fs.rmSync(tmp, { force: true }); throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function moveToTrash(cfg, abs, rel, stamp) {
  const dest = path.join(cfg.trashDir, stamp, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(abs, dest); } catch { fs.copyFileSync(abs, dest); fs.rmSync(abs); }
}

// ---------- git ----------

function git(cfg, args, { cwd, allowFail = false } = {}) {
  const pre = ["-c", "core.autocrlf=false", "-c", "core.quotepath=false"];
  if (/^https:/i.test(cfg.remote)) pre.push("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential");
  const r = spawnSync("git", [...pre, ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`git introuvable : ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args[0]} a échoué :\n${(r.stderr || r.stdout).trim()}`);
  return r;
}

function remoteBranchExists(cfg) {
  const r = git(cfg, ["ls-remote", "--heads", cfg.remote, cfg.branch]);
  return r.stdout.trim().length > 0;
}

function refreshClone(cfg) {
  const cwd = cfg.dataDir;
  if (fs.existsSync(path.join(cwd, ".git"))) {
    git(cfg, ["fetch", "--quiet", "origin", `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`], { cwd });
    git(cfg, ["reset", "--quiet", "--hard", `origin/${cfg.branch}`], { cwd });
    git(cfg, ["clean", "-fdxq"], { cwd });
  } else {
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    git(cfg, ["clone", "--quiet", "--single-branch", "--branch", cfg.branch, cfg.remote, cwd]);
  }
}

// true : envoyé ; false : rien à envoyer ; "race" : la branche distante a bougé entre-temps.
function commitAndPush(cfg, message, { force = false } = {}) {
  const cwd = cfg.dataDir;
  git(cfg, ["add", "-A"], { cwd });
  if (!git(cfg, ["status", "--porcelain"], { cwd }).stdout.trim()) return false;
  git(cfg, ["-c", `user.name=${cfg.author.name}`, "-c", `user.email=${cfg.author.email}`,
    "commit", "--quiet", "-m", message], { cwd });
  if (process.env.CARNET_TEST_HOOK_BEFORE_PUSH) {
    const hook = process.env.CARNET_TEST_HOOK_BEFORE_PUSH;
    delete process.env.CARNET_TEST_HOOK_BEFORE_PUSH;
    spawnSync(hook, { shell: true, stdio: "inherit" });
  }
  const args = ["push", "--quiet", "origin", `HEAD:refs/heads/${cfg.branch}`];
  if (force) args.splice(1, 0, "--force");
  const r = git(cfg, args, { cwd, allowFail: true });
  if (r.status === 0) return true;
  if (/rejected|non-fast-forward|fetch first|failed to update ref/i.test(r.stderr)) return "race";
  throw new Error(`Envoi refusé par GitHub :\n${r.stderr.trim()}`);
}

// ---------- saisie de la phrase de passe ----------

function askHidden(prompt) {
  if (process.env.CARNET_TEST_PASSPHRASE) return Promise.resolve(process.env.CARNET_TEST_PASSPHRASE);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    // Si l'entrée se ferme sans réponse, on s'arrête proprement au lieu de quitter en silence.
    const keepAlive = setInterval(() => {}, 1 << 30);
    const done = (fn) => (v) => { clearInterval(keepAlive); stdin.off("end", onEnd); fn(v); };
    const onEnd = () => done(reject)(new Error("Saisie interrompue : aucune phrase de passe reçue."));
    stdin.once("end", onEnd);
    resolve = done(resolve);
    stdin.setEncoding("utf8");
    if (!stdin.isTTY) {
      let buf = "";
      const onData = (d) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i >= 0) { stdin.off("data", onData); stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, "")); }
      };
      stdin.on("data", onData);
      stdin.resume();
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let chars = [];
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (c === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") { chars.pop(); continue; }
        chars.push(c);
      }
    };
    stdin.on("data", onData);
  });
}

function generatePassphrase() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // sans 0/o, 1/l/i
  const groups = [];
  for (let g = 0; g < 6; g++) {
    let s = "";
    while (s.length < 4) {
      const b = C.randomBytes(1)[0];
      if (b < 248) s += alphabet[b % 31]; // tirage uniforme
    }
    groups.push(s);
  }
  return groups.join("-");
}

// ---------- plan de synchronisation (fonction pure) ----------

export function computePlan(L, R, S) {
  const plan = { upload: [], download: [], deleteRemote: [], deleteLocal: [], conflict: [], same: [] };
  const paths = new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(S)]);
  for (const p of [...paths].sort()) {
    const l = L[p]?.sha, r = R[p]?.sha, s = S[p]?.sha;
    if (l === r) { if (l !== undefined) plan.same.push(p); }
    else if (r === s) (l === undefined ? plan.deleteRemote : plan.upload).push(p);
    else if (l === s) (r === undefined ? plan.deleteLocal : plan.download).push(p);
    else if (l === undefined) plan.download.push(p);      // modifiée sur le web, supprimée ici : on la récupère
    else if (r === undefined) plan.upload.push(p);        // modifiée ici, supprimée ailleurs : on la garde
    else plan.conflict.push(p);
  }
  return plan;
}

export function brakeTriggered(plan, nLocal, nRemote, brake) {
  const del = plan.deleteRemote.length + plan.deleteLocal.length;
  const total = Math.max(nLocal, nRemote, 1);
  return del > brake.max || (del > 3 && del > brake.ratio * total);
}

// ---------- commandes ----------

async function cmdInit(cfg, opts) {
  if (remoteBranchExists(cfg) && !opts.force) {
    throw new Error(`Le carnet existe déjà sur ${cfg.remote} (branche ${cfg.branch}). Utilise "sync".`);
  }
  const iterations = opts.iterations || C.DEFAULT_ITERATIONS;
  if (iterations < C.MIN_SAFE_ITERATIONS && !process.env.CARNET_ALLOW_WEAK) {
    throw new Error("Nombre d'itérations trop faible.");
  }
  let pass;
  if (opts.generer) {
    pass = generatePassphrase();
    console.log("\nTa phrase de passe (note-la sur papier, elle ne sera plus jamais affichée) :\n");
    console.log("    " + pass + "\n");
    const again = await askHidden("Recopie-la pour confirmer : ");
    if (again.trim() !== pass) throw new Error("Les deux saisies diffèrent : rien n'a été créé.");
  } else {
    pass = await askHidden(`Choisis une phrase de passe (au moins ${MIN_PASSPHRASE} caractères) : `);
    if ([...pass].length < MIN_PASSPHRASE) {
      throw new Error(`Trop courte (${[...pass].length} caractères). Rien n'a été créé. Astuce : init --generer.`);
    }
    const again = await askHidden("Retape-la pour confirmer : ");
    if (again !== pass) throw new Error("Les deux saisies diffèrent : rien n'a été créé.");
  }
  if (opts.force && !process.env.CARNET_TEST_PASSPHRASE) {
    const ok = await askHidden('Le carnet existant sur GitHub sera REMPLACÉ. Tape OUI pour continuer : ');
    if (ok !== "OUI") throw new Error("Abandon : rien n'a été modifié.");
  }

  console.log("Dérivation de la clé…");
  const { header, keys } = await C.createVaultHeader(pass, iterations);
  const isExcluded = makeExcluder(cfg);
  const L = await scanVault(cfg, isExcluded, {});

  const cwd = cfg.dataDir;
  assertSafeDataDir(cfg);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(path.join(cwd, "n"), { recursive: true });
  git(cfg, ["init", "--quiet"], { cwd });
  git(cfg, ["checkout", "--quiet", "--orphan", cfg.branch], { cwd });
  git(cfg, ["remote", "add", "origin", cfg.remote], { cwd });

  fs.writeFileSync(path.join(cwd, "vault.json"), JSON.stringify(header, null, 2) + "\n");
  const manifest = C.emptyManifest();
  let i = 0;
  const paths = Object.keys(L).sort();
  for (const p of paths) {
    const bytes = fs.readFileSync(L[p].abs);
    const id = await C.noteId(keys.name, p);
    fs.writeFileSync(path.join(cwd, C.noteFile(id)), await C.encryptBytes(keys.enc, bytes, C.noteAad(id)));
    manifest.notes[p] = { id, sha: L[p].sha, size: L[p].size, mtime: Math.round(L[p].mtimeMs) };
    if (++i % 250 === 0) console.log(`  ${i}/${paths.length} notes chiffrées`);
  }
  fs.writeFileSync(path.join(cwd, "manifest.bin"), await C.encryptManifest(keys.enc, manifest));
  console.log("Envoi vers GitHub…");
  commitAndPush(cfg, `init : ${paths.length} notes`, { force: !!opts.force });

  const files = {};
  for (const p of paths) files[p] = { sha: L[p].sha, size: L[p].size, mtimeMs: L[p].mtimeMs };
  saveState({ files, lastSync: new Date().toISOString() });
  log(`init ${paths.length} notes`);
  console.log(`\nCarnet créé : ${paths.length} notes chiffrées et envoyées.`);
}

async function cmdSync(cfg, opts) {
  if (!fs.existsSync(path.join(cfg.dataDir, ".git")) && !remoteBranchExists(cfg)) {
    throw new Error('Aucun carnet sur GitHub pour l\'instant : lance d\'abord "init".');
  }
  const isExcluded = makeExcluder(cfg);
  let keys = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    refreshClone(cfg);
    const cwd = cfg.dataDir;
    const header = JSON.parse(fs.readFileSync(path.join(cwd, "vault.json"), "utf8"));
    if (!keys) {
      const pass = await askHidden("Phrase de passe du carnet : ");
      console.log("Déverrouillage…");
      keys = await C.unlock(header, pass);
    }
    const remote = await C.decryptManifest(keys.enc, fs.readFileSync(path.join(cwd, "manifest.bin")));
    const R = {};
    let ignored = 0;
    for (const [p, e] of Object.entries(remote.notes)) { if (isExcluded(p)) ignored++; else R[p] = e; }
    const state = loadState();
    const S = state.files || {};
    const L = await scanVault(cfg, isExcluded, S);
    const plan = computePlan(L, R, S);

    if (Object.keys(L).length === 0 && Object.keys(S).length > 0) {
      throw new Error("Le vault semble vide ou introuvable : synchronisation arrêtée, rien n'a été modifié.");
    }
    if (!opts.allowDeletes && brakeTriggered(plan, Object.keys(L).length, Object.keys(R).length, cfg.deleteBrake)) {
      throw new Error(`Frein de sécurité : ${plan.deleteRemote.length} suppression(s) sur GitHub et ` +
        `${plan.deleteLocal.length} dans le vault étaient prévues. Rien n'a été modifié.\n` +
        `Si c'est bien voulu : sync --autoriser-suppressions`);
    }
    if (opts.dryRun) { printPlan(plan, ignored, true); return; }

    const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");
    const final = {};
    for (const p of plan.same) final[p] = pick(L[p]);
    const notes = { ...remote.notes };
    const localLower = new Map(Object.keys(L).map((p) => [p.toLowerCase(), p]));
    const conflicts = [];
    let remoteChanged = 0;

    const fetchRemote = async (p) => {
      const e = R[p];
      const bytes = await C.decryptBytes(keys.enc, fs.readFileSync(path.join(cwd, C.noteFile(e.id))), C.noteAad(e.id));
      if (await C.sha256Hex(bytes) !== e.sha) throw new Error(`Empreinte incohérente pour une note distante (${p}).`);
      return bytes;
    };
    const writeLocal = (p, bytes) => {
      const abs = vaultPath(cfg, p);
      atomicWrite(abs, bytes);
      const st = fs.statSync(abs);
      localLower.set(p.toLowerCase(), p);
      return { size: st.size, mtimeMs: st.mtimeMs };
    };
    const upload = async (p, bytes, abs = vaultPath(cfg, p)) => {
      const sha = await C.sha256Hex(bytes);
      const id = await C.noteId(keys.name, p);
      const old = notes[p];
      if (old && old.id !== id) fs.rmSync(path.join(cwd, C.noteFile(old.id)), { force: true });
      fs.writeFileSync(path.join(cwd, C.noteFile(id)), await C.encryptBytes(keys.enc, bytes, C.noteAad(id)));
      const st = fs.statSync(abs);
      notes[p] = { id, sha, size: bytes.length, mtime: Math.round(st.mtimeMs) };
      final[p] = { sha, size: st.size, mtimeMs: st.mtimeMs };
      remoteChanged++;
    };
    const freeConflictPath = (p) => {
      let cp = C.conflictPath(p, "conflit web");
      for (let n = 2; localLower.has(cp.toLowerCase()) || notes[cp]; n++) cp = C.conflictPath(p, `conflit web ${n}`);
      return cp;
    };

    const removeRemote = (p) => {
      fs.rmSync(path.join(cwd, C.noteFile(notes[p].id)), { force: true });
      delete notes[p];
      remoteChanged++;
    };
    // Une copie « conflit web » au même contenu existe-t-elle déjà (tentative précédente) ?
    const hasCopy = (p, sha) => {
      const base = p.replace(/\.md$/i, "") + " (conflit web";
      return Object.keys(L).some((q) => q.startsWith(base) && L[q].sha === sha);
    };

    // D'abord les suppressions locales : un renommage qui ne change que la casse se propage proprement.
    for (const p of plan.deleteLocal) {
      moveToTrash(cfg, L[p].abs, p, stamp);
      localLower.delete(p.toLowerCase());
    }
    for (const p of plan.download) {
      const bytes = await fetchRemote(p);
      const other = localLower.get(p.toLowerCase());
      if (other && other !== p) {
        // Même nom à la casse près (Windows ne distingue pas) : on n'écrase rien. La version distante
        // est gardée sous un nom « conflit web », et l'entrée distante en double est retirée.
        if (!hasCopy(p, R[p].sha)) {
          const cp = freeConflictPath(p);
          writeLocal(cp, bytes);
          await upload(cp, bytes);
          conflicts.push(cp);
        }
        removeRemote(p);
        continue;
      }
      const st = writeLocal(p, bytes);
      final[p] = { sha: R[p].sha, ...st };
    }
    for (const p of plan.upload) {
      await upload(p, fs.readFileSync(L[p].abs), L[p].abs);
    }
    for (const p of plan.deleteRemote) removeRemote(p);
    for (const p of plan.conflict) {
      const remoteBytes = await fetchRemote(p);
      if (!hasCopy(p, R[p].sha)) {
        const cp = freeConflictPath(p);
        writeLocal(cp, remoteBytes);
        await upload(cp, remoteBytes);
        conflicts.push(cp);
      }
      await upload(p, fs.readFileSync(L[p].abs), L[p].abs);
    }

    if (remoteChanged > 0) {
      remote.notes = notes;
      fs.writeFileSync(path.join(cwd, "manifest.bin"), await C.encryptManifest(keys.enc, remote));
      const n = plan.upload.length + plan.deleteRemote.length + plan.conflict.length + conflicts.length;
      const pushed = commitAndPush(cfg, `sync : ${n} note${n > 1 ? "s" : ""}`);
      if (pushed === "race") { console.log("Le carnet a changé pendant l'opération, nouvelle tentative…"); continue; }
    }

    saveState({ files: final, lastSync: new Date().toISOString() });
    log(`sync envoyees=${plan.upload.length} recues=${plan.download.length} conflits=${conflicts.length} ` +
      `suppr_github=${plan.deleteRemote.length} corbeille=${plan.deleteLocal.length}`);
    printPlan(plan, ignored, false, conflicts, stamp, cfg);
    return;
  }
  throw new Error("Le carnet change trop vite sur GitHub : réessaie dans un instant.");
}

function pick(e) { return { sha: e.sha, size: e.size, mtimeMs: e.mtimeMs }; }

function printPlan(plan, ignored, dry, conflicts = plan.conflict, stamp, cfg) {
  const head = dry ? "Ce que ferait la synchronisation :" : "Carnet synchronisé.";
  console.log(`\n${head}`);
  console.log(`  envoyées vers GitHub : ${plan.upload.length}    reçues dans le vault : ${plan.download.length}`);
  console.log(`  conflits : ${dry ? plan.conflict.length : conflicts.length}    ` +
    `supprimées sur GitHub : ${plan.deleteRemote.length}    mises à la corbeille : ${plan.deleteLocal.length}`);
  if (ignored) console.log(`  ignorées (dossiers exclus) : ${ignored}`);
  if (!dry && conflicts.length) {
    console.log("\nCopies de conflit créées (compare-les puis supprime celle en trop) :");
    for (const c of conflicts) console.log("  - " + c);
  }
  if (!dry && plan.deleteLocal.length) console.log(`\nCorbeille : ${path.join(cfg.trashDir, stamp)}`);
}

// ---------- point d'entrée ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {
    generer: rest.includes("--generer"),
    force: rest.includes("--force"),
    allowDeletes: rest.includes("--autoriser-suppressions"),
    dryRun: cmd === "status",
  };
  const it = rest.indexOf("--iterations");
  if (it >= 0) opts.iterations = Number(rest[it + 1]);
  if (!["init", "sync", "status"].includes(cmd)) {
    console.log("Usage : node sync.mjs init [--generer] | sync [--autoriser-suppressions] | status");
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const release = acquireLock();
  try {
    if (cmd === "init") await cmdInit(cfg, opts);
    else await cmdSync(cfg, opts);
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("\nErreur : " + err.message);
    try { log("ERREUR " + err.message.split("\n")[0]); } catch {}
    process.exitCode = 1;
  });
}
