import { newId } from './model.js';
import { DEFAULT_COLOUR, DEFAULT_SIZE, KIND_LABELS, COLOURS } from './palette.js';
import { boundsOf, centre, containsPoint, containsRect, intersects, isNode, pointsBounds, routeConnector } from './geometry.js';
import { closeMenu } from '../js/ui.js';

/**
 * Everything a person does to the board: pointer gestures, keyboard
 * shortcuts, text editing and the clipboard. It changes the board only
 * through the model, and draws only through the renderer.
 *
 *   Drag empty board        select an area
 *   Space + drag, middle or right drag, two fingers   pan
 *   Wheel / pinch           pan or zoom (see wheel())
 *   Blue + on a step        click: add the next step; drag: connect
 *   Double-click            edit text; on empty board, a new sticky note
 */

export const CREATE_TOOLS = new Set(['sticky', 'step', 'decision', 'terminal', 'text', 'lane']);
const NEXT_KIND = { sticky: 'sticky', step: 'step', decision: 'step', terminal: 'step', text: 'text' };
const MIN_SIZE = { text: [40, 20], lane: [160, 80] };
const PASTE_FORMAT = 'process-map-clip';

const isTyping = (target) =>
  target instanceof Element && (target.closest('input, textarea, select, [contenteditable]') !== null);

