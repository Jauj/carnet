// Carnet — lecture à voix haute avec la synthèse vocale du navigateur (Web Speech API), hors ligne si la voix
// est installée sur l'appareil. Lecture phrase par phrase (Chrome interrompt les textes longs) avec surlignage.

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, .callout-title, figcaption";
const SKIP = "pre, code, .props, .embed-head, .att, script, style, button, input";

export const supported = () => "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

export function voices() {
  if (!supported()) return [];
  return speechSynthesis.getVoices().slice().sort((a, b) =>
    (b.lang.startsWith("fr") - a.lang.startsWith("fr")) || a.name.localeCompare(b.name));
}

export function onVoicesChanged(fn) { if (supported()) speechSynthesis.addEventListener("voiceschanged", fn); }

// Groupes de texte (un par bloc), chacun avec ses nœuds texte pour retrouver les positions à l'écran.
function collect(root) {
  const groups = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.data.trim() || n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let cur = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const block = n.parentElement.closest(BLOCKS) || n.parentElement;
    if (!cur || cur.block !== block) { cur = { block, nodes: [], text: "" }; groups.push(cur); }
    cur.nodes.push({ node: n, at: cur.text.length });
    cur.text += n.data;
  }
  return groups.filter((g) => g.text.trim());
}

function sentences(text) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("fr", { granularity: "sentence" }).segment(text)]
      .map((s) => ({ at: s.index, text: s.segment })).filter((s) => s.text.trim());
  }
  const out = [];
  for (const m of text.matchAll(/[^.!?…]+[.!?…]*\s*/g)) if (m[0].trim()) out.push({ at: m.index, text: m[0] });
  return out;
}

function rangeFor(group, at, len) {
  const r = document.createRange();
  const find = (pos) => {
    for (let i = group.nodes.length - 1; i >= 0; i--) if (group.nodes[i].at <= pos) return group.nodes[i];
    return group.nodes[0];
  };
  const a = find(at), b = find(Math.max(at, at + len - 1));
  r.setStart(a.node, Math.min(at - a.at, a.node.data.length));
  r.setEnd(b.node, Math.min(at + len - b.at, b.node.data.length));
  return r;
}

export class Reader {
  constructor(onState) {
    this.onState = onState;
    this.state = "stopped";
    this.queue = [];
    this.pos = 0;
    this.token = 0;
  }

  // Lit root à partir du premier bloc visible dans scroller (ou du bloc « from »).
  start(root, { scroller, from, voiceName, rate = 1 } = {}) {
    if (!supported()) throw new Error("La lecture à voix haute n'est pas disponible dans ce navigateur.");
    this.stop();
    const groups = collect(root);
    let first = 0;
    if (from) first = Math.max(0, groups.findIndex((g) => from.contains(g.block) || g.block.contains(from)));
    else if (scroller) {
      const top = scroller.getBoundingClientRect().top;
      const i = groups.findIndex((g) => g.block.getBoundingClientRect().bottom > top + 4);
      first = Math.max(0, i);
    }
    this.queue = [];
    for (const g of groups.slice(first)) for (const s of sentences(g.text)) this.queue.push({ g, ...s });
    this.pos = 0;
    this.voice = voices().find((v) => v.name === voiceName) || voices().find((v) => v.lang.startsWith("fr")) || null;
    this.rate = rate;
    this.scroller = scroller;
    this.token++;
    this.set("playing");
    this.next(this.token);
  }

  next(token) {
    if (token !== this.token) return;
    if (this.pos >= this.queue.length) { this.stop(); return; }
    const item = this.queue[this.pos];
    this.mark(item);
    const u = new SpeechSynthesisUtterance(item.text.trim());
    u.lang = this.voice?.lang || "fr-FR";
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.onend = () => { if (token === this.token && this.state !== "stopped") { this.pos++; this.next(token); } };
    u.onerror = (e) => { if (token === this.token && e.error !== "interrupted" && e.error !== "canceled") { this.pos++; this.next(token); } };
    speechSynthesis.speak(u);
  }

  mark(item) {
    this.clearMark();
    const r = rangeFor(item.g, item.at, item.text.length);
    if (window.CSS?.highlights && typeof Highlight === "function") CSS.highlights.set("tts", new Highlight(r));
    else { item.g.block.classList.add("tts-block"); this.marked = item.g.block; }
    const rect = r.getBoundingClientRect();
    const box = this.scroller?.getBoundingClientRect();
    if (box && (rect.top < box.top + 40 || rect.bottom > box.bottom - 40)) {
      this.scroller.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: "smooth" });
    }
  }

  clearMark() {
    if (window.CSS?.highlights) CSS.highlights.delete("tts");
    this.marked?.classList.remove("tts-block");
    this.marked = null;
  }

  pause() { if (this.state === "playing") { speechSynthesis.pause(); this.set("paused"); } }
  resume() { if (this.state === "paused") { speechSynthesis.resume(); this.set("playing"); } }
  toggle() { if (this.state === "playing") this.pause(); else if (this.state === "paused") this.resume(); }

  // Phrase précédente ou suivante.
  skip(delta) {
    if (this.state === "stopped") return;
    this.token++;
    speechSynthesis.cancel();
    this.pos = Math.max(0, Math.min(this.queue.length, this.pos + delta));
    this.set("playing");
    const t = this.token;
    setTimeout(() => this.next(t), 50);
  }

  stop() {
    this.token++;
    if (supported()) speechSynthesis.cancel();
    this.clearMark();
    this.set("stopped");
  }

  set(state) { this.state = state; this.onState?.(state); }
}
