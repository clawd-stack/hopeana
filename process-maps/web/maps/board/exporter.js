import { arrowPath, boundsOf, isNode, linePath, midpoint, pointsBounds, routeConnector } from './geometry.js';
import { FLAGS, borderFor, fontSize, laneHeadFor, mix } from './palette.js';

/**
 * Exports. The PNG is drawn from the items with the same geometry the board
 * uses, rather than screenshotting the page, so it is sharp at any size and
 * looks the same for everybody. It is meant for pasting into Notion, an IC
 * pack or an email.
 */

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MAX_PIXELS = 4800;

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const safeName = (name) => (String(name || 'process-map').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'process-map');

export function exportJson(map, items) {
  const data = {
    format: 'process-map',
    version: 1,
    exportedAt: new Date().toISOString(),
    map: { name: map.name, area: map.area, description: map.description, status: map.status },
    items,
  };
  download(`${safeName(map.name)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

/** Word-wraps text to a width, honouring line breaks and splitting very long words. */
function wrap(ctx, text, width) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const word of words) {
      const test = line + word;
      if (ctx.measureText(test).width <= width || !line.trim()) {
        if (ctx.measureText(test).width > width && !line.trim()) {
          // A single word wider than the box: break it by characters.
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > width && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = test;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function drawText(ctx, item, box, { align = 'center', weight = 400, colour = '#1f2328', fit = true, valign = 'middle' } = {}) {
  if (!item.text) return;
  let size = fontSize(item.kind, item.size);
  let lines;
  for (;;) {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
    lines = wrap(ctx, item.text, box.w);
    if (!fit || lines.length * size * 1.3 <= box.h || size <= 8) break;
    size -= 0.5;
  }
  const lineHeight = size * 1.3;
  const total = lines.length * lineHeight;
  let y = valign === 'top' ? box.y : box.y + (box.h - total) / 2;
  ctx.fillStyle = colour;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  for (const line of lines) {
    if (y + lineHeight > box.y + box.h + lineHeight * 0.3 && fit) break;
    ctx.fillText(line, x, y + (lineHeight - size) / 2);
    y += lineHeight;
  }
}

function roundRect(ctx, x, y, w, h, radius) {
  const rr = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawLane(ctx, lane) {
  const border = mix(lane.color, '#2f3a48', 0.2);
  roundRect(ctx, lane.x, lane.y, lane.w, lane.h, 6);
  ctx.fillStyle = lane.color;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = laneHeadFor(lane.color);
  ctx.fillRect(lane.x, lane.y, 44, lane.h);
  ctx.restore();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  roundRect(ctx, lane.x, lane.y, lane.w, lane.h, 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(lane.x + 44, lane.y);
  ctx.lineTo(lane.x + 44, lane.y + lane.h);
  ctx.stroke();
  if (lane.text) {
    ctx.save();
    ctx.translate(lane.x + 22, lane.y + lane.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `650 ${fontSize('lane', lane.size)}px ${FONT_STACK}`;
    ctx.fillStyle = '#1f2328';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let text = lane.text.replace(/\s+/g, ' ');
    while (text.length > 1 && ctx.measureText(text).width > lane.h - 16) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

function drawConnector(ctx, c, points) {
  ctx.strokeStyle = c.color;
  ctx.fillStyle = c.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(c.dashed ? [7, 6] : []);
  ctx.stroke(new Path2D(linePath(points, c.arrow)));
  ctx.setLineDash([]);
  const heads = arrowPath(points, c.arrow);
  if (heads) ctx.fill(new Path2D(heads));
  if (c.text) {
    const mid = midpoint(points);
    ctx.font = `550 13px ${FONT_STACK}`;
    const w = Math.min(ctx.measureText(c.text).width, 260) + 12;
    roundRect(ctx, mid.x - w / 2, mid.y - 11, w, 22, 4);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#e4e4de';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#59606a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.text, mid.x, mid.y + 0.5, 248);
  }
}

function drawNode(ctx, n) {
  const meta = [n.owner, n.system, n.duration].filter(Boolean).join(' · ');
  const hasMeta = meta && (n.kind === 'step' || n.kind === 'decision' || n.kind === 'terminal');
  if (n.kind === 'sticky') {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = n.color;
    ctx.fillRect(n.x, n.y, n.w, n.h);
    ctx.restore();
    drawText(ctx, n, { x: n.x + 14, y: n.y + 14, w: n.w - 28, h: n.h - 28 }, { weight: 450 });
  } else if (n.kind === 'text') {
    drawText(ctx, n, { x: n.x + 4, y: n.y + 2, w: n.w - 8, h: n.h }, { align: 'left', colour: n.color, fit: false, valign: 'top' });
  } else {
    if (n.kind === 'decision') {
      ctx.beginPath();
      ctx.moveTo(n.x + n.w / 2, n.y);
      ctx.lineTo(n.x + n.w, n.y + n.h / 2);
      ctx.lineTo(n.x + n.w / 2, n.y + n.h);
      ctx.lineTo(n.x, n.y + n.h / 2);
      ctx.closePath();
    } else {
      roundRect(ctx, n.x, n.y, n.w, n.h, n.kind === 'terminal' ? n.h / 2 : 10);
    }
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.strokeStyle = borderFor(n.color);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const padX = n.kind === 'decision' ? 30 : 12;
    const padY = n.kind === 'decision' ? 18 : 10;
    const metaH = hasMeta ? 16 : 0;
    drawText(ctx, n, { x: n.x + padX, y: n.y + padY, w: n.w - padX * 2, h: n.h - padY * 2 - metaH }, { weight: n.kind === 'terminal' ? 600 : 400 });
    if (hasMeta) {
      ctx.font = `400 11px ${FONT_STACK}`;
      ctx.fillStyle = '#59606a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(meta, n.x + n.w / 2, n.y + n.h - padY - 2, n.w - padX * 2);
    }
  }
  const flag = FLAGS[n.flag];
  if (flag) {
    ctx.beginPath();
    ctx.arc(n.x + n.w - 24, n.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = flag.colour;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 11px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(flag.glyph, n.x + n.w - 24, n.y + 0.5);
  }
}

export async function exportPng(map, items, { selection = null } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lookup = { get: (id) => byId.get(id) };
  let chosen = items;
  if (selection?.size) chosen = items.filter((i) => selection.has(i.id));
  const nodesList = chosen.filter(isNode);
  const routes = new Map();
  for (const c of chosen) {
    if (c.kind !== 'connector') continue;
    const points = routeConnector(c, lookup);
    if (points) routes.set(c.id, points);
  }
  const bounds = boundsOf([...nodesList, ...[...routes.values()].map(pointsBounds).filter(Boolean)]);
  if (!bounds) throw new Error('There is nothing on the map to export yet.');

  const pad = 48;
  const box = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  const scale = Math.max(0.5, Math.min(2, MAX_PIXELS / Math.max(box.w, box.h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(box.w * scale);
  canvas.height = Math.ceil(box.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-box.x, -box.y);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(box.x, box.y, box.w, box.h);

  const byZ = (a, b) => a.z - b.z;
  nodesList.filter((n) => n.kind === 'lane').sort(byZ).forEach((lane) => drawLane(ctx, lane));
  for (const c of chosen) if (routes.has(c.id)) drawConnector(ctx, c, routes.get(c.id));
  nodesList.filter((n) => n.kind !== 'lane').sort(byZ).forEach((n) => drawNode(ctx, n));

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not create the image. Try a smaller selection.');
  download(`${safeName(map.name)}.png`, blob);
}
