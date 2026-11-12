#!/usr/bin/env node
// Serve a built site under its base path, like GitHub Pages does.
// Usage: node scripts/serve.mjs site/dist 4410 /openshell-docs/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [dir = "site/dist", port = "4410", base = "/"] = process.argv.slice(2);
const root = path.resolve(dir);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".woff2": "font/woff2", ".pf_meta": "application/octet-stream" };
http
  .createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!u.startsWith(base) && u + "/" !== base) return res.writeHead(404).end("not found");
    let f = path.join(root, u.slice(base.length - 1));
    if (!f.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
      if (!u.endsWith("/")) return res.writeHead(301, { location: u + "/" }).end();
      f = path.join(f, "index.html");
    }
    if (!fs.existsSync(f)) {
      res.writeHead(404, { "content-type": types[".html"] });
      return fs.createReadStream(path.join(root, "404.html")).pipe(res);
    }
    res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`serving ${dir} at http://127.0.0.1:${port}${base}`));
