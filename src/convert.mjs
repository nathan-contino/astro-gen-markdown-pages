import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Selector for elements that are considered block-level inside card <a> tags.
const BLOCK_SELECTOR = 'div, p, h1, h2, h3, h4, h5, h6, section, article, header, figure, blockquote, ul, ol';

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
  const $ = cheerio.load(html);

  let container = $('article').first();
  if (!container.length) container = $('main').first();
  if (!container.length) container = $('body').first();
  if (!container.length) return { markdown: '', title: '', description: '' };

  const rawTitle =
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim() ||
    '';
  const title = (trimTitleSuffix && rawTitle.endsWith(trimTitleSuffix))
    ? rawTitle.slice(0, -trimTitleSuffix.length).trimEnd()
    : rawTitle;
  const description = $('meta[name="description"]').attr('content') || '';

  // Reveal hidden tab panels so their content is included
  container.find('.tab-panel').removeClass('hidden');

  // Swap SSR-rendered mermaid diagrams back to fenced code blocks
  container.find('[data-mermaid-src]').each((_, el) => {
    const src = $(el).attr('data-mermaid-src');
    if (src) {
      const $pre = $('<pre><code></code></pre>');
      $pre.find('code').addClass('language-mermaid').text(src);
      $(el).replaceWith($pre);
    }
  });

  // Wrap card-style <a> elements (those with block-level direct children) in a <div>.
  // Turndown treats <a> as inline and strips surrounding blank lines; the <div> wrapper
  // makes Turndown emit \n\n before and after each card, so adjacent cards are separated.
  container.find('a[href]').each((_, el) => {
    const $el = $(el);
    if ($el.children(BLOCK_SELECTOR).length > 0) {
      $el.wrap('<div></div>');
    }
  });

  container
    .find(
      'script, style, svg, button, nav, footer, aside, ' +
      '.not-prose.hidden, [aria-hidden="true"], .hidden, .sr-only, dialog, noscript, ' +
      '[data-nomd], [data-markdown-ignore]'
    )
    .remove();

  const rawHtml = container.html();
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
