import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { htmlToMarkdown, createConverter, transformUrl } from './src/convert.mjs';

export { htmlToMarkdown, createConverter, transformUrl };

const WORKER_PATH = fileURLToPath(new URL('./src/worker.mjs', import.meta.url));

function spawnWorker(files, distDir, siteUrl, indexUrl, mdPathPlaceholder, mdLinkId) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, {
      workerData: { files, distDir, siteUrl, indexUrl, mdPathPlaceholder, mdLinkId },
    });
    w.on('message', resolve);
    w.on('error', reject);
    w.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

function walkHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(p));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function defaultFormatCategoryName(name) {
  return name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Astro integration that generates .md companion files and an llms.txt index
 * for every HTML page in the build output.
 *
 * @param {object} [opts]
 * @param {string} [opts.indexUrl]
 *   Full URL of the llms.txt hub file, used in the per-page backlink header.
 *   Defaults to `${siteUrl}/${llmsTxtPath}`.
 * @param {(urlPath: string) => boolean} [opts.indexFilter]
 *   Return true for pages to include in the llms.txt index. Default: include all.
 * @param {(urlPath: string) => string} [opts.categorize]
 *   Map a page URL path to a raw category key. Return null/'' to omit from the index.
 *   Default: use the first path segment.
 * @param {(key: string) => string} [opts.formatCategoryName]
 *   Convert a raw category key to a display name. Default: title-case with hyphens as spaces.
 * @param {(names: string[]) => string[]} [opts.sortCategories]
 *   Sort display names before writing. Default: alphabetical.
 * @param {string} [opts.llmsTxtPath]
 *   Path relative to the dist root where llms.txt is written. Default: 'llms.txt'.
 * @param {string} [opts.llmsTxtTitle]
 *   H1 title in llms.txt. Default: 'Documentation'.
 * @param {string} [opts.llmsTxtDescription]
 *   Blockquote description in llms.txt. Omitted when empty.
 * @param {string|null} [opts.spokesDir]
 *   When set, each category gets its own `llms-{slug}.txt` file under `{spokesDir}/`
 *   and the hub links to them. When null, all entries are inlined in the hub.
 * @param {string[]} [opts.inlineCategories]
 *   Category display names to inline in the hub even when spokesDir is set.
 * @param {string} [opts.mdPathPlaceholder]
 *   Placeholder string in built HTML to replace with the page's .md public URL.
 *   Default: 'LLM_MD_PATH_PLACEHOLDER'.
 * @param {string} [opts.mdLinkId]
 *   ID of a `<link>` element whose href gets rewritten to the .md URL.
 *   Default: 'llm-md-link'.
 */
export default function genMarkdownPages(opts = {}) {
  const {
    indexUrl: configuredIndexUrl = '',
    indexFilter = () => true,
    categorize = (urlPath) => urlPath.split('/').filter(Boolean)[0] || 'root',
    formatCategoryName = defaultFormatCategoryName,
    sortCategories = (names) => [...names].sort(),
    llmsTxtPath = 'llms.txt',
    llmsTxtTitle = 'Documentation',
    llmsTxtDescription = '',
    spokesDir = null,
    inlineCategories = [],
    mdPathPlaceholder = 'LLM_MD_PATH_PLACEHOLDER',
    mdLinkId = 'llm-md-link',
  } = opts;

  let siteUrl = '';

  return {
    name: 'astro-gen-markdown-pages',
    hooks: {
      'astro:config:done': ({ config }) => {
        siteUrl = (config.site || '').replace(/\/$/, '');
      },

      'astro:server:setup': ({ server }) => {
        const llmsTxtDevPath = '/' + llmsTxtPath;
        const llmsTxtDir = path.dirname(llmsTxtPath);
        const wellKnownDevPath =
          llmsTxtDir === '.'
            ? '/.well-known/llms.txt'
            : '/' + llmsTxtDir + '/.well-known/llms.txt';

        server.middlewares.use(async (req, res, next) => {
          const url = req.url ?? '';

          if (url === llmsTxtDevPath || url === wellKnownDevPath) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(
              `# ${llmsTxtTitle} (Dev Mode)\n\nRun a production build to generate the full index.`
            );
            return;
          }

          if (url.includes('?format=md')) {
            try {
              const route = url.split('?')[0];
              const devBase = `http://${req.headers.host}`;
              const response = await fetch(devBase + route);
              if (response.ok) {
                const html = await response.text();
                const devIndexUrl = configuredIndexUrl || `${devBase}/${llmsTxtPath}`;
                const { markdown } = htmlToMarkdown(html, {
                  siteUrl: devBase,
                  indexUrl: devIndexUrl,
                });
                res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
                res.end(markdown);
                return;
              }
            } catch (err) {
              console.error(`[gen-markdown] Error generating MD for ${url}:`, err);
            }
          }

          next();
        });
      },

      'astro:build:done': async ({ dir, logger }) => {
        const log = (msg) => (logger ? logger.info(msg) : console.log(msg));
        log('[gen-markdown] Generating .md companion files...');

        const distDir = dir instanceof URL ? fileURLToPath(dir) : String(dir);
        const htmlFiles = walkHtml(distDir);
        const resolvedIndexUrl =
          configuredIndexUrl || (siteUrl ? `${siteUrl}/${llmsTxtPath}` : '');

        const workerCount = Math.max(1, Math.min(os.cpus().length, htmlFiles.length));
        const chunkSize = Math.ceil(htmlFiles.length / workerCount);
        const chunks = Array.from({ length: workerCount }, (_, i) =>
          htmlFiles.slice(i * chunkSize, (i + 1) * chunkSize)
        ).filter((c) => c.length > 0);

        const allResults = (
          await Promise.all(
            chunks.map((chunk) =>
              spawnWorker(
                chunk,
                distDir,
                siteUrl,
                resolvedIndexUrl,
                mdPathPlaceholder,
                mdLinkId
              )
            )
          )
        )
          .flat()
          .filter(Boolean);

        log(`[gen-markdown] Wrote ${allResults.length} .md files`);

        // Build category display-name → entry-lines map
        const categories = new Map();
        for (const { mdUrl, title, description } of allResults) {
          if (!indexFilter(mdUrl)) continue;
          const key = categorize(mdUrl);
          if (!key) continue;
          const displayName = formatCategoryName(key);
          if (!categories.has(displayName)) categories.set(displayName, []);
          const descText = description ? `: ${description}` : '';
          categories.get(displayName).push(`- [${title}](${siteUrl}${mdUrl})${descText}`);
        }

        const sortedNames = sortCategories(Array.from(categories.keys()));

        let hub = `# ${llmsTxtTitle}\n\n`;
        if (llmsTxtDescription) hub += `> ${llmsTxtDescription}\n\n`;

        if (spokesDir) {
          const inlineSet = new Set(inlineCategories);
          // Inline categories first, then spoke links
          for (const name of sortedNames) {
            if (!inlineSet.has(name)) continue;
            hub += categories.get(name).join('\n') + '\n\n';
          }
          for (const name of sortedNames) {
            if (inlineSet.has(name)) continue;
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const spokeFile = `llms-${slug}.txt`;
            const spokePath = path.join(distDir, spokesDir, spokeFile);
            fs.mkdirSync(path.dirname(spokePath), { recursive: true });
            fs.writeFileSync(spokePath, `# ${name}\n\n${categories.get(name).join('\n')}\n`, 'utf-8');
            hub += `- [${name}](${siteUrl}/${spokesDir}/${spokeFile})\n`;
          }
        } else {
          for (const name of sortedNames) {
            hub += `## ${name}\n\n${categories.get(name).join('\n')}\n\n`;
          }
        }

        const llmsAbsPath = path.join(distDir, llmsTxtPath);
        fs.mkdirSync(path.dirname(llmsAbsPath), { recursive: true });
        fs.writeFileSync(llmsAbsPath, hub, 'utf-8');

        // Mirror at .well-known/llms.txt alongside the hub
        const wellKnown = path.join(path.dirname(llmsAbsPath), '.well-known', 'llms.txt');
        fs.mkdirSync(path.dirname(wellKnown), { recursive: true });
        fs.writeFileSync(wellKnown, hub, 'utf-8');

        log(`[gen-markdown] llms.txt written`);
      },
    },
  };
}
