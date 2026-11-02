// A tiny web framework on Node's built-in http module: routes, JSON bodies, cookies, static files.
import fs from "node:fs";
import path from "node:path";

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, "That upload is too large. Try smaller images.")); }
    const chunks = []; let size = 0; let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, "That upload is too large. Try smaller images.")); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

export function createApp({ publicDir, trustProxy = true, securityHeaders = {} }) {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/\/:([A-Za-z_]+)/g, (_m, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    routes.push({ method, rx, keys, handlers });
  };
  const before = [];

  async function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir)) return false;
    let target = file;
    try {
      const st = await fs.promises.stat(target);
      if (!st.isFile()) return false;
    } catch {
      if (path.extname(rel)) return false;
      target = path.join(publicDir, "index.html"); // client-side routes fall back to the app
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end(), true;
    fs.createReadStream(target).pipe(res);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    const fwd = trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    req.ip = fwd || req.socket.remoteAddress || "unknown";
    req.secure = !!req.socket.encrypted || (trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
    req.get = (h) => req.headers[String(h).toLowerCase()];
    let rawCache, jsonCache;
    req.raw = async (limit = 1024 * 1024) => (rawCache ??= await readBody(req, limit));
    req.json = async (limit = 1024 * 1024) => {
      if (jsonCache !== undefined) return jsonCache;
      const buf = await req.raw(limit);
      if (!buf.length) return (jsonCache = {});
      try { jsonCache = JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "The request couldn't be read."); }
      if (!jsonCache || typeof jsonCache !== "object") jsonCache = {};
      return jsonCache;
    };
    res.json = (obj, status = 200) => {
      if (res.headersSent) return;
      const body = JSON.stringify(obj);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    };
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);

    try {
      for (const fn of before) { await fn(req, res); if (res.headersSent) return; }
      const method = req.method === "HEAD" ? "GET" : req.method;
      let pathMatched = false;
      for (const r of routes) {
        const m = req.path.match(r.rx);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        for (const h of r.handlers) { await h(req, res); if (res.headersSent || res.writableEnded) return; }
        return;
      }
      if (req.path.startsWith("/api/")) return res.json({ error: pathMatched ? "Method not allowed." : "Not found." }, pathMatched ? 405 : 404);
      if ((method === "GET") && await serveStatic(req, res, req.path)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found");
    } catch (e) {
      if (e instanceof HttpError) return res.json({ error: e.message, ...e.extra }, e.status);
      console.error("[http]", e);
      if (!res.headersSent) res.json({ error: "Something went wrong on our side. Try again." }, 500);
      else res.end();
    }
  }

  return { get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE"), before: (fn) => before.push(fn), handle };
}
