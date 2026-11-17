import {METRICS, buildTree, parseReport, percent} from './istanbul.js';
import {layout} from './treemap.js';

const LOW = 50;
const HIGH = 80;
const CLASSES = [
  {key: 'good', label: `High ≥ ${HIGH}%`},
  {key: 'mid', label: 'Medium'},
  {key: 'bad', label: `Low < ${LOW}%`},
  {key: 'untested', label: 'Untested'},
];
const GAP_LIMIT = 8;
const DETAIL_LIMIT = 100;

const $ = id => document.getElementById(id);
const el = {
  meta: $('report-meta'), search: $('search'), open: $('open'), file: $('file'),
  start: $('start'), startOpen: $('open-start'), error: $('error'), main: $('main'),
  tabs: $('tabs'), filters: $('filters'), crumbs: $('crumbs'), map: $('map'), panel: $('panel'), tip: $('tip'),
  theme: $('theme'), dialog: $('source'), sourceTitle: $('source-title'), sourceStats: $('source-stats'),
  sourceBlocks: $('source-blocks'), prevMiss: $('prev-miss'), nextMiss: $('next-miss'), sourceClose: $('source-close'),
  codeScroll: $('code-scroll'), gutter: $('gutter'), code: $('code'),
  views: $('views'), toolbar: $('toolbar'), mapPane: $('map-pane'), expandAll: $('expand-all'), collapseAll: $('collapse-all'), files: $('files'), filesCount: $('files-count'), filesBody: $('files-body'),
};
const sortHeads = [...el.files.querySelectorAll('th[data-sort]')];

const LINE_HEIGHT = 20;
const THEME_KEY = 'coverage-theme';

