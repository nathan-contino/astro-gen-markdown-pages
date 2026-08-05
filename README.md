# astro-gen-markdown-pages

Astro integration that generates a `.md` companion file for every HTML page in your build output, plus an `llms.txt` index. Useful for giving LLMs a plain-text version of your documentation without a separate pipeline.

At build time, each HTML page is parsed, stripped of noise (scripts, navigation, hidden elements), and converted to markdown. Internal links are rewritten to point at the corresponding `.md` files. Tab panels that are hidden by default are revealed so their content is included.

In dev mode, any page can be previewed as markdown by adding `?format=md` to its URL. The `llms.txt` index returns a stub so nothing breaks.

## Installation

```
npm install astro-gen-markdown-pages
```

Peer dependency: `astro >= 4.0.0`.

## Usage

```ts
// astro.config.ts
import { defineConfig } from 'astro/config';
import genMarkdownPages from 'astro-gen-markdown-pages';

export default defineConfig({
  site: 'https://example.com',
  integrations: [
    genMarkdownPages({
      llmsTxtTitle: 'My Documentation',
      llmsTxtDescription: 'Full docs for My Project.',
      indexFilter: (url) => url.startsWith('/docs/'),
      categorize: (url) => url.split('/')[2] || 'overview',
    }),
  ],
});
```

After a build, each `.html` file in the output directory gets a sibling `.md` file, and `llms.txt` is written to the root of the output.

## Options

```ts
genMarkdownPages({
  // Full URL of the llms.txt hub, used in each page's backlink header.
  // Defaults to `${site}/${llmsTxtPath}`.
  indexUrl: 'https://example.com/llms.txt',

  // Which pages to include in the llms.txt index.
  // Defaults to all pages.
  indexFilter: (urlPath) => true,

  // Map a page's URL path to a raw category key.
  // Return null or '' to exclude a page from the index.
  // Defaults to the first path segment.
  categorize: (urlPath) => urlPath.split('/').filter(Boolean)[0] || 'root',

  // Convert a raw category key to a display name.
  // Default: title-case with hyphens as word separators.
  formatCategoryName: (key) => key.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),

  // Sort the category display names before writing.
  // Default: alphabetical.
  sortCategories: (names) => [...names].sort(),

  // Where to write llms.txt, relative to the build output directory.
  // Default: 'llms.txt'
  llmsTxtPath: 'docs/llms.txt',

  llmsTxtTitle: 'Documentation',
  llmsTxtDescription: '',

  // When set, each category gets its own llms-{slug}.txt file written inside
  // this directory (relative to the build output), and the hub links to them.
  // When null (default), all entries are inlined in the hub under ## headings.
  spokesDir: 'docs',

  // Category display names to inline in the hub even when spokesDir is set.
  // Useful for a small 'Overview' section that belongs directly in the root file.
  inlineCategories: ['Overview'],

  // Placeholder string in built HTML to replace with the page's .md public URL.
  // Default: 'LLM_MD_PATH_PLACEHOLDER'
  mdPathPlaceholder: 'LLM_MD_PATH_PLACEHOLDER',

  // ID of a <link> element whose href gets rewritten to the .md URL.
  // Default: 'llm-md-link'
  mdLinkId: 'llm-md-link',

  // Trailing substring to strip from extracted page titles before they appear in llms.txt
  // link text and .md headings. Matched exactly, case-sensitively, after trimming.
  // Useful when your HTML <title> and og:title include a site-name suffix.
  // Example: ' | My Site' turns "Getting Started | My Site" into "Getting Started".
  trimTitleSuffix: ' | My Site',
})
```

## Using the converter directly

The HTML-to-markdown converter is exported for use outside the Astro integration:

```ts
import { htmlToMarkdown, createConverter, transformUrl } from 'astro-gen-markdown-pages';

// Convert a full HTML document
const { markdown, title, description } = htmlToMarkdown(html, {
  siteUrl: 'https://example.com',
  indexUrl: 'https://example.com/llms.txt',
});

// Reuse a pre-built converter across many pages (avoids re-initialization per call)
import { createConverter } from 'astro-gen-markdown-pages';
const converter = createConverter();
for (const html of pages) {
  const { markdown } = htmlToMarkdown(html, { siteUrl, indexUrl, converter });
}
```

`htmlToMarkdown` looks for content inside `<article>`, then `<main>`, then `<body>`. It strips scripts, styles, SVGs, buttons, navigation, footers, hidden elements, and screen-reader-only text before converting. Any element with a `data-nomd` attribute is also stripped, which lets you exclude specific HTML elements (e.g. a mobile action menu that duplicates desktop controls) without affecting their visibility or accessibility in the browser.

## llms.txt format

With default settings, a single `llms.txt` is written with one `## Category` section per category:

```
# My Documentation

## Guides

- [Getting Started](https://example.com/docs/guides/start.md): How to set up the project.
- [Configuration](https://example.com/docs/guides/config.md): All available options.

## API

- [REST API](https://example.com/docs/api/index.md): Full API reference.
```

With `spokesDir` set, the hub links to per-category spoke files instead:

```
# My Documentation

- [Guides](https://example.com/docs/llms-guides.txt)
- [API](https://example.com/docs/llms-api.txt)
```

In both cases the hub is also mirrored at `.well-known/llms.txt` alongside it.

## Whitespace handling

Card components (an `<a>` element wrapping block-level children like `<div>` or `<p>`) are detected and wrapped in a block container before conversion, so adjacent cards are separated by blank lines in the markdown output rather than run together on one line.
