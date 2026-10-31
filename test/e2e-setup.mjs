// Prépare un vault de démonstration chiffré dans un dépôt nu local, pour tester la page avec mock-github.mjs.
//   node test/e2e-setup.mjs <dossier>   (le dossier est vidé puis recréé)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.argv[2]);
const TOOL = fileURLToPath(new URL("../tools/sync.mjs", import.meta.url));
fs.rmSync(dir, { recursive: true, force: true });
const remote = path.join(dir, "remote.git"), home = path.join(dir, "home"), vault = path.join(dir, "vault");
for (const d of [home, vault]) fs.mkdirSync(d, { recursive: true });
spawnSync("git", ["init", "--bare", "--quiet", remote]);

const notes = {
  "Accueil.md": `# Accueil

Voir [[Réunion du Bureau]] et [[Sous-dossier/Note profonde|la note profonde]], puis [[Inexistante]].
Un lien Markdown : [note profonde](Sous-dossier/Note%20profonde.md). Un scan : ![[scan.pdf]].
Un lien externe : [exemple](https://example.org). Une image externe : ![photo](https://example.org/x.png)

> [!info] Un encadré
> Contenu de l'encadré.

- [ ] une tâche
- [x] une tâche faite

| Colonne | Valeur |
|---|---|
| a | 1 |

<script>alert("pas de script")</script>
`,
  "02 Notes/Réunion du Bureau.md": `---
tags: [bureau, cr]
date: 2026-10-20
---
# Réunion du Bureau

Texte du compte rendu. Retour à l'[[Accueil]].
`,
  "Sous-dossier/Note profonde.md": "# Note profonde\n\n## Section A\n\nRetour à [[Accueil#Accueil|l'accueil]].\n",
  "Projets/Carnet.md": `---
statut: en cours
priorité: 2
échéance: 2026-11-15
tags: [projet, informatique]
aliases: [Le carnet chiffré]
---
# Carnet

Un vault chiffré lisible partout. #projet/carnet

## Tâches
- [x] Chiffrement
- [ ] Recherche plein texte
- [ ] Lecture à voix haute

> [!warning]- Attention (repliable)
> Ne jamais perdre la phrase de passe.

> [!tip] Astuce
> Ctrl+K pour aller à une note. ==Texte surligné==.

Intégration : ![[Sous-dossier/Note profonde#Section A]]
`,
  "Projets/Lecture.md": "---\nstatut: fait\npriorité: 1\ntags: lecture\n---\n# Lecture\n\nNotes de lecture sur la Commune de Paris et la révolution russe. Voir [[Carnet]].\n",
  "Journal/2026-10-29.md": "# 2026-10-29\n\n- Réunion avec le Bureau.\n- Idée : [[Carnet]] doit lire à voix haute.\n",
  "Bibliothèque/Long texte.md": "# Long texte\n\n" + Array.from({ length: 40 }, (_, i) => `## Chapitre ${i + 1}\n\nLa révolution de ${1789 + i} fut un moment décisif. Les ouvriers et les paysans se soulevèrent contre l'ordre ancien. Phrase numéro ${i} du chapitre, avec des mots rares comme anticonstitutionnellement.\n`).join("\n"),
  "Rubbish/exclue.md": "ne doit pas apparaître",
  "02 Notes/02_06 Personnel/API.md": "ne doit pas apparaître",
};
// Vault lourd (CARNET_E2E_LOURD=1) : 300 notes, dont 30 textes d'environ 1 Mo, pour mesurer les performances.
if (process.env.CARNET_E2E_LOURD) {
  const mots = "la révolution française fut un moment décisif où les ouvriers et les paysans se soulevèrent contre l'ordre ancien État Œuvre classe commune pouvoir".split(" ");
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const texte = (n) => { let t = ""; let k = 0; while (t.length < n) { t += mots[Math.floor(rnd() * mots.length)] + (rnd() < 0.08 ? ". " : " "); if (++k % 900 === 0) t += `\n\n## Partie ${k / 900}\n\n`; } return t; };
  for (let i = 0; i < 270; i++) notes[`Lourd/Notes/Note ${i}.md`] = `# Note ${i}\n\n${texte(3000)}\n`;
  for (let i = 0; i < 30; i++) notes[`Lourd/Livres/Livre ${i}.md`] = `# Livre ${i}\n\n${texte(1_000_000)}\n`;
}
for (const [p, c] of Object.entries(notes)) {
  const abs = path.join(vault, ...p.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c);
}
fs.writeFileSync(path.join(vault, "Latin-1.md"), Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a])); // « # Café » en latin-1

fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ vault, remote, author: { name: "carnet", email: "carnet@test" } }));
const r = spawnSync(process.execPath, [TOOL, "init", "--iterations", "1000"], {
  env: { ...process.env, CARNET_HOME: home, CARNET_TEST_PASSPHRASE: "phrase de passe de démonstration locale", CARNET_ALLOW_WEAK: "1" },
  encoding: "utf8",
});
console.log(r.stdout, r.stderr);
process.exitCode = r.status;
