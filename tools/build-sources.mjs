// Development helper: writes pre-highlighted sources into public/ for `npm run dev`.
// Usage: node tools/build-sources.mjs <report.json> [--root <dir>] [--out public/sources]
import path from 'node:path';

import {buildSources} from '../lib/build-sources.mjs';

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : args.splice(i, 2)[1];
};
const root = option('--root');
const out = path.resolve(option('--out') ?? 'public/sources');
const [reportPath] = args;
if (!reportPath) {
  console.error('Usage: node tools/build-sources.mjs <report.json> [--root <dir>] [--out public/sources]');
  process.exit(1);
}
const {count, skipped, maxBytes} = await buildSources({reportPath, out, root});
console.log(`${count} sources -> ${out} (${skipped.missing} not found, ${skipped.large} over ${maxBytes / 1000} KB)`);
