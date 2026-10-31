// Carnet — lecture à voix haute.
// Deux moteurs derrière la même interface :
//   - « piper » : voix neuronales Piper calculées dans un worker (tts-piper.js), hors ligne, privées ;
//   - « browser » : synthèse vocale du navigateur (Web Speech API) ; certaines voix sont « en ligne »
//     (Edge « Natural », Google) et envoient alors le texte au service de l'éditeur du navigateur.
// Le lecteur découpe la note en phrases, regroupées en paragraphes et en sections (titres), et permet de
// démarrer n'importe où, de naviguer et de régler voix et vitesse sans recommencer.

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, .callout-title, figcaption";
const SKIP = "pre, code, .props, .embed-head, .att, script, style, button, input, .tts-skip";

export const PIPER_VOICES = [
  { id: "fr_FR-siwis-medium", label: "Siwis (femme)", speakers: null },
  { id: "fr_FR-tom-medium", label: "Tom (homme)", speakers: null },
  { id: "fr_FR-upmc-medium", label: "UPMC", speakers: [["0", "Jessica (femme)"], ["1", "Pierre (homme)"]] },
  { id: "fr_FR-siwis-low", label: "Siwis légère (femme, qualité moindre)", speakers: null },
];

export const browserSupported = () => "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

// Voix du navigateur utilisables (Edge 150 renvoie parfois des voix « undefined » : écartées).
export function browserVoices() {
  if (!browserSupported()) return [];
  return speechSynthesis.getVoices()
    .filter((v) => v.name && !/undefined/i.test(v.name) && v.lang)
    .sort((a, b) => (b.lang.startsWith("fr") - a.lang.startsWith("fr")) || (isOnline(a) - isOnline(b)) || a.name.localeCompare(b.name));
}
export const isOnline = (v) => !v.localService || /online|natural|google/i.test(v.name);
export function onVoicesChanged(fn) { if (browserSupported()) speechSynthesis.addEventListener("voiceschanged", fn); }

// ---------- découpage du texte affiché ----------
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

export function sentences(text) {
  let parts;
  if (typeof Intl.Segmenter === "function") {
    parts = [...new Intl.Segmenter("fr", { granularity: "sentence" }).segment(text)].map((s) => ({ at: s.index, text: s.segment }));
  } else {
    parts = [...text.matchAll(/[^.!?…]+[.!?…]*\s*/g)].map((m) => ({ at: m.index, text: m[0] }));
  }
  // Phrases très longues : coupées aux virgules (Piper et certaines voix s'essoufflent au-delà).
  const out = [];
  for (const p of parts) {
    if (!p.text.trim()) continue;
    if (p.text.length <= 320) { out.push(p); continue; }
    let start = 0;
    for (const m of p.text.matchAll(/[,;:]\s+/g)) {
      if (m.index + m[0].length - start >= 200) { out.push({ at: p.at + start, text: p.text.slice(start, m.index + m[0].length) }); start = m.index + m[0].length; }
    }
    if (start < p.text.length) out.push({ at: p.at + start, text: p.text.slice(start) });
  }
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

// File de lecture : une entrée par phrase, avec son paragraphe et sa section.
export function buildQueue(root) {
  const queue = [];
  let block = -1, section = 0;
  for (const g of collect(root)) {
    block++;
    if (/^H[1-6]$/.test(g.block.tagName)) section++;
    for (const s of sentences(g.text)) queue.push({ g, block, section, ...s });
  }
  return queue;
}

// ---------- moteur : navigateur ----------
class BrowserEngine {
  constructor() { this.kind = "browser"; this.u = null; }
  configure({ voiceName, rate = 1, pitch = 1 }) {
    this.voice = browserVoices().find((v) => v.name === voiceName) || browserVoices().find((v) => v.lang.startsWith("fr")) || null;
    this.rate = rate;
    this.pitch = pitch;
  }
  get online() { return !!this.voice && isOnline(this.voice); }
  speak(text) {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.voice?.lang || "fr-FR";
      if (this.voice) u.voice = this.voice;
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.onend = () => resolve();
      u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? reject(new Error("annulé")) : resolve());
      this.u = u;
      speechSynthesis.speak(u);
    });
  }
  // Changer la vitesse ou la voix : on relit la phrase en cours avec les nouveaux réglages.
  get liveRate() { return false; }
  cancel() { if (browserSupported()) speechSynthesis.cancel(); }
  pause() { speechSynthesis.pause(); }
  resume() { speechSynthesis.resume(); }
  prefetch() {}
}

// ---------- moteur : Piper ----------
let worker = null, msgSeq = 0;
const waiting = new Map();
function piperWorker() {
  if (!worker) {
    worker = new Worker("tts-piper.js");
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      if (e.data.type === "progress") { w.progress?.(e.data.loaded, e.data.total); return; }
      waiting.delete(e.data.id);
      if (e.data.type === "error") w.reject(new Error(e.data.message)); else w.resolve(e.data);
    };
  }
  return worker;
}
export function piperCall(msg, progress) {
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    waiting.set(id, { resolve, reject, progress });
    piperWorker().postMessage({ ...msg, id });
  });
}
export const piperStatus = () => piperCall({ type: "voices" });

