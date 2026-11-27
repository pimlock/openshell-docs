#!/usr/bin/env node
// Build one repo's docs, the way the live site would show them, from a local
// checkout. Source repos call this (through their docs build script) for
// local builds, Netlify deploy previews and CI checks.
//
//   node scripts/docset.mjs --docset driver-docker --path ../openshell-driver-docker \
//     [--out <dir>] [--base /] [--site <live site>] [--layout fragment|full] \
//     [--ref <label>] [--ref-url <url>] [--branch <branch>] [--edit-repo <owner/repo>] \
//     [--site-url <origin the build is served from>]
//
// Only the one docset is built. Links into the other repos are checked
// against the live site's links.json and point there. The last links.json
// fetched is kept in .cache/, so a build without network falls back to it.
//
// --ref, --branch and --edit-repo default to what git says about --path.
// The site goes to --out (default: site/dist in this repo).
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--") || argv[i + 1] === undefined) usage(`bad argument ${argv[i]}`);
  args[argv[i].slice(2)] = argv[i + 1];
}
if (!args.docset || !args.path) usage("--docset and --path are required");

function usage(msg) {
  console.error(`${msg}\nusage: docset.mjs --docset <id> --path <checkout> [--out dir] [--base /] [--site url] ...`);
  process.exit(2);
}

const source = path.resolve(args.path);
const site = (args.site ?? "https://pimlock.github.io/openshell-docs").replace(/\/$/, "");
const base = ("/" + (args.base ?? "/") + "/").replace(/\/+/g, "/");
const out = args.out ? path.resolve(args.out) : null;

const git = (...a) => {
  try {
    return execFileSync("git", ["-C", source, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const sha = git("rev-parse", "--short=7", "HEAD");
const branch = args.branch ?? (git("rev-parse", "--abbrev-ref", "HEAD").replace(/^HEAD$/, "") || undefined);
const dirty = git("status", "--porcelain", "--", ".") !== "";
const remoteRepo = git("remote", "get-url", "origin").match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1];
const ref = args.ref ?? (sha ? `${branch ?? "detached"}, ${sha}${dirty ? " + local changes" : ""}` : "working tree");

// links.json: fetch it, remember it, fall back to the remembered copy.
const cachedIndex = path.join(root, ".cache", "links.json");
let index = args.index;
if (!index) {
  try {
    const res = await fetch(`${site}/links.json`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(cachedIndex), { recursive: true });
    fs.writeFileSync(cachedIndex, await res.text());
  } catch (e) {
    if (!fs.existsSync(cachedIndex)) {
      console.error(`could not fetch ${site}/links.json (${e.message}), and there is no cached copy`);
      process.exit(1);
    }
    console.warn(`could not fetch ${site}/links.json (${e.message}); using the copy from ${fs.statSync(cachedIndex).mtime.toISOString()}`);
  }
  index = cachedIndex;
}

const run = (cmd, cmdArgs, env = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const assembled = path.join(root, "build", "docset");
const assemble = ["assembler/assemble.mjs", "--preview", args.docset, "--path", source, "--index", index, "--site", site,
  "--ref", ref, "--base", base, "--layout", args.layout ?? "fragment", "--out", assembled];
if (args["ref-url"]) assemble.push("--ref-url", args["ref-url"]);
if (branch) assemble.push("--branch", branch);
if (args["edit-repo"] ?? remoteRepo) assemble.push("--edit-repo", args["edit-repo"] ?? remoteRepo);
run(process.execPath, assemble);

const env = { ASSEMBLED: assembled, PREVIEW: "1", BASE_PATH: base, ...(args["site-url"] ? { SITE_URL: args["site-url"] } : {}) };
run(process.execPath, ["site/scripts/sync.mjs"], env);
run(path.join(root, "node_modules/.bin/astro"), ["build", "--root", "site"], env);
run(process.execPath, ["scripts/redirects.mjs", "site/dist"], env);

if (out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, "site/dist"), out, { recursive: true });
}
console.log(`built ${args.docset} (${ref}) into ${out ?? path.join(root, "site/dist")}, served under ${base}`);
