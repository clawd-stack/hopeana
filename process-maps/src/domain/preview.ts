import type { Item, NodeItem } from './items.ts';
import type { MapPreview } from '../store/types.ts';

/**
 * The maps-list thumbnail, computed on the server for edits that arrive
 * without a browser (agents). The same arithmetic as web/maps/js/preview.js,
 * so a thumbnail looks the same whoever made the change.
 */

const KIND_CODE: Record<string, string> = { sticky: 's', step: 'p', decision: 'd', terminal: 't', text: 'x', lane: 'l' };
const MAX = 400;

export function computePreview(items: Item[]): MapPreview {
  const nodes = items.filter((i): i is NodeItem => i.kind !== 'connector');
  if (!nodes.length) return { w: 0, h: 0, shapes: [], links: [] };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const scale = 1000 / Math.max(maxX - minX, maxY - minY, 1);
  const sx = (x: number) => Math.round((x - minX) * scale);
  const sy = (y: number) => Math.round((y - minY) * scale);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = [...nodes].sort((a, b) =>
    (a.kind === 'lane') === (b.kind === 'lane') ? a.z - b.z : a.kind === 'lane' ? -1 : 1,
  );
  const shapes = ordered.slice(0, MAX).map((n): MapPreview['shapes'][number] => [
    KIND_CODE[n.kind]!,
    sx(n.x),
    sy(n.y),
    Math.max(1, Math.round(n.w * scale)),
    Math.max(1, Math.round(n.h * scale)),
    /^#[0-9a-f]{6}$/i.test(n.color) ? n.color : '#ffffff',
  ]);
  const links: MapPreview['links'] = [];
  for (const c of items) {
    if (c.kind !== 'connector' || links.length >= MAX) continue;
    const a = 'id' in c.from ? byId.get(c.from.id) : undefined;
    const b = 'id' in c.to ? byId.get(c.to.id) : undefined;
    if (!a || !b) continue;
    links.push([sx(a.x + a.w / 2), sy(a.y + a.h / 2), sx(b.x + b.w / 2), sy(b.y + b.h / 2)]);
  }
  return { w: sx(maxX), h: sy(maxY), shapes, links };
}
