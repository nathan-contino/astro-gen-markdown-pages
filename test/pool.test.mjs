/**
 * build:done through the shared worker pool: two instances back to back, as
 * sites with one instance per section run them. The test process exiting at
 * all shows idle workers don't hold it open.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import genMarkdownPages from '../index.mjs';

const page = (title, body) =>
  `<!DOCTYPE html><html><head><title>${title}</title><meta name="description" content="About ${title}"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

function makeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-'));
  const write = (rel, html) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), html);
  };
  for (let i = 0; i < 45; i++) write(`docs/guide/page-${String(i).padStart(2, '0')}.html`, page(`Guide ${i}`, `<p>Body <a href="/docs/guide/page-00">link</a></p>`));
  for (let i = 0; i < 20; i++) write(`blog/post-${String(i).padStart(2, '0')}.html`, page(`Post ${i}`, '<p>Post body</p>'));
  return dir;
}

async function runHook(integration, dir) {
  integration.hooks['astro:config:done']({ config: { site: 'https://example.com' } });
  await integration.hooks['astro:build:done']({ dir: pathToFileURL(dir + '/'), logger: { info() {} } });
}

test('two instances share the pool and each writes its own section', async () => {
  const dir = makeSite();
  await runHook(genMarkdownPages({ pageFilter: (u) => u.startsWith('/docs/'), llmsTxtPath: 'docs/llms.txt' }), dir);
  await runHook(genMarkdownPages({ pageFilter: (u) => u.startsWith('/blog/'), llmsTxtPath: 'blog/llms.txt' }), dir);

  for (let i = 0; i < 45; i++) assert.ok(fs.existsSync(path.join(dir, `docs/guide/page-${String(i).padStart(2, '0')}.md`)));
  for (let i = 0; i < 20; i++) assert.ok(fs.existsSync(path.join(dir, `blog/post-${String(i).padStart(2, '0')}.md`)));

  const docsIndex = fs.readFileSync(path.join(dir, 'docs/llms.txt'), 'utf-8');
  const listed = [...docsIndex.matchAll(/\[Guide (\d+)\]/g)].map(m => Number(m[1]));
  assert.equal(listed.length, 45);
  // entries follow the directory walk, not worker completion order
  const walkOrder = fs.readdirSync(path.join(dir, 'docs/guide')).filter(f => f.endsWith('.html')).map(f => Number(f.match(/\d+/)[0]));
  assert.deepEqual(listed, walkOrder);
  assert.ok(!docsIndex.includes('Post '), 'blog pages stay out of the docs index');
  assert.ok(fs.readFileSync(path.join(dir, 'blog/llms.txt'), 'utf-8').includes('[Post 7](https://example.com/blog/post-07.md)'));
});

test('empty section writes an index without starting work', async () => {
  const dir = makeSite();
  await runHook(genMarkdownPages({ pageFilter: (u) => u.startsWith('/nothing/'), llmsTxtPath: 'nothing/llms.txt' }), dir);
  assert.equal(fs.readFileSync(path.join(dir, 'nothing/llms.txt'), 'utf-8'), '# Documentation\n\n');
});
