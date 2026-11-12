#!/usr/bin/env node
// Assemble the OpenShell docs from several repos.
//
// Full build (reads sources.yml):
//   node assembler/assemble.mjs [--base /openshell-docs/] [--local core=../OpenShell]
//
//   1. Resolves every listed ref (release tags, plus each source's `dev`
//      branch) to a commit and fetches only the docs directory at that commit
//      (cached by commit in .cache/sources/). Nothing is copied into this repo.
//   2. Reads each checkout in its own format (adapters.mjs): native
//      docset.yml, Fern index.yml or mdBook SUMMARY.md.
//   3. Publishes each (source, version) under /<mount>/<version>/, rewrites
//      and checks every link, and writes the site inputs, Markdown for
//      agents, llms.txt, the host's alias table and the public link index.
//
// Links: root-relative links (/how-it-works/x) stay in their release.
// repo://path links (core://about/installation) go to the target's latest
// release, or to its dev version from a dev page. Problems in versions that
// can still change (dev, previews) fail the build. Problems in a published
// release only warn, and the link falls back to the release's first page:
// a release is frozen, so it must never block the build.
//
// Preview build (one repo, no access to the others):
//   node assembler/assemble.mjs --preview driver-docker --path <checkout> \
//     --index <site>/links.json --site <site url> [--ref pr-12]
//
// Everything outside the previewed repo comes from the published links.json.
// Links into other repos are checked against it and point at the live site.
// Pages that other repos link to must survive the change, or be listed under
// `redirects:` in docset.yml.
//
// Output (build/assembled/):
//   content/**        pages for the site generator
//   public/**         assets, Markdown pages (<slug>.md), llms.txt,
//                     versions.json, links.json
//   nav.json          topics, docsets, versions and each version's sidebar
//   pages.json        every page with its docset and version
//   sources.lock.json the commit each version was built from

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import GithubSlugger from "github-slugger";
import { checkout } from "./fetch.mjs";
import { join, pageKey, parseFrontmatter, read } from "./adapters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const argv = process.argv.slice(2);
const args = {};
const locals = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1];
  if (k === "local") {
    const [id, p] = v.split("=");
    locals[id] = path.resolve(p);
  } else args[k] = v;
  i++;
}
const PREVIEW = args.preview;
const out = path.resolve(args.out ?? path.join(root, "build", PREVIEW ? "preview" : "assembled"));
const cache = path.resolve(args.cache ?? path.join(root, ".cache/sources"));
const BASE = ("/" + (args.base ?? process.env.BASE_PATH ?? "/") + "/").replace(/\/+/g, "/");
const url = (slug, hash = "") => `${BASE}${slug ? slug + "/" : ""}${hash}`;
// a page on the live site (preview builds link there for other repos)
const liveUrl = (slug, hash = "") => `${SITE}/${slug ? slug + "/" : ""}${hash}`;
const errors = [];
const warnings = [];
fs.rmSync(out, { recursive: true, force: true });

// ---------- 0. what to build ----------
let index = null;
if (PREVIEW) {
  for (const k of ["path", "index", "site"]) if (!args[k]) throw new Error(`--preview needs --${k}`);
  index = /^https?:/.test(args.index)
    ? await (await fetch(args.index)).json()
    : JSON.parse(fs.readFileSync(args.index, "utf8"));
  if (!index.docsets[PREVIEW]) throw new Error(`${PREVIEW} is not in the published index`);
}
const SITE = (args.site ?? "").replace(/\/$/, "");
const manifest = PREVIEW
  ? {
      site: { title: index.title },
      topics: index.topics,
      sources: {
        [PREVIEW]: {
          ...index.docsets[PREVIEW],
          versions: [],
          dev: { ref: args.ref ?? "working tree", local: path.resolve(args.path) },
        },
      },
    }
  : YAML.parse(fs.readFileSync(path.join(root, "sources.yml"), "utf8"));
const allIds = PREVIEW ? Object.keys(index.docsets) : Object.keys(manifest.sources);

