export const METRICS = [
  {key: 'st', label: 'Statements', unit: 'statements'},
  {key: 'br', label: 'Branches', unit: 'branches'},
  {key: 'fn', label: 'Functions', unit: 'functions'},
  {key: 'ln', label: 'Lines', unit: 'lines'},
];

const SUMMARY_KEYS = {st: 'statements', br: 'branches', fn: 'functions', ln: 'lines'};

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const position = at => (at && Number.isFinite(Number(at.line)) ? {line: Number(at.line), column: num(at.column)} : null);

const count = hits => ({covered: hits.filter(n => n > 0).length, total: hits.length});

function fromFinal(entry) {
  const statementIds = Object.keys(entry.statementMap ?? {});
  const lineHits = new Map();
  for (const id of statementIds) {
    const line = num(entry.statementMap[id].start?.line);
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, entry.s[id] ?? 0));
  }
  const branchHits = Object.values(entry.b ?? {}).flat();
  const uncovered = [];
  for (const id of statementIds) {
    if (!entry.s[id]) {
      const at = position(entry.statementMap[id].start);
      if (at) uncovered.push({kind: 'statement', ...at, label: 'statement'});
    }
  }
  for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
    if (!entry.f[id]) {
      const at = position(fn.loc?.start) ?? position(fn.decl?.start);
      if (at) uncovered.push({kind: 'function', ...at, label: String(fn.name || '(anonymous)')});
    }
  }
  for (const [id, branch] of Object.entries(entry.branchMap ?? {})) {
    (entry.b[id] ?? []).forEach((hits, index) => {
      if (hits) return;
      const at = position(branch.locations?.[index]?.start) ?? position(branch.loc?.start);
      if (at) uncovered.push({kind: 'branch', ...at, label: `${String(branch.type)} #${index + 1}`});
    });
  }
  uncovered.sort((a, b) => a.line - b.line || a.column - b.column);
  return {
    lineHits: Object.fromEntries(lineHits),
    metrics: {
      st: count(statementIds.map(id => entry.s[id] ?? 0)),
      br: count(branchHits),
      fn: count(Object.keys(entry.fnMap ?? {}).map(id => entry.f[id] ?? 0)),
      ln: count([...lineHits.values()]),
    },
    uncovered,
  };
}

function fromSummary(entry) {
  const metrics = {};
  for (const [key, name] of Object.entries(SUMMARY_KEYS)) {
    metrics[key] = {covered: entry[name]?.covered ?? 0, total: entry[name]?.total ?? 0};
  }
  return {metrics, uncovered: null};
}

export function parseReport(json) {
  if (json === null || typeof json !== 'object') throw new Error('The file is not a JSON object.');
  const isSummary = Boolean(json.total?.lines);
  const files = [];
  for (const [key, entry] of Object.entries(json)) {
    if (key === 'total' || entry === null || typeof entry !== 'object') continue;
    const path = (entry.path ?? key).replaceAll('\\', '/');
    if (isSummary) {
      if (!entry.lines) continue;
      files.push({path, ...fromSummary(entry)});
    } else {
      if (!entry.statementMap) continue;
      files.push({path, ...fromFinal(entry)});
    }
  }
  if (files.length === 0) throw new Error('No files found. Expected Istanbul coverage-final.json or coverage-summary.json.');
  return {files, hasDetail: !isSummary};
}

function normalizeParts(filePath) {
  const parts = [];
  for (const part of filePath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.length ? parts : ['(unnamed)'];
}

export function buildTree(files) {
  const split = files.map(file => ({file, parts: normalizeParts(file.path)}));
  let prefix = split[0].parts.slice(0, -1);
  for (const {parts} of split) {
    let i = 0;
    while (i < prefix.length && i < parts.length - 1 && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const root = newDir('', prefix.at(-1) ?? 'All files');
  const index = new Map([['', root]]);
  for (const {file, parts} of split) {
    let dir = root;
    const rel = parts.slice(prefix.length);
    rel.slice(0, -1).forEach((name, i) => {
      const path = rel.slice(0, i + 1).join('/');
      let next = index.get(path);
      if (!next) {
        next = newDir(path, name, dir);
        dir.children.push(next);
        index.set(path, next);
      }
      dir = next;
    });
    const path = rel.join('/');
    const leaf = {path, name: rel.at(-1), parent: dir, children: null, file, metrics: file.metrics, fileCount: 1, uncovered: file.uncovered};
    dir.children.push(leaf);
    index.set(path, leaf);
  }
  collapse(root);
  index.clear();
  finalize(root, index);
  return {root, index, hasDetail: files.some(f => f.uncovered)};
}

function newDir(path, name, parent = null) {
  return {path, name, parent, children: [], file: null};
}

function collapse(node) {
  for (const child of node.children ?? []) {
    if (!child.children) continue;
    while (child.children.length === 1 && child.children[0].children) {
      const only = child.children[0];
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.children = only.children;
      child.children.forEach(grandchild => (grandchild.parent = child));
    }
    collapse(child);
  }
}

function finalize(node, index) {
  index.set(node.path, node);
  if (!node.children) return;
  node.metrics = Object.fromEntries(METRICS.map(({key}) => [key, {covered: 0, total: 0}]));
  node.fileCount = 0;
  for (const child of node.children) {
    finalize(child, index);
    node.fileCount += child.fileCount;
    for (const {key} of METRICS) {
      node.metrics[key].covered += child.metrics[key].covered;
      node.metrics[key].total += child.metrics[key].total;
    }
  }
  node.children.sort((a, b) => b.metrics.ln.total - a.metrics.ln.total || a.name.localeCompare(b.name));
}

export function percent({covered, total}) {
  return total === 0 ? null : (covered / total) * 100;
}
