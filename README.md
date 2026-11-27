# OpenShell docs (multi-repo v0)

An experiment in building one docs site from several repos. Each repo keeps its
docs next to its code and ships them with its releases. This repo holds no
content: it owns the build, the theme and the navigation. The site is live at
<https://pimlock.github.io/openshell-docs/>.

| Repo | Docset | Format | Versions |
|---|---|---|---|
| [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) (releases), [pimlock/OpenShell@multirepo-docs](https://github.com/pimlock/OpenShell/tree/multirepo-docs) (dev) | OpenShell (Platform) | Fern `index.yml` | dev, 0.1.8, 0.1.7 |
| [pimlock/openshell-sdk-python](https://github.com/pimlock/openshell-sdk-python) | Python SDK | `docset.yml` | dev, 0.1.8 |
| [pimlock/openshell-sdk-go](https://github.com/pimlock/openshell-sdk-go) | Go SDK | mdBook `SUMMARY.md` | dev, 0.1.8, 0.1.7 |
| [pimlock/openshell-driver-docker](https://github.com/pimlock/openshell-driver-docker) | Docker driver | `docset.yml` | dev, 0.2.0, 0.1.0 |
| [pimlock/openshell-driver-podman](https://github.com/pimlock/openshell-driver-podman) | Podman driver | `docset.yml` | dev, 0.1.0 |

## How it works

[`sources.yml`](sources.yml) lists each repo, where it's mounted and which refs
to publish. A build:

1. **Fetches each version from its tag or branch.** Only the docs directory is
   fetched (sparse, blobless, depth 1) and cached by commit. The commits used
   are recorded in `sources.lock.json`.
2. **Reads each checkout in its own format**: `docset.yml`, Fern `index.yml`,
   or mdBook ([`assembler/adapters.mjs`](assembler/adapters.mjs)). Old release
   tags build as they are. Pages use one MDX component set, with Fern's names
   ([`theme/CONTRACT.md`](theme/CONTRACT.md)).
3. **Publishes each version at its own path**, such as `/0.1.8/about/overview/`
   or `/drivers/docker/dev/setup/`. `/<mount>/latest/<page>` redirects to the
   newest release.
4. **Checks every link**, including links between repos (`core://kubernetes/setup`,
   `driver-docker://setup#mounts`). Broken links fail dev builds and previews;
   published releases only warn, so a frozen release never blocks the build.
5. **Builds the site** with Starlight ([`site/`](site/)). Mermaid diagrams are
   rendered to SVG at build time. Every page also gets a Markdown copy at
   `<url>.md`, and the site gets an `/llms.txt`.

The site rebuilds hourly. In production, each source repo would trigger a
rebuild when it pushes or tags.

## Why Starlight

We prototyped the same pages, theme and components on three generators. We
then checked Hugo + Docsy separately, because CNCF recommends it. The full
write-up is in [#1](https://github.com/pimlock/openshell-docs/issues/1).

| | First page load | Custom theme | Low maintenance | Result |
|---|---|---|---|---|
| **Starlight** (Astro) | 325 KB, 106 KB JS | 4/5 | 3/5 | **Chosen** |
| Docusaurus | 767 KB, 569 KB JS | 4/5 | 4/5 | Fallback |
| Fumadocs (Next.js) | 1,448 KB, 854 KB JS | 4/5 | 2/5 | Dropped |
| Hugo + Docsy | 644 KB gzipped (Starlight: 109 KB) | 10 template overrides | 4 copied templates to re-merge on upgrades | Not worth a migration |

- **Starlight** ships almost no JavaScript, has local search (Pagefind) built
  in, and allowed exactly the layout we wanted through public extension points.
  Per-component versions are a small routing step
  ([`site/src/routeData.ts`](site/src/routeData.ts)). The risk is that about
  400 lines of CSS target internal class names, and Starlight is still 0.x.
- **Docusaurus** is the safest to upgrade and has versioning built in, but its
  versions are copies kept in the site repo rather than read from each repo's
  tags. Pages are about 5× heavier, search needs a third-party plugin, and
  putting page actions in the title row needs an unsafe "swizzle".
- **Fumadocs** has the AI features (Markdown copies, page actions) built in,
  but its major versions follow Next.js, custom layouts are copied-in code with
  no upgrade path, and it has essentially one maintainer.
- **Hugo + Docsy** builds fast, but it can't read MDX. Either a converter
  translates every page at build time, or every repo migrates to Hugo
  shortcodes and old releases are frozen. Docsy assumes one version list per
  site, so per-component versions needed template overrides. CNCF recommends
  it but doesn't require it.

A hosted docs platform was ruled out because we need versions per component,
docs fetched from each repo's tags, and full control over the theme and the
build.

## Build one repo's docs

`npm run docset` builds a single repo's docs from a local checkout, the way
the live site shows them. Links into other repos are checked against the
live site's `links.json`; the last copy is kept in `.cache/` for builds
without network.

```shell
npm ci
npm run docset -- --docset driver-docker --path ../openshell-driver-docker --out /tmp/docs
```

Source repos run it through the `@pimlock/openshell-docs-build` package,
which this repo publishes. The package holds the assembler, the site shell
and the theme, and an `openshell-docs` command:

```shell
npm install -D @pimlock/openshell-docs-build
npx openshell-docs check --docset driver-docker   # links only, under a second
npx openshell-docs build --docset driver-docker   # site in build/docs/
npx openshell-docs serve --docset driver-docker   # build, then serve on :4410
```

The command builds the git checkout around the current directory. On
Netlify it labels the build with the pull request. It never writes into
`node_modules`: it copies the site shell into `.cache/openshell-docs/`. See
[pimlock/openshell-driver-docker](https://github.com/pimlock/openshell-driver-docker)
for a repo set up this way (`package.json`, `netlify.toml`, a CI check, and
Dependabot). The `package.json` can also sit in the docs directory itself:
pages and assets are read from the files git tracks or would track, so
ignored `node_modules/`, `build/` and `.cache/` are never published, and
neither is `package.json`.

### Releasing the package

Production builds from `main` and never waits for a release. Source repos
take changes when a release reaches them:

1. Run the **Release package** workflow on `main` and pick patch, minor or
   major. Major means source repos must change something (`docset.yml`,
   `links.json`, command options).
2. It bumps `package.json`, packs the package, and builds
   openshell-driver-docker with the packed tarball installed the way a source
   repo installs it. A broken package stops here.
3. It commits the version, tags `v<version>`, and creates a GitHub release
   with the tarball.
4. With the repository variable `NPM_PUBLISH=true` it publishes to npmjs.org
   with trusted publishing (no token). Dependabot in each source repo then
   opens a PR whose docs check runs on the new version.

Until the package is on npmjs.org, source repos install the release tarball
by URL, which Dependabot can't update.

## Pull request previews

Source repos get a preview of their docs on every pull request, including
pull requests from forks. Three reusable workflows split the work so that the
pull request's code never runs with write access:

| Workflow | Trigger in the source repo | Access | Does |
|---|---|---|---|
| [`preview-build.yml`](.github/workflows/preview-build.yml) | `pull_request` | read-only | Builds only that repo's docs against the live site's [`links.json`](https://pimlock.github.io/openshell-docs/links.json); uploads the site and `meta.json` |
| [`preview-publish.yml`](.github/workflows/preview-publish.yml) | `workflow_run` | writes `gh-pages` | Trusts the PR number only if that PR's head is the built commit, checks the site is plain files, publishes it to `gh-pages/pr-<n>/` from an environment, and sets the `docs/preview` status and one PR comment |
| [`preview-remove.yml`](.github/workflows/preview-remove.yml) | `pull_request_target` closed | writes `gh-pages` | Removes the preview |
| [`preview-prune.yml`](.github/workflows/preview-prune.yml) | `schedule` | writes `gh-pages` | Removes previews of pull requests that aren't open, and optionally previews older than `max-age-days` |

`gh-pages` is always a single parentless commit: every change replaces the
branch with `--force-with-lease` against the commit it started from, so its
history never grows and concurrent publishes are redone instead of lost.

Previews of branches in the source repo publish through the `docs-preview`
environment; previews of forks go through `docs-preview-fork`, which has
required reviewers, so a maintainer approves each fork preview before it is
published. Both environments only allow `main`. Preview pages say they are
unreviewed and are marked `noindex`. Broken links fail the build, as does a
page or heading that another repo links to disappearing, unless `docset.yml`
lists it under `redirects:`.

Example callers: [driver-docker's workflows](https://github.com/pimlock/openshell-driver-docker/tree/main/.github/workflows).
Test PRs: [#6](https://github.com/pimlock/openshell-driver-docker/pull/6)
(branch: published, broken link reported, removed on close),
[#7](https://github.com/pimlock/openshell-driver-docker/pull/7) (fork: waits
for approval), and
[#8](https://github.com/pimlock/openshell-driver-docker/pull/8) (fork that
claims another PR's number: rejected).

The older single-job [`preview.yml`](.github/workflows/preview.yml) (with the
experimental `docs-diff` view) still works for same-repo pull requests.

## Run it locally

```shell
npm ci
node assembler/assemble.mjs --base /openshell-docs/
BASE_PATH=/openshell-docs/ npm run site
node scripts/serve.mjs site/dist 4410 /openshell-docs/
```

Use a local checkout instead of a source's dev branch with
`--local core=../OpenShell`. `node scripts/verify.mjs http://127.0.0.1:4410/openshell-docs`
runs browser checks against a running site (needs `playwright-core`).

## Not done yet

- GitHub Pages has no server-side rules, so redirects are HTML pages and URLs
  can't serve another version's content. A host such as Netlify would fix both.
- New versions are added to `sources.yml` by hand, not discovered from tags.
- The site has the CNCF and LF Projects footer, but no analytics.