const state = {
  tree: null,
  metric: 'ln',
  view: 'treemap',
  rows: [],
  expanded: new Set(),
  sort: {key: 'ln', direction: 1},
  zoom: '',
  selected: '',
  query: '',
  show: {good: true, mid: true, bad: true, untested: true},
  fileName: '',
  focus: null,
  sources: new Set(),
  sourceNode: null,
  blocks: [],
  block: -1,
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const numberFormat = new Intl.NumberFormat();
const fmt = n => numberFormat.format(n);
const pctText = p => (p === null ? '—' : `${p >= 99.95 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`);
const metricInfo = key => METRICS.find(m => m.key === key);

function classify(node, key = state.metric) {
  const m = node.metrics[key];
  if (m.total === 0) return 'none';
  if (m.covered === 0) return 'untested';
  const p = (m.covered / m.total) * 100;
  return p >= HIGH ? 'good' : p >= LOW ? 'mid' : 'bad';
}

function leaves(node, out = []) {
  if (node.children) node.children.forEach(child => leaves(child, out));
  else out.push(node);
  return out;
}

function folders() {
  return [...state.tree.index.values()].filter(node => node.children && node.parent).map(node => node.path);
}

function panelNode() {
  return state.view === 'list' ? state.tree.root : (state.tree.index.get(state.zoom) ?? state.tree.root);
}

function weightOf(node) {
  return node.metrics.ln.total || node.metrics.st.total;
}

function describe(node) {
  const key = state.metric;
  const info = metricInfo(key);
  const m = node.metrics[key];
  const kind = node.children ? 'Folder' : 'File';
  const value = m.total === 0 ? `no ${info.unit}` : `${pctText(percent(m))} ${info.label.toLowerCase()}, ${fmt(m.covered)} of ${fmt(m.total)}`;
  return `${kind} ${node.path || node.name}, ${value}`;
}

/* ---------- loading ---------- */

function showStart(message) {
  el.start.hidden = false;
  el.main.hidden = true;
  el.search.hidden = true;
  el.views.hidden = true;
  el.meta.textContent = '';
  el.error.hidden = !message;
  el.error.textContent = message ?? '';
}

function load(json, fileName) {
  const report = parseReport(json);
  state.tree = buildTree(report.files);
  state.fileName = fileName;
  state.zoom = '';
  state.selected = '';
  state.query = '';
  el.search.value = '';
  el.start.hidden = true;
  el.main.hidden = false;
  el.search.hidden = false;
  el.views.hidden = false;
  const root = state.tree.root;
  state.rows = leaves(root).map(node => ({node, lower: node.path.toLowerCase()}));
  state.expanded = new Set(state.rows.length <= 200 ? folders() : []);
  el.meta.textContent = `${fileName} · ${fmt(root.fileCount)} files${report.hasDetail ? '' : ' · summary only'}`;
  readHash();
  render();
  loadSourceIndex();
}

let embeddedSources = null;

function readEmbedded() {
  const node = document.getElementById('embedded');
  if (!node) return null;
  try {
    const data = JSON.parse(node.textContent);
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function loadSourceIndex() {
  const tree = state.tree;
  state.sources = new Set();
  if (embeddedSources) {
    state.sources = new Set(Object.keys(embeddedSources));
    renderPanel(panelNode());
    return;
  }
  try {
    const response = await fetch('sources/_index.json');
    if (response.ok && state.tree === tree) state.sources = new Set(await response.json());
  } catch {}
  if (state.tree === tree) renderPanel(panelNode());
}

async function loadFile(file) {
  embeddedSources = null;
  try {
    load(JSON.parse(await file.text()), file.name);
  } catch (error) {
    showStart(error instanceof SyntaxError ? `${file.name} is not valid JSON.` : error.message);
  }
}

async function loadUrl(url) {
  embeddedSources = null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  load(await response.json(), url.split('/').at(-1));
}

async function autoLoad() {
  const embedded = readEmbedded();
  if (embedded) {
    embeddedSources = embedded.sources ?? {};
    try {
      load(embedded.report, embedded.name ?? 'coverage');
    } catch (error) {
      embeddedSources = null;
      showStart(error.message);
    }
    return;
  }
  const explicit = new URLSearchParams(location.search).get('data');
  if (explicit && new URL(explicit, location.href).origin !== location.origin) {
    showStart('?data= must point to a file on this site.');
    return;
  }
  const candidates = explicit ? [explicit] : ['coverage-final.json', 'coverage-summary.json'];
  for (const url of candidates) {
    try {
      await loadUrl(url);
      return;
    } catch (error) {
      if (explicit) {
        showStart(`Could not load ${explicit}. ${error.message}`);
        return;
      }
    }
  }
  showStart();
}

/* ---------- navigation state ---------- */

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const metric = params.get('m');
  state.metric = METRICS.some(m => m.key === metric) ? metric : 'ln';
  state.view = params.get('v') === 'list' ? 'list' : 'treemap';
  const index = state.tree?.index;
  const zoom = params.get('z') ?? '';
  const selected = params.get('s') ?? '';
  state.zoom = index?.get(zoom)?.children ? zoom : '';
  state.selected = index?.has(selected) ? selected : '';
  for (let node = index?.get(state.selected)?.parent; node; node = node.parent) state.expanded.add(node.path);
}

function hashOf(next) {
  const merged = {metric: state.metric, view: state.view, zoom: state.zoom, selected: state.selected, ...next};
  const params = new URLSearchParams();
  if (merged.view === 'list') params.set('v', 'list');
  if (merged.metric !== 'ln') params.set('m', merged.metric);
  if (merged.zoom) params.set('z', merged.zoom);
  if (merged.selected) params.set('s', merged.selected);
  return params.toString();
}

function go(next, focus = null) {
  state.focus = focus;
  const hash = hashOf(next);
  if (hash === location.hash.slice(1)) {
    readHash();
    render();
  } else {
    location.hash = hash;
  }
}

window.addEventListener('hashchange', () => {
  if (!state.tree) return;
  readHash();
  render();
});

/* ---------- rendering ---------- */

function matches(node, memo) {
  if (memo.has(node)) return memo.get(node);
  let result;
  if (node.children) {
    result = node.children.some(child => matches(child, memo));
  } else {
    const cls = classify(node);
    const filtered = cls === 'none' || state.show[cls];
    const query = state.query.trim().toLowerCase();
    result = filtered && (!query || node.path.toLowerCase().includes(query));
  }
  memo.set(node, result);
  return result;
}

function renderTabs(zoomNode) {
  el.tabs.innerHTML = METRICS.map(({key, label}) => {
    const p = percent(zoomNode.metrics[key]);
    return `<button type="button" class="tab" data-metric="${key}" aria-pressed="${key === state.metric}"><span>${label}</span><span class="pct">${pctText(p)}</span></button>`;
  }).join('');
}

function renderFilters(zoomNode) {
  const counts = Object.fromEntries(CLASSES.map(({key}) => [key, 0]));
  leaves(zoomNode).forEach(leaf => {
    const cls = classify(leaf);
    if (cls in counts) counts[cls]++;
  });
  el.filters.innerHTML = CLASSES.map(({key, label}) =>
    `<button type="button" class="chip" data-class="${key}" aria-pressed="${state.show[key]}"><span class="swatch ${key}" aria-hidden="true"></span>${escapeHtml(label)}<span class="n">${fmt(counts[key])}</span></button>`,
  ).join('');
}

function renderCrumbs(zoomNode) {
  const chain = [];
  for (let n = zoomNode; n; n = n.parent) chain.unshift(n);
  el.crumbs.innerHTML = chain.map((n, i) => {
    const current = n === zoomNode;
    const sep = i > 0 ? '<span class="sep" aria-hidden="true">/</span>' : '';
    const label = n.parent ? n.name : state.tree.root.name;
    return `${sep}<button type="button" class="crumb" data-crumb="${escapeHtml(n.path)}"${current ? ' aria-current="location"' : ''}>${escapeHtml(label)}</button>`;
  }).join('');
}

function renderMap(zoomNode) {
  const width = Math.floor(el.map.clientWidth);
  const height = Math.floor(el.map.clientHeight);
  if (width < 2 || height < 2) return;
  const {frames, tiles} = layout(zoomNode, {x: 0, y: 0, w: width, h: height}, state.metric);
  const memo = new Map();
  const rovingId = state.selected && state.tree.index.has(state.selected) && tiles.some(t => t.node.path === state.selected) ? state.selected : null;
  let rovingTaken = false;
  const tab = id => {
    const take = !rovingTaken && (rovingId === null || rovingId === id);
    if (take) rovingTaken = true;
    return take ? 0 : -1;
  };
  const px = n => `${Math.round(n * 100) / 100}px`;
  const pos = r => `left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)}`;

  const parts = [];
  for (const f of frames) {
    const p = percent(f.node.metrics[state.metric]);
    const showPct = f.w > 150;
    parts.push(
      `<div class="frame" style="${pos(f)}"><button type="button" class="frame-head" data-id="${escapeHtml(f.node.path)}" data-dir tabindex="${tab(f.node.path)}" aria-label="${escapeHtml(describe(f.node))}"><span class="name">${escapeHtml(f.node.name)}</span>${showPct ? `<span class="pct">${pctText(p)}</span>` : ''}</button></div>`,
    );
  }
  for (const t of tiles) {
    const node = t.node;
    const cls = classify(node);
    const dim = matches(node, memo) ? '' : ' dim';
    const selected = node.path === state.selected ? ' selected' : '';
    const showLabel = t.w >= 56 && t.h >= 20;
    const showPct = showLabel && t.h >= 38 && t.w >= 44;
    const p = percent(node.metrics[state.metric]);
    parts.push(
      `<button type="button" class="tile ${cls}${dim}${selected}" style="${pos(t)}" data-id="${escapeHtml(node.path)}"${node.children ? ' data-dir' : ''} tabindex="${tab(node.path)}" aria-label="${escapeHtml(describe(node))}">${showLabel ? `<span class="chip-label">${escapeHtml(node.name)}</span>` : ''}${showPct ? `<span class="chip-label sub">${pctText(p)}</span>` : ''}</button>`,
    );
  }
  el.map.innerHTML = parts.join('');
  hideTip();
}

function bar(p, cls) {
  return `<span class="bar"><i class="${cls}" style="width:${p ?? 0}%"></i></span>`;
}

function renderPanel(zoomNode) {
  const node = state.selected ? state.tree.index.get(state.selected) : zoomNode;
  const key = state.metric;
  const info = metricInfo(key);
  const m = node.metrics[key];
  const p = percent(m);
  const cls = classify(node);
  const tag = {good: 'High', mid: 'Medium', bad: 'Low', untested: 'Untested', none: ''}[cls];
  const title = node.parent ? node.name : state.tree.root.name;

  const html = [];
  html.push(`<div class="heading"><span class="kicker">${node.children ? 'Folder' : 'File'}</span><h2>${escapeHtml(title)}</h2>${node.path ? `<span class="sub">${escapeHtml(node.path)}</span>` : ''}</div>`);
  html.push(
    `<div class="hero"><div class="big"><span class="figure">${pctText(p)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>` +
    `<span class="detail">${info.label} · ${m.total === 0 ? `no ${info.unit}` : `${fmt(m.covered)} of ${fmt(m.total)} ${info.unit} covered`}</span>${bar(p, cls)}</div>`,
  );
  html.push(`<div><h3>All metrics</h3><div class="rows">${METRICS.map(({key: k, label}) => metricRow(node, k, label, k === key)).join('')}</div></div>`);

  const actions = [];
  if (state.view === 'list' && node.parent) actions.push(`<button type="button" class="btn" data-treemap="${escapeHtml(node.path)}">Show in treemap</button>`);
  if (!node.children && state.sources.has(node.path)) actions.push(`<button type="button" class="btn" data-source="${escapeHtml(node.path)}">View source</button>`);
  if (actions.length) html.push(`<div class="actions">${actions.join('')}</div>`);

  if (node.children) {
    const gaps = leaves(node)
      .map(leaf => ({leaf, missed: leaf.metrics[key].total - leaf.metrics[key].covered}))
      .filter(g => g.missed > 0)
      .sort((a, b) => b.missed - a.missed)
      .slice(0, GAP_LIMIT);
    if (gaps.length) {
      html.push(`<div><h3>Most uncovered ${info.unit}</h3><ul class="list">${gaps.map(({leaf, missed}) =>
        `<li><button type="button" class="item" data-pick="${escapeHtml(leaf.path)}"><span class="file">${escapeHtml(leaf.name)}<small>${escapeHtml(leaf.parent.path || state.tree.root.name)}</small></span><span class="gap">${fmt(missed)}</span></button></li>`,
      ).join('')}</ul></div>`);
    }
    const unmeasured = leaves(node).filter(leaf => weightOf(leaf) === 0).length;
    if (unmeasured) html.push(`<p class="note">${fmt(unmeasured)} ${unmeasured === 1 ? 'file has' : 'files have'} no statements and ${unmeasured === 1 ? 'is' : 'are'} not drawn.</p>`);
  } else if (node.uncovered?.length) {
    const shown = node.uncovered.slice(0, DETAIL_LIMIT);
    html.push(`<div><h3>Not covered</h3><ul class="list">${shown.map(u =>
      `<li class="plain"><span class="loc">${Number(u.line)}:${Number(u.column)}</span><span class="what">${u.kind === 'statement' ? 'statement' : `${u.kind} ${escapeHtml(u.label)}`}</span></li>`,
    ).join('')}</ul>${node.uncovered.length > shown.length ? `<p class="note">${fmt(node.uncovered.length - shown.length)} more not shown.</p>` : ''}</div>`);
  }
  el.panel.innerHTML = html.join('');
}

function metricRow(node, key, label, active) {
  const m = node.metrics[key];
  const p = percent(m);
  const cls = classify(node, key);
  return `<div class="row"><span class="label${active ? ' on' : ''}">${label}</span>${bar(p, cls)}<span class="v">${pctText(p)}</span><span class="c">${fmt(m.covered)} / ${fmt(m.total)}</span></div>`;
}

function fileCells(node) {
  return METRICS.map(({key}) => {
    const m = node.metrics[key];
    const p = percent(m);
    return `<td><span class="bar"><i class="${classify(node, key)}" style="width:${p ?? 0}%"></i></span><span class="v">${pctText(p)}</span><span class="c">${fmt(m.covered)}/${fmt(m.total)}</span></td>`;
  }).join('');
}

function sortValue(node, key) {
  return key === 'name' ? node.name : (percent(node.metrics[key]) ?? 100);
}

const ROW_CHUNK = 250;
let filesFrame = 0;

const TWISTY = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5"/></svg>';

function collectRows(node, depth, query, out) {
  const {key, direction} = state.sort;
  const children = [...node.children].sort((a, b) => {
    if (Boolean(a.children) !== Boolean(b.children)) return a.children ? -1 : 1;
    const [left, right] = [sortValue(a, key === 'file' ? 'name' : key), sortValue(b, key === 'file' ? 'name' : key)];
    return (left < right ? -1 : left > right ? 1 : a.name.localeCompare(b.name)) * direction;
  });
  let matched = 0;
  for (const child of children) {
    if (!child.children) {
      if (!query || child.path.toLowerCase().includes(query)) {
        out.push({node: child, depth});
        matched++;
      }
      continue;
    }
    const at = out.length;
    out.push({node: child, depth});
    const inner = query || state.expanded.has(child.path) ? collectRows(child, depth + 1, query, out) : 0;
    if (query && inner === 0) out.length = at;
    else matched += inner;
  }
  return matched;
}

function rowHtml({node, depth}) {
  const selected = node.path === state.selected;
  const href = `#${escapeHtml(hashOf({selected: node.path}))}`;
  const path = escapeHtml(node.path);
  const cells = (node.cells ??= fileCells(node));
  const label = `<a href="${href}" data-select="${path}" title="${path}"${selected ? ' aria-current="true"' : ''}>${escapeHtml(node.name)}</a>`;
  if (!node.children) {
    return `<tr${selected ? ' class="selected"' : ''}><td class="file" style="--depth:${depth}"><span class="twisty"></span>${label}</td>${cells}</tr>`;
  }
  const open = state.expanded.has(node.path);
  return `<tr class="dir${selected ? ' selected' : ''}"><td class="file" style="--depth:${depth}"><button type="button" class="twisty" data-toggle="${path}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHtml(node.name)}">${TWISTY}</button>${label}<span class="n">${fmt(node.fileCount)} ${node.fileCount === 1 ? 'file' : 'files'}</span></td>${cells}</tr>`;
}

function renderFiles(sync = false) {
  const {key, direction} = state.sort;
  const query = state.query.trim().toLowerCase();
  const rows = [];
  collectRows(state.tree.root, 0, query, rows);
  const matched = query ? state.rows.filter(row => row.lower.includes(query)).length : state.rows.length;
  cancelAnimationFrame(filesFrame);
  const first = sync ? rows.length : ROW_CHUNK;
  el.filesBody.innerHTML = rows.length ? rows.slice(0, first).map(rowHtml).join('') : '<tr><td class="empty" colspan="5">No files match.</td></tr>';
  let done = first;
  const more = () => {
    if (done >= rows.length) return;
    el.filesBody.insertAdjacentHTML('beforeend', rows.slice(done, done + ROW_CHUNK).map(rowHtml).join(''));
    done += ROW_CHUNK;
    filesFrame = requestAnimationFrame(more);
  };
  filesFrame = requestAnimationFrame(more);
  el.filesCount.textContent = `${fmt(matched)} of ${fmt(state.rows.length)} files`;
  sortHeads.forEach(head => {
    if (head.dataset.sort === key) head.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
    else head.removeAttribute('aria-sort');
  });
}

function render() {
  if (!state.tree) return;
  const list = state.view === 'list';
  el.toolbar.hidden = list;
  el.mapPane.hidden = list;
  el.files.hidden = !list;
  el.views.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
  if (list) {
    hideTip();
    renderFiles(Boolean(state.focus));
    renderPanel(state.tree.root);
    if (state.focus) {
      document.querySelector(state.focus)?.focus();
      state.focus = null;
    }
    return;
  }
  const zoomNode = state.tree.index.get(state.zoom) ?? state.tree.root;
  renderTabs(zoomNode);
  renderFilters(zoomNode);
  renderCrumbs(zoomNode);
  renderMap(zoomNode);
  renderPanel(zoomNode);
  if (state.focus) {
    const target = state.focus === 'first' ? el.map.querySelector('[data-id]') : document.querySelector(state.focus);
    target?.focus();
    state.focus = null;
  }
}

/* ---------- tooltip ---------- */

function hideTip() {
  if (el.tip.matches(':popover-open')) el.tip.hidePopover();
}

function showTip(target, point) {
  const node = state.tree.index.get(target.dataset.id);
  if (!node) return;
  if (el.tip.dataset.id !== target.dataset.id || !el.tip.matches(':popover-open')) {
    el.tip.innerHTML =
      `<div><div class="title">${escapeHtml(node.name)}</div>${node.path ? `<div class="path">${escapeHtml(node.path)}</div>` : ''}</div>` +
      `<div class="rows">${METRICS.map(({key, label}) => metricRow(node, key, label, key === state.metric)).join('')}</div>`;
    el.tip.dataset.id = target.dataset.id;
  }
  if (!el.tip.matches(':popover-open')) el.tip.showPopover();
  const box = target.getBoundingClientRect();
  const anchor = point ?? {x: box.left + box.width / 2, y: box.bottom};
  const w = el.tip.offsetWidth;
  const h = el.tip.offsetHeight;
  const left = Math.min(Math.max(8, anchor.x + 12), window.innerWidth - w - 8);
  const top = anchor.y + 16 + h > window.innerHeight ? Math.max(8, anchor.y - h - 12) : anchor.y + 16;
  el.tip.style.left = `${left}px`;
  el.tip.style.top = `${top}px`;
}

/* ---------- interaction ---------- */

function activate(target, clicks) {
  const node = state.tree.index.get(target.dataset.id);
  if (!node) return;
  if (node.children) {
    go({zoom: node.path, selected: ''}, 'first');
    return;
  }
  const again = clicks >= 2 || (clicks === 0 && node.path === state.selected);
  if (again && state.sources.has(node.path)) {
    hideTip();
    openSource(node);
    return;
  }
  go({selected: node.path}, `[data-id="${CSS.escape(node.path)}"]`);
}

/* ---------- source preview ---------- */

const lineStartsOf = text => {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
};

let registered = [];

function clearHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  registered.forEach(name => CSS.highlights.delete(name));
  registered = [];
}

function applyHighlights(data, missLines) {
  if (!CSS.highlights || typeof Highlight === 'undefined') return;
  const text = el.code.firstChild;
  if (!text) return;
  const groups = new Map();
  const add = (name, start, end) => {
    const range = new Range();
    range.setStart(text, start);
    range.setEnd(text, end);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(range);
  };
  for (let i = 0; i < data.ranges.length; i += 3) add(data.categories[data.ranges[i]], data.ranges[i + 1], data.ranges[i + 2]);
  if (missLines.length) {
    const starts = lineStartsOf(data.text);
    for (const line of missLines) {
      const start = starts[line - 1];
      const end = (starts[line] ?? data.text.length + 1) - 1;
      if (end > start) add('cov-miss', start, end);
    }
  }
  for (const [name, ranges] of groups) {
    CSS.highlights.set(name, new Highlight(...ranges));
    registered.push(name);
  }
}

function missBlocks(hits) {
  if (!hits) return {lines: [], blocks: []};
  const lines = Object.keys(hits).map(Number).sort((a, b) => a - b);
  const miss = lines.filter(line => hits[line] === 0);
  const blocks = [];
  let open = false;
  for (const line of lines) {
    if (hits[line] === 0) {
      if (!open) blocks.push(line);
      open = true;
    } else {
      open = false;
    }
  }
  return {lines: miss, blocks};
}

function jumpToBlock(step) {
  if (!state.blocks.length) return;
  state.block = (state.block + step + state.blocks.length) % state.blocks.length;
  const line = state.blocks[state.block];
  el.codeScroll.scrollTo({top: Math.max(0, 8 + (line - 1) * LINE_HEIGHT - el.codeScroll.clientHeight / 3)});
  el.sourceBlocks.textContent = `${state.block + 1} of ${state.blocks.length}`;
}

async function openSource(node) {
  state.sourceNode = node;
  clearHighlights();
  el.code.textContent = '';
  el.gutter.innerHTML = '';
  el.sourceTitle.textContent = node.path;
  const lines = node.metrics.ln;
  el.sourceStats.textContent = lines.total ? `${pctText(percent(lines))} lines · ${fmt(lines.covered)} of ${fmt(lines.total)}` : '';
  el.sourceBlocks.textContent = '';
  [el.prevMiss, el.nextMiss].forEach(button => (button.hidden = true));
  state.blocks = [];
  state.block = -1;
  if (!el.dialog.open) el.dialog.showModal();
  el.codeScroll.scrollTo({top: 0});
  try {
    let data = embeddedSources && Object.hasOwn(embeddedSources, node.path) ? embeddedSources[node.path] : null;
    if (!data) {
      const response = await fetch(`sources/${node.path.split('/').map(encodeURIComponent).join('/')}.json`);
      if (!response.ok) throw new Error(String(response.status));
      data = await response.json();
    }
    if (state.sourceNode !== node) return;
    const rows = data.text.split('\n');
    if (rows.length > 1 && rows.at(-1) === '') rows.pop();
    el.code.textContent = data.text;
    el.gutter.innerHTML = rows.map((_, i) => {
      const hits = data.hits?.[i + 1];
      const cls = hits === undefined ? '' : hits > 0 ? ' hit' : ' miss';
      return `<div class="gl${cls}"><span class="n">${i + 1}</span><span class="h">${hits === undefined ? '' : fmt(hits)}</span></div>`;
    }).join('');
    const {lines: missLines, blocks} = missBlocks(data.hits);
    applyHighlights(data, missLines);
    state.blocks = blocks;
    [el.prevMiss, el.nextMiss].forEach(button => (button.hidden = blocks.length === 0));
  } catch {
    if (state.sourceNode !== node) return;
    el.code.textContent = `Could not load the source of ${node.path}.`;
  }
}

el.dialog.addEventListener('close', () => {
  clearHighlights();
  el.code.textContent = '';
  el.gutter.innerHTML = '';
  const node = state.sourceNode;
  state.sourceNode = null;
  if (node) el.map.querySelector(`[data-id="${CSS.escape(node.path)}"]`)?.focus();
});
el.dialog.addEventListener('click', event => {
  if (event.target === el.dialog) el.dialog.close();
});
el.sourceClose.addEventListener('click', () => el.dialog.close());
el.prevMiss.addEventListener('click', () => jumpToBlock(-1));
el.nextMiss.addEventListener('click', () => jumpToBlock(1));

function spatialTarget(current, candidates, dir) {
  const a = current.getBoundingClientRect();
  const tolerance = 1;
  let best = null;
  for (const c of candidates) {
    if (c === current || !c.checkVisibility()) continue;
    const b = c.getBoundingClientRect();
    const gap = {right: b.left - a.right, left: a.left - b.right, down: b.top - a.bottom, up: a.top - b.bottom}[dir];
    if (gap < -tolerance) continue;
    const horizontal = dir === 'left' || dir === 'right';
    const overlap = horizontal ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0 : Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
    const offset = horizontal ? Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) : Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
    const score = overlap ? [0, Math.max(0, gap), offset] : [1, Math.max(0, gap) + 2 * offset, 0];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
      best = {el: c, score};
    }
  }
  return best?.el ?? null;
}

