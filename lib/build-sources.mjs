// Pre-highlights the sources of an Istanbul report so the page needs no grammars at runtime.
// MicroLighter registers its tokens as CSS Custom Highlight ranges; here it runs under jsdom and the
// ranges are saved as offsets into the file text.
import {mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {buildTree, parseReport} from '../src/istanbul.js';

const MAX_BYTES = 400_000;
const LANGUAGES = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', py: 'python', java: 'java', kt: 'kotlin',
};

let highlightAll;
const highlights = new Map();

async function setup() {
  if (highlightAll) return;
  const {JSDOM} = await import('jsdom');
  const {window} = new JSDOM('<!doctype html><body></body>');
  globalThis.document = window.document;
  globalThis.Range = window.Range;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Highlight = class Highlight extends Set {};
  globalThis.CSS = {highlights};
  ({highlightAll} = await import('microlighter'));
}

async function highlight(text, language) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = `language-${language}`;
  code.textContent = text;
  pre.append(code);
  document.body.append(pre);
  highlights.clear();
  await highlightAll({root: pre.parentElement});
  const categories = [];
  const ranges = [];
  for (const [category, set] of highlights) {
    const index = categories.push(category) - 1;
    for (const range of set) ranges.push([range.startOffset, range.endOffset, index]);
  }
  pre.remove();
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {categories, ranges: ranges.flatMap(([start, end, index]) => [index, start, end])};
}

const within = (base, target) => target === base || target.startsWith(base + path.sep);

const isReadableFile = file => {
  try {
    const info = statSync(file);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
};

/**
 * @param {{reportPath: string, out: string, root?: string | null}} options
 * Sources are read only from under `root` and the current directory. Report paths outside them are
 * ignored and looked up under `root` by their tree path instead (CI paths).
 */
export async function buildSources({reportPath, out, root = null}) {
  await setup();
  const report = parseReport(JSON.parse(readFileSync(reportPath, 'utf8')));
  const tree = buildTree(report.files);
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});

  const outDir = path.resolve(out);
  const allowed = [root, process.cwd()].filter(Boolean).map(dir => path.resolve(dir));
  const available = [];
  const skipped = {missing: 0, large: 0};
  for (const node of tree.index.values()) {
    if (node.children) continue;
    const candidates = [
      allowed.some(base => within(base, path.resolve(node.file.path))) ? path.resolve(node.file.path) : null,
      root ? path.join(path.resolve(root), node.path) : null,
    ].filter(Boolean);
    const source = candidates.find(candidate => isReadableFile(candidate));
    if (!source) {
      skipped.missing++;
      continue;
    }
    if (isReadableFile(source).size > MAX_BYTES) {
      skipped.large++;
      continue;
    }
    const text = readFileSync(source, 'utf8');
    const language = LANGUAGES[path.extname(source).slice(1).toLowerCase()];
    const tokens = language ? await highlight(text, language) : {categories: [], ranges: []};
    const target = path.resolve(outDir, `${node.path}.json`);
    if (!within(outDir, target)) {
      skipped.missing++;
      continue;
    }
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, JSON.stringify({text, categories: tokens.categories, ranges: tokens.ranges, hits: node.file.lineHits ?? null}));
    available.push(node.path);
  }
  writeFileSync(path.join(out, '_index.json'), JSON.stringify(available));
  return {count: available.length, skipped, maxBytes: MAX_BYTES};
}
