// Carnet — mode nuit : quel thème appliquer à un instant donné.
// prefs : { theme, nightAuto, nightFrom: "21:00", nightTo: "07:00", nightOverride: { on, until } | null }

const minutes = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return ((h || 0) * 60 + (m || 0)) % 1440; };

// L'instant est-il dans la plage de nuit ? (la plage peut passer minuit : 21:00 → 07:00)
export function inNight(date, from, to) {
  const m = date.getHours() * 60 + date.getMinutes(), a = minutes(from), b = minutes(to);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// Prochaine bascule (début ou fin de la plage de nuit) après date.
export function nextBoundary(date, from, to) {
  const out = [];
  for (const hhmm of [from, to]) {
    const t = new Date(date);
    t.setHours(0, minutes(hhmm), 0, 0);
    if (t <= date) t.setDate(t.getDate() + 1);
    out.push(t.getTime());
  }
  return Math.min(...out);
}

// Thème effectif : forçage manuel (jusqu'à la prochaine bascule), sinon programmation, sinon thème choisi.
export function effectiveTheme(prefs, date = new Date()) {
  const o = prefs.nightOverride;
  const day = prefs.theme === "night" ? "auto" : prefs.theme || "auto";
  if (o && (o.until === null || o.until > date.getTime())) return o.on ? "night" : day;
  if (prefs.theme === "night") return "night";
  if (prefs.nightAuto && inNight(date, prefs.nightFrom, prefs.nightTo)) return "night";
  return day;
}

// Bouton lune : inverse le thème jusqu'à la prochaine bascule programmée (ou durablement sans programmation).
export function toggledOverride(prefs, date = new Date()) {
  const isNight = effectiveTheme(prefs, date) === "night";
  if (prefs.theme === "night" && isNight) return { theme: "auto", nightOverride: prefs.nightAuto ? { on: false, until: nextBoundary(date, prefs.nightFrom, prefs.nightTo) } : null };
  return { nightOverride: { on: !isNight, until: prefs.nightAuto ? nextBoundary(date, prefs.nightFrom, prefs.nightTo) : null } };
}