el.map.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const current = event.target.closest('[data-id]');
  if (!current) return;
  const dir = {ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up'}[event.key];
  if (dir) {
    const next = spatialTarget(current, el.map.querySelectorAll('[data-id]'), dir);
    if (!next) return;
    event.preventDefault();
    el.map.querySelectorAll('[data-id][tabindex="0"]').forEach(n => (n.tabIndex = -1));
    next.tabIndex = 0;
    next.focus();
    next.scrollIntoView({block: 'nearest', inline: 'nearest'});
  } else if (event.key === 'Backspace') {
    const parent = state.tree.index.get(state.zoom)?.parent;
    if (!parent) return;
    event.preventDefault();
    go({zoom: parent.path, selected: ''}, 'first');
  } else if (event.key === 'Escape') {
    hideTip();
  }
});

el.map.addEventListener('click', event => {
  const target = event.target.closest('[data-id]');
  if (target) activate(target, event.detail);
});

el.map.addEventListener('pointermove', event => {
  const target = event.target.closest('[data-id]');
  if (target) showTip(target, {x: event.clientX, y: event.clientY});
  else hideTip();
});
el.map.addEventListener('pointerleave', hideTip);
el.map.addEventListener('focusin', event => {
  const target = event.target.closest('[data-id]');
  if (target && event.target.matches(':focus-visible')) showTip(target, null);
});
el.map.addEventListener('focusout', hideTip);

