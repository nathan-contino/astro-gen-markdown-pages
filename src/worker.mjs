import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createConverter, htmlToMarkdown } from './convert.mjs';

const { files, distDir, siteUrl, indexUrl, mdPathPlaceholder, mdLinkId } = workerData;

// Create the converter once and share it across all files in this worker's batch
const converter = createConverter();

function processFile(htmlFile) {
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

  const { markdown, title, description } = htmlToMarkdown(html, { siteUrl, indexUrl, converter });
  if (!markdown) return null;

  fs.mkdirSync(path.dirname(path.join(distDir, mdRel)), { recursive: true });
  fs.writeFileSync(path.join(distDir, mdRel), markdown, 'utf-8');

  return { mdUrl, title, description };
}

const results = [];
for (const htmlFile of files) {
  try {
    const r = processFile(htmlFile);
    if (r) results.push(r);
  } catch {
    // skip files that fail — don't abort the whole batch
  }
}

parentPort.postMessage(results);
