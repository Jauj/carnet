import { test } from "node:test";
import assert from "node:assert/strict";
import { inNight, nextBoundary, effectiveTheme, toggledOverride } from "../night.js";
import { sentences } from "../tts.js";

const at = (h, m = 0) => new Date(2026, 9, 31, h, m);

test("plage de nuit qui passe minuit, et plage dans la journée", () => {
  assert.equal(inNight(at(22), "21:00", "07:00"), true);
  assert.equal(inNight(at(3), "21:00", "07:00"), true);
  assert.equal(inNight(at(7), "21:00", "07:00"), false);
  assert.equal(inNight(at(12), "21:00", "07:00"), false);
  assert.equal(inNight(at(14), "13:00", "15:30"), true);
  assert.equal(inNight(at(16), "13:00", "15:30"), false);
});

test("prochaine bascule", () => {
  assert.equal(new Date(nextBoundary(at(22), "21:00", "07:00")).getHours(), 7);
  assert.equal(new Date(nextBoundary(at(12), "21:00", "07:00")).getHours(), 21);
});

test("thème effectif : programmation, forçage jusqu'à la bascule, thème Nuit choisi", () => {
  const p = { theme: "sepia", nightAuto: true, nightFrom: "21:00", nightTo: "07:00", nightOverride: null };
  assert.equal(effectiveTheme(p, at(12)), "sepia");
  assert.equal(effectiveTheme(p, at(23)), "night");
  const forced = { ...p, ...toggledOverride(p, at(23)) };   // jour forcé à 23 h…
  assert.equal(effectiveTheme(forced, at(23, 30)), "sepia");
  assert.equal(effectiveTheme(forced, at(7, 1)), "sepia");   // … jusqu'à 7 h, puis la programmation reprend
  assert.equal(effectiveTheme({ ...forced }, new Date(2026, 10, 1, 22)), "night");
  const manual = { theme: "light", nightAuto: false, nightOverride: null };
  const on = { ...manual, ...toggledOverride(manual, at(12)) };
  assert.equal(effectiveTheme(on, at(12)), "night");
  assert.equal(effectiveTheme({ ...on, ...toggledOverride(on, at(13)) }, at(13)), "light");
  assert.equal(effectiveTheme({ theme: "night" }, at(12)), "night");
});

test("lecture : phrases, et phrases trop longues coupées aux virgules", () => {
  assert.deepEqual(sentences("Bonjour. Comment vas-tu ? Très bien !").map((s) => s.text.trim()), ["Bonjour.", "Comment vas-tu ?", "Très bien !"]);
  const long = Array.from({ length: 12 }, (_, i) => `une proposition numéro ${i} assez longue`).join(", ") + ".";
  const parts = sentences(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.text.length <= 320));
  assert.equal(parts.map((p) => p.text).join(""), long);
});
