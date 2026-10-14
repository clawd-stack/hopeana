/**
 * Pure geometry: anchors, connector routing, bounds and hit tests. No DOM, so
 * the board renderer and the PNG export draw exactly the same lines.
 */

export const isNode = (item) => Boolean(item) && item.kind !== 'connector';

export const DIR = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export function centre(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function anchor(r, side) {
  switch (side) {
    case 'top': return { x: r.x + r.w / 2, y: r.y };
    case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h };
    case 'left': return { x: r.x, y: r.y + r.h / 2 };
    default: return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

/**
 * The side of `from` that faces `to`. Distances are weighed against the two
 * boxes' sizes, so two wide steps stacked vertically connect top to bottom
 * even when their centres are further apart horizontally than vertically.
 */
export function facingSide(from, to) {
  const a = centre(from);
  const b = centre(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rx = Math.abs(dx) / Math.max(1, from.w / 2 + to.w / 2);
  const ry = Math.abs(dy) / Math.max(1, from.h / 2 + to.h / 2);
  if (rx >= ry) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** The side to arrive at, given the side the line left by. */
function arrivingSide(to, from, leftBy) {
  const [dx, dy] = DIR[leftBy];
  const ahead = dx !== 0
    ? (dx > 0 ? to.x >= from.x + from.w : to.x + to.w <= from.x)
    : (dy > 0 ? to.y >= from.y + from.h : to.y + to.h <= from.y);
  return ahead ? OPPOSITE[leftBy] : facingSide(to, from);
}

export function resolveSides(a, b, fromSide, toSide) {
  if (fromSide && toSide) return [fromSide, toSide];
  if (fromSide) return [fromSide, arrivingSide(b, a, fromSide)];
  if (toSide) return [arrivingSide(a, b, toSide), toSide];
  return [facingSide(a, b), facingSide(b, a)];
}

/** A connector end as a box: a node's bounds, or a zero-size box at a free point. */
export function endBox(end, nodes) {
  if (!end) return null;
  if (end.id !== undefined) {
    const node = nodes.get(end.id);
    return node && isNode(node) ? { x: node.x, y: node.y, w: node.w, h: node.h, kind: node.kind } : null;
  }
  return { x: end.x, y: end.y, w: 0, h: 0, kind: 'point' };
}

const GAP = 22;

function elbow(ra, sa, rb, sb) {
  const a = anchor(ra, sa);
  const b = anchor(rb, sb);
  const [adx, ady] = DIR[sa];
  const [bdx, bdy] = DIR[sb];
  const a1 = { x: a.x + adx * GAP, y: a.y + ady * GAP };
  const b1 = { x: b.x + bdx * GAP, y: b.y + bdy * GAP };
  const aH = adx !== 0;
  const bH = bdx !== 0;

  if (aH && bH) {
    if (adx === -bdx && (b.x - a.x) * adx >= GAP) {
      const mx = (a.x + b.x) / 2;
      return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
    }
    if (adx === bdx) {
      const x = adx > 0 ? Math.max(a1.x, b1.x) : Math.min(a1.x, b1.x);
      return [a, { x, y: a.y }, { x, y: b.y }, b];
    }
    // Facing each other but overlapping: go round, between the two if there
    // is a gap, otherwise underneath both.
    const between = ra.y + ra.h < rb.y ? (ra.y + ra.h + rb.y) / 2 : rb.y + rb.h < ra.y ? (rb.y + rb.h + ra.y) / 2 : null;
    const y = between ?? Math.max(ra.y + ra.h, rb.y + rb.h) + GAP;
    return [a, a1, { x: a1.x, y }, { x: b1.x, y }, b1, b];
  }

  if (!aH && !bH) {
    if (ady === -bdy && (b.y - a.y) * ady >= GAP) {
      const my = (a.y + b.y) / 2;
      return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
    }
    if (ady === bdy) {
      const y = ady > 0 ? Math.max(a1.y, b1.y) : Math.min(a1.y, b1.y);
      return [a, { x: a.x, y }, { x: b.x, y }, b];
    }
    const between = ra.x + ra.w < rb.x ? (ra.x + ra.w + rb.x) / 2 : rb.x + rb.w < ra.x ? (rb.x + rb.w + ra.x) / 2 : null;
    const x = between ?? Math.max(ra.x + ra.w, rb.x + rb.w) + GAP;
    return [a, a1, { x, y: a1.y }, { x, y: b1.y }, b1, b];
  }

  if (aH) {
    const corner = { x: b.x, y: a.y };
    if ((corner.x - a.x) * adx >= GAP && (b.y - corner.y) * -bdy >= GAP) return [a, corner, b];
    return [a, a1, { x: a1.x, y: b1.y }, b1, b];
  }
  const corner = { x: a.x, y: b.y };
  if ((corner.y - a.y) * ady >= GAP && (b.x - corner.x) * -bdx >= GAP) return [a, corner, b];
  return [a, a1, { x: b1.x, y: a1.y }, b1, b];
}

/** Where the line from a box's centre towards a point leaves the box. */
function clipToBox(r, toward) {
  const c = centre(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if ((r.w === 0 && r.h === 0) || (dx === 0 && dy === 0)) return c;
  if (r.kind === 'decision') {
    // |x|/(w/2) + |y|/(h/2) = 1 on a diamond.
    const t = 1 / (Math.abs(dx) / (r.w / 2) + Math.abs(dy) / (r.h / 2));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  const tx = dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function simplify(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    out.push({ x: p.x, y: p.y });
  }
  // Drop middle points that sit on a straight run.
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) {
      out.splice(i, 1);
    }
  }
  return out;
}

/** The polyline a connector draws, or null when an end has nothing to attach to. */
export function routeConnector(connector, nodes) {
  const ra = endBox(connector.from, nodes);
  const rb = endBox(connector.to, nodes);
  if (!ra || !rb) return null;
  if (connector.route === 'straight') {
    const a = clipToBox(ra, centre(rb));
    const b = clipToBox(rb, centre(ra));
    return [a, b];
  }
  const fromSide = connector.from.id !== undefined ? connector.from.side ?? null : null;
  const toSide = connector.to.id !== undefined ? connector.to.side ?? null : null;
  const [sa, sb] = resolveSides(ra, rb, fromSide, toSide);
  return simplify(elbow(ra, sa, rb, sb));
}

function shorten(points, atEnd, by) {
  const pts = points.map((p) => ({ ...p }));
  const i = atEnd ? pts.length - 1 : 0;
  const j = atEnd ? pts.length - 2 : 1;
  const a = pts[j];
  const b = pts[i];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return pts;
  const t = Math.min(by, len - 0.5) / len;
  b.x -= (b.x - a.x) * t;
  b.y -= (b.y - a.y) * t;
  return pts;
}

export const ARROW = { length: 11, half: 5.5 };

/** The connector as SVG path data, with corners rounded and room left for arrowheads. */
export function linePath(points, arrow) {
  let pts = points;
  if (arrow === 'end' || arrow === 'both') pts = shorten(pts, true, ARROW.length * 0.75);
  if (arrow === 'both') pts = shorten(pts, false, ARROW.length * 0.75);
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const n = pts[i + 1];
    const r = Math.min(10, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const inX = c.x - Math.sign(c.x - p.x) * r;
    const inY = c.y - Math.sign(c.y - p.y) * r;
    const outX = c.x + Math.sign(n.x - c.x) * r;
    const outY = c.y + Math.sign(n.y - c.y) * r;
    d += `L${inX},${inY}Q${c.x},${c.y} ${outX},${outY}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last.x},${last.y}`;
}

/** Triangle at the tip of a segment running from `from` to `tip`. */
export function arrowHead(from, tip) {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / len;
  const uy = (tip.y - from.y) / len;
  const bx = tip.x - ux * ARROW.length;
  const by = tip.y - uy * ARROW.length;
  return [tip, { x: bx - uy * ARROW.half, y: by + ux * ARROW.half }, { x: bx + uy * ARROW.half, y: by - ux * ARROW.half }];
}

export function arrowPath(points, arrow) {
  const tri = (t) => `M${t[0].x},${t[0].y}L${t[1].x},${t[1].y}L${t[2].x},${t[2].y}Z`;
  let d = '';
  const n = points.length;
  if (arrow === 'end' || arrow === 'both') d += tri(arrowHead(points[n - 2], points[n - 1]));
  if (arrow === 'both') d += tri(arrowHead(points[1], points[0]));
  return d;
}

/** The point halfway along a polyline, where a label sits. */
export function midpoint(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (half <= len) {
      const t = len ? half / len : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    half -= len;
  }
  return points[0];
}

export function boundsOf(rects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pointsBounds(points) {
  return boundsOf(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
}

export function intersects(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function containsRect(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function containsPoint(r, p, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

/** Distance from a point to a polyline, for picking a connector by its line. */
export function distanceToPolyline(p, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}