function wav(pcm, rate) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}

class PiperEngine {
  constructor() {
    this.kind = "piper";
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.cache = new Map(); // texte -> promesse d'URL audio
    this.gen = 0;           // incrémenté à chaque annulation : une phrase encore en calcul n'est pas jouée
  }
  configure({ voice, speaker = 0, rate = 1 }) {
    if (voice !== this.voiceId || speaker !== this.speaker) { this.flush(); this.voiceId = voice; this.speaker = speaker; }
    this.rate = rate;
    this.audio.playbackRate = rate;
  }
  get online() { return false; }
  get liveRate() { return true; }
  setRate(r) { this.rate = r; this.audio.playbackRate = r; }
  load(progress) { return piperCall({ type: "load", voice: this.voiceId }, progress); }
  synth(text) {
    if (!this.cache.has(text)) {
      const p = piperCall({ type: "speak", voice: this.voiceId, speaker: this.speaker, text })
        .then((a) => URL.createObjectURL(wav(a.pcm, a.rate)));
      p.catch(() => this.cache.delete(text));
      this.cache.set(text, p);
      if (this.cache.size > 12) { const [k, old] = this.cache.entries().next().value; this.cache.delete(k); old.then(URL.revokeObjectURL, () => {}); }
    }
    return this.cache.get(text);
  }
  prefetch(texts) { for (const t of texts) this.synth(t); }
  async speak(text) {
    const gen = this.gen;
    const url = await this.synth(text);
    if (gen !== this.gen) throw new Error("annulé");
    return new Promise((resolve, reject) => {
      const a = this.audio;
      this.rejectCurrent = reject;
      a.onended = () => resolve();
      a.onerror = () => resolve();
      a.src = url;
      a.playbackRate = this.rate;
      a.play().catch(reject);
    });
  }
  cancel() {
    this.gen++;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.rejectCurrent?.(new Error("annulé"));
    this.rejectCurrent = null;
  }
  pause() { this.audio.pause(); }
  resume() { this.audio.play().catch(() => {}); }
  flush() { for (const p of this.cache.values()) p.then(URL.revokeObjectURL, () => {}); this.cache.clear(); }
}

// ---------- lecteur ----------
export class Reader {
  constructor(onState) {
    this.onState = onState;
    this.state = "stopped";
    this.queue = [];
    this.pos = 0;
    this.token = 0;
    this.engines = { browser: new BrowserEngine(), piper: new PiperEngine() };
    this.engine = this.engines.browser;
    this.setupMediaSession();
  }

  // settings : { engine: "piper"|"browser", voice, speaker, voiceName, rate, pitch }
  configure(settings) {
    this.settings = { ...this.settings, ...settings };
    const s = this.settings;
    const next = this.engines[s.engine === "piper" ? "piper" : "browser"];
    if (next !== this.engine && this.state !== "stopped") this.engine.cancel();
    this.engine = next;
    if (next.kind === "piper") next.configure({ voice: s.voice, speaker: Number(s.speaker || 0), rate: s.rate });
    else next.configure({ voiceName: s.voiceName, rate: s.rate, pitch: s.pitch });
  }

  // Prépare le moteur (téléchargement des voix Piper au besoin).
  async prepare(progress) { if (this.engine.kind === "piper") await this.engine.load(progress); }

  // Démarre la lecture de root.
  //   from : élément à partir duquel lire ; range : sélection à lire (seulement elle) ;
  //   sinon : à partir du premier bloc visible dans scroller.
  start(root, { scroller, from, range, title } = {}) {
    this.stop();
    this.root = root;
    this.scroller = scroller;
    this.title = title;
    this.queue = buildQueue(root);
    this.end = this.queue.length;
    let first = 0;
    if (range && !range.collapsed) {
      const inRange = (it) => { const r = rangeFor(it.g, it.at, it.text.length); return range.compareBoundaryPoints(Range.END_TO_START, r) < 0 && range.compareBoundaryPoints(Range.START_TO_END, r) > 0; };
      first = this.queue.findIndex(inRange);
      let last = first;
      while (last + 1 < this.queue.length && inRange(this.queue[last + 1])) last++;
      if (first < 0) first = 0; else this.end = last + 1;
    } else if (from) first = this.indexOfElement(from);
    else if (scroller) {
      const top = scroller.getBoundingClientRect().top;
      first = Math.max(0, this.queue.findIndex((it) => it.g.block.getBoundingClientRect().bottom > top + 4));
    }
    this.pos = Math.max(0, first);
    this.play();
  }

  indexOfElement(el) {
    const i = this.queue.findIndex((it) => it.g.block === el || el.contains(it.g.block) || it.g.block.contains(el));
    return i < 0 ? 0 : i;
  }

  play() {
    this.token++;
    this.set("playing");
    this.loop(this.token);
  }

