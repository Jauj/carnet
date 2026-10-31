// Test de l'interface dans un vrai navigateur (Playwright + Chromium), contre le faux GitHub local.
//   node test/e2e-ui.cjs            (Playwright doit être installé ; le vault de démonstration est recréé)
// Vérifie : déverrouillage, aller à (Ctrl+K), rendu, recherche plein texte, tags, Base, vue scindée, édition,
// complétion, case à cocher, renommage, suppression, brouillon, lecture à voix haute (simulée), hors ligne.
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-ui-"));
const PORT = 8800 + Math.floor(Math.random() * 100);
const URL = `http://localhost:${PORT}/`;
const PASS = "phrase de passe de démonstration locale";
const FAKE_TTS = `
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, "speechSynthesis", { value: {
    getVoices: () => [{ name: "Test", lang: "fr-FR", localService: true }], addEventListener() {},
    speak(u) { window.__spoken.push(u.text); this.t = setTimeout(() => u.onend && u.onend(), 50); },
    cancel() { clearTimeout(this.t); }, pause() {}, resume() {} } });`;

async function main() {
  const setup = spawnSync(process.execPath, [path.join(ROOT, "test/e2e-setup.mjs"), DIR], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const mock = spawn(process.execPath, [path.join(ROOT, "test/mock-github.mjs"), path.join(DIR, "remote.git"), String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch();
  const errors = [];
  const step = (name) => console.log("✓ " + name);
  try {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(FAKE_TTS);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const cur = ".pane.active .tabview:not([hidden])";
    const statusIs = (start) => page.waitForFunction((s) => document.querySelector("#status-msg").textContent.startsWith(s), start);
    const unlock = async () => { await page.fill("#pass", PASS); await page.click("#unlock-form button"); await page.waitForSelector("#app:not([hidden])"); };
    const goTo = async (q) => { await page.keyboard.press("Control+k"); await page.keyboard.type(q); await page.keyboard.press("Enter"); await page.waitForSelector(cur + " .note > *"); };

    await page.goto(URL);
    await unlock();
    step("déverrouillage");

    await goTo("carnet");
    assert.equal(await page.textContent(cur + " .doc-title"), "Carnet");
    assert.equal(await page.$$eval(cur + " .prop", (p) => p.length), 5);
    assert.equal(await page.$$eval(cur + " details.callout", (c) => c.length), 1);
    assert.equal(await page.$$eval(cur + " .note mark", (m) => m.length), 1);
    await page.waitForSelector(cur + " .embed .embed-body h2");
    assert.equal(await page.$$eval("#r-backlinks .bl", (b) => b.length), 2);
    step("rendu, propriétés, callouts, intégration, rétroliens");

    await page.keyboard.press("Control+Shift+F");
    await page.keyboard.type("révolution -russe");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".hit .snip mark");
    assert.deepEqual(await page.$$eval(".hit .nl-t", (a) => a.map((x) => x.textContent)), ["Long texte"]);
    await page.click(".hit a.nl");
    await page.waitForSelector(cur + " mark.hit.first");
    await page.fill(".search-input", '"commune de paris"');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".hit .nl-t")].map((x) => x.textContent).join() === "Lecture");
    step("recherche plein texte, exclusion, expression, surlignage");

    await page.click(".rb[data-view=tags]");
    await page.click('.side-view[data-view=tags] .tagrow:has-text("#lecture")');
    await page.waitForFunction(() => document.querySelector(".search-input").value === "tag:lecture");
    step("tags");

    await page.click(".rb[data-view=base]");
    await page.click(".side-view[data-view=base] button.primary");
    await page.click("text=Colonnes ▾");
    await page.check(".base-cols label:has-text('priorité') input");
    await page.fill(".base-q", "prop:statut");
    await page.waitForFunction(() => document.querySelectorAll(".base-table tbody tr").length === 2);
    await page.click(".base-table th:has-text('priorité')");
    assert.match(await page.textContent(".base-table tbody tr"), /^Lecture/);
    step("base : filtre, colonne, tri");

    await goTo("carnet");
    await page.click(cur + " .embed a.wl", { modifiers: ["Shift"] });
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2);
    step("vue scindée");

    await page.keyboard.press("Control+Shift+D");
    const ed = cur + " .editor";
    await page.waitForSelector(ed + ":not([hidden])");
    await page.click(ed);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- [ ] premier");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second\n\nVoir [[carn");
    await page.waitForSelector(".complete:not([hidden])");
    await page.keyboard.press("Enter");
    assert.match(await page.inputValue(ed), /- \[ \] premier\n- \[ \] second\n\nVoir \[\[Carnet\]\]$/);
    await page.keyboard.press("Control+s");
    await page.fill("#tok", "test-token");
    await page.check("input[name=remember]"); // gardé (chiffré) après le verrouillage plus bas
    await page.keyboard.press("Enter");
    await statusIs("Enregistré");
    step("note du jour, liste, complétion, enregistrement");

    await page.click(cur + " .note li.task input >> nth=0");
    await statusIs("Case enregistrée");
    await page.click(cur + " .b-more");
    await page.click(".menu button:has-text('Renommer')");
    await page.fill("#rn", "Journée test");
    await page.keyboard.press("Enter");
    await statusIs("Note déplacée");
    step("case cochée, renommage");

    await page.keyboard.press("Control+e");
    await page.fill(ed, "brouillon");
    await page.click(".rb[data-cmd=lock]");
    await page.waitForSelector("#lock:not([hidden])");
    await unlock();
    await page.waitForSelector("#dlg[open]");
    await page.click("#dlg button.primary");
    await page.waitForFunction(() => [...document.querySelectorAll(".editor")].some((e) => e.value === "brouillon"));
    await page.click(cur + " .b-cancel");
    await page.click("#dlg button.primary");
    await page.click(cur + " .b-more");
    await page.click(".menu button:has-text('Supprimer')");
    await page.click("#dlg button.primary");
    await statusIs("Note supprimée");
    step("brouillon repris, suppression");

    await goTo("long texte");
    const spoken = () => page.evaluate(() => window.__spoken.slice());
    const reset = () => page.evaluate(() => (window.__spoken = []));
    await page.click(cur + " .b-tts");
    await page.click("#dlg button[value=browser]"); // premier usage : voix du navigateur (simulée ici)
    await page.waitForFunction(() => window.__spoken.length >= 3);
    assert.deepEqual((await spoken()).slice(0, 3), ["Long texte", "Chapitre 1", "La révolution de 1789 fut un moment décisif."]);
    // Paragraphe suivant, vitesse changée en direct, arrêt
    await reset();
    await page.click(cur + ' .tts-bar button[title^="Paragraphe suivant"]');
    await page.waitForFunction(() => window.__spoken.length >= 1);
    await page.selectOption(cur + " .tts-bar select[title=Vitesse]", "1.5");
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("carnet.prefs")).rate), 1.5);
    await page.click(cur + ' .tts-bar button[title^="Arrêter"]');
    // Alt+clic sur un paragraphe : lecture à partir de là
    await reset();
    await page.click(cur + " .note p:has-text('1795 fut')", { modifiers: ["Alt"] });
    await page.waitForFunction(() => window.__spoken.length >= 1);
    assert.match((await spoken())[0], /^La révolution de 1795/);
    // Pendant la lecture, un clic simple fait sauter
    await reset();
    await page.click(cur + " .note p:has-text('1800 fut')");
    await page.waitForFunction(() => window.__spoken.some((t) => /1800/.test(t)));
    await page.keyboard.press("Alt+k");
    // ▶ du plan
    await reset();
    await page.hover("#r-outline .ol-row:has-text('Chapitre 30')");
    await page.click("#r-outline .ol-row:has-text('Chapitre 30') .ol-read");
    await page.waitForFunction(() => window.__spoken.length >= 1);
    assert.equal((await spoken())[0], "Chapitre 30");
    await page.keyboard.press("Alt+k");
    // Lire la sélection seulement
    await reset();
    await page.evaluate(() => {
      const p = [...document.querySelectorAll(".pane.active .tabview:not([hidden]) .note p")].find((x) => x.textContent.includes("1792 fut"));
      const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.click(cur + " .b-tts");
    await page.waitForFunction(() => window.__spoken.length >= 3);
    await page.waitForTimeout(400);
    const sel = await spoken();
    assert.ok(sel.every((t) => /1792|ouvriers|Phrase numéro 3/.test(t)), JSON.stringify(sel));
    step("lecture à voix haute : sélection, Alt+clic, saut, vitesse, plan");

    // Mode nuit : bouton lune, puis programmation (horloge simulée)
    await page.click(".rb[data-cmd=night]");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "night");
    await page.click(".rb[data-cmd=night]");
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), "night");
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("carnet.prefs")); Object.assign(p, { nightAuto: true, nightFrom: "21:00", nightTo: "07:00", nightOverride: null }); localStorage.setItem("carnet.prefs", JSON.stringify(p)); });
    await page.clock.setFixedTime(new Date(2026, 9, 31, 23, 0));
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "night");
    await page.clock.setFixedTime(new Date(2026, 9, 31, 12, 0));
    await page.reload();
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), "night");
    await unlock();
    step("mode nuit : bouton et programmation horaire");

    await page.waitForFunction(() => navigator.serviceWorker?.controller);
    await page.reload(); // les fichiers chiffrés passent maintenant par le service worker
    await unlock();
    await ctx.setOffline(true);
    await page.reload();
    await unlock().catch(async (e) => { throw new Error("hors ligne : " + await page.textContent("#lock-msg")); });
    await page.waitForFunction(() => document.querySelector("#status-sync").textContent.includes("hors ligne"));
    await page.waitForSelector(cur + " .note h2");
    await ctx.setOffline(false);
    step("hors ligne");

    const log = spawnSync("git", ["--git-dir", path.join(DIR, "remote.git"), "log", "--format=%s", "data"], { encoding: "utf8" }).stdout;
    for (const m of ["web suppression", "web déplacement", "web case", "web : 1 note"]) assert.ok(log.includes(m), log);
    assert.deepEqual(errors, []);
    step("commits attendus, aucune erreur de page");
  } finally {
    await b.close();
    mock.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
