#!/usr/bin/env node
// Experimental diff view: the PR comment section listing changed pages.
// Usage: node diff-comment.mjs <diff.json> <preview url>
import fs from "node:fs";

const [file, previewUrl] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const base = `${previewUrl}diff/`;
const link = (p) => `[${p.title}](${base}${p.slug}/)`;
const lines = [`**Diff view** against \`${d.base}\` (experimental): ${base}`, ""];
if (d.changed.length) lines.push(`- Changed: ${d.changed.map(link).join(", ")}`);
if (d.added.length) lines.push(`- New: ${d.added.map(link).join(", ")}`);
if (d.removed.length) lines.push(`- Removed: ${d.removed.map((p) => p.title).join(", ")}`);
if (!d.changed.length && !d.added.length && !d.removed.length) lines.push("- No page changes.");
console.log(lines.join("\n") + "\n");
