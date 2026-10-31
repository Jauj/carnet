// Voix neuronales Piper dans la vraie page (télécharge environ 60 Mo : moteur + voix Siwis légère).
//   node test/e2e-piper.cjs
// Vérifie : téléchargement et empreintes, lecture qui avance phrase après phrase, vitesse en direct,
// et qu'aucune requête réseau ne contient le texte de la note.
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-piper-"));
const PORT = 8900 + Math.floor(Math.random() * 90);

async function main() {
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "test/e2e-setup.mjs"), DIR]).status, 0);
  const mock = spawn(process.execPath, [path.join(ROOT, "test/mock-github.mjs"), path.join(DIR, "remote.git"), String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => localStorage.setItem("carnet.prefs", JSON.stringify({ piperVoice: "fr_FR-siwis-low" })));
    const page = await ctx.newPage();
    const errors = [], requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    ctx.on("request", (r) => requests.push(r.url() + " " + (r.postData() || "")));
    await page.goto(`http://localhost:${PORT}/`);
    await page.fill("#pass", "phrase de passe de démonstration locale");
    await page.click("#unlock-form button");
    await page.waitForSelector("#app:not([hidden])");
    await page.keyboard.press("Control+k"); await page.keyboard.type("long texte"); await page.keyboard.press("Enter");
    const cur = ".pane.active .tabview:not([hidden])";
    await page.waitForSelector(cur + " .note h2");
    const t0 = Date.now();
    await page.click(cur + " .b-tts");
    await page.click("#dlg button[value=piper]");
    await page.click("#dlg button.primary"); // confirmer le téléchargement
    await page.waitForFunction(() => navigator.mediaSession?.playbackState === "playing", null, { timeout: 180000 });
    console.log(`✓ première lecture après téléchargement et vérification : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const highlighted = () => page.evaluate(() => { const h = CSS.highlights.get("tts"); return h ? [...h][0].toString() : ""; });
    const first = await highlighted();
    await page.waitForFunction((f) => { const h = CSS.highlights.get("tts"); return h && [...h][0].toString() !== f; }, first, { timeout: 30000 });
    console.log(`✓ la lecture avance : « ${first.trim()} » → « ${(await highlighted()).trim()} »`);
    await page.selectOption(cur + " .tts-bar select[title=Vitesse]", "1.5");
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), "playing");
    console.log("✓ vitesse changée en direct, la lecture continue");
    await page.keyboard.press("Alt+p");
    assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), "paused");
    await page.keyboard.press("Alt+p");
    await page.waitForFunction(() => navigator.mediaSession.playbackState === "playing");
    await page.keyboard.press("Alt+k");
    console.log("✓ pause, reprise, arrêt");
    const leaks = requests.filter((r) => /r[ée]volution|ouvriers|paysans|Chapitre/i.test(decodeURIComponent(r)));
    assert.deepEqual(leaks, [], "le texte de la note ne doit jamais partir sur le réseau");
    const hosts = [...new Set(requests.map((r) => new URL(r.split(" ")[0]).host))];
    console.log("✓ aucune requête ne contient le texte ; hôtes contactés :", hosts.join(", "));
    assert.deepEqual(errors, []);
  } finally {
    await b.close();
    mock.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
