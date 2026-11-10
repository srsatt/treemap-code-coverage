// Writes the viewer, a report and its pre-highlighted sources as one HTML file with no external requests.
import {readdirSync, readFileSync, statSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

import {parseReport} from '../src/istanbul.js';

const breakout = /<(\/script|\/style|!--)/i;
const inline = (text, what) => {
  if (breakout.test(text)) throw new Error(`The viewer ${what} contains a sequence that cannot be inlined.`);
  return text;
};
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function readSources(sourcesDir) {
  const base = path.join(sourcesDir, 'sources');
  const sources = new Map();
  for (const name of JSON.parse(readFileSync(path.join(base, '_index.json'), 'utf8'))) {
    sources.set(name, JSON.parse(readFileSync(path.join(base, `${name}.json`), 'utf8')));
  }
  return Object.fromEntries(sources);
}

/** @returns {number} size of the written file in bytes */
export function exportHtml({reportPath, sourcesDir, out, name, dist}) {
  let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  parseReport(report);
  const sources = sourcesDir ? readSources(sourcesDir) : {};

  html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/, (_, file) => `<style>${inline(readFileSync(path.join(dist, file), 'utf8'), 'stylesheet')}</style>`);
  const script = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/);
  if (!script) throw new Error('The built viewer is missing its script.');
  html = html.replace(script[0], '');
  const embedded = `<script type="application/json" id="embedded">${safeJson({name, report, sources})}</script>`;
  const code = `<script type="module">${inline(readFileSync(path.join(dist, script[1]), 'utf8'), 'script')}</script>`;
  html = html.replace('</body>', () => `${embedded}\n${code}\n</body>`);

  mkdirSync(path.dirname(out), {recursive: true});
  writeFileSync(out, html);
  return Buffer.byteLength(html);
}
