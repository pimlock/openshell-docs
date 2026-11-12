#!/usr/bin/env node
// Write static redirect pages for hosts without redirect rules (GitHub Pages).
// Reads <dist>/versions.json (written by the assembler):
//   /                      -> newest OpenShell release
//   /<mount>/              -> the docset's latest release
//   /<mount>/latest/<page> -> /<mount>/<latest>/<page>
//   /<mount>/<version>/    -> that version's first page, when it has no home page
//   /<prefix>/<old page>   -> /<prefix>/<new page>, from `redirects:` in docset.yml
//                             (and Fern section URLs without an overview page)
// Existing pages are never overwritten. A production host would use edge
// rules instead (and could also negotiate Markdown).
// Usage: node scripts/redirects.mjs site/dist
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? "site/dist");
const { base, home, docsets } = JSON.parse(fs.readFileSync(path.join(dist, "versions.json"), "utf8"));
const join = (...p) => p.filter(Boolean).join("/");
const href = (slug) => base + (slug ? slug + "/" : "");
let written = 0;
const redirect = (from, to) => {
  const file = path.join(dist, from, "index.html");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = JSON.stringify(to);
  fs.writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>Redirecting</title><meta name="robots" content="noindex">` +
      `<link rel="canonical" href=${t}><meta http-equiv="refresh" content="0; url=${to}">` +
      `<script>location.replace(${t} + location.hash)</script><a href=${t}>${to}</a>\n`,
  );
  written++;
};

redirect("", home);
for (const d of Object.values(docsets)) {
  const latest = d.versions.find((v) => v.name === d.latest);
  if (d.mount) redirect(d.mount, href(latest.first));
  redirect(join(d.mount, "latest"), href(latest.pages.includes("") ? latest.prefix : latest.first));
  for (const key of latest.pages) if (key) redirect(join(d.mount, "latest", key), href(join(latest.prefix, key)));
  for (const v of d.versions) {
    if (!v.pages.includes("")) redirect(v.prefix, href(v.first));
    for (const [from, to] of Object.entries(v.redirects ?? {})) redirect(join(v.prefix, from), href(join(v.prefix, to)));
  }
}
console.log(`wrote ${written} redirect pages`);