// One entry per (source, version). dev (if any) first, then releases newest first.
const wanted = [];
for (const [id, src] of Object.entries(manifest.sources)) {
  if (src.dev) {
    const local = src.dev.local ?? locals[id];
    wanted.push({ id, src, name: "dev", dev: true, repo: src.dev.repo ?? src.repo, ref: src.dev.ref, subdir: src.dev.path ?? src.path, local });
  }
  for (const v of src.versions)
    wanted.push({ id, src, name: v.name ?? v.ref.replace(/^v/, ""), dev: false, repo: v.repo ?? src.repo, ref: v.ref, subdir: v.path ?? src.path });
}

// ---------- 1. fetch ----------
const t0 = Date.now();
await Promise.all(
  wanted.map(async (w) => {
    if (w.local) {
      w.dir = path.join(w.local, w.subdir);
      w.sha = "working-tree";
    } else Object.assign(w, await checkout(w, cache));
  }),
);
console.log(`fetched ${wanted.length} versions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- 2. read ----------
const parserMdx = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(remarkFrontmatter);
const parserMd = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
const textOf = (n) => (n.type === "text" || n.type === "inlineCode" ? n.value : (n.children ?? []).map(textOf).join(""));
// Apply fn to the parts of a page outside code (fenced blocks and inline code).
const outsideCode = (body, fn) =>
  body
    .split(/(^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$|`[^`\n]+`)/m)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");
