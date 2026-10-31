import { test } from "node:test";
import assert from "node:assert/strict";
import { taskLines, toggleTask, sectionOf } from "../render.js";

test("cases à cocher : positions dans le texte source, code et frontmatter ignorés", () => {
  const text = "---\ntitre: x\n---\n- [ ] a\n```\n- [ ] dans le code\n```\n> - [x] dans une citation\n1. [ ] numérotée\n  - [ ] imbriquée\n%% - [ ] commentaire %%\n";
  assert.equal(taskLines(text).length, 4);
  assert.equal(toggleTask(text, 0, true).split("\n")[3], "- [x] a");
  assert.equal(toggleTask(text, 1, false).split("\n")[7], "> - [ ] dans une citation");
  assert.equal(toggleTask(text, 3, true).split("\n")[9], "  - [x] imbriquée");
  assert.equal(toggleTask(text, 4, true), null);
});

test("section d'une note pour ![[Note#Section]]", () => {
  const t = "# T\nintro\n## A\ntexte A\n### A1\nsous\n## B\ntexte B";
  assert.equal(sectionOf(t, "a"), "## A\ntexte A\n### A1\nsous");
  assert.equal(sectionOf(t, "B"), "## B\ntexte B");
  assert.match(sectionOf(t, "Z"), /introuvable/);
});

test("très longue note découpée avant les titres, jamais dans un bloc de code ni dans une liste", async () => {
  const { splitMarkdown } = await import("../render.js");
  const para = "Un paragraphe de texte assez long pour remplir le morceau. ".repeat(20) + "\n\n";
  let body = "";
  for (let i = 0; i < 40; i++) body += `## Partie ${i}\n\n${para}\`\`\`\n## pas un titre (code)\n\`\`\`\n\n- élément\n\n- élément suivant de la même liste\n\n${para}`;
  const parts = splitMarkdown(body, 8000);
  assert.ok(parts.length > 5);
  assert.equal(parts.join("\n"), body);
  for (const p of parts.slice(1)) assert.match(p, /^## Partie \d+/);
  const prose = (para.repeat(200));
  const pp = splitMarkdown(prose, 8000);
  assert.ok(pp.length > 3);
  assert.equal(pp.join("\n"), prose);
});