  async loop(token) {
    while (token === this.token && this.pos < this.end) {
      const item = this.queue[this.pos];
      this.mark(item);
      this.engine.prefetch(this.queue.slice(this.pos + 1, this.pos + 3).map((x) => x.text.trim()));
      try { await this.engine.speak(item.text.trim()); }
      catch (err) { if (token !== this.token) return; if (err.message !== "annulé") { this.onError?.(err); this.stop(); return; } return; }
      if (token !== this.token) return;
      this.pos++;
    }
    if (token === this.token) this.stop();
  }

  // Aller à une autre phrase (unit : "sentence" | "block" | "section") ou à un indice précis.
  skip(delta, unit = "sentence") {
    if (this.state === "stopped" || !this.queue.length) return;
    let i = this.pos;
    if (unit === "sentence") i += delta;
    else {
      const key = unit === "block" ? "block" : "section";
      const cur = this.queue[this.pos]?.[key];
      if (delta > 0) { while (i < this.queue.length && this.queue[i][key] === cur) i++; }
      else {
        // Début du paragraphe courant ; s'il est déjà en cours depuis le début, le précédent.
        let start = i;
        while (start > 0 && this.queue[start - 1][key] === cur) start--;
        if (start === i && start > 0) { const prev = this.queue[start - 1][key]; start--; while (start > 0 && this.queue[start - 1][key] === prev) start--; }
        i = start;
      }
    }
    this.jump(Math.max(0, Math.min(this.queue.length - 1, i)));
  }

  jump(i) {
    this.token++; // la boucle en cours s'arrête sans avancer d'une phrase
    this.engine.cancel();
    this.pos = i;
    this.end = Math.max(this.end, i + 1);
    if (this.state === "paused") { this.mark(this.queue[i]); this.token++; return; }
    setTimeout(() => this.play(), 30);
  }

  jumpToElement(el) { if (this.state !== "stopped") this.jump(this.indexOfElement(el)); }

  // Vitesse : immédiate avec Piper ; avec la voix du navigateur, la phrase en cours est relue.
  setRate(rate) {
    this.settings.rate = rate;
    if (this.engine.liveRate) { this.engine.setRate(rate); return; }
    this.engine.rate = rate;
    if (this.state === "playing") this.jump(this.pos);
  }

  // Autre voix ou autre moteur : on reprend à la phrase en cours.
  async changeVoice(settings, progress) {
    const was = this.state;
    if (was !== "stopped") { this.token++; this.engine.cancel(); }
    this.configure(settings);
    if (was === "stopped") return;
    try { await this.prepare(progress); } catch (err) { this.onError?.(err); this.stop(); return; }
    if (was === "playing") this.play(); else this.set("paused");
  }

  pause() {
    if (this.state !== "playing") return;
    this.token++;
    if (this.engine.kind === "piper") this.engine.pause(); else this.engine.cancel();
    this.set("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    if (this.engine.kind === "piper" && this.engine.audio.src && !this.engine.audio.ended) {
      // Reprise au milieu de la phrase.
      this.token++;
      const token = this.token;
      this.set("playing");
      const a = this.engine.audio;
      const done = new Promise((res) => { a.onended = res; });
      this.engine.resume();
      done.then(() => { if (token === this.token) { this.pos++; this.loop(token); } });
      return;
    }
    this.play();
  }

  toggle() { if (this.state === "playing") this.pause(); else if (this.state === "paused") this.resume(); }

  stop() {
    this.token++;
    this.engines.browser.cancel();
    this.engines.piper.cancel();
    this.clearMark();
    if (this.state !== "stopped") this.set("stopped");
  }

  mark(item) {
    if (!item) return;
    this.clearMark();
    const r = rangeFor(item.g, item.at, item.text.length);
    if (window.CSS?.highlights && typeof Highlight === "function") CSS.highlights.set("tts", new Highlight(r));
    else { item.g.block.classList.add("tts-block"); this.marked = item.g.block; }
    if (this.follow !== false) {
      const rect = r.getBoundingClientRect();
      const box = this.scroller?.getBoundingClientRect();
      if (box && (rect.top < box.top + 40 || rect.bottom > box.bottom - 40)) {
        this.scroller.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: "smooth" });
      }
    }
  }

  clearMark() {
    if (window.CSS?.highlights) CSS.highlights.delete("tts");
    this.marked?.classList.remove("tts-block");
    this.marked = null;
  }

  set(state) {
    this.state = state;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = state === "playing" ? "playing" : state === "paused" ? "paused" : "none";
      if (state !== "stopped" && typeof MediaMetadata === "function") {
        navigator.mediaSession.metadata = new MediaMetadata({ title: this.title || "Carnet", artist: "Carnet · lecture à voix haute" });
      }
    }
    this.onState?.(state);
  }

  // Touches média (clavier, casque, écran verrouillé) : fonctionne avec Piper (lecture par un élément audio).
  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const h = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    h("play", () => this.resume());
    h("pause", () => this.pause());
    h("stop", () => this.stop());
    h("nexttrack", () => this.skip(1, "block"));
    h("previoustrack", () => this.skip(-1, "block"));
    h("seekforward", () => this.skip(1));
    h("seekbackward", () => this.skip(-1));
  }
}
