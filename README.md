# Carnet

Un vault Obsidian (les notes `.md` seulement) lisible et modifiable depuis n'importe quel navigateur, **chiffré de bout en bout**.

- **La page** : https://jauj.github.io/carnet/
- **Les données** : branche `data` du dépôt de données (`dataRepo` dans `config.js` : ce dépôt, ou `Jauj/carnet-data` après la migration ci-dessous).
  - `vault.json` contient les paramètres de dérivation de clé.
  - `manifest.bin` est la liste chiffrée des notes.
  - Les fichiers `n/*.bin` sont les notes chiffrées.
  - Rien n'y est en clair : ni le contenu, ni les titres, ni les dossiers.
- **Le vault Obsidian du PC** reste la référence. L'outil `tools/sync.mjs` le synchronise avec la branche `data`.

## Utilisation

### Sur la page
1. **Déverrouiller** avec la phrase de passe. La dérivation de la clé prend quelques secondes ; c'est voulu, car cela ralentit d'autant toute tentative de la deviner.
2. **Lire** :
   - on navigue dans l'arborescence ou on filtre par nom ;
   - les liens `[[…]]` sont cliquables ;
   - les pièces jointes (PDF, images) ne sont pas synchronisées.
3. **Modifier ou créer** (bouton **＋**) : enregistrer avec `Ctrl+S`.
   - Au premier enregistrement sur un appareil, la page demande un **jeton GitHub** (voir plus bas).
   - Option « Mémoriser » : le jeton est gardé dans le navigateur, **chiffré** avec la phrase de passe.
4. **Verrouiller** : la page se verrouille aussi seule après 30 minutes d'inactivité, ou 5 minutes en arrière-plan (téléphone rangé, autre onglet). Un brouillon non enregistré est gardé, chiffré, et proposé au déverrouillage suivant.
   - *Maj + clic* sur « Verrouiller » oublie le jeton mémorisé sur cet appareil.

### Sur le PC
Double-cliquer sur **« Synchroniser le carnet »** (Bureau), puis taper la phrase de passe. Le bilan s'affiche : envoyées, reçues, conflits.

**Ne plus taper la phrase à chaque fois** : lancer une fois `sync --memoriser`. La clé est gardée dans `%USERPROFILE%\.carnet\cle.dpapi`, chiffrée par Windows (DPAPI) pour ton seul compte sur ce seul PC. Elle ne donne rien de plus que le vault lui-même, déjà en clair sur ce PC. `oublier` l'efface. Après un `init --force`, elle est oubliée d'office.

**Synchroniser tout seul** (une fois la clé mémorisée) : plus on synchronise souvent, moins il y a de conflits.
- Dans Obsidian, plugin communautaire **Shell commands** : une commande `node "C:\Users\FERRIER\carnet\tools\sync.mjs" sync`, avec les événements « Obsidian starts » et « Every n seconds » (par exemple 600). Le nom exact des événements est dans la documentation du plugin.
- Ou le **Planificateur de tâches** de Windows, avec la même commande.
- Le frein et le verrou restent actifs : une synchronisation automatique qui prévoit trop de suppressions s'arrête sans rien toucher, et deux synchronisations ne tournent jamais en même temps.

