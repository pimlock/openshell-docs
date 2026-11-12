// Read a docs checkout in whatever format that ref uses, and return one shape:
//
//   { format, meta: { title?, description?, redirects },
//     nav:    [{ type: "page", key, label } | { type: "group", label, items } | { type: "link", label, href }],
//     pages:  [{ relPath, key, label, data, body, ext }],   // only pages in the nav
//     assets: [relPath] }                                    // everything that isn't a page
//
// `key` is the page's URL inside its release ("" for the release's home page).
// It's what root-relative links (/how-it-works/x) and repo:// links name.
//
// Formats:
//   native  docset.yml + MDX (pages named by file path)
//   fern    Fern's index.yml + MDX (pages named by Fern's slug rules), so
//           tags cut before the move build unchanged
//   mdbook  SUMMARY.md + Markdown (pages named by file path)
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const posix = (p) => p.split(path.sep).join("/");
export const join = (...p) => p.filter(Boolean).join("/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const pageKey = (rel) => {
  let p = rel.replace(/\.mdx?$/, "");
  if (p === "index" || p === "README") p = "";
  return p.replace(/\/(index|README)$/, "");
};
export const parseFrontmatter = (src) => {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { data: YAML.parse(m[1]) ?? {}, body: src.slice(m[0].length) } : { data: {}, body: src };
};
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function detect(dir) {
  if (fs.existsSync(path.join(dir, "docset.yml"))) return "native";
  if (fs.existsSync(path.join(dir, "index.yml"))) return "fern";
  if (fs.existsSync(path.join(dir, "SUMMARY.md"))) return "mdbook";
  throw new Error(`${dir}: no docset.yml, index.yml or SUMMARY.md`);
}

export function read(dir, problems) {
  const format = detect(dir);
  const out = { native, fern, mdbook }[format](dir, problems);
  const pageFiles = new Set(out.pages.map((p) => p.relPath));
  const skip = (rel) =>
    pageFiles.has(rel) || /(^|\/)(_|\.)/.test(rel) || /\.(mdx?|ya?ml|toml|tsx?|jsx?)$/.test(rel);
  out.assets = walk(dir).map((f) => posix(path.relative(dir, f))).filter((r) => !skip(r));
  return { format, ...out };
}

function loadPage(dir, relPath, key, label) {
  const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, relPath), "utf8"));
  return { relPath, key, label, data, body, ext: path.extname(relPath).slice(1) };
}

// ---------- native: docset.yml ----------
function native(dir, problems) {
  const docset = YAML.parse(fs.readFileSync(path.join(dir, "docset.yml"), "utf8"));
  const pages = [];
  const items = (list) =>
    list.map((it) => {
      if (it.section) return { type: "group", label: it.section, items: items(it.items ?? []) };
      if (it.link) return { type: "link", label: it.link, href: it.href };
      if (!fs.existsSync(path.join(dir, it.page))) {
        problems.push(`docset.yml: nav references missing ${it.page}`);
        return null;
      }
      const page = loadPage(dir, it.page, pageKey(it.page));
      page.label = it.label ?? page.data["sidebar-title"] ?? page.data.title;
      pages.push(page);
      return { type: "page", key: page.key, label: page.label };
    }).filter(Boolean);
  const nav = items(docset.nav ?? []);
  return {
    meta: {
      title: docset.title,
      description: docset.description,
      redirects: Object.fromEntries(Object.entries(docset.redirects ?? {}).map(([a, b]) => [pageKey(a), pageKey(b)])),
    },
    nav,
    pages,
  };
}

