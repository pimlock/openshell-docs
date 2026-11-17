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
then checked Hugo + Docsy separately, because CNCF recommends it.

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

## Pull request previews

A source repo calls the reusable workflow
[`.github/workflows/preview.yml`](.github/workflows/preview.yml) with its docset
id ([example caller](https://github.com/pimlock/openshell-driver-docker/blob/main/.github/workflows/docs-preview.yml)).
It builds only that repo's docs. Everything about the other repos comes from the
live site's [`links.json`](https://pimlock.github.io/openshell-docs/links.json).
The preview:

- is published to the repo's `gh-pages` branch under `pr-<n>/`, and linked from
  one PR comment that is updated on every run;
- fails if a page or heading that another repo links to disappears, unless
  `docset.yml` lists it under `redirects:`;
- with the `docs-diff` label (experimental), also builds `pr-<n>/diff/`, which
  marks what the PR changed on each page ([`assembler/diff.mjs`](assembler/diff.mjs)).

Demo PRs: [driver-docker#1](https://github.com/pimlock/openshell-driver-docker/pull/1)
and [#4](https://github.com/pimlock/openshell-driver-docker/pull/4) (with the
diff view); [#2](https://github.com/pimlock/openshell-driver-docker/pull/2)
renames a page that other repos link to, and fails.

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
- Previews of PRs from forks can't publish or comment, because their token is
  read-only.
- New versions are added to `sources.yml` by hand, not discovered from tags.
- The site has the CNCF and LF Projects footer, but no analytics.