// Heading ids, as Astro/Starlight generate them (github-slugger).
function anchorsOf(body, ext) {
  const slugger = new GithubSlugger();
  const ids = [];
  try {
    visit((ext === "md" ? parserMd : parserMdx).parse(body), "heading", (h) => {
      ids.push(slugger.slug(textOf(h)));
    });
  } catch {
    for (const m of body.matchAll(/^#{1,6}\s+(.*)$/gm)) ids.push(slugger.slug(m[1].replace(/`/g, "")));
  }
  return ids;
}

const releases = [];
const releasesOf = Object.fromEntries(allIds.map((id) => [id, []]));
const pages = [];
const strict = (rel) => !!(PREVIEW || rel.dev || rel.strict);
const report = (rel, msg) => (strict(rel) ? errors : warnings).push(`${rel.name}: ${msg}`);
for (const w of wanted) {
  const name = `${w.id}@${w.name}`;
  const problems = [];
  let docs;
  try {
    docs = read(w.dir, problems);
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    continue;
  }
  const rel = {
    id: w.id, version: w.name, dev: w.dev, ref: w.ref, sha: w.sha, repo: w.repo, path: w.subdir,
    mount: w.src.mount, prefix: join(w.src.mount, w.name), name, format: docs.format,
    title: docs.meta.title ?? w.src.title ?? w.id,
    description: docs.meta.description ?? w.src.description,
    redirects: docs.meta.redirects ?? {}, nav: docs.nav, pages: [], assets: new Set(docs.assets),
    preview: !!PREVIEW,
  };
  problems.forEach((p) => report(rel, p));
  const seen = new Set();
  for (const p of docs.pages) {
    if (seen.has(p.key)) {
      report(rel, `two pages publish at "${p.key}"; keeping the first`);
      continue;
    }
    seen.add(p.key);
    // Fern's custom heading ids ("## Title {#id}") aren't MDX: keep the id as an anchor
    const ids = [];
    p.body = outsideCode(p.body, (part) =>
      part.replace(/^(#{1,6}\s.*?)\s*\{#([\w-]+)\}\s*$/gm, (_, h, id) => (ids.push(id), `${h} <a id="${id}"></a>`)),
    );
    const page = { ...p, rel, slug: join(rel.prefix, p.key), anchors: [...anchorsOf(p.body, p.ext), ...ids] };
    page.data.title ??= p.label ?? p.key;
    pages.push(page);
    rel.pages.push(page);
  }
  for (const a of rel.assets) {
    const dest = path.join(out, "public", rel.prefix, a);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(w.dir, a), dest);
  }
  releases.push(rel);
  releasesOf[w.id].push(rel);
}
// latest = the newest release; a docset with only a dev version uses dev.
// (A preview is never latest: the published index says which release is.)
if (!PREVIEW) for (const id of Object.keys(manifest.sources)) {
  const first = releasesOf[id].find((r) => !r.dev) ?? releasesOf[id][0];
  if (first) first.latest = true;
}
const bySlug = new Map(pages.map((p) => [p.slug, p]));

// Releases known only from the published index (preview mode): page keys,
// titles and anchors, never content. The previewed docset's own published
// dev is replaced by the preview.
const remoteSlugs = new Map();
if (PREVIEW) {
  for (const [id, d] of Object.entries(index.docsets)) {
    for (const v of d.versions) {
      if (id === PREVIEW && v.dev) continue;
      const rel = {
        id, version: v.name, dev: !!v.dev, ref: v.ref, sha: v.sha, repo: d.repo, mount: d.mount, latest: v.name === d.latest,
        prefix: v.prefix, name: `${id}@${v.name}`, remote: true, redirects: v.redirects ?? {}, pageInfo: v.pages, first: v.first,
        title: d.title, description: d.description,
      };
      releasesOf[id].push(rel);
      for (const [key, info] of Object.entries(v.pages)) remoteSlugs.set(join(v.prefix, key), info);
    }
    releasesOf[id].sort((a, b) => Number(b.dev) - Number(a.dev)); // dev first, then releases as published
  }
}
const target = (slug) => bySlug.get(slug) ?? remoteSlugs.get(slug);
const latestOf = (id) => releasesOf[id].find((r) => r.latest) ?? releasesOf[id][0];
const devOf = (id) => releasesOf[id].find((r) => r.dev);

// ---------- 3. links ----------
const crossLinks = [];
function firstOf(rel) {
  if (rel.remote) return rel.first;
  const walkNav = (items) => {
    for (const it of items) {
      if (it.type === "page") return join(rel.prefix, it.key);
      const s = it.items && walkNav(it.items);
      if (s !== undefined) return s;
    }
  };
  return walkNav(rel.nav) ?? rel.prefix;
}
function checked(slug, anchor, original, page, rel) {
  const t = target(slug);
  const link = rel.remote ? liveUrl : url;
  const soft = !strict(page.rel);
  if (!t) {
    const msg = `${page.relPath}: broken link "${original}" -> /${slug}`;
    if (!soft) return errors.push(`${page.rel.name}: ${msg}`), original;
    warnings.push(`${page.rel.name}: ${msg}; using the first page of ${rel.name}`);
    return link(firstOf(rel));
  }
  if (anchor && !t.anchors.includes(anchor)) {
    const msg = `${page.relPath}: missing heading "${original}" -> /${slug}#${anchor}`;
    if (!soft) errors.push(`${page.rel.name}: ${msg}`);
    else warnings.push(`${page.rel.name}: ${msg}; linking the page`);
    return link(slug);
  }
  return link(slug, anchor ? `#${anchor}` : "");
}
function resolveLink(raw, page) {
  if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(raw)) return raw;
  const [p, anchor] = raw.split("#");
  const rel = page.rel;
  const scheme = p.match(/^([a-z0-9-]+):\/\/(.*)$/);
  if (scheme) {
    const [, id, rest] = scheme;
    if (!releasesOf[id]?.length) {
      report(rel, `${page.relPath}: unknown docset in "${raw}"`);
      return raw;
    }
    const t = id === rel.id ? rel : (rel.dev && devOf(id)) || latestOf(id);
    const key = t.redirects?.[pageKey(rest)] ?? pageKey(rest);
    crossLinks.push({ from: { docset: rel.id, version: rel.version, page: page.key }, to: { docset: id, version: t.version, key, ...(anchor ? { anchor } : {}) } });
    return checked(join(t.prefix, key), anchor, raw, page, t);
  }
  if (p.startsWith("/")) {
    const key = pageKey(p.slice(1).replace(/\/$/, ""));
    return checked(join(rel.prefix, rel.redirects[key] ?? key), anchor, raw, page, rel);
  }
  if (!p) return raw;
  // relative to the page's file
  const abs = path.posix.normalize(path.posix.join(path.posix.dirname(page.relPath), p));
  if (!/\.mdx?$/.test(abs) && /\.[a-z0-9]+$/i.test(abs)) {
    if (!rel.assets.has(abs)) report(rel, `${page.relPath}: missing file "${raw}"`);
    return BASE + join(rel.prefix, abs);
  }
  const byFile = rel.pages.find((x) => x.relPath.replace(/\.mdx?$/, "") === abs.replace(/\.mdx?$/, ""));
  return checked(join(rel.prefix, byFile ? byFile.key : pageKey(abs)), anchor, raw, page, rel);
}
const rewrite = (body, fn) =>
  outsideCode(body, (part) =>
    part
      .replace(/\]\(([^)\s*\[\]{}]+)\)/g, (_, t) => `](${fn(t)})`)
      .replace(/\b(href|src)="([^"]+)"/g, (_, a, t) => `${a}="${fn(t)}"`),
  );
