import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const BLOCK_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'figure', 'blockquote', 'ul', 'ol']);

export function createConverter() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.use(gfm);

  td.addRule('links', {
    filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href'),
    replacement: (content, node) => {
      const href = node.getAttribute('href');
      if (!href) return content;
      // Derive text from the Turndown-converted content rather than node.textContent.
      // node.textContent loses spacing when adjacent block children like <div> have no
      // whitespace text node between them (e.g. card components mash "TitleDesc" together).
      // Turndown's content already has \n\n between those blocks, so replacing them with
      // spaces gives proper spacing: "Title\n\nDesc" → "Title Desc".
      const text = content
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // unwrap nested link text
        .replace(/[`*#_~]/g, '')                  // strip inline markdown markers
        .replace(/\n+/g, ' ')                     // block-children newlines → space
        .trim()
        .replace(/\s+/g, ' ');
      if (!text) return '';
      return `[${text}](${href})`;
    },
  });

  td.addRule('tabLabels', {
    filter: (node) =>
      node.nodeName === 'LABEL' && (node.getAttribute('class') || '').includes('tab-label'),
    replacement: (content) => `\n### ${content.trim()}\n\n`,
  });

  return td;
}

export function transformUrl(url, siteUrl) {
  if (!siteUrl) return url;
  // Absolutize root-relative URLs (but not protocol-relative like //cdn.example.com)
  if (url.startsWith('/') && !url.startsWith('//')) url = siteUrl + url;
  // Leave external links alone
  if (!url.startsWith(`${siteUrl}/`)) return url;
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const bare = (hashIdx >= 0 ? url.slice(0, hashIdx) : url).replace(/\/$/, '');
  const lastSegment = bare.split('/').pop() || '';
  // Add .md only when the last segment has no file extension
  return lastSegment.includes('.') ? url : `${bare}.md${fragment}`;
}

/**
 * Convert an HTML page to LLM-friendly markdown.
 *
 * Returns { markdown, title, description } where title and description
 * are extracted from the page's meta tags for use in index files.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.siteUrl]          Base URL for rewriting internal links (e.g. 'https://example.com')
 * @param {string} [opts.indexUrl]         URL linked in the top preamble (e.g. 'https://example.com/llms.txt')
 * @param {TurndownService} [opts.converter]  Pre-built converter; pass one to avoid re-initializing per call
 * @param {string} [opts.trimTitleSuffix]  Trailing substring to strip from extracted page titles
 *   (e.g. ' | My Site'). Matched exactly and case-sensitively after trimming. Useful when your
 *   HTML `<title>` and `og:title` include a site-name suffix that should not appear in llms.txt
 *   link text or .md headings.
 */
export function htmlToMarkdown(html, opts = {}) {
  const { siteUrl = '', indexUrl = '', converter, trimTitleSuffix = '' } = opts;
  const td = converter ?? createConverter();
  const root = parse(html);

  const container =
    root.querySelector('article') ??
    root.querySelector('main') ??
    root.querySelector('body');
  if (!container) return { markdown: '', title: '', description: '' };

  const rawTitle =
    root.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
    root.querySelector('title')?.textContent?.trim() ||
    '';
  const title =
    trimTitleSuffix && rawTitle.endsWith(trimTitleSuffix)
      ? rawTitle.slice(0, -trimTitleSuffix.length).trimEnd()
      : rawTitle;
  const description =
    root.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  // Reveal hidden tab panels so their content is included
  container.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('hidden'));

  // Swap SSR-rendered mermaid diagrams back to fenced code blocks
  container.querySelectorAll('[data-mermaid-src]').forEach(el => {
    const src = el.getAttribute('data-mermaid-src');
    if (src) {
      const escaped = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      el.replaceWith(parse(`<pre><code class="language-mermaid">${escaped}</code></pre>`).firstChild);
    }
  });

  // Wrap card-style <a> elements (those with block-level direct children) in a <div>.
  // Turndown treats <a> as inline and strips surrounding blank lines; the <div> wrapper
  // makes Turndown emit \n\n before and after each card, so adjacent cards are separated.
  container.querySelectorAll('a[href]').forEach(el => {
    const hasBlock = el.childNodes.some(n => BLOCK_TAGS.has(n.tagName?.toLowerCase()));
    if (hasBlock) {
      const div = parse('<div></div>').firstChild;
      el.replaceWith(div);
      div.appendChild(el);
    }
  });

  // Rescue accessible text from icon/image elements before stripping SVGs.
  // ARIA pattern: role="img" + aria-label means "this element is an image with this label."
  container.querySelectorAll('[role="img"][aria-label]').forEach(el => {
    const label = el.getAttribute('aria-label');
    if (label) el.replaceWith(label);
  });

  // SVG accessibility: a <title> child element names the SVG for screen readers.
  container.querySelectorAll('svg').forEach(el => {
    if (!el.parentNode) return; // already replaced by [role="img"] pass above
    const titleText = el.querySelector('title')?.textContent?.trim();
    if (titleText) { el.replaceWith(titleText); return; }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) el.replaceWith(ariaLabel);
    else el.remove();
  });

  container
    .querySelectorAll(
      'script, style, svg, button, nav, footer, aside, ' +
      '.not-prose.hidden, [aria-hidden="true"], .hidden, .sr-only, dialog, noscript, ' +
      '[data-nomd], [data-markdown-ignore]'
    )
    .forEach(el => el.remove());

  const rawHtml = container.innerHTML;
  if (!rawHtml) return { markdown: '', title, description };

  const body = td
    .turndown(rawHtml)
    .replace(/\]\(([^)]+)\)/g, (_, url) => `](${transformUrl(url, siteUrl)})`);

  let markdown = '';
  if (indexUrl) markdown += `> For the complete documentation index, see [llms.txt](${indexUrl})\n\n`;
  if (title) markdown += `# ${title}\n\n`;
  if (description) markdown += `${description}\n\n`;
  markdown += body;

  return { markdown, title, description };
}
