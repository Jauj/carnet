// Carnet — voix neuronales Piper, calculées dans ce worker (la page ne se fige pas), entièrement hors ligne
// une fois les fichiers téléchargés. Le texte des notes ne quitte jamais l'appareil.
//
// Fichiers téléchargés une seule fois, puis gardés dans le cache « carnet-voix » :
//   - moteur : onnxruntime-web 1.18.0 et piper_phonemize 1.0.0 (espeak-ng), depuis jsDelivr (miroir de npm) ;
//   - voix : modèles officiels rhasspy/piper-voices, révision v1.0.0, depuis Hugging Face.
// Chaque fichier est vérifié par son empreinte SHA-256 AVANT d'être exécuté ou chargé : un fichier modifié
// en route ou sur le serveur est refusé.

const NPM = "https://cdn.jsdelivr.net/npm/";
const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/";
const CACHE = "carnet-voix";

const ENGINE = {
  ortJs: { url: NPM + "onnxruntime-web@1.18.0/dist/ort.wasm.min.js", sha: "90533a3fd7006df7f897c0d63c468996da5c8e430e39964d92ebe586c4996614", size: 142930 },
  ortWasm: { url: NPM + "onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm", sha: "f533b5f21790563d7556c611c3835ac65848ee326da2689aac54ed7d9cc8c6a4", size: 10595041 },
  phonJs: { url: NPM + "@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js", sha: "fef0c2fc442d24fdef5c7c7cc37d5da2314407640fe11ab1bfe347c723dff19b", size: 120714 },
  phonWasm: { url: NPM + "@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm", sha: "b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6", size: 635212 },
  phonData: { url: NPM + "@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data", sha: "29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c", size: 18077249 },
};

const VOICES = {
  "fr_FR-siwis-medium": { path: "siwis/medium/", onnx: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99", size: 63201294, json: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959" },
  "fr_FR-tom-medium": { path: "tom/medium/", onnx: "bf65074ccdeeeeaa832e75edb1c0a513c01c9a972bdf085ff8a6e71ea234fd41", size: 63511038, json: "2f7f885ad5a0aad802e3cc24e4f57239febdcb142b4876de5d238094674361cc" },
  "fr_FR-upmc-medium": { path: "upmc/medium/", onnx: "9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f", size: 76733615, json: "e8636ec15dfd5d72db37a02cb5320a20f2b8d339f2a0e4337da64c58a33a5868" },
  "fr_FR-siwis-low": { path: "siwis/low/", onnx: "a7b7dcaf87229b32af8275cb1a719371234ea677bc0313d2289d5c50ab0ac53d", size: 28130791, json: "9722527d748c284f6dd7639c4b4e661853d4f7d4514079571f67d6a97a652b69" },
};

