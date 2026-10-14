/**
 * Map thumbnails. The board computes one from its items (computePreview) and
 * sends it with its edits; the maps list draws it (renderPreview). It is only
 * numbers and colours, built into SVG with DOM calls, never parsed markup.
 */

const KIND_CODE = { sticky: 's', step: 'p', decision: 'd', terminal: 't', text: 'x', lane: 'l' };
const MAX = 400;
const SVG = 'http://www.w3.org/2000/svg';

export function computePreview(items) {
  const nodes = items.filter((i) => i.kind !== 'connector');
  if (!nodes.length) return { w: 0, h: 0, shapes: [], links: [] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  const scale = 1000 / Math.max(maxX - minX, maxY - minY, 1);
  const sx = (x) => Math.round((x - minX) * scale);
  const sy = (y) => Math.round((y - minY) * scale);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = [...nodes].sort((a, b) => (a.kind === 'lane') === (b.kind === 'lane') ? a.z - b.z : a.kind === 'lane' ? -1 : 1);
  const shapes = ordered.slice(0, MAX).map((n) => [
    KIND_CODE[n.kind], sx(n.x), sy(n.y), Math.max(1, Math.round(n.w * scale)), Math.max(1, Math.round(n.h * scale)),
    /^#[0-9a-f]{6}$/i.test(n.color) ? n.color : '#ffffff',
  ]);
  const links = [];
  for (const c of items) {
    if (c.kind !== 'connector' || links.length >= MAX) continue;
    const a = byId.get(c.from?.id);
    const b = byId.get(c.to?.id);
    if (!a || !b) continue;
    links.push([sx(a.x + a.w / 2), sy(a.y + a.h / 2), sx(b.x + b.w / 2), sy(b.y + b.h / 2)]);
  }
  return { w: sx(maxX), h: sy(maxY), shapes, links };
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function renderPreview(preview) {
  const root = svg('svg', { viewBox: '-40 -40 1080 1080', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  if (!preview || !preview.shapes?.length) {
    root.setAttribute('viewBox', '0 0 400 140');
    root.append(svg('rect', { x: 150, y: 46, width: 100, height: 48, rx: 8, fill: '#fff', stroke: '#d4d4cd', 'stroke-width': 2, 'stroke-dasharray': '6 5' }));
    return root;
  }
  // Fit the content's own aspect inside the card, centred.
  const pad = 40;
  root.setAttribute('viewBox', `${-pad} ${-pad} ${preview.w + pad * 2} ${preview.h + pad * 2}`);
  const stroke = Math.max(2, Math.max(preview.w, preview.h) / 260);
  const drawShape = ([k, x, y, w, h, c]) => {
    if (k === 'd') {
      root.append(svg('polygon', { points: `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`, fill: c, stroke: '#9aa1aa', 'stroke-width': stroke }));
    } else if (k === 'x') {
      root.append(svg('rect', { x, y: y + h * 0.35, width: w, height: Math.max(stroke, h * 0.3), rx: 2, fill: '#c3c7cd' }));
    } else {
      const rx = k === 't' ? h / 2 : k === 'p' ? Math.min(h / 5, 14) : k === 'l' ? 6 : 1;
      root.append(svg('rect', {
        x, y, width: w, height: h, rx, fill: c,
        stroke: k === 's' ? 'none' : '#a9afb7', 'stroke-width': k === 'l' ? stroke * 0.8 : stroke,
      }));
    }
  };
  // Lanes underneath, then the links, then everything else on top.
  preview.shapes.filter((s) => s[0] === 'l').forEach(drawShape);
  for (const [x1, y1, x2, y2] of preview.links) {
    root.append(svg('line', { x1, y1, x2, y2, stroke: '#8a9099', 'stroke-width': stroke }));
  }
  preview.shapes.filter((s) => s[0] !== 'l').forEach(drawShape);
  return root;
}
