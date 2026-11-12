// Experimental: mark what a pull request changed on each rendered page.
//
// Compares every page of a preview with the same page at the PR's base
// commit, block by block (paragraphs, headings, lists, code blocks,
// components). Added blocks are highlighted and removed blocks are shown
// muted, so the site renders the real page with its changes marked. A block
// is the smallest unit: a one-word edit marks the whole paragraph. Components
// whose opening tag is unchanged (<Steps>, <Tabs>, <Note>...) are compared
// inside, so an edit in one step doesn't mark the whole tutorial.
//
// Self-contained on purpose: the assembler calls diffRelease() only when it
// gets --diff-base, so removing this feature means deleting this file and
// that call.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";

const mdx = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const md = unified().use(remarkParse).use(remarkGfm);
const parse = (body, ext) => (ext === "md" ? md : mdx).parse(body).children;
const slice = (src, n) => src.slice(n.position.start.offset, n.position.end.offset);
const norm = (t) => t.replace(/\s+/g, " ").trim();
const wrap = (kind, text) => `<div class="os-diff os-diff--${kind}">\n\n${text}\n\n</div>`;

// A removed block must not add headings (TOC, anchors) or links that the
// build would check; keep its text only.
const removed = (text) =>
  text
    .replace(/\s*\{#[\w-]+\}/g, "")
    .replace(/^(#{1,6})\s+(.*)$/gm, "**$2**")
    .replace(/(!?)\[([^\]]*)\]\([^)]*\)/g, (_, img, label) => (img ? "" : label));

// A component compared inside: same element name and same opening tag.
const container = (n, src) =>
  n.type === "mdxJsxFlowElement" && n.children?.length
    ? { name: n.name, open: src.slice(n.position.start.offset, n.children[0].position.start.offset), close: src.slice(n.children.at(-1).position.end.offset, n.position.end.offset) }
    : null;

/** Returns [body with changes marked, whether anything changed]. */
function diffBlocks(head, hsrc, base, bsrc) {
  const h = head.map((n) => ({ n, text: slice(hsrc, n) }));
  const b = base.map((n) => ({ n, text: slice(bsrc, n) }));
  // longest common subsequence of blocks
  const L = Array.from({ length: h.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = h.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] = norm(h[i].text) === norm(b[j].text) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < h.length || j < b.length) {
    if (i < h.length && j < b.length && norm(h[i].text) === norm(b[j].text)) ops.push({ op: "same", ...h[i++] }), j++;
    else if (j < b.length && (i >= h.length || L[i][j + 1] >= L[i + 1][j])) ops.push({ op: "del", ...b[j++] });
    else ops.push({ op: "add", ...h[i++] });
  }
  // an edited component: compare inside instead of replacing it whole
  for (const [k, op] of ops.entries()) {
    if (op.op !== "add") continue;
    const c = container(op.n, hsrc);
    if (!c) continue;
    for (let d = k - 1; d >= 0 && ops[d].op !== "same"; d--) {
      const o = ops[d].op === "del" && container(ops[d].n, bsrc);
      if (o && o.name === c.name && norm(o.open) === norm(c.open)) {
        const [inner] = diffBlocks(op.n.children, hsrc, ops[d].n.children, bsrc);
        Object.assign(op, { op: "nest", text: `${c.open.trimEnd()}\n\n${inner}\n\n${c.close.trimStart()}` });
        ops.splice(d, 1);
        break;
      }
    }
  }
  // Show each removed block right above the block that replaced it: within a
  // run of changes, interleave removals and additions in order.
  const ordered = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].op === "same" || ops[k].op === "nest") { ordered.push(ops[k++]); continue; }
    const run = [];
    while (k < ops.length && ops[k].op !== "same" && ops[k].op !== "nest") run.push(ops[k++]);
    const dels = run.filter((o) => o.op === "del");
    const adds = run.filter((o) => o.op === "add");
    for (let x = 0; x < Math.max(dels.length, adds.length); x++) ordered.push(...[dels[x], adds[x]].filter(Boolean));
  }
  ops.splice(0, ops.length, ...ordered);
  const changed = ops.some((o) => o.op !== "same");
  const out = ops.map((o) => (o.op === "add" ? wrap("added", o.text) : o.op === "del" ? wrap("removed", removed(o.text)) : o.text));
  return [out.join("\n\n"), changed];
}

/**
 * Marks changes in `rel`'s pages against `base` (adapters.read() of the base
 * checkout). `normalize` applies the same source fixes the assembler applies
 * to head pages. Sets page.diff ("added" | "changed") and returns a summary.
 */
export function diffRelease(rel, base, normalize, problems) {
  const before = new Map(base.pages.map((p) => [p.key, p]));
  const summary = { added: [], changed: [], removed: [] };
  for (const page of rel.pages) {
    const old = before.get(page.key);
    before.delete(page.key);
    if (!old) {
      page.diff = "added";
      summary.added.push({ key: page.key, slug: page.slug, title: page.data.title });
      continue;
    }
    try {
      const oldBody = normalize(old.body);
      const [body, changed] = diffBlocks(parse(page.body, page.ext), page.body, parse(oldBody, old.ext), oldBody);
      if (!changed) continue;
      page.body = body;
      page.diff = "changed";
      summary.changed.push({ key: page.key, slug: page.slug, title: page.data.title });
    } catch (e) {
      problems.push(`${page.relPath}: diff skipped (${e.message.split("\n")[0]})`);
    }
  }
  for (const old of before.values()) summary.removed.push({ key: old.key, title: old.data.title ?? old.label ?? old.key });
  return summary;
}
