/**
 * tools/build-web.mjs
 * ---------------------------------------------------------------------------
 * Builds docs/ (the GitHub Pages deploy root) from web/.
 *
 * web/app.js and web/telemetry.js import the shared engine via paths like
 * '../core/EventBus.js', which only resolve correctly when web/ sits next to
 * core/, state/, data/, models/, engine/, ui/ at the repo root (as it does
 * locally). A plain `cp -r web/* docs/` copies those files flat into docs/
 * without ever bringing the directories they import from along, and
 * '../core/EventBus.js' from a file living AT the site root (docs/app.js on
 * GitHub Pages) resolves outside the deployed tree entirely — a 404 that
 * fails the whole module script and silently leaves every button (including
 * "Commencer") unwired, with no visible error unless the browser console is
 * open on the Network tab.
 *
 * Fix: copy the referenced source directories into docs/ as well (as
 * siblings of docs/app.js, excluding *.test.js), then rewrite the '../X/'
 * import specifiers in the copied entry files to './X/' so they point at
 * those freshly-copied siblings instead of climbing above the site root.
 * Directories are copied wholesale (not just the files app.js happens to
 * import) so their own internal cross-imports (e.g. engine/*.js importing
 * '../data/balance.js') keep resolving unchanged, since every directory
 * keeps the same relative position to every other one it had at the repo
 * root.
 * ---------------------------------------------------------------------------
 */

import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');
const DOCS_DIR = path.join(ROOT, 'docs');

/** Top-level repo directories that web/app.js and web/telemetry.js import from via '../<dir>/...'. */
const SHARED_DIRS = ['core', 'state', 'data', 'models', 'engine', 'ui'];

/** Entry files copied from web/ whose '../<dir>/' imports must become './<dir>/' once they live at the docs/ root. */
const ENTRY_FILES_TO_REWRITE = ['app.js', 'telemetry.js'];

function removeTestFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTestFiles(full);
    else if (entry.name.endsWith('.test.js')) rmSync(full);
  }
}

function main() {
  rmSync(DOCS_DIR, { recursive: true, force: true });
  mkdirSync(DOCS_DIR, { recursive: true });

  cpSync(WEB_DIR, DOCS_DIR, { recursive: true });
  removeTestFiles(DOCS_DIR);

  for (const dirName of SHARED_DIRS) {
    const src = path.join(ROOT, dirName);
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    const dest = path.join(DOCS_DIR, dirName);
    cpSync(src, dest, { recursive: true });
    removeTestFiles(dest);
  }

  for (const fileName of ENTRY_FILES_TO_REWRITE) {
    const filePath = path.join(DOCS_DIR, fileName);
    if (!existsSync(filePath)) continue;
    const original = readFileSync(filePath, 'utf8');
    let rewritten = original;
    for (const dirName of SHARED_DIRS) {
      rewritten = rewritten.replaceAll(`'../${dirName}/`, `'./${dirName}/`);
    }
    if (rewritten !== original) writeFileSync(filePath, rewritten);
  }

  writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');

  console.log(`[build-web] docs/ built from web/ + [${SHARED_DIRS.join(', ')}] with import paths rewritten for site-root deployment.`);
}

main();