| Situation | Ce que fait l'outil |
|---|---|
| Note modifiée seulement sur le PC | Envoyée |
| Note modifiée seulement sur la page | Écrite dans le vault |
| Modifiée des deux côtés | La version du PC reste en place. La version du web est enregistrée à côté : « Note (conflit web 2026-10-26 14h03).md ». Comparer, puis supprimer la copie en trop. |
| Supprimée d'un côté | Supprimée de l'autre. Côté PC, la note va dans `%USERPROFILE%\.carnet\corbeille\`, jamais à la poubelle. |
| Plus de 20 suppressions d'un coup | **Arrêt sans rien toucher**. Relancer avec `--autoriser-suppressions` si c'est voulu. |

**Ne sont jamais envoyés** :
- `.obsidian/` et tout dossier qui commence par un point ;
- `Rubbish/` ;
- `02 Notes/02_06 Personnel/API.md` ;
- les fichiers de conflit de Syncthing.

**Commandes** (dans un terminal) :
```
node C:\Users\FERRIER\carnet\tools\sync.mjs status    ce que ferait la synchronisation, sans rien modifier
node C:\Users\FERRIER\carnet\tools\sync.mjs sync      synchroniser (--memoriser : garder la clé sur ce PC)
node C:\Users\FERRIER\carnet\tools\sync.mjs oublier   effacer la clé mémorisée
node C:\Users\FERRIER\carnet\tools\sync.mjs migrer    déplacer les données vers Jauj/carnet-data (une seule fois)
node C:\Users\FERRIER\carnet\tools\sync.mjs init      créer le carnet (une seule fois ; --generer propose une phrase forte)
```
La configuration se trouve dans `%USERPROFILE%\.carnet\config.json`, et l'historique dans `sync.log`.

## Le jeton GitHub (pour enregistrer depuis la page)

github.com → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** → *Generate new token* :
- *Repository access* : **Only select repositories** → le dépôt de données seulement (`Jauj/carnet-data` après la migration) ;
- *Permissions* → *Repository permissions* → **Contents : Read and write** ;
- une date d'expiration (par exemple un an).

La lecture n'a pas besoin de jeton. GitHub prévient par e-mail avant l'expiration d'un jeton.

## Séparer le code et les données (recommandé, à faire une fois)

Tant que les données sont dans `Jauj/carnet`, le jeton d'écriture peut aussi modifier le code de la page, donc la piéger pour capter la phrase de passe. Avec un dépôt de données à part, un jeton volé ne peut plus qu'abîmer des données chiffrées, qui sont aussi dans l'historique et sur le PC.

La page est prête (`dataRepo: "carnet-data"` dans `config.js`). Tant que ce dépôt ne contient pas le carnet, elle continue d'utiliser `Jauj/carnet`, puis elle bascule d'elle-même. Il reste trois étapes :

1. Sur github.com : **New repository** → nom `carnet-data`, **Public**, sans README.
2. Sur le PC, dans un terminal :
   ```
   git -C C:\Users\FERRIER\carnet pull
   node C:\Users\FERRIER\carnet\tools\sync.mjs migrer
   node C:\Users\FERRIER\carnet\tools\sync.mjs sync --memoriser
   ```
   `migrer` envoie tout l'historique chiffré, met à jour `config.json` et repart d'un clone propre. Le relancer ne fait rien de mal.
3. Créer un nouveau jeton limité à `Jauj/carnet-data` (voir plus haut) et **révoquer l'ancien**. À la première modification, la page refuse l'ancien jeton et demande le nouveau.

L'ancienne branche `data` de `Jauj/carnet` n'est plus lue. Tu peux la supprimer quand tu veux.

## Sécurité : ce qui protège quoi

- **Le chiffrement**, côté client :
  - PBKDF2-SHA256 avec 1 000 000 d'itérations, puis HKDF qui dérive trois clés indépendantes ;
  - AES-256-GCM pour chaque note et pour le manifeste ;
  - les noms de fichiers sont un HMAC du chemin.
  - Code : `crypto.js`, le même dans la page et dans l'outil.
- **La phrase de passe protège tout.** Les fichiers chiffrés sont publics : n'importe qui peut les télécharger et tenter de la deviner hors ligne. Il faut une phrase longue (`init` exige au moins 25 caractères) ou celle générée par `init --generer`.
- **Ce qui reste visible publiquement** :
  - le nombre de notes ;
  - leur taille approximative (compressée) ;
  - les dates de modification (commits).

  Les messages de commit ne contiennent jamais de nom de note.
- **La page refuse d'être affichée dans le cadre d'un autre site** (protection contre le clickjacking). GitHub Pages ne permet pas l'en-tête `frame-ancestors`, donc c'est la page qui vérifie.
- **La page ne charge rien d'extérieur** :
  - les bibliothèques sont copiées dans `vendor/`. Leur empreinte est vérifiée par les tests, et une action GitHub mensuelle ouvre une issue quand une nouvelle version sort ;
  - la politique CSP n'autorise que `api.github.com` et `raw.githubusercontent.com` ;
  - aucune image externe n'est chargée ;
  - le chemin des notes n'apparaît jamais dans l'adresse.
- **Le compte GitHub** : quiconque le contrôle peut modifier la page pour capter la phrase de passe. Active la double authentification (2FA), de préférence avec une clé d'accès (passkey).
- **Pourquoi PBKDF2 et pas Argon2** : les navigateurs n'offrent toujours pas Argon2 en natif. Il faudrait du WebAssembly et assouplir la politique CSP. Avec une phrase longue, 1 000 000 d'itérations PBKDF2-SHA256 dépassent déjà le minimum de l'OWASP (600 000).
- **Phrase de passe perdue** : les données sur GitHub sont irrécupérables, mais le vault du PC est intact. `init --force` recrée le carnet avec une nouvelle phrase.

## Anciennes versions

Chaque enregistrement est un commit de la branche `data`. On peut donc revenir à n'importe quel état passé, toujours chiffré, avec git.

## Tests

`node --test test/*.test.mjs` lance 26 tests :
- chiffrement ;
- contrôles d'échec ;
- scénarios de synchronisation à deux appareils ;
- conflits, frein, course à l'écriture, chemins longs ;
- clé mémorisée (DPAPI simulée hors Windows), migration vers un dépôt de données ;
- empreintes des bibliothèques de `vendor/`.

Pour tester la page en local :
- `node test/e2e-setup.mjs <dossier>` prépare un vault de démonstration ;
- `node test/mock-github.mjs <dossier>/remote.git` sert la page et simule GitHub (jeton de test : `test-token`).

## Licences

- `vendor/marked.esm.js` : marked 18.0.14 (MIT).
- `vendor/purify.es.mjs` : DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0).
- Voir `vendor/`.
