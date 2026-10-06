import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createConverter, htmlToMarkdown } from './convert.mjs';

// Create the converter once and share it across every batch this worker handles
const converter = createConverter();

function processFile(htmlFile, { distDir, siteUrl, indexUrl, docsIndexUrl, mdPathPlaceholder, mdLinkId, trimTitleSuffix }) {
  let html = fs.readFileSync(htmlFile, 'utf-8');

  const rel = path.relative(distDir, htmlFile).replace(/\\/g, '/');
  // foo/index.html represents the directory itself → write as foo.md, not foo/index.md
  const mdRel = rel.endsWith('/index.html')
    ? rel.slice(0, -'/index.html'.length) + '.md'
    : rel.replace(/\.html$/, '.md');
  const mdUrl = '/' + mdRel;

  // Patch in-page markdown link element and any placeholder strings, then save
  let changed = false;
  if (mdLinkId && html.includes(`id="${mdLinkId}"`)) {
    html = html.replace(
      new RegExp(`<link\\s+id="${mdLinkId}"[^>]*>`),
      `<link rel="alternate" type="text/markdown" title="Page Markdown Source" href="${mdUrl}">`
    );
    changed = true;
  }
  if (mdPathPlaceholder && html.includes(mdPathPlaceholder)) {
    html = html.replaceAll(mdPathPlaceholder, mdUrl);
    changed = true;
  }
  if (changed) fs.writeFileSync(htmlFile, html, 'utf-8');

  const { markdown, title, description } = htmlToMarkdown(html, { siteUrl, indexUrl, docsIndexUrl, converter, trimTitleSuffix });
  if (!markdown) return null;

  fs.mkdirSync(path.dirname(path.join(distDir, mdRel)), { recursive: true });
  fs.writeFileSync(path.join(distDir, mdRel), markdown, 'utf-8');

  return { mdUrl, title, description };
}

// one message per batch: { id, files, opts } in, { id, results } out
parentPort.on('message', ({ id, files, opts }) => {
  const results = [];
  for (const htmlFile of files) {
    try {
      const r = processFile(htmlFile, opts);
      if (r) results.push(r);
    } catch {
      // skip files that fail — don't abort the whole batch
    }
  }
  parentPort.postMessage({ id, results });
});
