# OpenShell docs (multi-repo v0)

Experiment: one docs site built from several repos, where each repo owns its
docs and the site repo owns the build, theme and navigation. The site is
published at <https://pimlock.github.io/openshell-docs/>.

| Repo | Docset | Format | Published versions |
|---|---|---|---|
| [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) (releases), [pimlock/OpenShell@multirepo-docs](https://github.com/pimlock/OpenShell/tree/multirepo-docs) (dev) | OpenShell (Platform) | Fern `docs/index.yml` | dev, 0.1.8, 0.1.7 |
| [pimlock/openshell-sdk-python](https://github.com/pimlock/openshell-sdk-python) (fork) | Python SDK | `docs/docset.yml` | dev, 0.1.8 |
| [pimlock/openshell-sdk-go](https://github.com/pimlock/openshell-sdk-go) (fork) | Go SDK | mdBook `docs/src/SUMMARY.md` | dev, 0.1.8, 0.1.7 |
| [pimlock/openshell-driver-docker](https://github.com/pimlock/openshell-driver-docker) | Docker driver | `docs/docset.yml` | dev, 0.2.0, 0.1.0 |
| [pimlock/openshell-driver-podman](https://github.com/pimlock/openshell-driver-podman) | Podman driver | `docs/docset.yml` | dev, 0.1.0 |

## How it works

**This repo holds no content.** [`sources.yml`](sources.yml) lists each
source repo, where it's mounted, the path of its docs, and the refs to
publish. A build:

1. **Fetches each version from its ref.** `git ls-remote` resolves the tag or
   branch to a commit, then a sparse, blobless, depth-1 fetch checks out only
   the docs directory. Checkouts are cached by commit (`.cache/sources/`), so a
   release is downloaded once. 13 versions take about 3 s cold. The commits
   used are written to `build/assembled/sources.lock.json` and to the
   workflow summary.
2. **Reads each checkout in its own format** ([`assembler/adapters.mjs`](assembler/adapters.mjs)):
   - `docset.yml` (native, the format new repos use),
   - Fern `index.yml` (so OpenShell's existing release tags build unchanged,
     including Fern's slug rules, folders and custom heading ids),
   - mdBook `SUMMARY.md` (the Go SDK's tags).
   The format is detected per checkout, so a repo can switch formats between
   releases. Pages in every format may use the same component set
   ([`theme/CONTRACT.md`](theme/CONTRACT.md)): Fern's names (`Note`, `Tabs`,
   `Steps`, `Cards`…).
3. **Publishes every version under its own path**: `/<mount>/<version>/<page>`,
   e.g. `/0.1.8/about/overview/`, `/sdks/go/0.1.7/getting-started/`,
   `/drivers/docker/dev/setup/`. `/<mount>/latest/<page>` redirects to the
   newest release, and `/` to the newest OpenShell.
4. **Checks every link** ([`assembler/assemble.mjs`](assembler/assemble.mjs)):
   - Root-relative links (`/how-it-works/x`) stay in their own release.
   - Links into another repo use its id as a scheme: `core://kubernetes/setup`,
     `driver-docker://setup#mounts`. They resolve to that repo's latest release,
     or to its `dev` from a dev page, and are checked down to the heading.
   - Versions that can still change (`dev`, PR previews) fail the build on any
     broken link. A published release only warns, and the link falls back to
     the target release's first page. A frozen release must never block the
     build.
5. **Writes the site** (Starlight, [`site/`](site/)) plus Markdown for
   agents: each page at `<url>.md`, `/llms.txt`, and `/<version>/llms.txt`.

### Navigation

Topic tabs are Platform, SDKs and Drivers. A topic with several docsets has
sub-tabs: Overview plus one tab per docset. On narrow screens the sub-tabs
become a dropdown. The version dropdown sits at the top of the sidebar, and the
sidebar shows only the current docset. Older and dev versions carry a banner and
are left out of search. `/sdks/` and `/drivers/` are generated overview pages,
each with a hand-written intro from [`topics/`](topics/) and one card per
docset.

### Pull request previews in source repos

[`.github/workflows/preview.yml`](.github/workflows/preview.yml) is a reusable
workflow. A source repo calls it with its docset id (see the caller in
[openshell-driver-docker](https://github.com/pimlock/openshell-driver-docker/blob/main/.github/workflows/docs-preview.yml)).
It builds **only that repo's docs**, with no access to the other repos.
Everything it needs about them comes from the live site's
[`links.json`](https://pimlock.github.io/openshell-docs/links.json): every
published version's pages, headings and redirects, and every cross-repo link.
The preview:

- checks outbound links against the index and points them at the live site;
- fails if a page or heading that another repo (or a topic intro) links to
  disappears, unless `docset.yml` lists the old page under `redirects:`;
- is deployed to the source repo's own GitHub Pages site, linked from the PR.

## Fetching from tags instead of copying

The current OpenShell docs flow copies content at release time. Here nothing
is copied: the build reads each release straight from its tag. What that buys:

- **No sync jobs or copies to drift.** A release is whatever its tag holds.
- **Old releases stay as they were written.** Adapters read old formats,
  so moving to a new format doesn't require migrating past releases.
- **Adding a version is one line** in `sources.yml` (or, later, automatic
  from tags).

Downsides, and what v0 does about them:

| Downside | Mitigation |
|---|---|
| A release's docs can't be fixed after the tag (a typo, a broken link, a security note). | `ref` can be any ref. Point a version at a docs branch (`release-0.1-docs`) or a commit when it needs a fix. Link problems in releases only warn. |
| Tags are mutable, and a moved tag silently changes a published version. | Every build records the commit each ref resolved to (`sources.lock.json`). A stricter mode could pin commits in a lock file and fail on drift. |
| Old tags use old formats and conventions. | Adapters (Fern, mdBook) are needed for as long as those versions are published. They're about 150 lines here. |
| Every build depends on every source repo being reachable. Private repos need a token. | Cached by commit, so only new commits are fetched. Use a read-only token or GitHub App for private repos. |
| New releases and dev commits don't trigger a rebuild by themselves. | v0 rebuilds hourly. In production, each source repo would send `repository_dispatch` on push to main or on a tag. That needs a token in each repo. |
| Build time grows with the number of versions, because every version is rebuilt every time. | Fine at this size (270 pages in ~6 s). Releases never change, so their output could be cached by commit. |
| A release's links into other repos resolve to *their* latest, which may not match the version a reader runs. | Accepted: the support matrix answers "which versions go together". |

## Run it locally

```shell
npm ci
node assembler/assemble.mjs --base /openshell-docs/
BASE_PATH=/openshell-docs/ npm run site
node scripts/serve.mjs site/dist 4410 /openshell-docs/
```

Use a local working tree instead of a source's dev branch with
`--local core=../OpenShell`. Preview one repo against the published index:

```shell
node assembler/assemble.mjs --preview driver-docker --path ../openshell-driver-docker \
  --index https://pimlock.github.io/openshell-docs/links.json \
  --site https://pimlock.github.io/openshell-docs --out build/preview
ASSEMBLED=build/preview npm run site
```

`node scripts/verify.mjs http://127.0.0.1:4410/openshell-docs` runs browser
checks against a running site (needs `playwright-core`).

## What changed in the source repos

- **OpenShell** ([`multirepo-docs`](https://github.com/pimlock/OpenShell/compare/main...multirepo-docs)): removed the Python and Go SDK pages (their repos own them now). Links point at `sdk-python://` and at the driver docs, `driver-docker://setup` and `driver-podman://setup`. The rest is still Fern-format.
- **sdk-python**: adds `docs/` (from OpenShell's `sdk/python.mdx`). Tag `v0.1.8-docs` stands in for the first release that ships docs.
- **sdk-go**: unchanged mdBook docs; the dev branch adds a `core://` link.
- **Driver repos**: new, docs only, with `v0.1.0`/`v0.2.0` tags.

## Not done yet

- Search covers latest releases only (Pagefind could filter by version).
- Redirects are static HTML pages, because GitHub Pages has no edge rules. A real host would use edge rules, and could serve Markdown by content negotiation.
- Only one preview per source repo at a time (GitHub Pages has one site per repo).
- No automatic version discovery from tags.
