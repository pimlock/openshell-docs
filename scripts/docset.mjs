#!/usr/bin/env node
// Build one repo's docs, the way the live site would show them, from a local
// checkout. Source repos run this through the openshell-docs command of the
// published package (bin/openshell-docs.mjs) for local builds, Netlify
// deploy previews and CI checks; this repo's preview workflow runs it as
// `npm run docset`.
//
//   node scripts/docset.mjs --docset driver-docker [--path <checkout>] \
//     [--out <dir>] [--base /] [--site <live site>] [--layout fragment|full] \
//     [--ref <label>] [--ref-url <url>] [--branch <branch>] [--edit-repo <owner/repo>] \
//     [--site-url <origin the build is served from>] [--work <dir>] [--check]
//
// Only the one docset is built. Links into the other repos are checked
// against the live site's links.json and point there. The last links.json
// fetched is kept in the work directory, so a build without network falls
// back to it. --check stops after the link checks, without building the site.
//
// --path defaults to the git checkout around the current directory. --ref,
// --branch and --edit-repo default to what git says about it. On Netlify
// they come from Netlify's build environment instead.
//
// Run from this repo, it builds in place and writes site/dist (or --out).
// Run from an installed package, it never writes into node_modules: the
// site shell is copied into the work directory (default .cache/openshell-docs
// in the current directory) and the site goes to --out (default build/docs).
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installed = root.split(path.sep).includes("node_modules");
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) usage(`bad argument ${argv[i]}`);
  const name = argv[i].slice(2);
  if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) args[name] = true;
  else args[name] = argv[++i];
}
if (!args.docset || args.docset === true) usage("--docset is required");

function usage(msg) {
  console.error(`${msg}\nusage: docset.mjs --docset <id> [--path checkout] [--out dir] [--base /] [--site url] [--check] ...`);
  process.exit(2);
}

const gitIn = (dir, ...a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const source = path.resolve(args.path ?? (gitIn(process.cwd(), "rev-parse", "--show-toplevel") || process.cwd()));
const site = (args.site ?? "https://pimlock.github.io/openshell-docs").replace(/\/$/, "");
const base = ("/" + (args.base ?? "/") + "/").replace(/\/+/g, "/");
const work = path.resolve(args.work ?? (installed ? path.join(process.cwd(), ".cache", "openshell-docs") : root));
const out = args.out ? path.resolve(args.out) : installed ? path.resolve("build/docs") : null;

// Netlify checks out a commit, not a branch: label the build from its env.
const env = process.env;
if (env.NETLIFY === "true") {
  args.branch ??= env.HEAD;
  args["site-url"] ??= env.DEPLOY_PRIME_URL ?? env.URL;
  const sha7 = (env.COMMIT_REF ?? "").slice(0, 7);
  if (env.PULL_REQUEST === "true") {
    args.ref ??= `PR #${env.REVIEW_ID}, ${sha7}`;
    args["ref-url"] ??= `${env.REPOSITORY_URL}/pull/${env.REVIEW_ID}`;
  } else args.ref ??= `${env.HEAD}, ${sha7}`;
}

const git = (...a) => gitIn(source, ...a);
const sha = git("rev-parse", "--short=7", "HEAD");
const branch = args.branch ?? (git("rev-parse", "--abbrev-ref", "HEAD").replace(/^HEAD$/, "") || undefined);
const dirty = git("status", "--porcelain", "--", ".") !== "";
const remoteRepo = git("remote", "get-url", "origin").match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1];
const ref = args.ref ?? (sha ? `${branch ?? "detached"}, ${sha}${dirty ? " + local changes" : ""}` : "working tree");

// links.json: fetch it, remember it, fall back to the remembered copy.
const cachedIndex = path.join(work, ".cache", "links.json");
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

const run = (cmd, cmdArgs, extraEnv = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: work, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const assembled = path.join(work, "build", "docset");
const assemble = [path.join(root, "assembler/assemble.mjs"), "--preview", args.docset, "--path", source, "--index", index, "--site", site,
  "--ref", ref, "--base", base, "--layout", args.layout ?? "fragment", "--out", assembled];
if (args["ref-url"]) assemble.push("--ref-url", args["ref-url"]);
if (branch) assemble.push("--branch", branch);
if (args["edit-repo"] ?? remoteRepo) assemble.push("--edit-repo", args["edit-repo"] ?? remoteRepo);
run(process.execPath, assemble);
if (args.check) {
  console.log(`checked ${args.docset} (${ref}): links and inbound links are fine`);
  process.exit(0);
}

// The Starlight project to build in. From an installed package, copy the
// shell (sources only) into the work directory and let it resolve astro and
// the other dependencies from the package's node_modules.
const astroPkg = createRequire(path.join(root, "package.json")).resolve("astro/package.json");
const astroBin = path.join(path.dirname(astroPkg), JSON.parse(fs.readFileSync(astroPkg, "utf8")).bin.astro);
let siteDir = path.join(root, "site");
if (installed) {
  siteDir = path.join(work, "site");
  const generated = new Set(["dist", ".astro", "node_modules", "public", "src/content/docs", "src/generated"].map((p) => path.join(root, "site", p)));
  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.cpSync(path.join(root, "site"), siteDir, { recursive: true, filter: (src) => !generated.has(src) });
  const modules = astroPkg.slice(0, astroPkg.lastIndexOf(`${path.sep}node_modules${path.sep}`) + "/node_modules".length);
  fs.rmSync(path.join(work, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(modules, path.join(work, "node_modules"), "dir");
}

const siteEnv = { ASSEMBLED: assembled, THEME_DIR: path.join(root, "theme"), PREVIEW: "1", BASE_PATH: base, ...(args["site-url"] ? { SITE_URL: args["site-url"] } : {}) };
run(process.execPath, [path.join(siteDir, "scripts/sync.mjs")], siteEnv);
run(process.execPath, [astroBin, "build", "--root", siteDir], siteEnv);
run(process.execPath, [path.join(root, "scripts/redirects.mjs"), path.join(siteDir, "dist")], siteEnv);

const dist = path.join(siteDir, "dist");
if (out && out !== dist) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(dist, out, { recursive: true });
}
console.log(`built ${args.docset} (${ref}) into ${out ?? dist}, served under ${base}`);