el.tabs.addEventListener('click', event => {
  const button = event.target.closest('[data-metric]');
  if (button) go({metric: button.dataset.metric}, `[data-metric="${button.dataset.metric}"]`);
});

el.filters.addEventListener('click', event => {
  const button = event.target.closest('[data-class]');
  if (!button) return;
  state.show[button.dataset.class] = !state.show[button.dataset.class];
  state.focus = `[data-class="${button.dataset.class}"]`;
  render();
});

el.crumbs.addEventListener('click', event => {
  const button = event.target.closest('[data-crumb]');
  if (button && !button.hasAttribute('aria-current')) go({zoom: button.dataset.crumb, selected: ''}, `[data-crumb="${CSS.escape(button.dataset.crumb)}"]`);
});

el.panel.addEventListener('click', event => {
  const source = event.target.closest('[data-source]');
  if (source) {
    const node = state.tree.index.get(source.dataset.source);
    if (node) openSource(node);
    return;
  }
  const open = event.target.closest('[data-treemap]');
  if (open) {
    const node = state.tree.index.get(open.dataset.treemap);
    if (node) go(node.children ? {view: 'treemap', zoom: node.path, selected: ''} : {view: 'treemap', zoom: node.parent.path, selected: node.path}, 'first');
    return;
  }
  const button = event.target.closest('[data-pick]');
  if (!button) return;
  const node = state.tree.index.get(button.dataset.pick);
  if (node && state.view === 'list') go({selected: node.path}, `[data-select="${CSS.escape(node.path)}"]`);
  else if (node) go({zoom: node.parent.path, selected: node.path}, `[data-id="${CSS.escape(node.path)}"]`);
});

