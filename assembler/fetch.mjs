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

const ghRepo = (repo) => repo.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
const headers = () => ({
  "User-Agent": "docs-assembler",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

// GitHub repos resolve over HTTPS (no git needed); other URLs fall back to git.
export async function resolveRef(repo, ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const gh = ghRepo(repo);
  if (gh) {
    const res = await fetch(`https://api.github.com/repos/${gh}/commits/${encodeURIComponent(ref)}`, {
      headers: { ...headers(), Accept: "application/vnd.github.sha" },
    });
    if (res.status === 404 || res.status === 422) throw new Error(`${repo}: ref "${ref}" not found`);
    if (!res.ok) throw new Error(`${repo}: resolving "${ref}" failed (HTTP ${res.status})`);
    return (await res.text()).trim();
  }
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
    const gh = ghRepo(repo);
    if (gh) {
      const res = await fetch(`https://codeload.github.com/${gh}/tar.gz/${sha}`, { headers: headers() });
      if (!res.ok) throw new Error(`${repo}@${ref}: download failed (HTTP ${res.status})`);
      const tgz = path.join(dir, ".src.tar.gz");
      fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      await run("tar", ["-xzf", tgz, "--strip-components=1", "--wildcards", `*/${subdir}`], { cwd: dir, maxBuffer: 64 << 20 }).catch(() => {});
      fs.rmSync(tgz, { force: true });
      fs.writeFileSync(path.join(dir, ".fetched"), `${repo}@${ref}\n`);
      return;
    }
    await git(["init", "-q"], dir);
    await git(["remote", "add", "origin", urlOf(repo)], dir);
    await git(["sparse-checkout", "set", "--no-cone", `/${subdir}/`], dir);
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", sha], dir);
    await git(["checkout", "-q", "FETCH_HEAD"], dir);
    fs.writeFileSync(path.join(dir, ".fetched"), `${repo}@${ref}\n`);
  }
}
