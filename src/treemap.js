function worst(row, side) {
  const sum = row.reduce((s, r) => s + r.area, 0);
  const max = Math.max(...row.map(r => r.area));
  const min = Math.min(...row.map(r => r.area));
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

export function squarify(items, rect) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const queue = items.map(item => ({item, area: item.weight * scale}));
  const out = [];
  let {x, y, w, h} = rect;
  let row = [];
  const flush = () => {
    if (row.length === 0) return;
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      const colW = sum / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / colW;
        out.push({item: r.item, x, y: cy, w: colW, h: rh});
        cy += rh;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = sum / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rowH;
        out.push({item: r.item, x: cx, y, w: rw, h: rowH});
        cx += rw;
      }
      y += rowH;
      h -= rowH;
    }
    row = [];
  };
  for (const entry of queue) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, entry], side) <= worst(row, side)) {
      row.push(entry);
    } else {
      flush();
      row.push(entry);
    }
  }
  flush();
  return out;
}

const HEADER = 18;
const MIN_FRAME_W = 72;
const MIN_FRAME_H = 44;
const MIN_TILE = 3;

export function layout(node, rect, metricKey) {
  const frames = [];
  const tiles = [];
  const weightOf = n => n.metrics.ln.total || n.metrics.st.total;
  const place = (parent, box) => {
    const kids = parent.children.filter(c => weightOf(c) > 0);
    const rects = squarify(kids.map(c => ({node: c, weight: weightOf(c)})), box);
    for (const r of rects) {
      if (r.w < MIN_TILE || r.h < MIN_TILE) continue;
      const child = r.item.node;
      if (child.children && r.w >= MIN_FRAME_W && r.h >= MIN_FRAME_H) {
        frames.push({node: child, x: r.x, y: r.y, w: r.w, h: r.h});
        place(child, {x: r.x + 1, y: r.y + HEADER, w: r.w - 2, h: r.h - HEADER - 1});
      } else {
        tiles.push({node: child, x: r.x, y: r.y, w: r.w, h: r.h});
      }
    }
  };
  if (node.children) place(node, rect);
  else tiles.push({node, ...rect});
  return {frames, tiles, metricKey};
}
