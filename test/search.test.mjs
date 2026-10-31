import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, fold, parseQuery, buildPostings, runSearch, matchRanges, snippets } from "../search.js";

test("mots : accents, ligatures, casse, mots d'une lettre ignorés", () => {
  assert.deepEqual([...tokens("L'Œuvre de Lénine, ÉTAT et révolution ; l'État !")], ["oeuvre", "de", "lenine", "etat", "et", "revolution"]);
  assert.equal(fold("Ça Été"), "ca ete");
});

test("requête : mots, expression, exclusion, filtres", () => {
  const q = parseQuery('révolution "classe ouvrière" -russie tag:#histoire dossier:"02 Notes" prop:statut=fait');
  assert.deepEqual(q.terms, ["revolution", "classe", "ouvriere"]);
  assert.deepEqual(q.phrases, ["classe ouvriere"]);
  assert.deepEqual(q.exclude, ["russie"]);
  assert.deepEqual(q.tags, [{ neg: false, v: "histoire" }]);
  assert.deepEqual(q.folders, [{ neg: false, v: "02 notes" }]);
  assert.deepEqual(q.props, [{ neg: false, k: "statut", v: "fait" }]);
});

function fixture() {
  const texts = {
    "A/Révolution.md": "La révolution russe de 1917. Classe ouvrière.",
    "A/Commune.md": "La Commune de Paris, révolutionnaire. La classe ouvrière au pouvoir.",
    "B/Recette.md": "Une recette de tarte.",
    "B/Récente.md": "Écrite sur le web : révolution culturelle.",
  };
  const notes = {};
  for (const [p, t] of Object.entries(texts)) notes[p] = { sha: "s-" + p, mtime: 1, meta: {} };
  notes["A/Commune.md"].meta = { tags: ["histoire/france"] };
  // Base construite sans « Récente » ; delta : rien.
  const basePaths = ["A/Révolution.md", "A/Commune.md", "B/Recette.md"];
  const head = { notes: basePaths, shas: basePaths.map((p) => notes[p].sha) };
  const shards = buildPostings(basePaths.map((p) => tokens(p.split("/").pop(), tokens(texts[p]))));
  const reads = [];
  const src = {
    notes, loadHead: async () => head, loadShard: async (n) => shards[n], loadDelta: async () => null,
    readText: async (p) => { reads.push(p); return texts[p]; },
  };
  return { src, texts, reads, notes };
}

test("recherche : préfixes, ET entre les mots, exclusion, filtres, note non indexée lue directement", async () => {
  const { src, reads } = fixture();
  const r1 = await runSearch("révol", src);
  assert.deepEqual(r1.results.map((r) => r.path).sort(), ["A/Commune.md", "A/Révolution.md", "B/Récente.md"]);
  assert.equal(r1.results[0].path, "A/Révolution.md"); // mot exact dans le titre : en tête
  assert.deepEqual(reads, ["B/Récente.md"]);           // seule la note non indexée est lue
  const r2 = await runSearch("classe ouvriere -russe", src);
  assert.deepEqual(r2.results.map((r) => r.path), ["A/Commune.md"]);
  const r3 = await runSearch("tag:histoire", src);
  assert.deepEqual(r3.results.map((r) => r.path), ["A/Commune.md"]);
  const r4 = await runSearch("de", src);               // deux lettres : mot exact seulement
  assert.ok(!r4.results.some((r) => r.path === "B/Récente.md"));
});

test("une note modifiée depuis l'indexation n'est plus trouvée par l'ancien index", async () => {
  const { src, notes, texts } = fixture();
  notes["B/Recette.md"].sha = "nouvelle";
  texts["B/Recette.md"] = "Une recette de soupe.";
  assert.deepEqual((await runSearch("tarte", src)).results, []);
  assert.deepEqual((await runSearch("soupe", src)).results.map((r) => r.path), ["B/Recette.md"]);
});

test("plages et extraits : accents conservés, expression exacte vérifiée", () => {
  const text = "Préambule. La Révolution française et la révolution russe.";
  const q = parseQuery('"revolution russe"');
  const r = matchRanges(text, q);
  assert.equal(text.slice(r[r.length - 1][0], r[r.length - 1][1]), "révolution russe");
  assert.equal(matchRanges(text, parseQuery('"russe revolution"')), null);
  const s = snippets(text, matchRanges(text, parseQuery("révolution")), { radius: 10 });
  assert.equal(s[0].text.slice(s[0].marks[0][0], s[0].marks[0][1]), "Révolution");
});

test("repli d'un texte de 1 Mo rapide, et identique au repli caractère par caractère", async () => {
  const { foldWithMap } = await import("../search.js");
  const words = "La Révolution française État Œuvre ouvriers Пролетарии всех стран 😀 straße".split(" ");
  let t = "";
  for (let i = 0; t.length < 1_000_000; i++) t += words[i % words.length] + (i % 9 ? " " : ". ");
  foldWithMap(t);
  const s = performance.now();
  const { f, map } = foldWithMap(t);
  assert.ok(performance.now() - s < 250, `trop lent : ${Math.round(performance.now() - s)} ms`);
  const sample = t.slice(0, 2000);
  let ref = "", i = 0;
  const rmap = [];
  for (const ch of sample) { const g = fold(ch); for (let k = 0; k < g.length; k++) rmap.push(i); ref += g; i += ch.length; }
  assert.equal(f.slice(0, ref.length), ref);
  assert.deepEqual([...map.slice(0, rmap.length)], rmap);
});

test("matchRanges : limite du nombre d'occurrences", () => {
  const text = "mot ".repeat(1000);
  assert.equal(matchRanges(text, parseQuery("mot"), 5).length, 5);
});
