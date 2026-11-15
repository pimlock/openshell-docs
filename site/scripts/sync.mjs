#!/usr/bin/env node
// Copy the assembled docs into the Starlight project.
//   build/assembled/content -> site/src/content/docs (MDX pages get one import line for the components)
//   build/assembled/{nav,pages}.json -> site/src/generated/ (read by src/versioning.ts)
//   site/static + build/assembled/public -> site/public (assets, <slug>.md, llms.txt, versions.json, links.json)
//   theme/tokens.css -> site/src/styles/tokens.css
// Per page it also sets:
//   slug      explicit, so version segments like "0.1.8" keep their dots
//   banner    on dev and older versions, linking to the same page in the latest release
//   pagefind  false on dev and older versions, so search returns the latest docs only
//   template  splash on topic overview pages (no sidebar)
// ```mermaid code blocks become SVG diagrams, rendered here with pele (the
// Markdown copies keep the source).
// ASSEMBLED and THEME_DIR let the preview build use this shell from elsewhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "pele";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const assembled = path.resolve(process.env.ASSEMBLED ?? path.join(site, "../build/assembled"));
const themeDir = path.resolve(process.env.THEME_DIR ?? path.join(site, "../theme"));
const docsDir = path.join(site, "src/content/docs");
const barrel = path.join(site, "src/components/contract/index.ts");
const names = [...fs.readFileSync(barrel, "utf8").matchAll(/as (\w+) \}/g)].map((m) => m[1]);

fs.rmSync(docsDir, { recursive: true, force: true });
fs.cpSync(path.join(assembled, "content"), docsDir, { recursive: true });

const nav = JSON.parse(fs.readFileSync(path.join(assembled, "nav.json"), "utf8"));
const pages = JSON.parse(fs.readFileSync(path.join(assembled, "pages.json"), "utf8"));
const byFile = new Map(pages.map((p) => [p.file, p]));
const href = (slug) => nav.base + (slug ? slug + "/" : "");
const latestHref = (p) => {
  const d = nav.docsets[p.source];
  const v = d.versions.find((x) => x.name === d.latest);
  return href(v.pages.includes(p.key) ? [v.prefix, p.key].filter(Boolean).join("/") : v.first);
};
const str = (v) => JSON.stringify(v);

let diagrams = 0;
const failed = [];
/** Replaces ```mermaid blocks with SVG; a diagram that fails stays a code block. */
function mermaid(body, file, mdx) {
  return body.replace(/^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (block, source) => {
    try {
      const { svg } = render(source, { idPrefix: `d${diagrams}-`, fontFamily: "Geist, sans-serif" });
      diagrams++;
      // .md pages take raw HTML (one line, so no blank line ends the block)
      return mdx ? `<Diagram svg={${str(svg)}} />` : `<div class="os-mermaid">${svg.replace(/\n/g, " ")}</div>`;
    } catch (e) {
      failed.push(`${file}: ${e.message.split("\n")[0]}`);
      return block;
    }
  });
}

for (const file of fs.readdirSync(docsDir, { recursive: true })) {
  if (!/\.mdx?$/.test(file)) continue;
  const abs = path.join(docsDir, file);
  const page = byFile.get(file.split(path.sep).join("/"));
  if (!page) throw new Error(`${file}: not in pages.json`);
  const src = fs.readFileSync(abs, "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing front matter`);
  let fm = m[1] + `\nslug: ${str(page.slug)}`;
  if (!page.source) fm += `\ntemplate: splash`;
  const d = page.source && nav.docsets[page.source];
  let banner;
  if (page.preview) {
    const pv = nav.preview;
    banner = `Preview of ${pv.repo} (${pv.ref}). Only ${d.title} is built here; links to other docs open the <a href="${nav.site}/">live site</a>.`;
    if (pv.diff) {
      const removed = pv.diff.removed.length ? ` Removed pages: ${pv.diff.removed.join(", ")}.` : "";
      banner = `Changes against ${pv.diff.base}: <span class="os-diff-key os-diff-key--added">added</span> <span class="os-diff-key os-diff-key--removed">removed</span>. Changed pages: ${pv.diff.changed}, new: ${pv.diff.added} (marked in the sidebar).${removed}`;
    }
  } else if (page.dev && !page.latest) {
    banner = `These docs are for the development version. <a href="${latestHref(page)}">Go to the latest released version (${d.latest})</a>.`;
  } else if (page.source && !page.latest) {
    banner = `You are viewing ${d.title} ${page.version}. The latest version is ${d.latest}. <a href="${latestHref(page)}">Go to the latest version</a>.`;
  }
  if (banner) fm += `\npagefind: false\nbanner:\n  content: ${str(banner)}`;
  const mdx = file.endsWith(".mdx");
  const raw = src.slice(m[0].length);
  let body = mermaid(raw, file, mdx);
  if (mdx) {
    const imp = (to) => {
      const rel = path.relative(path.dirname(abs), to).split(path.sep).join("/");
      return rel.startsWith(".") ? rel : "./" + rel;
    };
    const diagram = body !== raw ? `import Diagram from "${imp(path.join(site, "src/components/Diagram.astro"))}";\n` : "";
    body = `import { ${names.join(", ")} } from "${imp(barrel)}";\n${diagram}\n${body}`;
  }
  fs.writeFileSync(abs, `---\n${fm}\n---\n${body}`);
}

fs.mkdirSync(path.join(site, "src/generated"), { recursive: true });
for (const f of ["nav.json", "pages.json"]) fs.copyFileSync(path.join(assembled, f), path.join(site, "src/generated", f));

const pub = path.join(site, "public");
fs.rmSync(pub, { recursive: true, force: true });
fs.cpSync(path.join(site, "static"), pub, { recursive: true });
fs.cpSync(path.join(assembled, "public"), pub, { recursive: true });

fs.copyFileSync(path.join(themeDir, "tokens.css"), path.join(site, "src/styles/tokens.css"));
for (const f of failed) console.warn(`warning: diagram left as code: ${f}`);
console.log(`synced ${pages.length} pages, ${diagrams} diagrams and ${names.length} components (base ${nav.base})`);
