// Fetch one directory of a repo at a ref, without cloning the repo.
//
// The ref (tag, branch or commit) is resolved to a commit with `git ls-remote`.
// Checkouts are cached by commit, so a release is fetched once and reused by
// every later build. Only `path` is checked out (sparse, blobless, depth 1).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = (args, cwd) => run("git", args, { cwd, maxBuffer: 64 << 20 }).then((r) => r.stdout.trim());
const urlOf = (repo) => (/^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : repo);

export async function resolveRef(repo, ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const out = await git(["ls-remote", urlOf(repo), ref, `${ref}^{}`]);
  const lines = out.split("\n").filter(Boolean).map((l) => l.split("\t"));
  const exact = (name) => lines.find(([, r]) => r === name)?.[0];
  // annotated tags: use the peeled commit
  const sha = exact(`refs/tags/${ref}^{}`) ?? exact(`refs/tags/${ref}`) ?? exact(`refs/heads/${ref}`);
  if (!sha) throw new Error(`${repo}: ref "${ref}" not found`);
  return sha;
}

// Two refs can name the same commit (a tag on main); fetch it once.
const inflight = new Map();

/** Returns { dir, sha }: `dir` is `subdir` inside a cached checkout at `sha`. */
export async function checkout({ repo, ref, subdir }, cacheRoot) {
  const sha = await resolveRef(repo, ref);
  const dir = path.join(cacheRoot, repo.replace(/[^\w.-]+/g, "__"), sha);
  if (!inflight.has(dir)) inflight.set(dir, fetchInto(dir, repo, ref, sha, subdir));
  await inflight.get(dir);
  const docs = path.join(dir, subdir);
  if (!fs.existsSync(docs)) throw new Error(`${repo}@${ref}: no ${subdir}/ at ${sha.slice(0, 12)}`);
  return { dir: docs, sha };
}

async function fetchInto(dir, repo, ref, sha, subdir) {
  if (!fs.existsSync(path.join(dir, ".fetched"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await git(["init", "-q"], dir);
    await git(["remote", "add", "origin", urlOf(repo)], dir);
    await git(["sparse-checkout", "set", "--no-cone", `/${subdir}/`], dir);
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", sha], dir);
    await git(["checkout", "-q", "FETCH_HEAD"], dir);
    fs.writeFileSync(path.join(dir, ".fetched"), `${repo}@${ref}\n`);
  }
}
