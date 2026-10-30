// Les bibliothèques copiées dans vendor/ sont bien celles dont l'empreinte est notée dans VERSIONS.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const dir = new URL("../vendor/", import.meta.url);

test("vendor/ : empreintes SHA-256 conformes à VERSIONS.txt", () => {
  const lines = fs.readFileSync(new URL("VERSIONS.txt", dir), "utf8").split("\n");
  const entries = lines.map((l) => /^([0-9a-f]{64}) \*(.+)$/.exec(l.trim())).filter(Boolean);
  assert.ok(entries.length >= 2, "VERSIONS.txt doit lister les empreintes");
  for (const [, sha, file] of entries) {
    const got = createHash("sha256").update(fs.readFileSync(new URL(file, dir))).digest("hex");
    assert.equal(got, sha, `${file} ne correspond pas à son empreinte`);
  }
});
