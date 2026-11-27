#!/usr/bin/env node
// openshell-docs: build a source repo's docs the way the docs website shows
// them. Installed in the source repo as a dev dependency.
//
//   openshell-docs build --docset <id> [options]   build the site into build/docs/
//   openshell-docs check --docset <id> [options]   check links only (no site build)
//   openshell-docs serve --docset <id> [--port 4410] [options]
//                                                  build, then serve it locally
//
// Options are those of scripts/docset.mjs (--path, --out, --base, --site, ...).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  console.error(`openshell-docs needs Node.js 24 or later (found ${process.versions.node})`);
  process.exit(1);
}

const docset = (extra) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/docset.mjs"), ...extra], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : fallback;
};

switch (cmd) {
  case "build":
    docset(rest);
    break;
  case "check":
    docset([...rest, "--check"]);
    break;
  case "serve": {
    const i = rest.indexOf("--port");
    const port = opt("port", process.env.PORT ?? "4410");
    const args = i >= 0 ? rest.filter((_, j) => j !== i && j !== i + 1) : rest;
    docset(args);
    spawnSync(process.execPath, [path.join(root, "scripts/serve.mjs"), path.resolve(opt("out", "build/docs")), port, opt("base", "/")], { stdio: "inherit" });
    break;
  }
  default:
    console.error("usage: openshell-docs build|check|serve --docset <id> [options]");
    process.exit(2);
}