const voiceFiles = (id) => {
  const v = VOICES[id];
  if (!v) throw new Error(`Voix inconnue : ${id}`);
  return {
    onnx: { url: `${HF}${v.path}${id}.onnx`, sha: v.onnx, size: v.size },
    json: { url: `${HF}${v.path}${id}.onnx.json`, sha: v.json, size: 5000 },
  };
};

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function sha256Hex(buf) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fichier vérifié : depuis le cache, sinon téléchargé (avec progression), vérifié, puis mis en cache.
async function getFile(f, label, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(f.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(f.url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${label}`);
  const total = Number(res.headers.get("content-length")) || f.size;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (await sha256Hex(bytes) !== f.sha) throw new Error(`Fichier refusé (empreinte inattendue) : ${label}`);
  await cache.put(f.url, new Response(bytes));
  return bytes;
}

async function isCached(f) { return !!(await (await caches.open(CACHE)).match(f.url)); }

// ---------- état ----------
let engineReady = null;   // promesse : { ort, phon }
let session = null;       // { id, ort session, config }
let phonPending = null;
const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));

function loadEngine(progress) {
  engineReady ||= (async () => {
    const files = Object.entries(ENGINE);
    const total = files.reduce((n, [, f]) => n + f.size, 0);
    let base = 0;
    const got = {};
    for (const [k, f] of files) {
      got[k] = await getFile(f, k, (l) => progress?.(base + l, total));
      base += f.size;
    }
    importScripts(blobUrl(got.ortJs, "text/javascript"));
    const ort = self.ort;
    ort.env.wasm.numThreads = 1; // GitHub Pages ne permet pas l'isolation nécessaire aux fils multiples
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { "ort-wasm-simd.wasm": blobUrl(got.ortWasm, "application/wasm") };
    importScripts(blobUrl(got.phonJs, "text/javascript"));
    const wasmUrl = blobUrl(got.phonWasm, "application/wasm"), dataUrl = blobUrl(got.phonData, "application/octet-stream");
    const phon = await self.createPiperPhonemize({
      print: (line) => { const p = phonPending; phonPending = null; p?.resolve(line); },
      printErr: () => {},
      locateFile: (u) => (u.endsWith(".wasm") ? wasmUrl : u.endsWith(".data") ? dataUrl : u),
    });
    return { ort, phon };
  })();
  engineReady.catch(() => { engineReady = null; });
  return engineReady;
}

async function loadVoice(id, progress) {
  if (session?.id === id) return session;
  const vf = voiceFiles(id);
  const engineTotal = Object.values(ENGINE).reduce((n, f) => n + f.size, 0);
  const total = engineTotal + vf.onnx.size;
  const { ort } = await loadEngine((l) => progress?.(l, total));
  const config = JSON.parse(new TextDecoder().decode(await getFile(vf.json, id + ".json")));
  const model = await getFile(vf.onnx, id, (l) => progress?.(engineTotal + l, total));
  const s = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  session = { id, s, config };
  return session;
}

// Phonèmes d'un texte (espeak-ng), convertis avec la table propre à la voix (comme Piper :
// « ^ » au début, « _ » entre les phonèmes, « $ » à la fin ; un phonème inconnu de la voix est ignoré).
// La table par défaut du phonétiseur ne convient pas à toutes les voix (Siwis légère n'en a que 130).
async function phonemeIds(phon, config, text) {
  const out = await phonemize(phon, config.espeak.voice, text);
  const map = config.phoneme_id_map;
  if (!map) return out.phoneme_ids;
  const pad = map._ || [0];
  const ids = [...(map["^"] || [1]), ...pad];
  for (const ph of out.phonemes) if (map[ph]) ids.push(...map[ph], ...pad);
  ids.push(...(map.$ || [2]));
  return ids;
}

async function phonemize(phon, voice, text) {
  const line = await new Promise((resolve, reject) => {
    phonPending = { resolve, reject };
    try {
      phon.callMain(["-l", voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
    } catch (err) { phonPending = null; reject(err); }
    setTimeout(() => { if (phonPending?.resolve === resolve) { phonPending = null; reject(new Error("Phonétisation sans réponse.")); } }, 10000);
  });
  return JSON.parse(line);
}

async function synth(id, text, speaker, lengthScale) {
  const { phon } = await loadEngine();
  const { s, config } = await loadVoice(id);
  const ids = await phonemeIds(phon, config, text);
  const { ort } = await loadEngine();
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)])),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) * (lengthScale || 1), inf.noise_w ?? 0.8])),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(speaker || 0)]));
  const out = await s.run(feeds);
  return { pcm: out.output.data, rate: config.audio.sample_rate };
}

// ---------- messages ----------
// Les synthèses sont faites une par une, dans l'ordre (le phonétiseur n'est pas réentrant).
let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  const run = (fn) => { chain = chain.then(fn, fn); };
  if (m.type === "voices") {
    run(async () => {
      const engine = (await Promise.all(Object.values(ENGINE).map(isCached))).every(Boolean);
      const voices = {};
      for (const id of Object.keys(VOICES)) voices[id] = engine && (await isCached(voiceFiles(id).onnx)) && (await isCached(voiceFiles(id).json));
      post({ type: "voices", id: m.id, engine, voices, sizes: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.size])), engineSize: Object.values(ENGINE).reduce((n, f) => n + f.size, 0) });
    });
  } else if (m.type === "load") {
    run(async () => {
      try {
        await loadVoice(m.voice, (loaded, total) => post({ type: "progress", id: m.id, loaded, total }));
        post({ type: "loaded", id: m.id });
      } catch (err) { post({ type: "error", id: m.id, message: err.message }); }
    });
  } else if (m.type === "speak") {
    run(async () => {
      try {
        const { pcm, rate } = await synth(m.voice, m.text, m.speaker, m.lengthScale);
        const copy = new Float32Array(pcm);
        post({ type: "audio", id: m.id, pcm: copy, rate }, [copy.buffer]);
      } catch (err) { post({ type: "error", id: m.id, message: err.message }); }
    });
  } else if (m.type === "delete") {
    run(async () => {
      const cache = await caches.open(CACHE);
      const vf = voiceFiles(m.voice);
      await cache.delete(vf.onnx.url);
      await cache.delete(vf.json.url);
      if (session?.id === m.voice) session = null;
      post({ type: "deleted", id: m.id });
    });
  }
};
