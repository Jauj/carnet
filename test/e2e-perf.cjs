// Performances sur un gros vault (300 notes, dont 30 textes d'environ 1 Mo) : la page ne doit jamais se figer.
//   node test/e2e-perf.cjs
// Échoue si une tâche du fil principal dépasse 250 ms pendant une recherche ou l'ouverture d'un long texte.
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-perf-"));
const PORT = 8990 + Math.floor(Math.random() * 9);
const MAX_TASK = 250;

async function main() {
  const setup = spawnSync(process.execPath, [path.join(ROOT, "test/e2e-setup.mjs"), DIR], { env: { ...process.env, CARNET_E2E_LOURD: "1" } });
  assert.equal(setup.status, 0, String(setup.stderr));
  const mock = spawn(process.execPath, [path.join(ROOT, "test/mock-github.mjs"), path.join(DIR, "remote.git"), String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch();
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
    });
    await page.goto(`http://localhost:${PORT}/`);
    await page.fill("#pass", "phrase de passe de démonstration locale");
    await page.click("#unlock-form button");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForTimeout(500);
    await page.evaluate(() => (window.__long = []));
    await page.keyboard.press("Control+Shift+F");
    const t0 = Date.now();
    await page.keyboard.type("révolution");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".hit");
    const tList = Date.now() - t0;
    await page.waitForSelector(".hit .snip mark");
    const tSnip = Date.now() - t0;
    await page.waitForTimeout(2500);
    const search = await page.evaluate(() => window.__long);
    console.log(`recherche : liste en ${tList} ms, premier extrait en ${tSnip} ms ; tâches longues : ${JSON.stringify(search)}`);
    await page.evaluate(() => (window.__long = []));
    const t1 = Date.now();
    await page.click(".hit a.nl:has-text('Livre')");
    await page.waitForSelector(".tabview:not([hidden]) mark.hit.first");
    const tOpen = Date.now() - t1;
    await page.waitForTimeout(1500);
    const open = await page.evaluate(() => window.__long);
    console.log(`ouverture d'un texte de 1 Mo en ${tOpen} ms ; tâches longues : ${JSON.stringify(open)}`);
    assert.ok(tList < 1000, "liste des résultats trop lente");
    assert.ok([...search, ...open].every((d) => d < MAX_TASK), `tâche de plus de ${MAX_TASK} ms`);
    console.log("✓ aucune tâche de plus de " + MAX_TASK + " ms");
  } finally {
    await b.close();
    mock.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
