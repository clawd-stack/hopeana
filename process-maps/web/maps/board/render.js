import { arrowPath, boundsOf, isNode, linePath, midpoint, pointsBounds, routeConnector } from './geometry.js';
import { FLAGS, borderFor, fontSize, laneHeadFor, mix } from './palette.js';
import { icons } from '../js/icons.js';
import { personColour } from '../js/ui.js';

/**
 * Draws the board. Items are DOM elements inside one transformed world
 * element; connectors are paths in one SVG inside it. Only what changed is
 * touched each frame: a changed node, and the connectors attached to it.
 *
 * The overlay (selection, handles, guides, collaborators' selections) is drawn
 * in screen space on top, rebuilt each frame it is needed, so handles stay the
 * same size at any zoom.
 */

const SVG = 'http://www.w3.org/2000/svg';
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function div(className, attrs = {}) {
  const node = document.createElement('div');
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const zIndex = (z) => String(Math.max(-2e9, Math.min(2e9, Math.round(z))));

/**
 * Shrinks a label's font until its text fits the box, so a long sticky note
 * reads smaller rather than disappearing. Binary search keeps it to a handful
 * of layouts.
 */
export function fitLabel(label, base, maxHeight) {
  label.style.fontSize = `${base}px`;
  if (label.scrollHeight <= maxHeight) return;
  let lo = 8;
  let hi = base;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    label.style.fontSize = `${mid}px`;
    if (label.scrollHeight <= maxHeight) lo = mid;
    else hi = mid;
  }
  label.style.fontSize = `${lo}px`;
}

