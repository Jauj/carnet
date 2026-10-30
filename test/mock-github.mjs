// Faux GitHub pour tester la page en local, adossé à un vrai dépôt git nu.
// Sert l'application (avec un config.js de test) + le sous-ensemble de l'API utilisé + les fichiers bruts.
//   node test/mock-github.mjs <dépôt-nu> [port]
// Jeton de test accepté pour écrire : "test-token". POST /__mock/ratelimit?on=1 simule la limite sans jeton.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [repoDir, portArg] = process.argv.slice(2);
const PORT = Number(process.env.PORT || portArg || 8787);
const TOKEN = "test-token";
let rateLimited = false;
const requests = [];

function git(args, { input, env } = {}) {
  const r = spawnSync("git", ["--git-dir", repoDir, ...args], { input, env: { ...process.env, ...env }, maxBuffer: 1 << 30 });
  if (r.status !== 0) { const e = new Error(r.stderr.toString()); e.git = true; throw e; }
  return r.stdout;
}
const gitText = (args, o) => git(args, o).toString().trim();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function send(res, status, body, type = "application/json") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

async function readJson(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function authorized(req) { return req.headers.authorization === `Bearer ${TOKEN}`; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  requests.push(`${req.method} ${p}`);
  try {
    // ----- outils du test -----
    if (p === "/__mock/ratelimit") { rateLimited = url.searchParams.get("on") === "1"; return send(res, 200, { rateLimited }); }
    if (p === "/__mock/log") return send(res, 200, requests);

    // ----- application -----
    if (p === "/config.js") {
      return send(res, 200, `export default { owner: "test", repo: "carnet", branch: "data", api: "/api", raw: "/raw",
        author: { name: "carnet", email: "carnet@test" }, lockMinutes: 30 };`, TYPES[".js"]);
    }
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
        .replace(/connect-src [^;]+;/, "connect-src 'self';");
      return send(res, 200, html, TYPES[".html"]);
    }
    if (!p.startsWith("/api/") && !p.startsWith("/raw/")) {
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "introuvable", "text/plain");
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
    }

    // ----- fichiers bruts : /raw/<owner>/<repo>/<ref>/<chemin> -----
    if (p.startsWith("/raw/")) {
      const [, , , , ref, ...rest] = p.split("/");
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : gitText(["rev-parse", `refs/heads/${ref}`]);
      try { return send(res, 200, git(["cat-file", "blob", `${sha}:${rest.join("/")}`]), "application/octet-stream"); }
      catch { return send(res, 404, "404: Not Found", "text/plain"); }
    }

    // ----- API : /api/repos/<owner>/<repo>/... -----
    const parts = p.split("/").slice(5); // après /api/repos/<owner>/<repo>
    const write = req.method !== "GET";
    if (req.headers.authorization && !authorized(req)) return send(res, 401, { message: "Bad credentials" });
    if (write && !authorized(req)) return send(res, 404, { message: "Not Found" });

    if (req.method === "GET" && parts.length === 0) return send(res, 200, { full_name: "test/carnet", permissions: { push: true } });

    if (req.method === "GET" && parts[0] === "git" && parts[1] === "ref") {
      if (rateLimited && !authorized(req)) return send(res, 403, { message: "API rate limit exceeded" });
      const ref = parts.slice(2).join("/");
      let sha;
      try { sha = gitText(["rev-parse", "--verify", `refs/${ref}`]); } catch { return send(res, 404, { message: "Not Found" }); }
      return send(res, 200, { ref: `refs/${ref}`, object: { sha, type: "commit" } });
    }
    if (req.method === "GET" && parts[0] === "git" && parts[1] === "commits") {
      const txt = gitText(["cat-file", "-p", parts[2]]);
      const tree = /^tree ([0-9a-f]{40})/m.exec(txt)[1];
      const parents = [...txt.matchAll(/^parent ([0-9a-f]{40})/gm)].map((m) => ({ sha: m[1] }));
      return send(res, 200, { sha: parts[2], tree: { sha: tree }, parents });
    }
    if (req.method === "POST" && parts[0] === "git" && parts[1] === "blobs") {
      const body = await readJson(req);
      const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      return send(res, 201, { sha: gitText(["hash-object", "-w", "--stdin"], { input: bytes }) });
    }
    if (req.method === "POST" && parts[0] === "git" && parts[1] === "trees") {
      const body = await readJson(req);
      const index = path.join(os.tmpdir(), `mock-index-${process.pid}-${Date.now()}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        if (body.base_tree) git(["read-tree", body.base_tree], { env });
        for (const e of body.tree) {
          if (e.sha === null) git(["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${e.path}\n` });
          else git(["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], { env });
        }
        return send(res, 201, { sha: gitText(["write-tree"], { env }) });
      } finally { fs.rmSync(index, { force: true }); }
    }
    if (req.method === "POST" && parts[0] === "git" && parts[1] === "commits") {
      const b = await readJson(req);
      const env = {
        GIT_AUTHOR_NAME: b.author?.name || "test", GIT_AUTHOR_EMAIL: b.author?.email || "test@test", GIT_AUTHOR_DATE: b.author?.date || "",
        GIT_COMMITTER_NAME: b.committer?.name || "test", GIT_COMMITTER_EMAIL: b.committer?.email || "test@test", GIT_COMMITTER_DATE: b.committer?.date || "",
      };
      const args = ["commit-tree", b.tree, ...b.parents.flatMap((x) => ["-p", x]), "-m", b.message];
      return send(res, 201, { sha: gitText(args, { env }) });
    }
    if (req.method === "PATCH" && parts[0] === "git" && parts[1] === "refs") {
      const ref = `refs/${parts.slice(2).join("/")}`;
      const b = await readJson(req);
      const cur = gitText(["rev-parse", ref]);
      const ff = spawnSync("git", ["--git-dir", repoDir, "merge-base", "--is-ancestor", cur, b.sha]).status === 0;
      if (!b.force && !ff) return send(res, 422, { message: "Update is not a fast forward" });
      try { git(["update-ref", ref, b.sha, cur]); } catch { return send(res, 422, { message: "Reference update failed" }); }
      return send(res, 200, { ref, object: { sha: b.sha, type: "commit" } });
    }
    return send(res, 404, { message: "Not Found (mock)" });
  } catch (err) {
    return send(res, 500, { message: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Faux GitHub sur http://localhost:${PORT} (dépôt ${repoDir})`));
