// Writes an Istanbul coverage-final.json for demos. It walks a real source tree for paths and sizes;
// the hit counts are synthetic and deterministic. Usage: node tools/make-sample.mjs <root> <out> [subdir...]
import {readFileSync, readdirSync, statSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const out = path.resolve(process.argv[3] ?? 'public/sample/coverage-final.json');
const subdirs = process.argv.slice(4).length ? process.argv.slice(4) : ['.'];
const skip = /(^|\/)(node_modules|dist|build|coverage|tests?|__mocks__|\.git)(\/|$)|\.(test|spec|stories|d)\.[jt]sx?$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (skip.test(rel)) continue;
    const info = statSync(full);
    if (info.isDirectory()) yield* walk(full);
    else if (/\.[jt]sx?$/.test(name)) yield {full, rel};
  }
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const report = {};
for (const {full, rel} of subdirs.flatMap(sub => [...walk(path.join(root, sub))])) {
  const lines = readFileSync(full, 'utf8').split('\n');
  const rand = random(hash(rel));
  const folder = rel.split('/').slice(0, 3).join('/');
  const bias = random(hash(folder))();
  const tested = rand() < 0.15 + bias * 0.8;
  const quality = tested ? 0.35 + bias * 0.6 : 0;
  const entry = {path: `/${rel}`, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {}};
  const at = (line, column) => ({line, column});
  lines.forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed || /^(\/\/|\/\*|\*|import |export \{|\}|\)|\]|<\/)/.test(trimmed)) return;
    const id = String(Object.keys(entry.statementMap).length);
    entry.statementMap[id] = {start: at(i + 1, text.length - text.trimStart().length), end: at(i + 1, text.length)};
    entry.s[id] = rand() < quality ? 1 + Math.floor(rand() * 20) : 0;
    if (/=>|function\b/.test(trimmed)) {
      const fid = String(Object.keys(entry.fnMap).length);
      const name = /(?:function\s+|const\s+|let\s+)([A-Za-z0-9_$]+)/.exec(trimmed)?.[1] ?? '(anonymous)';
      entry.fnMap[fid] = {name, decl: entry.statementMap[id], loc: entry.statementMap[id], line: i + 1};
      entry.f[fid] = entry.s[id];
    }
    if (/\bif\b|\?|&&|\|\|/.test(trimmed)) {
      const bid = String(Object.keys(entry.branchMap).length);
      entry.branchMap[bid] = {type: /\bif\b/.test(trimmed) ? 'if' : 'binary-expr', loc: entry.statementMap[id], locations: [entry.statementMap[id], entry.statementMap[id]], line: i + 1};
      entry.b[bid] = [entry.s[id], rand() < quality * 0.8 ? 1 + Math.floor(rand() * 5) : 0];
    }
  });
  report[entry.path] = entry;
}

mkdirSync(path.dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify(report));
console.log(`${Object.keys(report).length} files -> ${out}`);