export function createRenderer({ model, camera, ui, dom }) {
  const { lanes, links, labels, nodes, overlay } = dom;
  const els = new Map();
  const linkLabels = new Map();
  const routes = new Map();
  let attached = new Map();
  const dirty = new Set();
  let everything = true;
  let overlayDirty = true;
  let queued = false;
  const frameHooks = new Set();
  let shownSelection = new Set();
  let overlayKey = '';

  model.onChange((ids) => {
    for (const id of ids) dirty.add(id);
    schedule();
  });

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  function frame() {
    queued = false;
    renderItems();
    renderOverlay();
    for (const fn of frameHooks) fn();
  }

  function rebuildAttached() {
    attached = new Map();
    for (const item of model.all()) {
      if (item.kind !== 'connector') continue;
      for (const end of [item.from, item.to]) {
        if (end?.id === undefined) continue;
        if (!attached.has(end.id)) attached.set(end.id, new Set());
        attached.get(end.id).add(item.id);
      }
    }
  }

  function renderItems() {
    if (everything) {
      everything = false;
      for (const id of els.keys()) dirty.add(id);
      for (const item of model.all()) dirty.add(item.id);
    }
    if (!dirty.size) return;
    const linkIds = new Set();
    let connectorsChanged = false;
    for (const id of dirty) {
      attached.get(id)?.forEach((c) => linkIds.add(c));
      const item = model.get(id);
      if (!item || item.kind === 'connector') {
        if (!item && els.get(id)?._kind !== 'connector') removeNode(id);
        linkIds.add(id);
        connectorsChanged = true;
        continue;
      }
      updateNode(item);
    }
    if (connectorsChanged) {
      rebuildAttached();
      for (const id of dirty) attached.get(id)?.forEach((c) => linkIds.add(c));
    }
    dirty.clear();
    for (const id of linkIds) {
      const item = model.get(id);
      if (item?.kind === 'connector') updateLink(item);
      else removeLink(id);
    }
    if (linkIds.size) sizeLinkLayer();
    overlayDirty = true;
  }

  /* Nodes ---------------------------------------------------------- */

  function createNode(item) {
    if (item.kind === 'lane') {
      const el = div('pm-lane', { 'data-id': item.id });
      const head = div('pm-lane__head');
      const label = document.createElement('span');
      label.className = 'pm-lane__label';
      head.append(label);
      el.append(head);
      el._label = label;
      el._head = head;
      lanes.append(el);
      return el;
    }
    const el = div(`pm-node pm-node--${item.kind}`, { 'data-id': item.id });
    if (item.kind === 'decision') {
      const shape = svgEl('svg', { class: 'pm-node__shape', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
      const poly = svgEl('polygon', { points: '50,1 99,50 50,99 1,50', 'vector-effect': 'non-scaling-stroke', 'stroke-width': '1.5' });
      shape.append(poly);
      el.append(shape);
      el._poly = poly;
    }
    const label = div('pm-node__label');
    el.append(label);
    el._label = label;
    if (item.kind === 'step' || item.kind === 'decision' || item.kind === 'terminal') {
      const meta = div('pm-node__meta');
      el.append(meta);
      el._meta = meta;
    }
    nodes.append(el);
    return el;
  }

  function removeNode(id) {
    const el = els.get(id);
    if (!el) return;
    el.remove();
    els.delete(id);
  }

  function updateNode(item) {
    let el = els.get(item.id);
    if (!el || el._kind !== item.kind) {
      el?.remove();
      el = createNode(item);
      el._kind = item.kind;
      els.set(item.id, el);
    }
    const prev = el._item;
    el._item = item;
    const changed = (...keys) => !prev || keys.some((k) => prev[k] !== item[k]);

    if (changed('x', 'y')) el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    if (changed('w', 'h')) {
      el.style.width = `${item.w}px`;
      el.style.height = `${item.h}px`;
    }
    if (changed('z')) el.style.zIndex = zIndex(item.z);

    if (item.kind === 'lane') {
      if (changed('color')) {
        el.style.background = item.color;
        el.style.borderColor = mix(item.color, '#2f3a48', 0.2);
        el._head.style.background = laneHeadFor(item.color);
        el._head.style.borderColor = mix(item.color, '#2f3a48', 0.2);
      }
      if (changed('size')) el._label.style.fontSize = `${fontSize('lane', item.size)}px`;
      if (ui.editing !== item.id && el._label.textContent !== item.text) el._label.textContent = item.text;
      return;
    }

    if (changed('color')) {
      if (item.kind === 'sticky') el.style.background = item.color;
      else if (item.kind === 'text') el.style.color = item.color;
      else if (item.kind === 'decision') {
        el._poly.setAttribute('fill', item.color);
        el._poly.setAttribute('stroke', borderFor(item.color));
      } else {
        el.style.background = item.color;
        el.style.borderColor = borderFor(item.color);
      }
    }
    if (ui.editing !== item.id && el._label.textContent !== item.text) el._label.textContent = item.text;
    if (el._meta && changed('owner', 'system', 'duration')) {
      const meta = [item.owner, item.system, item.duration].filter(Boolean).join(' · ');
      el._meta.textContent = meta;
      el._meta.hidden = !meta;
    }
    if (changed('flag')) {
      el._flag?.remove();
      el._flag = null;
      const flag = FLAGS[item.flag];
      if (flag) {
        const badge = div('pm-node__flag', { title: flag.label });
        badge.style.background = flag.colour;
        badge.textContent = flag.glyph;
        el.append(badge);
        el._flag = badge;
      }
    }
    if (changed('notes')) {
      el._notes?.remove();
      el._notes = null;
      if (item.notes) {
        const note = div('pm-node__notes', { title: 'Has notes' });
        note.innerHTML = icons.note;
        el.append(note);
        el._notes = note;
      }
    }
    if (changed('text', 'w', 'h', 'size', 'owner', 'system', 'duration')) fit(el, item);
  }

  function fit(el, item) {
    const base = fontSize(item.kind, item.size);
    if (item.kind === 'text') {
      el._label.style.fontSize = `${base}px`;
      return;
    }
    const padding = item.kind === 'sticky' ? 28 : item.kind === 'decision' ? 36 : 20;
    const meta = el._meta && !el._meta.hidden ? el._meta.offsetHeight + 4 : 0;
    fitLabel(el._label, base, Math.max(10, item.h - padding - meta));
  }

  /* Connectors ------------------------------------------------------ */

  function updateLink(item) {
    let g = els.get(item.id);
    if (!g) {
      g = svgEl('g', { class: 'pm-link', 'data-id': item.id });
      g._halo = svgEl('path', { class: 'pm-link__halo' });
      g._hit = svgEl('path', { class: 'pm-link__hit' });
      g._line = svgEl('path', { class: 'pm-link__line' });
      g._arrow = svgEl('path', { class: 'pm-link__arrow' });
      g.append(g._halo, g._line, g._arrow, g._hit);
      g._kind = 'connector';
      links.append(g);
      els.set(item.id, g);
    }
    const points = routeConnector(item, model);
    if (!points || points.length < 2) {
      g.style.display = 'none';
      routes.delete(item.id);
      linkLabels.get(item.id)?.remove();
      linkLabels.delete(item.id);
      return;
    }
    g.style.display = '';
    routes.set(item.id, points);
    const full = linePath(points, 'none');
    g._hit.setAttribute('d', full);
    g._halo.setAttribute('d', full);
    g._line.setAttribute('d', linePath(points, item.arrow));
    g._line.setAttribute('stroke', item.color);
    if (item.dashed) g._line.setAttribute('stroke-dasharray', '7 6');
    else g._line.removeAttribute('stroke-dasharray');
    g._arrow.setAttribute('d', arrowPath(points, item.arrow));
    g._arrow.setAttribute('fill', item.color);
    g.classList.toggle('is-selected', ui.selection.has(item.id));

    let label = linkLabels.get(item.id);
    if (item.text || ui.editing === item.id) {
      if (!label) {
        label = div('pm-link-label', { 'data-id': item.id, 'data-link-label': '' });
        labels.append(label);
        linkLabels.set(item.id, label);
      }
      const mid = midpoint(points);
      label.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
      if (ui.editing !== item.id && label.textContent !== item.text) label.textContent = item.text;
    } else if (label) {
      label.remove();
      linkLabels.delete(item.id);
    }
  }

  function removeLink(id) {
    els.get(id)?.remove();
    els.delete(id);
    routes.delete(id);
    linkLabels.get(id)?.remove();
    linkLabels.delete(id);
  }

  /** The SVG only needs to be as big as its lines, plus room for strokes. */
  function sizeLinkLayer() {
    const b = boundsOf([...routes.values()].map(pointsBounds).filter(Boolean)) ?? { x: 0, y: 0, w: 1, h: 1 };
    const pad = 40;
    const x = Math.floor(b.x - pad);
    const y = Math.floor(b.y - pad);
    const w = Math.ceil(b.w + pad * 2);
    const h = Math.ceil(b.h + pad * 2);
    links.style.left = `${x}px`;
    links.style.top = `${y}px`;
    links.setAttribute('width', String(w));
    links.setAttribute('height', String(h));
    links.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  /* Overlay ---------------------------------------------------------- */

  function box(r, className, style = '') {
    const s = camera.rectToScreen(r);
    const node = div(className);
    node.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;${style}`;
    return node;
  }

  function handle(x, y, className, data) {
    const node = div(className, data);
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    return node;
  }

  function renderOverlay() {
    if (!overlayDirty) return;
    overlayDirty = false;
    const out = [];

    for (const peer of ui.peers) {
      const colour = personColour(peer.userId);
      let tagged = false;
      for (const id of peer.selection) {
        const item = model.get(id);
        if (!isNode(item)) continue;
        const node = box(item, 'pm-sel pm-sel--peer', `border-color:${colour}`);
        if (!tagged) {
          const tag = div('pm-sel__tag');
          tag.style.background = colour;
          tag.textContent = peer.name;
          node.append(tag);
          tagged = true;
        }
        out.push(node);
      }
    }

    const selected = [...ui.selection].map((id) => model.get(id)).filter(Boolean);
    const selectedNodes = selected.filter(isNode);
    const moving = ui.gesture?.started && (ui.gesture.type === 'move' || ui.gesture.type === 'resize');
    for (const item of selectedNodes) out.push(box(item, 'pm-sel', selectedNodes.length > 1 ? 'border-width:1.5px' : ''));
    if (selectedNodes.length > 1) {
      const b = boundsOf(selectedNodes);
      out.push(box({ x: b.x - 6 / camera.k, y: b.y - 6 / camera.k, w: b.w + 12 / camera.k, h: b.h + 12 / camera.k }, 'pm-sel pm-sel--group'));
    }

    const editable = !ui.readOnly && !ui.editing;
    if (editable && selected.length === 1 && selectedNodes.length === 1 && !moving) {
      const item = selectedNodes[0];
      const s = camera.rectToScreen(item);
      const at = {
        nw: [s.x, s.y], n: [s.x + s.w / 2, s.y], ne: [s.x + s.w, s.y], e: [s.x + s.w, s.y + s.h / 2],
        se: [s.x + s.w, s.y + s.h], s: [s.x + s.w / 2, s.y + s.h], sw: [s.x, s.y + s.h], w: [s.x, s.y + s.h / 2],
      };
      const dirs = item.kind === 'text' ? ['e', 'w', 'se', 'sw', 'ne', 'nw'] : HANDLE_DIRS;
      if (s.w > 16 && s.h > 8) {
        for (const dir of dirs) out.push(handle(at[dir][0], at[dir][1], 'pm-handle', { 'data-handle': 'resize', 'data-dir': dir }));
      }
      if (item.kind !== 'lane' && ui.tool === 'select') {
        const gap = 22;
        const plus = { top: [s.x + s.w / 2, s.y - gap], right: [s.x + s.w + gap, s.y + s.h / 2], bottom: [s.x + s.w / 2, s.y + s.h + gap], left: [s.x - gap, s.y + s.h / 2] };
        for (const [side, [x, y]] of Object.entries(plus)) {
          const p = handle(x, y, 'pm-plus', { 'data-handle': 'plus', 'data-side': side, title: 'Click to add the next step, or drag to connect' });
          p.innerHTML = icons.plus;
          out.push(p);
        }
      }
    }

    for (const item of selected) {
      if (item.kind !== 'connector' || ui.readOnly) continue;
      const points = routes.get(item.id);
      if (!points) continue;
      const a = camera.toScreen(points[0].x, points[0].y);
      const b = camera.toScreen(points[points.length - 1].x, points[points.length - 1].y);
      out.push(handle(a.x, a.y, 'pm-handle pm-handle--end', { 'data-handle': 'end', 'data-end': 'from', 'data-id': item.id }));
      out.push(handle(b.x, b.y, 'pm-handle pm-handle--end', { 'data-handle': 'end', 'data-end': 'to', 'data-id': item.id }));
    }

    if (ui.dropTarget) {
      const t = model.get(ui.dropTarget);
      if (t) out.push(box({ x: t.x - 4 / camera.k, y: t.y - 4 / camera.k, w: t.w + 8 / camera.k, h: t.h + 8 / camera.k }, 'pm-drop-target'));
    }
    if (ui.ghost) out.push(box(ui.ghost, 'pm-ghost'));
    if (ui.marquee) out.push(box(ui.marquee, 'pm-marquee'));
    for (const g of ui.guides) {
      if (g.axis === 'x') {
        const a = camera.toScreen(g.at, g.from);
        const b = camera.toScreen(g.at, g.to);
        const node = div('pm-guide pm-guide--v');
        node.style.cssText = `left:${a.x}px;top:${a.y}px;height:${b.y - a.y}px`;
        out.push(node);
      } else {
        const a = camera.toScreen(g.from, g.at);
        const b = camera.toScreen(g.to, g.at);
        const node = div('pm-guide pm-guide--h');
        node.style.cssText = `left:${a.x}px;top:${a.y}px;width:${b.x - a.x}px`;
        out.push(node);
      }
    }
    if (ui.preview) {
      const svg = svgEl('svg', { class: 'pm-preview' });
      const pts = ui.preview.map((p) => camera.toScreen(p.x, p.y));
      svg.append(svgEl('path', { d: linePath(pts, 'none') }));
      out.push(svg);
    }

    // Only touch the DOM when the overlay actually changed, so a handle under
    // the pointer is never swapped for an identical one mid-hover.
    const key = out.map((n) => n.outerHTML).join('');
    if (key !== overlayKey) {
      overlayKey = key;
      overlay.replaceChildren(...out);
    }

    // Connector selection is drawn on the line itself.
    const now = new Set(selected.filter((i) => i.kind === 'connector').map((i) => i.id));
    for (const id of shownSelection) if (!now.has(id)) els.get(id)?.classList.remove('is-selected');
    for (const id of now) els.get(id)?.classList.add('is-selected');
    shownSelection = now;
  }

  return {
    schedule,
    /** Redraw everything, e.g. after a reload of the whole board. */
    invalidateAll() {
      everything = true;
      overlayDirty = true;
      schedule();
    },
    invalidate(ids) {
      for (const id of ids) dirty.add(id);
      overlayDirty = true;
      schedule();
    },
    overlay() {
      overlayDirty = true;
      schedule();
    },
    flush() {
      model.flush();
      queued = false;
      renderItems();
      renderOverlay();
    },
    onFrame(fn) { frameHooks.add(fn); },
    element: (id) => els.get(id),
    labelFor(id) {
      const item = model.get(id);
      if (!item) return null;
      if (item.kind === 'connector') {
        let label = linkLabels.get(id);
        if (!label) {
          // Editing an unlabelled connector: make the label to type into.
          ui.editing = id;
          const el = els.get(id);
          if (el) updateLink(item);
          label = linkLabels.get(id);
        }
        return label ?? null;
      }
      return els.get(id)?._label ?? null;
    },
    fitNow(id) {
      const item = model.get(id);
      const el = els.get(id);
      if (item && el && isNode(item) && item.kind !== 'lane') fit(el, item);
    },
    route: (id) => routes.get(id),
    routes: () => routes,
  };
}