el.views.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button && button.dataset.view !== state.view) go({view: button.dataset.view}, `[data-view="${button.dataset.view}"]`);
});

el.files.querySelector('thead').addEventListener('click', event => {
  const head = event.target.closest('th[data-sort]');
  if (!head) return;
  const key = head.dataset.sort;
  state.sort = {key, direction: state.sort.key === key ? -state.sort.direction : 1};
  renderFiles();
});

el.filesBody.addEventListener('click', event => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const path = toggle.dataset.toggle;
    if (!state.expanded.delete(path)) state.expanded.add(path);
    renderFiles(true);
    el.filesBody.querySelector(`[data-toggle="${CSS.escape(path)}"]`)?.focus();
    return;
  }
  const link = event.target.closest('[data-select]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go({selected: link.dataset.select}, `[data-select="${CSS.escape(link.dataset.select)}"]`);
});

el.expandAll.addEventListener('click', () => {
  state.expanded = new Set(folders());
  renderFiles(true);
});

el.collapseAll.addEventListener('click', () => {
  state.expanded.clear();
  renderFiles(true);
});

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  if (state.view === 'list') {
    renderFiles();
    return;
  }
  const zoomNode = state.tree.index.get(state.zoom) ?? state.tree.root;
  renderMap(zoomNode);
});

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

