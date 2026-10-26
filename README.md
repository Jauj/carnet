# Carnet

Un vault Obsidian (les notes `.md` seulement) lisible et modifiable depuis n'importe quel navigateur, **chiffré de bout en bout**.

- **La page** : https://jauj.github.io/carnet/
- **Les données** : branche `data` de ce dépôt.
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
4. **Verrouiller** : la page se verrouille aussi seule après 30 minutes d'inactivité. Un brouillon non enregistré est gardé, chiffré, et proposé au déverrouillage suivant.
   - *Maj + clic* sur « Verrouiller » oublie le jeton mémorisé sur cet appareil.

### Sur le PC
Double-cliquer sur **« Synchroniser le carnet »** (Bureau), puis taper la phrase de passe. Le bilan s'affiche : envoyées, reçues, conflits.

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
node C:\Users\FERRIER\carnet\tools\sync.mjs sync      synchroniser
node C:\Users\FERRIER\carnet\tools\sync.mjs init      créer le carnet (une seule fois ; --generer propose une phrase forte)
```
La configuration se trouve dans `%USERPROFILE%\.carnet\config.json`, et l'historique dans `sync.log`.

## Le jeton GitHub (pour enregistrer depuis la page)

github.com → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** → *Generate new token* :
- *Repository access* : **Only select repositories** → `Jauj/carnet` ;
- *Permissions* → *Repository permissions* → **Contents : Read and write** ;
- une date d'expiration (par exemple un an).

La lecture n'a pas besoin de jeton. Ne mémorise le jeton que sur tes appareils de confiance : il permet aussi de modifier le code de la page.

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
- **La page ne charge rien d'extérieur** :
  - les bibliothèques sont copiées dans `vendor/` ;
  - la politique CSP n'autorise que `api.github.com` et `raw.githubusercontent.com` ;
  - aucune image externe n'est chargée ;
  - le chemin des notes n'apparaît jamais dans l'adresse.
- **Le compte GitHub** : quiconque le contrôle peut modifier la page pour capter la phrase de passe. Active la double authentification (2FA).
- **Phrase de passe perdue** : les données sur GitHub sont irrécupérables, mais le vault du PC est intact. `init --force` recrée le carnet avec une nouvelle phrase.

## Anciennes versions

Chaque enregistrement est un commit de la branche `data`. On peut donc revenir à n'importe quel état passé, toujours chiffré, avec git.

## Tests

`node --test test/crypto.test.mjs test/sync.test.mjs` lance 22 tests :
- chiffrement ;
- contrôles d'échec ;
- scénarios de synchronisation à deux appareils ;
- conflits, frein, course à l'écriture, chemins longs.

Pour tester la page en local :
- `node test/e2e-setup.mjs <dossier>` prépare un vault de démonstration ;
- `node test/mock-github.mjs <dossier>/remote.git` sert la page et simule GitHub (jeton de test : `test-token`).

## Licences

- `vendor/marked.esm.js` : marked 18.0.14 (MIT).
- `vendor/purify.es.mjs` : DOMPurify 3.4.16 (Apache-2.0 / MPL-2.0).
- Voir `vendor/`.
