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