for (const page of pages) page.body = rewrite(page.body, (t) => resolveLink(t, page));

// ---------- 4. site content ----------
// <llms-only> blocks exist only in the Markdown output; <llms-ignore> only on the site.
const siteBody = (body) =>
  body
    .replace(/<llms-only>[\s\S]*?<\/llms-only>\n?/g, "")
    .replace(/<\/?llms-ignore>\n?/g, "")
    // Fern-era pages import their custom components; the site provides them
    .replace(/^import\s+[^;\n]*from\s+["']\.[^"']*_components[^"']*["'];?\s*$/gm, "");
const writeFile = (rel, text) => {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
};
for (const page of pages) {
  const { rel } = page;
  const fm = {
    title: String(page.data.title),
    description: page.data.description,
    docset: rel.id,
    version: rel.version,
    source: `${rel.repo}@${rel.ref} (${String(rel.sha).slice(0, 12)}):${rel.path}/${page.relPath}`,
  };
  Object.keys(fm).forEach((k) => fm[k] === undefined && delete fm[k]);
  page.outRel = (page.key ? page.slug : join(rel.prefix, "index")) + "." + page.ext;
  writeFile(path.join("content", page.outRel), `---\n${YAML.stringify(fm)}---\n${siteBody(page.body)}`);
}

// ---------- 5. nav.json + pages.json ----------
const navItems = (items, rel) =>
  items.map((it) =>
    it.type === "group"
      ? { type: "group", label: it.label, items: navItems(it.items, rel) }
      : it.type === "link"
        ? { type: "link", label: it.label, href: it.href }
        : { type: "page", label: it.label, slug: join(rel.prefix, it.key) },
  );
const versionEntry = (rel) => ({
  name: rel.version, ref: rel.ref, sha: rel.sha, prefix: rel.prefix, latest: !!rel.latest, dev: !!rel.dev,
  first: firstOf(rel),
  pages: rel.remote ? Object.keys(rel.pageInfo) : rel.pages.map((p) => p.key),
  items: rel.remote ? [] : navItems(rel.nav, rel),
  ...(rel.remote ? { remote: true } : {}),
  ...(rel.preview ? { preview: true } : {}),
});
const docsets = {};
for (const id of allIds) {
  const rels = releasesOf[id];
  if (!rels.length) continue;
  const latest = latestOf(id);
  docsets[id] = {
    title: latest.title, description: latest.description, mount: latest.mount, repo: rels[0].repo,
    path: manifest.sources[id]?.path ?? index?.docsets[id]?.path,
    latest: latest.version, versions: rels.map(versionEntry),
  };
}

// Topic overview pages (/sdks/, /drivers/): an optional hand-written intro
// from the site repo, then one card per docset linking its latest release.
const landings = [];
function introFor(t) {
  if (!t.intro) return "";
  const file = path.join(root, t.intro);
  if (!fs.existsSync(file)) return errors.push(`topic ${t.id}: intro ${t.intro} not found`), "";
  const page = { rel: { id: "site", version: "topics", name: `topic ${t.id}`, strict: true, redirects: {} }, relPath: t.intro, key: t.id };
  return rewrite(parseFrontmatter(fs.readFileSync(file, "utf8")).body.trim(), (x) => {
    if (/^(https?:|mailto:|#)/.test(x)) return x;
    if (!/^[a-z0-9-]+:\/\//.test(x)) return errors.push(`${t.intro}: link "${x}" must be a repo:// link`), x;
    return resolveLink(x, page);
  });
}
if (!PREVIEW) {
  for (const t of manifest.topics) {
    if (t.sources.length < 2) continue;
    const intro = introFor(t);
    const cards = t.sources.map((id) => {
      const d = docsets[id];
      const latest = d.versions.find((v) => v.name === d.latest);
      return `<Card title="${d.title}" href="${url(latest.first)}">\n\n${d.description ?? ""}\n\nLatest: ${latest.name}\n\n</Card>`;
    });
    const body = [
      ...(intro ? [intro, `## Available ${/^[A-Z][a-z]/.test(t.label) ? t.label.toLowerCase() : t.label}`] : []),
      `<Cards>\n\n${cards.join("\n\n")}\n\n</Cards>`,
    ].join("\n\n");
    const outRel = `${t.id}/index.mdx`;
    writeFile(path.join("content", outRel), `---\n${YAML.stringify({ title: t.label, description: t.description })}---\n${body}\n`);
    landings.push({ topic: t.id, slug: t.id, outRel, title: t.label, description: t.description, body });
  }
}
const landingOf = (t) => (PREVIEW ? index.topics.find((x) => x.id === t.id)?.landing : landings.find((l) => l.topic === t.id)?.slug);
const local = releases;
const nav = {
  title: manifest.site.title,
  base: BASE,
  ...(PREVIEW ? { site: SITE, preview: { docset: PREVIEW, repo: local[0]?.repo, ref: local[0]?.ref } } : {}),
  topics: manifest.topics.map((t) => ({ id: t.id, label: t.label, sources: t.sources, landing: landingOf(t) })),
  docsets,
};
writeFile("nav.json", JSON.stringify(nav, null, 2));
writeFile(
  "pages.json",
  JSON.stringify(
    pages
      .map((p) => ({
        slug: p.slug, file: p.outRel, title: p.data.title, source: p.rel.id, version: p.rel.version,
        latest: !!p.rel.latest, dev: !!p.rel.dev, key: p.key, ...(PREVIEW ? { preview: true } : {}),
      }))
      .concat(landings.map((l) => ({ slug: l.slug, file: l.outRel, title: l.title, source: null, topic: l.topic, latest: true, key: "" }))),
    null,
    2,
  ),
);
writeFile(
  "sources.lock.json",
  JSON.stringify(Object.fromEntries(local.map((r) => [r.name, { repo: r.repo, ref: r.ref, sha: r.sha, path: r.path, format: r.format }])), null, 2),
);

// ---------- 6. Markdown for agents ----------
const attr = (node, name) => {
  const a = node.attributes?.find((x) => x.name === name);
  if (!a) return undefined;
  if (a.value === null) return true;
  return typeof a.value === "string" ? a.value : a.value?.value;
};
const text = (value) => ({ type: "text", value });
const strong = (...children) => ({ type: "strong", children });
const para = (...children) => ({ type: "paragraph", children });
const CALLOUTS = { Note: "Note", Tip: "Tip", Info: "Info", Warning: "Warning", Error: "Danger", Check: "Check" };
function convert(node, where) {
  if (!node.children) return [node];
  node.children = node.children.flatMap((c) => convert(c, where));
  if (node.type === "mdxjsEsm" || node.type === "mdxFlowExpression") return [];
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return [node];
  const kids = node.children;
  if (CALLOUTS[node.name]) {
    const title = attr(node, "title");
    const label = strong(text(title ? `${CALLOUTS[node.name]}: ${title}` : `${CALLOUTS[node.name]}:`));
    const [first, ...rest] = kids;
    return [{ type: "blockquote", children: first?.type === "paragraph" ? [para(label, text(" "), ...first.children), ...rest] : [para(label), ...kids] }];
  }
  switch (node.name) {
    case "Tabs": case "Steps": case "AccordionGroup": case "llms-only": case "div": case "span":
      return kids;
    case "Tab": case "Accordion":
      return [para(strong(text(attr(node, "title") ?? ""))), ...kids];
    case "Cards":
      return [{ type: "list", ordered: false, spread: false, children: kids.filter((k) => k.type === "listItem") }];
    case "Card": {
      const desc = kids.filter((k) => k.type === "paragraph").map(textOf).join(" ").trim();
      const link = { type: "link", url: attr(node, "href") ?? "#", children: [text(attr(node, "title") ?? "")] };
      return [{ type: "listItem", spread: false, children: [para(link, ...(desc ? [text(`: ${desc}`)] : []))] }];
    }
    case "Badge":
      return node.type === "mdxJsxTextElement" ? [text(`[${textOf(node)}]`)] : [para(text(`[${textOf(node)}]`))];
    case "ParamField": {
      const meta = [];
      const push = (...n) => meta.push(...(meta.length ? [text(", ")] : []), ...n);
      if (attr(node, "type")) push({ type: "inlineCode", value: attr(node, "type") });
      if (attr(node, "default")) push(text("default "), { type: "inlineCode", value: attr(node, "default") });
      if (attr(node, "required")) push(text("required"));
      return [para(strong({ type: "inlineCode", value: attr(node, "path") ?? "" }), ...(meta.length ? [text(" ("), ...meta, text(")")] : [])), ...kids];
    }
    case "CommandTerminal":
      return [{ type: "code", lang: "shell", value: attr(node, "command") ?? "" }];
    case "a": // anchors kept from Fern heading ids carry no text
      return attr(node, "href") ? [{ type: "link", url: attr(node, "href"), children: kids }] : kids;
    case "BadgeLinks": case "llms-ignore":
      return [];
    default:
      warnings.push(`${where}: no Markdown mapping for <${node.name}>`);
      return kids;
  }
}
const stringify = { bullet: "-", fences: true, rule: "-" };
const mdx2md = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(remarkFrontmatter).use(remarkStringify, stringify);
const md2md = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkStringify, stringify);
const mdUrl = (slug) => `${BASE}${slug}.md`;
const toMarkdown = (body, ext, where) => {
  const proc = ext === "md" ? md2md : mdx2md;
  try {
    const tree = proc.parse(body);
    convert(tree, where);
    return proc.stringify(tree);
  } catch (e) {
    warnings.push(`${where}: Markdown conversion failed (${e.message.split("\n")[0]}); publishing the source`);
    return body;
  }
};
for (const page of pages) {
  const { rel } = page;
  const latest = latestOf(rel.id);
  const latestEntry = docsets[rel.id].versions.find((v) => v.name === latest.version);
  const latestSlug = latestEntry.pages.includes(page.key) ? join(latest.prefix, page.key) : latestEntry.first;
  const latestMd = latest.remote ? `${SITE}/${latestSlug}.md` : mdUrl(latestSlug);
  const status = PREVIEW
    ? `> Preview build of ${rel.repo} (${rel.ref}); not published. Published version (${latest.version}): ${latestMd}`
    : rel.dev && !rel.latest ? `> Unreleased docs from ${rel.repo}@${rel.ref}. Latest release (${latest.version}): ${latestMd}`
      : rel.latest ? null : `> This is not the latest version. Latest (${latest.version}): ${latestMd}`;
  const header = [
    "---",
    YAML.stringify({
      title: page.data.title, description: page.data.description, url: url(page.slug), docset: rel.id,
      version: rel.version, latest_version: latest.version, source: `${rel.repo}@${rel.ref}:${rel.path}/${page.relPath}`,
    }).trim(),
    "---",
    "",
    `> Documentation index: ${BASE}${rel.prefix}/llms.txt. This page is for ${rel.title} ${rel.version}.`,
    ...(status ? [status] : []),
    "",
    `# ${page.data.title}`,
    "",
    "",
  ].join("\n");
  writeFile(path.join("public", page.slug + ".md"), header + toMarkdown(page.body, page.ext, `${rel.name}/${page.relPath}`));
}
for (const l of landings) {
  const header = ["---", YAML.stringify({ title: l.title, description: l.description, url: url(l.slug) }).trim(), "---", "", `> Documentation index: ${BASE}llms.txt.`, "", `# ${l.title}`, "", ""].join("\n");
  writeFile(path.join("public", l.slug + ".md"), header + toMarkdown(l.body, "mdx", l.outRel));
}

// ---------- 7. llms.txt, versions.json, links.json ----------
const entry = (p) => `- [${p.data.title}](${mdUrl(p.slug)})${p.data.description ? `: ${p.data.description}` : ""}`;
const llms = [`# ${manifest.site.title}`, ""];
if (PREVIEW) {
  const rel = local[0];
  llms.push(`> Preview of ${rel.title} from ${rel.repo} (${rel.ref}). Only this docset is built here; the rest is at ${SITE}/llms.txt.`, "", ...rel.pages.map(entry), "");
} else {
  llms.push("> Each section lists the latest release of one docset; other versions follow it. Every page is also available as Markdown at its URL plus .md.", "");
  for (const t of manifest.topics) {
    llms.push(`## ${t.label}`, "");
    for (const id of t.sources) {
      const latest = latestOf(id);
      llms.push(`### ${latest.title} ${latest.version}`, "", ...latest.pages.map(entry), "");
      const others = releasesOf[id].filter((r) => r !== latest);
      if (others.length) llms.push(`Other versions: ${others.map((r) => `[${r.version}](${BASE}${r.prefix}/llms.txt)`).join(", ")}`, "");
    }
  }
}
writeFile("public/llms.txt", llms.join("\n"));
for (const rel of local) writeFile(path.join("public", rel.prefix, "llms.txt"), [`# ${rel.title} ${rel.version}`, "", ...rel.pages.map(entry), ""].join("\n"));

// Alias table for the host: /<mount>/latest/<page> -> /<mount>/<newest>/<page>.
const hostIds = PREVIEW ? [PREVIEW] : Object.keys(docsets);
writeFile(
  "public/versions.json",
  JSON.stringify(
    {
      base: BASE,
      home: PREVIEW ? url(docsets[PREVIEW].versions.find((v) => !v.remote).first) : url(latestOf(manifest.topics[0].sources[0]).prefix),
      docsets: Object.fromEntries(
        hostIds.map((id) => {
          const d = docsets[id];
          const vs = d.versions.filter((v) => !v.remote);
          return [id, { mount: d.mount, latest: PREVIEW ? vs[0].name : d.latest, versions: vs.map((v) => ({ name: v.name, prefix: v.prefix, first: v.first, pages: v.pages })) }];
        }),
      ),
    },
    null,
    2,
  ),
);
// Public link index: all a preview build needs to know about the other repos.
if (!PREVIEW) {
  writeFile(
    "public/links.json",
    JSON.stringify(
      {
        title: manifest.site.title,
        generated: new Date().toISOString(),
        base: BASE,
        topics: nav.topics.map(({ id, label, sources, landing }) => ({ id, label, sources, landing })),
        docsets: Object.fromEntries(
          Object.entries(docsets).map(([id, d]) => [
            id,
            {
              title: d.title, description: d.description, mount: d.mount, repo: d.repo, path: d.path, latest: d.latest,
              versions: releasesOf[id].map((rel) => ({
                name: rel.version, ref: rel.ref, sha: rel.sha, dev: rel.dev, prefix: rel.prefix, first: firstOf(rel), redirects: rel.redirects,
                pages: Object.fromEntries(rel.pages.map((p) => [p.key, { title: p.data.title, anchors: p.anchors }])),
              })),
            },
          ]),
        ),
        links: crossLinks,
      },
      null,
      2,
    ),
  );
}

// Inbound guard (preview): pages and headings that other repos (or the
// site's topic pages) link to in this docset must still exist, or redirect.
if (PREVIEW) {
  const rel = local[0];
  const d = index.docsets[PREVIEW];
  const devName = d.versions.find((v) => v.dev)?.name;
  const byKey = new Map(rel.pages.map((p) => [p.key, p]));
  for (const l of index.links) {
    if (l.to.docset !== PREVIEW || l.from.docset === PREVIEW) continue;
    if (l.to.version !== devName && l.to.version !== d.latest) continue;
    const key = rel.redirects[l.to.key] ?? l.to.key;
    const page = byKey.get(key);
    const from = `${l.from.docset}@${l.from.version}/${l.from.page || "index"}`;
    if (!page) errors.push(`inbound: ${from} links to "${l.to.key}", which this change removes. Keep the page or add it to redirects: in docset.yml`);
    else if (l.to.anchor && !page.anchors.includes(l.to.anchor)) errors.push(`inbound: ${from} links to "${l.to.key}#${l.to.anchor}", and that heading no longer exists`);
  }
}

// ---------- report ----------
console.log(`assembled ${pages.length} pages from ${local.length} versions -> ${path.relative(process.cwd(), out)} (base ${BASE})`);
for (const rel of local) console.log(`  ${rel.name.padEnd(22)} ${rel.format.padEnd(7)} ${String(rel.sha).slice(0, 12)}  ${url(rel.prefix)}`);
if (warnings.length) console.warn(`\n${warnings.length} warning(s) (published releases never block the build):\n- ` + warnings.join("\n- "));
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n- ` + errors.join("\n- "));
  process.exit(1);
}
