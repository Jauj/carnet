// Où trouver le carnet chiffré. Rien de secret ici.
export default {
  owner: "Jauj",
  repo: "carnet",
  // Dépôt des données chiffrées, à part : le jeton d'écriture n'a ainsi aucun droit sur le code de cette page.
  // Tant qu'il ne contient pas encore le carnet (migration pas faite), la page lit et écrit dans "repo".
  dataRepo: "carnet-data",
  branch: "data",
  api: "https://api.github.com",
  raw: "https://raw.githubusercontent.com",
  // Identité des commits faits depuis la page (adresse « noreply » publique de GitHub).
  author: { name: "carnet", email: "52376184+Jauj@users.noreply.github.com" },
  lockMinutes: 30,
  hiddenLockMinutes: 5, // onglet en arrière-plan
};
