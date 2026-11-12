# Component contract

Pages may use these components **without importing them**, in any source
format (MDX in native and Fern repos). The site injects one import per page
(`site/scripts/sync.mjs`); the assembler defines the Markdown fallback for each
(`assembler/assemble.mjs`). The names follow Fern's, so OpenShell's existing
pages and release tags build unchanged.

| Component | Props | Site rendering |
|---|---|---|
| `Note`, `Tip`, `Info`, `Warning`, `Error` | `title?` | Callout box |
| `Tabs` > `Tab` | `Tab.title` | Tab strip; first tab selected |
| `Steps` | `toc?` (ignored) | Children are `##` headings + content; each `##` is a numbered step |
| `Cards` > `Card` | `title`, `href`, `icon?` | Grid of link cards |
| `Accordion`, `AccordionGroup` | `Accordion.title` | `<details>` disclosure |
| `ParamField` | `path`, `type?`, `default?`, `required?` | Field row |
| `Badge` | `intent?`, `minimal?`, `outlined?` | Small pill |
| `CommandTerminal` | `command` | Terminal-style block |
| `BadgeLinks` | `badges: {href, src, alt}[]` | Row of shield images |

Plain `<div>` wrappers pass through. `<llms-only>` / `<llms-ignore>` are
resolved by the assembler: the first appears only in the Markdown copy, the
second only on the site. Fern's `## Heading {#id}` custom ids are kept as anchors.
