import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, parseYaml, splitFrontmatter } from "../notes.js";

test("frontmatter : listes, listes en ligne, nombres, booléens, texte multiligne, sous-clés", () => {
  const y = parseYaml([
    "tags:", "  - bureau", "  - \"compte rendu\"", "date: 2026-10-20", "note: 4.5", "fait: true",
    "auteurs: [Marx, 'Engels, F.']", "résumé: |", "  ligne 1", "  ligne 2", "lieu:", "  ville: Paris", "vide:",
    "url: https://example.org/a:b",
  ].join("\n"));
  assert.deepEqual(y.tags, ["bureau", "compte rendu"]);
  assert.equal(y.date, "2026-10-20");
  assert.equal(y.note, 4.5);
  assert.equal(y.fait, true);
  assert.deepEqual(y.auteurs, ["Marx", "Engels, F."]);
  assert.equal(y["résumé"], "ligne 1\nligne 2");
  assert.equal(y.lieu, "ville: Paris");
  assert.equal(y.vide, null);
  assert.equal(y.url, "https://example.org/a:b");
});

test("métadonnées : tags (frontmatter et en ligne), liens, titres, tâches, code ignoré", () => {
  const text = `﻿---
tags: [cr, "bureau/2026"]
aliases:
  - Le Bureau
statut: fait
---
# Réunion
Voir [[Autre note|alias]], [[Dossier/Profond#Section]], ![[scan.pdf]] et [md](../Ailleurs/Note%20B.md).
Tags : #urgent #2026 #projet/carnet. Pas un tag : page#ancre.

## Tâches
- [ ] à faire
- [x] fait
\`\`\`
# pas un titre #pastag [[PasUnLien]]
\`\`\`
Un \`#code\` en ligne.
`;
  const m = parseNote(text, "Notes/CR/Réunion.md");
  assert.deepEqual(m.tags.sort(), ["bureau/2026", "cr", "projet/carnet", "urgent"]);
  assert.deepEqual(m.aliases, ["Le Bureau"]);
  assert.deepEqual(m.props, { statut: "fait" });
  assert.deepEqual(m.links, ["Autre note", "Dossier/Profond", "/Notes/Ailleurs/Note B"]);
  assert.deepEqual(m.heads, [[1, "Réunion"], [2, "Tâches"]]);
  assert.deepEqual(m.tasks, [1, 1]);
  assert.ok(m.words > 20);
});

test("sans frontmatter ; frontmatter non fermé laissé dans le corps", () => {
  assert.equal(splitFrontmatter("# Titre").yaml, null);
  assert.equal(splitFrontmatter("---\na: 1\nsans fin").yaml, null);
  const m = parseNote("Juste du texte.");
  assert.equal(m.props, undefined);
  assert.equal(m.words, 3);
});
