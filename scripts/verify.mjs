#!/usr/bin/env node
// Browser smoke test for a built site.
// Usage: node scripts/verify.mjs <site url, e.g. http://127.0.0.1:4410/openshell-docs> [screenshot dir]
// Needs playwright-core and a Chromium (PLAYWRIGHT_CHROMIUM or the playwright cache).
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [site = "http://127.0.0.1:4410/openshell-docs", shots = "build/screenshots"] = process.argv.slice(2);
const B = new URL(site).pathname.replace(/\/$/, "");
const exe = process.env.PLAYWRIGHT_CHROMIUM ?? path.join(os.homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome");
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`${page.url()}: ${m.text()}`));
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`); if (!ok) failed++; };
const go = (p) => page.goto(site + p, { waitUntil: "networkidle" });
const picker = () => page.$$eval(".os-version__menu a", (as) => as.map((a) => a.querySelector(".os-version__name").textContent.trim()));
const links = () => page.$$eval(".sl-markdown-content a", (as) => as.map((a) => a.getAttribute("href")));
const shot = (n) => page.screenshot({ path: path.join(shots, n + ".png") });

await go("/");
check("/ redirects to the newest OpenShell release", page.url().endsWith(`${B}/0.1.8/`), page.url());
check("core picker: dev, 0.1.8 (latest), 0.1.7", JSON.stringify(await picker()) === JSON.stringify(["devunreleased", "0.1.8latest", "0.1.7"]), await picker());
check("core sidebar has Fern sections", (await page.$$eval("#starlight__sidebar summary", (s) => s.map((x) => x.textContent.trim()))).includes("How It Works"));
await shot("core-latest");

await go("/0.1.8/about/architecture/");
const imgs = await page.$$eval(".sl-markdown-content img", (is) => is.map((i) => [i.getAttribute("src"), i.naturalWidth]));
check("images from the tag load", imgs.length > 0 && imgs.every(([, w]) => w > 0), imgs);

await go("/dev/how-it-works/sandboxes/runtimes/");
check("core dev links the Docker driver's dev docs", (await links()).includes(`${B}/drivers/docker/dev/setup/`), (await links()).filter((h) => h?.includes("drivers")));
check("dev pages carry the unreleased banner", (await page.textContent(".sl-banner"))?.includes("Unreleased docs from pimlock/OpenShell@multirepo-docs"));
await shot("core-dev-runtimes");

await go("/0.1.8/how-it-works/gateways/configuration/");
check("Fern custom heading id kept as an anchor", (await page.$("#gateway-config-preflight")) !== null);

await go("/sdks/python/0.1.8/");
check("python 0.1.8 links core's latest release", (await links()).includes(`${B}/0.1.8/kubernetes/setup/`), (await links()).filter((h) => h?.startsWith(B)));
check("python sub-tabs: Overview, Python SDK, Go SDK", JSON.stringify(await page.$$eval(".os-subtab", (a) => a.map((x) => x.textContent.trim()))) === JSON.stringify(["Overview", "Python SDK", "Go SDK"]));
await shot("python-latest");

await go("/sdks/go/0.1.7/getting-started/");
check("Go 0.1.7 (mdBook tag) renders", (await page.textContent("h1"))?.includes("Quick Start"));
check("Go 0.1.7 has outdated banner", (await page.textContent(".sl-banner"))?.includes("latest version is 0.1.8"));
check("Go picker: dev, 0.1.8, 0.1.7", JSON.stringify(await picker()) === JSON.stringify(["devunreleased", "0.1.8latest", "0.1.7"]), await picker());
await go("/sdks/go/dev/getting-started/");
check("Go dev links core dev", (await links()).includes(`${B}/dev/about/installation/`));
await shot("go-dev");

await go("/drivers/");
const cards = await page.$$eval(".os-card", (cs) => cs.map((c) => c.getAttribute("href")));
check("drivers overview: one card per driver", JSON.stringify(cards) === JSON.stringify([`${B}/drivers/docker/0.2.0/setup/`, `${B}/drivers/podman/0.1.0/setup/`]), cards);
await shot("drivers-overview");

await go("/drivers/docker/latest/setup/");
check("latest alias redirects", page.url().endsWith(`${B}/drivers/docker/0.2.0/setup/`), page.url());
await go("/drivers/docker/0.1.0/setup/");
check("docker 0.1.0 lacks proxy section", !(await page.textContent("main")).includes("Corporate Proxy Egress"));
await go("/drivers/docker/dev/troubleshooting/");
check("docker dev has the new page", (await page.textContent("h1"))?.includes("Troubleshooting"));

const md = await (await fetch(`${site}/sdks/go/0.1.8/getting-started.md`)).text();
check("Markdown copy exists for mdBook pages", md.includes("docset: sdk-go") && md.includes("# Quick Start"), md.slice(0, 200));
const lj = await (await fetch(`${site}/links.json`)).json();
check("links.json lists dev versions", lj.docsets["driver-docker"].versions[0].dev === true);

check("no console errors", errors.length === 0, errors);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