export function createEditor({ model, camera, renderer, ui, stage, toast, onChange }) {
  const pointers = new Map();
  let edit = null;
  let pinch = null;
  let pasteCount = 0;
  let touchpadUntil = 0;

  /* Helpers ----------------------------------------------------------- */

  const get = (id) => model.get(id);
  const nodes = () => model.all().filter(isNode);
  const r = (v) => Math.round(v);
  const notify = () => {
    renderer.overlay();
    onChange?.();
  };

  function nextZ(lane) {
    let max = lane ? -1000 : 0;
    for (const item of model.all()) if (isNode(item) && (item.kind === 'lane') === lane) max = Math.max(max, item.z);
    return max + 1;
  }
  function minZ(lane) {
    let min = lane ? -1000 : 0;
    for (const item of model.all()) if (isNode(item) && (item.kind === 'lane') === lane) min = Math.min(min, item.z);
    return min - 1;
  }

  function makeNode(kind, rect, extra = {}) {
    return {
      id: newId(), kind, x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h), z: nextZ(kind === 'lane'),
      text: '', color: DEFAULT_COLOUR[kind], size: 'M', owner: '', system: '', duration: '', notes: '', flag: '', ...extra,
    };
  }

  function makeConnector(from, to, extra = {}) {
    return { id: newId(), kind: 'connector', z: 0, from, to, text: '', color: DEFAULT_COLOUR.connector, dashed: false, arrow: 'end', route: 'elbow', ...extra };
  }

  /** The topmost step, sticky or shape under a board point. Lanes never count. */
  function nodeAt(p, exclude = null) {
    const pad = 6 / camera.k;
    let best = null;
    for (const item of nodes()) {
      if (item.kind === 'lane' || item.id === exclude || !containsPoint(item, p, pad)) continue;
      if (!best || item.z > best.z) best = item;
    }
    return best;
  }

  function setSelection(ids) {
    ui.selection = new Set([...ids].filter((id) => model.has(id)));
    notify();
  }

  function setTool(tool) {
    if (ui.readOnly && tool !== 'select' && tool !== 'hand') return;
    ui.tool = tool;
    stage.classList.toggle('tool-hand', tool === 'hand');
    stage.classList.toggle('tool-create', CREATE_TOOLS.has(tool) || tool === 'connector');
    notify();
  }

  function targetOf(event) {
    const t = event.target;
    if (!(t instanceof Element)) return { type: 'empty' };
    const handle = t.closest('[data-handle]');
    if (handle) return { type: 'handle', ...handle.dataset };
    const label = t.closest('[data-link-label]');
    if (label) return { type: 'item', id: label.dataset.id };
    const el = t.closest('.pm-node, .pm-lane__head, .pm-link');
    if (el) {
      const host = el.closest('[data-id]');
      if (host && model.has(host.dataset.id)) return { type: 'item', id: host.dataset.id };
    }
    return { type: 'empty' };
  }

  const screenPoint = (e) => {
    const rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /* Pointer gestures -------------------------------------------------- */

  function begin(gesture) {
    ui.gesture = { started: false, ...gesture };
  }

  function end(commit = true) {
    const g = ui.gesture;
    ui.gesture = null;
    ui.marquee = null;
    ui.guides = [];
    ui.ghost = null;
    ui.dropTarget = null;
    ui.preview = null;
    stage.classList.remove('is-panning');
    if (model.holding) {
      if (commit) model.commit();
      else model.cancel();
    }
    notify();
    return g;
  }

  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  stage.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element && e.target.closest('[contenteditable]')) return;
    if (edit) stopEdit();
    closeMenu();
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    e.preventDefault();

    pointers.set(e.pointerId, screenPoint(e));
    if (pointers.size === 2) return startPinch();
    if (pointers.size > 2) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }

    const sp = screenPoint(e);
    const wp = camera.toWorld(sp.x, sp.y);
    ui.pointer = wp;
    const target = targetOf(e);
    const editable = !ui.readOnly;

    if (e.button === 1 || e.button === 2 || ui.spaceDown || ui.tool === 'hand') {
      stage.classList.add('is-panning');
      return begin({ type: 'pan', last: sp, started: true });
    }
    if (e.button !== 0) return;

    if (editable && CREATE_TOOLS.has(ui.tool)) return begin({ type: 'create', kind: ui.tool, start: wp, sp });
    if (editable && ui.tool === 'connector') {
      const from = target.type === 'item' ? get(target.id) : null;
      const fromId = from && isNode(from) && from.kind !== 'lane' ? from.id : null;
      return begin({ type: 'connect', fromId, fromPoint: fromId ? null : wp, side: null, sp });
    }
    if (target.type === 'handle' && editable) {
      if (target.handle === 'resize') {
        const id = [...ui.selection][0];
        const item = get(id);
        if (item) return begin({ type: 'resize', id, dir: target.dir, start: wp, orig: { x: item.x, y: item.y, w: item.w, h: item.h }, sp });
      }
      if (target.handle === 'plus') return begin({ type: 'connect', fromId: [...ui.selection][0], side: target.side, sp, quick: true });
      if (target.handle === 'end') return begin({ type: 'endpoint', id: target.id, end: target.end, sp });
    }
    if (target.type === 'item') {
      const id = target.id;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const next = new Set(ui.selection);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelection(next);
        if (!next.has(id)) return;
      } else if (!ui.selection.has(id)) {
        setSelection([id]);
      }
      if (editable) begin({ type: 'move', id, start: wp, sp, alt: e.altKey, modifier: e.shiftKey || e.metaKey || e.ctrlKey });
      else if (!e.shiftKey && !e.metaKey && !e.ctrlKey) begin({ type: 'click', id, sp });
      return;
    }
    if (e.pointerType === 'touch') {
      return begin({ type: 'pan', last: sp, started: true, tapClears: true, sp });
    }
    begin({ type: 'marquee', start: wp, sp, base: e.shiftKey ? new Set(ui.selection) : new Set() });
  });

  stage.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, screenPoint(e));
    const sp = screenPoint(e);
    const wp = camera.toWorld(sp.x, sp.y);
    ui.pointer = wp;
    if (pinch) return updatePinch();
    const g = ui.gesture;
    if (!g) return;
    if (!g.started) {
      if (Math.hypot(sp.x - g.sp.x, sp.y - g.sp.y) < 4) return;
      g.started = true;
      startGesture(g);
    }
    moveGesture(g, sp, wp, e);
  });

  const finish = (e) => {
    const wasPinch = Boolean(pinch);
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    const g = ui.gesture;
    if (!g || wasPinch) return;
    if (e.type === 'pointercancel') return end(false);
    const sp = screenPoint(e);
    finishGesture(g, sp, camera.toWorld(sp.x, sp.y), e);
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);

  function startGesture(g) {
    if (g.type === 'move') {
      model.begin(g.alt ? 'Duplicate' : 'Move', { hold: true });
      if (g.alt) {
        const copies = copyItems(selectionForCopy(), { dx: 0, dy: 0 });
        setSelection(copies);
      }
      const selected = [...ui.selection].map(get).filter(Boolean);
      const moving = new Set(selected.filter(isNode).map((i) => i.id));
      // A lane carries whatever sits inside it.
      for (const lane of selected.filter((i) => i.kind === 'lane')) {
        for (const n of nodes()) if (n.kind !== 'lane' && !moving.has(n.id) && containsPoint(lane, centre(n))) moving.add(n.id);
      }
      g.origin = new Map([...moving].map((id) => [id, { x: get(id).x, y: get(id).y }]));
      g.freeEnds = selected.filter((i) => i.kind === 'connector').map((c) => ({ id: c.id, from: c.from, to: c.to }));
      const box = boundsOf(selected.filter(isNode));
      g.box = box;
      const lanesMoving = selected.some((i) => i.kind === 'lane');
      const view = camera.visibleRect();
      g.others = box
        ? nodes().filter((n) => !moving.has(n.id) && (n.kind === 'lane') === lanesMoving && intersects(n, { x: view.x - view.w, y: view.y - view.h, w: view.w * 3, h: view.h * 3 })).slice(0, 600)
        : [];
    } else if (g.type === 'resize' || g.type === 'endpoint') {
      model.begin(g.type === 'resize' ? 'Resize' : 'Reconnect', { hold: true });
    }
    notify();
  }

  function moveGesture(g, sp, wp, e) {
    switch (g.type) {
      case 'pan':
        camera.panBy(sp.x - g.last.x, sp.y - g.last.y);
        g.last = sp;
        if (g.tapClears && Math.hypot(sp.x - g.sp.x, sp.y - g.sp.y) > 4) g.tapClears = false;
        return;
      case 'marquee': {
        const m = { x: Math.min(g.start.x, wp.x), y: Math.min(g.start.y, wp.y), w: Math.abs(wp.x - g.start.x), h: Math.abs(wp.y - g.start.y) };
        ui.marquee = m;
        const hits = new Set(g.base);
        for (const item of model.all()) {
          if (item.kind === 'lane' ? containsRect(m, item) : isNode(item) ? intersects(m, item) : false) hits.add(item.id);
        }
        for (const [id, points] of renderer.routes()) {
          const b = pointsBounds(points);
          if (b && containsRect(m, b)) hits.add(id);
        }
        setSelection(hits);
        return;
      }
      case 'move': {
        let dx = wp.x - g.start.x;
        let dy = wp.y - g.start.y;
        ui.guides = [];
        if (g.box && !(e.ctrlKey || e.metaKey)) ({ dx, dy } = snap(g.box, dx, dy, g.others));
        for (const [id, o] of g.origin) {
          const item = get(id);
          if (item) model.put({ ...item, x: r(o.x + dx), y: r(o.y + dy) });
        }
        for (const c of g.freeEnds) {
          const item = get(c.id);
          if (!item) continue;
          const shift = (end) => (end.id === undefined ? { x: r(end.x + dx), y: r(end.y + dy) } : end);
          model.put({ ...item, from: shift(c.from), to: shift(c.to) });
        }
        renderer.overlay();
        return;
      }
      case 'resize':
        return resizeTo(g, wp, e.shiftKey);
      case 'create': {
        ui.ghost = { x: Math.min(g.start.x, wp.x), y: Math.min(g.start.y, wp.y), w: Math.abs(wp.x - g.start.x), h: Math.abs(wp.y - g.start.y) };
        renderer.overlay();
        return;
      }
      case 'connect': {
        const target = nodeAt(wp, g.fromId);
        ui.dropTarget = target?.id ?? null;
        const from = g.fromId ? { id: g.fromId, side: g.side ?? null } : g.fromPoint;
        const to = target ? { id: target.id, side: null } : { x: wp.x, y: wp.y };
        ui.preview = routeConnector({ from, to, route: 'elbow' }, model);
        renderer.overlay();
        return;
      }
      case 'endpoint': {
        const item = get(g.id);
        if (!item) return;
        const other = g.end === 'from' ? item.to : item.from;
        const target = nodeAt(wp, other.id ?? null);
        ui.dropTarget = target?.id ?? null;
        const end = target ? { id: target.id, side: null } : { x: r(wp.x), y: r(wp.y) };
        model.put({ ...item, [g.end]: end });
        renderer.overlay();
        return;
      }
      default:
    }
  }

  function finishGesture(g, sp, wp) {
    if (g.type === 'pan') {
      end();
      if (g.tapClears) setSelection([]);
      return;
    }
    if (g.type === 'marquee') {
      if (!g.started) setSelection(g.base);
      return end();
    }
    if (g.type === 'create') {
      const ghost = ui.ghost;
      end();
      const kind = g.kind;
      const [w, h] = DEFAULT_SIZE[kind];
      const rect = g.started && ghost && ghost.w > 12 && ghost.h > 12
        ? ghost
        : kind === 'lane'
          ? { x: g.start.x, y: g.start.y, w, h }
          : { x: g.start.x - w / 2, y: g.start.y - h / 2, w, h };
      addNode(kind, rect);
      setTool('select');
      return;
    }
    if (g.type === 'connect') {
      const target = ui.dropTarget ? get(ui.dropTarget) : null;
      end();
      if (!g.started) {
        if (g.quick && g.fromId) quickAdd(g.fromId, g.side);
        return;
      }
      if (target && (g.fromId || g.fromPoint)) {
        const c = makeConnector(g.fromId ? { id: g.fromId, side: g.side ?? null } : { x: r(g.fromPoint.x), y: r(g.fromPoint.y) }, { id: target.id, side: null });
        model.transact('Connect', () => model.put(c));
        setSelection([c.id]);
      } else if (g.quick) {
        dragOutNext(g.fromId, g.side, wp);
      } else {
        // The connector tool, dropped on empty board: an arrow ending there.
        const start = g.fromId ? null : g.fromPoint;
        if (g.fromId || Math.hypot(wp.x - start.x, wp.y - start.y) > 10) {
          const c = makeConnector(g.fromId ? { id: g.fromId, side: null } : { x: r(start.x), y: r(start.y) }, { x: r(wp.x), y: r(wp.y) });
          model.transact('Draw connector', () => model.put(c));
          setSelection([c.id]);
        }
      }
      setTool('select');
      return;
    }
    if ((g.type === 'move' || g.type === 'click') && !g.started) {
      end();
      // A plain click on something already in a multi-selection narrows to it.
      if (!g.modifier && ui.selection.size > 1 && model.has(g.id)) setSelection([g.id]);
      return;
    }
    end();
  }

  /** Smart guides: line up edges and centres with nearby items while dragging. */
  function snap(box, dx, dy, others) {
    const T = 6 / camera.k;
    const m = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
    const xs = [m.x, m.x + m.w / 2, m.x + m.w];
    const ys = [m.y, m.y + m.h / 2, m.y + m.h];
    let bx = null;
    let by = null;
    for (const o of others) {
      const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
      const oys = [o.y, o.y + o.h / 2, o.y + o.h];
      for (const a of xs) for (const t of oxs) {
        const d = t - a;
        if (Math.abs(d) <= T && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: t };
      }
      for (const a of ys) for (const t of oys) {
        const d = t - a;
        if (Math.abs(d) <= T && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: t };
      }
    }
    const guides = [];
    if (bx) {
      dx += bx.d;
      const top = box.y + dy;
      let from = top;
      let to = top + box.h;
      for (const o of others) {
        if ([o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - bx.at) < 0.5)) {
          from = Math.min(from, o.y);
          to = Math.max(to, o.y + o.h);
        }
      }
      guides.push({ axis: 'x', at: bx.at, from, to });
    }
    if (by) {
      dy += by.d;
      const left = box.x + dx;
      let from = left;
      let to = left + box.w;
      for (const o of others) {
        if ([o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - by.at) < 0.5)) {
          from = Math.min(from, o.x);
          to = Math.max(to, o.x + o.w);
        }
      }
      guides.push({ axis: 'y', at: by.at, from, to });
    }
    ui.guides = guides;
    return { dx, dy };
  }

  function resizeTo(g, wp, keepAspect) {
    const item = get(g.id);
    if (!item) return;
    const o = g.orig;
    const dx = wp.x - g.start.x;
    const dy = wp.y - g.start.y;
    let { x, y, w, h } = o;
    if (g.dir.includes('e')) w = o.w + dx;
    if (g.dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
    if (g.dir.includes('s')) h = o.h + dy;
    if (g.dir.includes('n')) { h = o.h - dy; y = o.y + dy; }
    if (keepAspect && g.dir.length === 2) {
      const ratio = o.w / o.h;
      if (w / h > ratio) {
        const nh = w / ratio;
        if (g.dir.includes('n')) y -= nh - h;
        h = nh;
      } else {
        const nw = h * ratio;
        if (g.dir.includes('w')) x -= nw - w;
        w = nw;
      }
    }
    const [minW, minH] = MIN_SIZE[item.kind] ?? [30, 24];
    if (w < minW) { if (g.dir.includes('w')) x -= minW - w; w = minW; }
    if (h < minH) { if (g.dir.includes('n')) y -= minH - h; h = minH; }
    let next = { ...item, x: r(x), y: r(y), w: r(w), h: r(h) };
    if (item.kind === 'text' && !g.dir.match(/[ns]/)) next = { ...next, h: textHeight(next) };
    model.put(next);
    renderer.overlay();
  }

  /* Pinch zoom on touch screens -------------------------------------- */

  function startPinch() {
    if (ui.gesture) end(false);
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  function updatePinch() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    camera.panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
    if (pinch.dist > 0) camera.zoomAt(mid.x, mid.y, dist / pinch.dist);
    pinch = { dist, mid };
  }

  /* Wheel ------------------------------------------------------------- */

  /**
   * Trackpads pan with two fingers and zoom with a pinch (which arrives as
   * ctrl + wheel). A mouse wheel zooms when the "wheel zooms" setting is on,
   * which is the default off a Mac, as in Miro. Touchpad scrolls are told
   * apart from wheel notches by their fractional or sideways deltas, and the
   * call holds for half a second so one gesture never switches mode midway.
   */
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sp = screenPoint(e);
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (e.ctrlKey || e.metaKey) {
      const pinchLike = Math.abs(dy) < 30;
      const d = Math.max(-60, Math.min(60, dy));
      camera.zoomAt(sp.x, sp.y, Math.exp(-d * (pinchLike ? 0.012 : 0.0035)));
      return;
    }
    const touchpadLike = dx !== 0 || !Number.isInteger(dy) || Math.abs(dy) < 4;
    if (touchpadLike) touchpadUntil = performance.now() + 500;
    if (ui.wheelZooms && performance.now() > touchpadUntil) {
      const d = Math.max(-60, Math.min(60, dy));
      camera.zoomAt(sp.x, sp.y, Math.exp(-d * 0.0035));
      return;
    }
    if (e.shiftKey && dx === 0) camera.panBy(-dy, 0);
    else camera.panBy(-dx, -dy);
  }, { passive: false });

  /* Double click ------------------------------------------------------- */

  stage.addEventListener('dblclick', (e) => {
    // Hit-test the point rather than trusting e.target: with pointer capture
    // on the stage, some browsers address the click to the stage itself.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (under instanceof Element && under.closest('[contenteditable]')) return;
    const target = targetOf({ target: under });
    if (target.type === 'item') {
      if (ui.readOnly) return onChange?.('details');
      return startEdit(target.id);
    }
    if (target.type === 'empty' && !ui.readOnly && ui.tool === 'select') {
      const sp = screenPoint(e);
      const wp = camera.toWorld(sp.x, sp.y);
      const [w, h] = DEFAULT_SIZE.sticky;
      addNode('sticky', { x: wp.x - w / 2, y: wp.y - h / 2, w, h });
    }
  });

  /* Making things ------------------------------------------------------ */

  function addNode(kind, rect, extra = {}) {
    const node = makeNode(kind, rect, extra);
    model.transact(`Add ${KIND_LABELS[kind].toLowerCase()}`, () => model.put(node));
    setSelection([node.id]);
    startEdit(node.id, { selectAll: true });
    return node;
  }

  function freeSpot(rect, side) {
    const others = nodes().filter((n) => n.kind !== 'lane');
    const step = side === 'left' || side === 'right' ? { x: 0, y: rect.h + 36 } : { x: rect.w + 40, y: 0 };
    for (let i = 0; i < 9; i++) {
      const n = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
      const candidate = { ...rect, x: rect.x + step.x * n, y: rect.y + step.y * n };
      const pad = { x: candidate.x - 12, y: candidate.y - 12, w: candidate.w + 24, h: candidate.h + 24 };
      if (!others.some((o) => intersects(o, pad))) return candidate;
    }
    return rect;
  }

  function nextNodeFrom(source, rect) {
    const kind = NEXT_KIND[source.kind] ?? 'step';
    const extra = kind === source.kind ? { color: source.color, size: source.size } : {};
    return makeNode(kind, rect, extra);
  }

  /** The blue + : the next step in the direction clicked, already connected. */
  function quickAdd(fromId, side) {
    const source = get(fromId);
    if (!source) return;
    const kind = NEXT_KIND[source.kind] ?? 'step';
    const [w, h] = kind === source.kind ? [source.w, source.h] : DEFAULT_SIZE[kind];
    const GAP = 80;
    const c = centre(source);
    const rect = {
      right: { x: source.x + source.w + GAP, y: c.y - h / 2 },
      left: { x: source.x - GAP - w, y: c.y - h / 2 },
      bottom: { x: c.x - w / 2, y: source.y + source.h + GAP },
      top: { x: c.x - w / 2, y: source.y - GAP - h },
    }[side];
    const node = nextNodeFrom(source, freeSpot({ ...rect, w, h }, side));
    const link = makeConnector({ id: source.id, side }, { id: node.id, side: null });
    model.transact('Add next step', () => {
      model.put(node);
      model.put(link);
    });
    setSelection([node.id]);
    startEdit(node.id, { selectAll: true });
  }

  /** Dragging from the + onto empty board: a new step where it was dropped. */
  function dragOutNext(fromId, side, wp) {
    const source = get(fromId);
    if (!source) return;
    const kind = NEXT_KIND[source.kind] ?? 'step';
    const [w, h] = kind === source.kind ? [source.w, source.h] : DEFAULT_SIZE[kind];
    const node = nextNodeFrom(source, { x: wp.x - w / 2, y: wp.y - h / 2, w, h });
    const link = makeConnector({ id: source.id, side: side ?? null }, { id: node.id, side: null });
    model.transact('Add connected step', () => {
      model.put(node);
      model.put(link);
    });
    setSelection([node.id]);
    startEdit(node.id, { selectAll: true });
  }

  /* Text editing --------------------------------------------------------- */

  const readText = (label) => label.innerText.replace(/ /g, ' ').replace(/\n$/, '');

  function textHeight(item) {
    const el = renderer.element(item.id);
    const label = el?._label;
    if (!label) return item.h;
    const prevWidth = el.style.width;
    el.style.width = `${item.w}px`;
    el.style.height = 'auto';
    const h = Math.max(24, Math.ceil(el.scrollHeight));
    el.style.width = prevWidth;
    el.style.height = `${item.h}px`;
    return h;
  }

  function startEdit(id, { selectAll = false } = {}) {
    if (ui.readOnly) return;
    if (edit) stopEdit();
    const item = get(id);
    if (!item) return;
    ui.selection = new Set([id]);
    ui.editing = id;
    renderer.flush();
    const label = renderer.labelFor(id);
    if (!label) {
      ui.editing = null;
      return;
    }
    label.textContent = item.text;
    label.contentEditable = 'plaintext-only';
    if (label.contentEditable !== 'plaintext-only') label.contentEditable = 'true';
    label.spellcheck = true;
    model.begin('Edit text');

    const onInput = () => {
      const current = get(id);
      if (!current) return stopEdit();
      const text = readText(label).slice(0, 4000);
      let next = { ...current, text };
      if (current.kind === 'text') next = { ...next, h: textHeight(next) };
      model.put(next);
      renderer.fitNow(id);
    };
    const onKey = (e) => {
      e.stopPropagation();
      const single = item.kind === 'connector' || item.kind === 'lane';
      if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (single && !e.shiftKey)))) {
        e.preventDefault();
        stopEdit();
      }
    };
    const onPaste = (e) => {
      if (label.contentEditable === 'plaintext-only') return;
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    };
    const onBlur = () => stopEdit();
    label.addEventListener('input', onInput);
    label.addEventListener('keydown', onKey);
    label.addEventListener('paste', onPaste);
    label.addEventListener('blur', onBlur);
    edit = { id, label, off: () => {
      label.removeEventListener('input', onInput);
      label.removeEventListener('keydown', onKey);
      label.removeEventListener('paste', onPaste);
      label.removeEventListener('blur', onBlur);
    } };

    label.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(label);
    if (!selectAll) range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    notify();
  }

  function stopEdit() {
    if (!edit) return;
    const { id, label, off } = edit;
    edit = null;
    off();
    const text = readText(label).slice(0, 4000);
    label.removeAttribute('contenteditable');
    const item = get(id);
    if (item) {
      let next = item.text === text ? item : { ...item, text };
      if (item.kind === 'text') {
        if (!text.trim()) {
          model.remove(id);
          next = null;
        } else {
          next = { ...next, h: textHeight(next) };
        }
      }
      if (next && next !== item) model.put(next);
    }
    model.commit();
    ui.editing = null;
    getSelection()?.removeAllRanges();
    if (!model.has(id)) ui.selection.delete(id);
    renderer.invalidate([id]);
    notify();
  }

  /* Commands ------------------------------------------------------------- */

  const selected = () => [...ui.selection].map(get).filter(Boolean);

  function selectionForCopy() {
    const items = selected();
    const ids = new Set(items.map((i) => i.id));
    for (const lane of items.filter((i) => i.kind === 'lane')) {
      for (const n of nodes()) if (n.kind !== 'lane' && containsPoint(lane, centre(n))) ids.add(n.id);
    }
    for (const c of model.all()) {
      if (c.kind !== 'connector') continue;
      const inside = (end) => end.id === undefined || ids.has(end.id);
      if (inside(c.from) && inside(c.to) && (ids.has(c.from.id) || ids.has(c.to.id) || ids.has(c.id))) ids.add(c.id);
    }
    return [...ids].map(get).filter(Boolean).filter((i) => {
      if (i.kind !== 'connector') return true;
      const ok = (end) => end.id === undefined || ids.has(end.id);
      return ok(i.from) && ok(i.to);
    });
  }

  /** Puts copies of items on the board with fresh ids, inside the current transaction. */
  function copyItems(items, { dx = 0, dy = 0, at = null } = {}) {
    const map = new Map(items.map((i) => [i.id, newId()]));
    const box = boundsOf(items.filter(isNode));
    if (at && box) {
      dx = at.x - (box.x + box.w / 2);
      dy = at.y - (box.y + box.h / 2);
    }
    const laneZ = nextZ(true);
    const nodeZ = nextZ(false);
    const ordered = [...items].sort((a, b) => a.z - b.z);
    const out = [];
    ordered.forEach((item, i) => {
      const id = map.get(item.id);
      if (item.kind === 'connector') {
        const end = (e) => (e.id !== undefined ? { id: map.get(e.id), side: e.side ?? null } : { x: r(e.x + dx), y: r(e.y + dy) });
        if ((item.from.id !== undefined && !map.has(item.from.id)) || (item.to.id !== undefined && !map.has(item.to.id))) return;
        out.push({ ...item, id, from: end(item.from), to: end(item.to) });
      } else {
        out.push({ ...item, id, x: r(item.x + dx), y: r(item.y + dy), z: (item.kind === 'lane' ? laneZ : nodeZ) + i });
      }
    });
    for (const item of out) model.put(item);
    return out.map((i) => i.id);
  }

  function deleteSelection() {
    const ids = new Set(ui.selection);
    if (!ids.size) return;
    for (const c of model.all()) {
      if (c.kind === 'connector' && (ids.has(c.from.id) || ids.has(c.to.id))) ids.add(c.id);
    }
    model.transact('Delete', () => ids.forEach((id) => model.remove(id)));
    setSelection([]);
  }

  function duplicateSelection() {
    const items = selectionForCopy();
    if (!items.length) return;
    let copies = [];
    model.transact('Duplicate', () => { copies = copyItems(items, { dx: 30, dy: 30 }); });
    setSelection(copies);
  }

  function clipboardPayload() {
    const items = selectionForCopy();
    return items.length ? { format: PASTE_FORMAT, items } : null;
  }

  function pasteText(text) {
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data?.format === PASTE_FORMAT && Array.isArray(data.items)) {
      const items = data.items.map(cleanPasted).filter(Boolean);
      if (!items.length) return;
      const view = camera.visibleRect();
      const at = ui.pointer && containsPoint(view, ui.pointer) ? ui.pointer : null;
      pasteCount += 1;
      let copies = [];
      model.transact('Paste', () => {
        copies = copyItems(items, at ? { at } : { dx: 30 * pasteCount, dy: 30 * pasteCount });
      });
      setSelection(copies);
      return;
    }
    const plain = text.trim();
    if (!plain) return;
    const view = camera.visibleRect();
    const at = ui.pointer && containsPoint(view, ui.pointer) ? ui.pointer : centre(view);
    const [w, h] = DEFAULT_SIZE.sticky;
    const node = makeNode('sticky', { x: at.x - w / 2, y: at.y - h / 2, w, h }, { text: plain.slice(0, 4000) });
    model.transact('Paste note', () => model.put(node));
    setSelection([node.id]);
  }

  /**
   * Clipboard text can come from anywhere, and pasted items are drawn before
   * the server has checked them, so anything that reaches a style attribute
   * is checked here too: colours must be hex, geometry must be numbers.
   */
  function cleanPasted(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.kind !== 'string') return null;
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    const colour = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_COLOUR[raw.kind] ?? DEFAULT_COLOUR.step;
    if (raw.kind === 'connector') {
      const end = (e) => (e && typeof e.id === 'string' ? { id: e.id, side: ['top', 'right', 'bottom', 'left'].includes(e.side) ? e.side : null }
        : e && finite(e.x) && finite(e.y) ? { x: e.x, y: e.y } : null);
      const from = end(raw.from);
      const to = end(raw.to);
      if (!from || !to) return null;
      return makeConnector(from, to, {
        id: raw.id, text: String(raw.text ?? '').slice(0, 160), color: colour, dashed: raw.dashed === true,
        arrow: ['end', 'both', 'none'].includes(raw.arrow) ? raw.arrow : 'end', route: raw.route === 'straight' ? 'straight' : 'elbow',
      });
    }
    if (!CREATE_TOOLS.has(raw.kind) || ![raw.x, raw.y, raw.w, raw.h].every(finite)) return null;
    const text = (v, max) => String(v ?? '').slice(0, max);
    return {
      ...makeNode(raw.kind, { x: raw.x, y: raw.y, w: Math.max(8, raw.w), h: Math.max(8, raw.h) }),
      id: raw.id, z: finite(raw.z) ? raw.z : 0, text: text(raw.text, 4000), color: colour,
      size: ['S', 'M', 'L', 'XL'].includes(raw.size) ? raw.size : 'M',
      owner: text(raw.owner, 160), system: text(raw.system, 160), duration: text(raw.duration, 160), notes: text(raw.notes, 8000),
      flag: ['pain', 'idea', 'automated', 'manual', 'question'].includes(raw.flag) ? raw.flag : '',
    };
  }

  const commands = {
    setTool,
    select: setSelection,
    selectAll: () => setSelection(model.all().map((i) => i.id)),
    clear: () => setSelection([]),
    delete: deleteSelection,
    duplicate: duplicateSelection,
    startEdit,
    stopEdit,
    undo() {
      if (edit) stopEdit();
      if (!model.undo()) return;
      setSelection([...ui.selection]);
    },
    redo() {
      if (edit) stopEdit();
      if (!model.redo()) return;
      setSelection([...ui.selection]);
    },
    /** Applies a change to every selected item it fits, as one undo step. */
    update(label, change) {
      if (edit) stopEdit();
      const items = selected();
      model.transact(label, () => {
        for (const item of items) {
          const next = change(item);
          if (next && next !== item) model.put(next);
        }
      });
      notify();
    },
    setField(id, field, value, label = 'Edit details') {
      const item = get(id);
      if (!item || item[field] === value) return;
      model.transact(label, () => model.put({ ...item, [field]: value }));
    },
    front() {
      commands.update('Bring to front', (item) => (isNode(item) ? { ...item, z: nextZ(item.kind === 'lane') } : item));
    },
    back() {
      commands.update('Send to back', (item) => (isNode(item) ? { ...item, z: minZ(item.kind === 'lane') } : item));
    },
    nudge(dx, dy) {
      const items = selected().filter(isNode);
      if (!items.length) return;
      model.transact('Nudge', () => items.forEach((item) => model.put({ ...item, x: item.x + dx, y: item.y + dy })));
      notify();
    },
    addLaneBelow(id) {
      const lane = get(id);
      if (!lane) return;
      let bottom = lane.y + lane.h;
      const stacked = nodes().filter((n) => n.kind === 'lane' && Math.abs(n.x - lane.x) < 4);
      for (let guard = 0; guard < 100; guard++) {
        const next = stacked.find((n) => Math.abs(n.y - bottom) < 4);
        if (!next) break;
        bottom = next.y + next.h;
      }
      const used = new Set(stacked.map((n) => n.color));
      const color = COLOURS.lane.find((c) => !used.has(c)) ?? lane.color;
      const node = makeNode('lane', { x: lane.x, y: bottom, w: lane.w, h: lane.h }, { color, text: 'New lane' });
      model.transact('Add lane', () => model.put(node));
      setSelection([node.id]);
      startEdit(node.id, { selectAll: true });
    },
    setReadOnly(readOnly) {
      if (ui.readOnly === readOnly) return;
      if (readOnly && edit) stopEdit();
      ui.readOnly = readOnly;
      if (readOnly) setTool('select');
      notify();
    },
    setPeers(peers) {
      const changed = JSON.stringify(peers) !== JSON.stringify(ui.peers);
      ui.peers = peers;
      if (changed) renderer.overlay();
    },
    zoomIn: () => camera.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25),
    zoomOut: () => camera.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 0.8),
    fit() {
      const b = boundsOf(nodes());
      camera.fit(b ? { x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 } : null);
    },
    fitSelection() {
      const b = boundsOf(selected().filter(isNode));
      if (b) camera.fit({ x: b.x - 80, y: b.y - 80, w: b.w + 160, h: b.h + 160 }, { maxZoom: 1.5 });
    },
    selected,
    get editing() { return ui.editing; },
  };

  /* Keyboard and clipboard ------------------------------------------------ */

  const TOOL_KEYS = { v: 'select', h: 'hand', n: 'sticky', r: 'step', d: 'decision', o: 'terminal', t: 'text', l: 'lane', c: 'connector' };

  addEventListener('keydown', (e) => {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (e.key === ' ') {
      if (!ui.spaceDown) {
        ui.spaceDown = true;
        stage.classList.add('is-panning');
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (ui.gesture) end(false);
      else if (ui.selection.size) setSelection([]);
      else setTool('select');
      return;
    }
    if (mod && key === 'z') {
      e.preventDefault();
      if (ui.readOnly) return;
      if (e.shiftKey) commands.redo();
      else commands.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      if (!ui.readOnly) commands.redo();
      return;
    }
    if (mod && key === 'a') {
      e.preventDefault();
      commands.selectAll();
      return;
    }
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); commands.zoomIn(); return; }
    if (mod && key === '-') { e.preventDefault(); commands.zoomOut(); return; }
    if (mod && key === '0') { e.preventDefault(); commands.fit(); return; }
    if (e.shiftKey && e.code === 'Digit1') { commands.fit(); return; }
    if (e.shiftKey && e.code === 'Digit2') { commands.fitSelection(); return; }
    if (ui.readOnly) {
      if (!mod && (key === 'v' || key === 'h')) setTool(TOOL_KEYS[key]);
      return;
    }
    if (mod && key === 'd') {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.key === 'Enter' && ui.selection.size === 1) {
      e.preventDefault();
      startEdit([...ui.selection][0]);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && ui.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      commands.nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
      return;
    }
    if (!mod && !e.altKey && e.key === ']') return commands.front();
    if (!mod && !e.altKey && e.key === '[') return commands.back();
    if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    }
  });

  addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      ui.spaceDown = false;
      if (!ui.gesture) stage.classList.remove('is-panning');
    }
  });
  addEventListener('blur', () => {
    ui.spaceDown = false;
    stage.classList.remove('is-panning');
  });

  document.addEventListener('copy', (e) => {
    if (isTyping(document.activeElement) || !ui.selection.size) return;
    const payload = clipboardPayload();
    if (!payload) return;
    e.clipboardData?.setData('text/plain', JSON.stringify(payload));
    e.preventDefault();
    pasteCount = 0;
  });
  document.addEventListener('cut', (e) => {
    if (isTyping(document.activeElement) || !ui.selection.size || ui.readOnly) return;
    const payload = clipboardPayload();
    if (!payload) return;
    e.clipboardData?.setData('text/plain', JSON.stringify(payload));
    e.preventDefault();
    deleteSelection();
  });
  document.addEventListener('paste', (e) => {
    if (isTyping(document.activeElement) || ui.readOnly || document.querySelector('dialog[open]')) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text && e.clipboardData?.files?.length) {
      toast('Images cannot be pasted onto a map yet.');
      return;
    }
    e.preventDefault();
    pasteText(text);
  });

  return commands;
}