const THEME_MODES = ['system', 'light', 'dark'];

function setThemeMode(mode) {
  applyTheme(mode);
  el.theme.dataset.mode = mode;
  el.theme.setAttribute('aria-label', `Theme: ${mode}. Switch to ${THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % 3]}`);
  el.theme.title = `Theme: ${mode}`;
}

try {
  const stored = localStorage.getItem(THEME_KEY);
  setThemeMode(stored === 'light' || stored === 'dark' ? stored : 'system');
} catch {
  setThemeMode('system');
}

el.theme.addEventListener('click', () => {
  const mode = THEME_MODES[(THEME_MODES.indexOf(el.theme.dataset.mode) + 1) % 3];
  setThemeMode(mode);
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {}
});

[el.open, el.startOpen].forEach(button => button.addEventListener('click', () => el.file.click()));
el.file.addEventListener('change', () => {
  const [file] = el.file.files;
  if (file) loadFile(file);
  el.file.value = '';
});

window.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    el.start.classList.add('dragging');
  }
});
window.addEventListener('dragleave', event => {
  if (event.relatedTarget === null) el.start.classList.remove('dragging');
});
window.addEventListener('drop', event => {
  const [file] = event.dataTransfer?.files ?? [];
  el.start.classList.remove('dragging');
  if (!file) return;
  event.preventDefault();
  loadFile(file);
});

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (state.tree) renderMap(state.tree.index.get(state.zoom) ?? state.tree.root);
  });
}).observe(el.map);

autoLoad();