// ---------- fern: index.yml ----------
// A page's URL is its sections' slugs plus its own slug (nav `slug`, else the
// slugified nav title). A `slug:` in the page's front matter replaces the
// whole path. `folder:` entries list a directory, ordered by `position`.
function fern(dir, problems) {
  const index = YAML.parse(fs.readFileSync(path.join(dir, "index.yml"), "utf8"));
  const pages = [];
  const add = (relPath, defaultKey, label) => {
    if (!fs.existsSync(path.join(dir, relPath))) {
      problems.push(`index.yml: nav references missing ${relPath}`);
      return null;
    }
    const page = loadPage(dir, relPath, "", label);
    page.key = page.data.slug ? String(page.data.slug).replace(/^\/|\/$/g, "") : defaultKey;
    page.label = label ?? page.data["sidebar-title"] ?? page.data.title;
    pages.push(page);
    return { type: "page", key: page.key, label: page.label };
  };
  const folder = (rel, prefix) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    const found = [];
    for (const e of entries) {
      const r = join(rel, e.name);
      if (e.isDirectory())
        found.push({ order: Infinity, title: e.name, node: () => ({ type: "group", label: e.name, items: folder(r, join(prefix, slugify(e.name))) }) });
      else if (/\.mdx?$/.test(e.name)) {
        const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, r), "utf8"));
        const isIndex = /^index\.mdx?$/.test(e.name);
        found.push({
          order: isIndex ? -Infinity : (data.position ?? Infinity),
          title: data.title ?? e.name,
          node: () => add(r, isIndex ? prefix : join(prefix, slugify(e.name.replace(/\.mdx?$/, "")))),
        });
      }
    }
    return found
      .sort((a, b) => a.order - b.order || String(a.title).localeCompare(String(b.title)))
      .map((f) => f.node())
      .filter(Boolean);
  };
  const items = (list, prefix) =>
    (list ?? []).flatMap((it) => {
      if (it.hidden) return [];
      if (it.section) {
        const p = join(prefix, it.slug ?? slugify(it.section));
        const overview = it.path ? [add(it.path, p, "Overview")] : [];
        return [{ type: "group", label: it.section, items: [...overview, ...items(it.contents, p)].filter(Boolean) }];
      }
      if (it.folder) {
        const p = join(prefix, it.slug ?? slugify(it.title ?? path.basename(it.folder)));
        return [{ type: "group", label: it.title ?? it.folder, items: folder(it.folder.replace(/^\.\//, ""), p) }];
      }
      if (it.page && it.path) return [add(it.path, join(prefix, it.slug ?? slugify(it.page)), it.page)].filter(Boolean);
      if (it.link) return [{ type: "link", label: it.link, href: it.href }];
      problems.push(`index.yml: unsupported nav entry ${JSON.stringify(it)}`);
      return [];
    });
  // Fern serves a section's URL even without an overview page; send it to the section's first page
  const redirects = {};
  const sectionRedirects = (list) => {
    for (const it of list) {
      if (it.type !== "group") continue;
      sectionRedirects(it.items);
      const first = it.items.find((x) => x.type === "page");
      const prefix = first?.key.includes("/") ? first.key.slice(0, first.key.lastIndexOf("/")) : null;
      if (prefix && !pages.some((p) => p.key === prefix)) redirects[prefix] ??= first.key;
    }
  };
  const home = index["landing-page"]?.path ? [add(index["landing-page"].path, "", index["landing-page"].page)] : [];
  const nav = [...home.filter(Boolean), ...items(index.navigation, "")];
  sectionRedirects(nav);
  return { meta: { redirects }, nav, pages };
}

// ---------- mdbook: SUMMARY.md ----------
// `# Part` headings become groups; `- [Title](file.md)` list items are pages,
// and nested lists become groups headed by their parent page.
function mdbook(dir, problems) {
  const pages = [];
  const root = [];
  let part = root;
  const stack = []; // [{ indent, list }]
  const add = (title, file) => {
    if (!file) return null; // draft chapter
    if (!fs.existsSync(path.join(dir, file))) {
      problems.push(`SUMMARY.md: missing ${file}`);
      return null;
    }
    const page = loadPage(dir, file, pageKey(file), title);
    // the title is rendered by the site; drop the page's own H1
    page.body = page.body.replace(/^\s*# .*\n+/, "");
    page.data.title ??= title;
    pages.push(page);
    return { type: "page", key: page.key, label: title };
  };
  for (const line of fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf8").split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (heading[1].trim() === "Summary") continue;
      part = [];
      root.push({ type: "group", label: heading[1].trim(), items: part });
      stack.length = 0;
      continue;
    }
    const item = line.match(/^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]*)\)/);
    const prefix = !item && line.match(/^\[([^\]]+)\]\(([^)]*)\)/);
    if (prefix) {
      const n = add(prefix[1], prefix[2]);
      if (n) part.push(n);
      continue;
    }
    if (!item) continue;
    const indent = item[1].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const list = stack.length ? stack.at(-1).list : part;
    const n = add(item[2], item[3]);
    if (!n) continue;
    list.push(n);
    // children (if any) go into a group headed by this page
    const children = [];
    stack.push({ indent, list: children, parent: { list, node: n } });
    Object.defineProperty(n, "_children", { value: children });
  }
  const nest = (items) =>
    items.map((it) => {
      if (it.type === "group") return { ...it, items: nest(it.items) };
      if (it._children?.length) return { type: "group", label: it.label, items: [{ ...it, label: "Overview" }, ...nest(it._children)] };
      return it;
    });
  return { meta: { redirects: {} }, nav: nest(root), pages };
}
