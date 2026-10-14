import { randomBytes } from 'node:crypto';
import { canEdit } from '../lib/auth.ts';
import { AppError, refuse } from '../lib/errors.ts';
import {
  DEFAULT_COLOURS,
  FLAGS,
  LIMITS,
  isItemId,
  sanitiseItem,
  type ConnectorItem,
  type Flag,
  type Item,
  type ItemOp,
  type NodeItem,
  type NodeKind,
} from './items.ts';
import { createMap, listMaps, publicMap, updateMap } from './maps.ts';
import { computePreview } from './preview.ts';
import type { MapRecord, Store, UserRecord } from '../store/types.ts';

/**
 * Process maps for agents.
 *
 * The board is a canvas drawn by JavaScript, which an agent cannot use: a
 * fetch sees an empty page, and driving the canvas through a browser means
 * dragging shapes about by pixel. So agents get the map as words, and edit it
 * with plain commands ("add a step after X in the AP clerk lane", "connect X
 * to Y labelled Yes"). The server works out where things go on the board,
 * and the change reaches everybody with the map open within a couple of
 * seconds, like anyone else's.
 *
 * Everything an agent sends still ends up as ordinary items that pass
 * sanitiseItem() and go through store.apply(), the same path as the browser,
 * so nothing an agent does can put a board in a state the editor could not.
 */

export const MAX_CHANGES = 300;

const GAP = 90;
const LANE_INSET = 110;
const LANE_W = 1640;
const LANE_H = 240;
const SIZE: Record<NodeKind, [number, number]> = {
  sticky: [180, 180],
  step: [190, 84],
  decision: [170, 120],
  terminal: [150, 64],
  text: [240, 34],
  lane: [LANE_W, LANE_H],
};

const KIND_NAMES: Record<NodeKind, string> = {
  step: 'Step',
  decision: 'Decision',
  terminal: 'Start/end',
  sticky: 'Note',
  text: 'Text',
  lane: 'Lane',
};

/** What an agent may call a kind, mapped to what the board calls it. */
const KIND_ALIASES: Record<string, NodeKind> = {
  step: 'step',
  task: 'step',
  activity: 'step',
  decision: 'decision',
  question: 'decision',
  gateway: 'decision',
  start: 'terminal',
  end: 'terminal',
  terminal: 'terminal',
  note: 'sticky',
  sticky: 'sticky',
  comment: 'sticky',
  text: 'text',
  label: 'text',
  lane: 'lane',
  swimlane: 'lane',
};

const FLAG_ALIASES: Record<string, Flag> = {
  '': '',
  none: '',
  pain: 'pain',
  'pain point': 'pain',
  painpoint: 'pain',
  idea: 'idea',
  improvement: 'idea',
  'improvement idea': 'idea',
  automated: 'automated',
  automatic: 'automated',
  manual: 'manual',
  question: 'question',
  'open question': 'question',
};

/** Colour names per palette, matching the swatches in the editor (board/palette.js). */
const COLOUR_NAMES: Record<'sticky' | 'shape' | 'lane' | 'line', Record<string, string>> = {
  sticky: { yellow: '#fff1a8', orange: '#ffd8a8', pink: '#fde2e4', red: '#fde2e4', purple: '#e5dbff', blue: '#d0ebff', teal: '#c3fae8', green: '#d3f9d8', grey: '#e9ecef', gray: '#e9ecef' },
  shape: { white: '#ffffff', blue: '#e7f1fb', green: '#e3f1e4', yellow: '#fff4e0', orange: '#fff4e0', red: '#fde8e8', pink: '#fde8e8', purple: '#efe9fb', teal: '#e3f6f4', grey: '#f1f3f5', gray: '#f1f3f5' },
  lane: { grey: '#f3f5f8', gray: '#f3f5f8', blue: '#eef4f9', orange: '#f6f1ee', beige: '#f6f1ee', green: '#eef6ef', yellow: '#fbf3e6', purple: '#f4eff9', red: '#fdf0f0', pink: '#fdf0f0', white: '#ffffff' },
  line: { black: '#1f2328', grey: '#4b5563', gray: '#4b5563', blue: '#2a78d6', red: '#c92a2a', green: '#2b8a3e', orange: '#e8590c', purple: '#7048e8', teal: '#0c8599' },
};

function palette(kind: Item['kind']): Record<string, string> {
  if (kind === 'sticky') return COLOUR_NAMES.sticky;
  if (kind === 'lane') return COLOUR_NAMES.lane;
  if (kind === 'text' || kind === 'connector') return COLOUR_NAMES.line;
  return COLOUR_NAMES.shape;
}

const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
const newId = () => randomBytes(9).toString('base64url');

export function boardUrl(origin: string, mapId: string): string {
  return `${origin}/maps/board.html?id=${mapId}`;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

interface Board {
  items: Map<string, Item>;
}

const isNode = (item: Item | undefined): item is NodeItem => Boolean(item) && item!.kind !== 'connector';
const nodesOf = (board: Board) => [...board.items.values()].filter(isNode);
const lanesOf = (board: Board) => nodesOf(board).filter((n) => n.kind === 'lane').sort((a, b) => a.y - b.y || a.x - b.x);
const shapesOf = (board: Board) => nodesOf(board).filter((n) => n.kind !== 'lane');
const connectorsOf = (board: Board) => [...board.items.values()].filter((i): i is ConnectorItem => i.kind === 'connector');

/** The lane a shape sits in: the one holding its centre, topmost first. */
function laneOf(board: Board, node: NodeItem): NodeItem | null {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const hits = lanesOf(board).filter((l) => cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h);
  return hits.sort((a, b) => b.z - a.z)[0] ?? null;
}

function endId(end: ConnectorItem['from']): string | null {
  return 'id' in end ? end.id : null;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, ' ').trim()}"`;
}

/** The map as words and as data, in reading order: lane by lane, left to right. */
export function outline(map: MapRecord, items: Item[], origin: string, editable: boolean) {
  const board: Board = { items: new Map(items.map((i) => [i.id, i])) };
  const lanes = lanesOf(board);
  const shapes = shapesOf(board);
  const connectors = connectorsOf(board);
  const laneFor = new Map(shapes.map((s) => [s.id, laneOf(board, s)?.id ?? null]));
  const byId = new Map(shapes.map((s) => [s.id, s]));

  const order = (list: NodeItem[]) => [...list].sort((a, b) => a.x - b.x || a.y - b.y);
  const groups: { lane: NodeItem | null; items: NodeItem[] }[] = lanes.map((lane) => ({
    lane,
    items: order(shapes.filter((s) => laneFor.get(s.id) === lane.id)),
  }));
  const loose = order(shapes.filter((s) => !laneFor.get(s.id)));
  if (loose.length) groups.push({ lane: null, items: loose });

  const next = (id: string) =>
    connectors
      .filter((c) => endId(c.from) === id)
      .map((c) => ({ id: endId(c.to), label: c.text, connector: c.id }));

  const describe = (n: NodeItem) => {
    const details = [
      n.owner && `who: ${n.owner}`,
      n.system && `system: ${n.system}`,
      n.duration && `time: ${n.duration}`,
      n.flag && `flag: ${n.flag}`,
    ].filter(Boolean);
    const lines = [`- [${n.id}] ${KIND_NAMES[n.kind]}: ${quote(n.text || '(no text)')}${details.length ? ` | ${details.join(' | ')}` : ''}`];
    if (n.notes) lines.push(`    notes: ${n.notes.replace(/\s+/g, ' ').trim()}`);
    for (const link of next(n.id)) {
      const target = link.id ? byId.get(link.id) : null;
      const where = target ? `[${target.id}] ${quote(target.text || KIND_NAMES[target.kind])}` : link.id ? `[${link.id}]` : 'a loose end';
      lines.push(`    -> ${where}${link.label ? ` (${link.label})` : ''}`);
    }
    return lines.join('\n');
  };

  const counts = shapes.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
  const summary = [
    counts.step && `${counts.step} step${counts.step === 1 ? '' : 's'}`,
    counts.decision && `${counts.decision} decision${counts.decision === 1 ? '' : 's'}`,
    counts.terminal && `${counts.terminal} start/end`,
    counts.sticky && `${counts.sticky} note${counts.sticky === 1 ? '' : 's'}`,
    lanes.length && `${lanes.length} lane${lanes.length === 1 ? '' : 's'}`,
    connectors.length && `${connectors.length} connector${connectors.length === 1 ? '' : 's'}`,
  ].filter(Boolean);

  const text = [
    `Map: ${map.name}`,
    `Id: ${map.mapId} | Status: ${map.status.replace('_', ' ')}${map.area ? ` | Area: ${map.area}` : ''} | Revision: ${map.revision}${map.archivedAt ? ' | ARCHIVED (read only)' : ''}`,
    `Open in a browser: ${boardUrl(origin, map.mapId)}`,
    map.description ? `Description: ${map.description}` : null,
    `Contains: ${summary.length ? summary.join(', ') : 'nothing yet'}.${editable ? '' : ' You can read this map but not change it.'}`,
    '',
    ...groups.flatMap((g) => [
      g.lane ? `Lane ${quote(g.lane.text || 'Lane')} [${g.lane.id}]:` : lanes.length ? 'Not in a lane:' : 'On the board:',
      ...(g.items.length ? g.items.map(describe) : ['  (empty)']),
      '',
    ]),
    'Refer to anything by the id in [brackets], or by its exact text.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    map: { ...publicMap(map), preview: undefined, url: boardUrl(origin, map.mapId), canEdit: editable },
    lanes: lanes.map((l, i) => ({ id: l.id, name: l.text, order: i + 1 })),
    items: groups.flatMap((g) =>
      g.items.map((n) => ({
        id: n.id,
        kind: n.kind,
        text: n.text,
        lane: g.lane?.id ?? null,
        owner: n.owner,
        system: n.system,
        duration: n.duration,
        flag: n.flag,
        notes: n.notes,
        color: n.color,
        next: next(n.id),
      })),
    ),
    connectors: connectors.map((c) => ({ id: c.id, from: endId(c.from), to: endId(c.to), label: c.text, dashed: c.dashed })),
    text,
  };
}

async function liveItems(store: Store, mapId: string): Promise<Item[]> {
  return (await store.maps.items(mapId, 0)).flatMap((row) => (row.item ? [row.item] : []));
}

async function requireMap(store: Store, mapId: string): Promise<MapRecord> {
  const map = await store.maps.get(mapId);
  if (!map) refuse('NOT_FOUND');
  return map;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A map by its id, or by its name (exactly, or a part of it that only one map has). */
export async function findMap(store: Store, ref: unknown): Promise<MapRecord> {
  if (typeof ref !== 'string' || !ref.trim()) refuse('INVALID_REQUEST', { field: 'map' }, 'Say which map: its id or its name.');
  const wanted = ref.trim();
  if (UUID.test(wanted)) return requireMap(store, wanted.toLowerCase());
  const maps = [...(await store.maps.list({ archived: false })), ...(await store.maps.list({ archived: true }))];
  const exact = maps.filter((m) => norm(m.name) === norm(wanted));
  const partial = exact.length ? exact : maps.filter((m) => norm(m.name).includes(norm(wanted)));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    refuse('INVALID_REQUEST', { field: 'map' }, `More than one map matches "${wanted}": ${partial.map((m) => `"${m.name}" (${m.mapId})`).join(', ')}. Use the id.`);
  }
  refuse('NOT_FOUND', { field: 'map' }, `No map is called "${wanted}". List the maps to see what there is.`);
}

export async function readMapForAgent(store: Store, agent: UserRecord, mapId: string, origin: string) {
  const map = await requireMap(store, mapId);
  const items = await liveItems(store, mapId);
  // People with the board open see the agent among them while it works.
  if (!map.archivedAt) await store.maps.touchPresence(mapId, agent.userId, 'agent', []);
  return outline(map, items, origin, canEdit(agent) && !map.archivedAt);
}

export async function listMapsForAgent(store: Store, origin: string, archived = false) {
  return (await listMaps(store, archived)).map((m) => ({
    id: m.mapId,
    name: m.name,
    area: m.area,
    status: m.status,
    description: m.description,
    items: m.itemCount,
    updatedAt: m.updatedAt,
    updatedBy: m.updatedByName,
    url: boardUrl(origin, m.mapId),
  }));
}

export async function createMapForAgent(store: Store, agent: UserRecord, body: Record<string, unknown>, origin: string) {
  const created = await createMap(store, agent, body);
  const map = await requireMap(store, created.mapId);
  const items = await liveItems(store, map.mapId);
  if (items.length) await store.maps.setPreview(map.mapId, computePreview(items));
  return outline(map, items, origin, true);
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

type Change = Record<string, unknown>;

interface EditState extends Board {
  touched: Set<string>;
  /** What the agent asked for, as opposed to lanes stretched to fit: outlined for people on the board. */
  focus: Set<string>;
  removed: Set<string>;
  created: { id: string; kind: string; text: string }[];
  notes: string[];
  lastPlaced: NodeItem | null;
  index: number;
  action: string;
}

function fail(state: EditState, message: string): never {
  refuse('INVALID_REQUEST', { change: state.index + 1, action: state.action }, `Change ${state.index + 1} (${state.action}): ${message}`);
}

function str(state: EditState, change: Change, field: string, max: number = LIMITS.field): string | undefined {
  const value = change[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') fail(state, `"${field}" must be text.`);
  return String(value).slice(0, max);
}

function put(state: EditState, item: Item): Item {
  const clean = sanitiseItem(item);
  state.items.set(clean.id, clean);
  state.touched.add(clean.id);
  state.removed.delete(clean.id);
  return clean;
}

function remove(state: EditState, id: string): void {
  state.items.delete(id);
  state.touched.delete(id);
  state.focus.delete(id);
  state.removed.add(id);
}

/** An item by id or by its exact text. Ambiguity is an error, never a guess. */
function find(state: EditState, ref: unknown, field: string, filter: (i: Item) => boolean = () => true): Item {
  if (typeof ref !== 'string' || !ref.trim()) fail(state, `"${field}" is missing: give an item's id or its exact text.`);
  const byId = state.items.get(ref.trim());
  if (byId && filter(byId)) return byId;
  const wanted = norm(ref);
  const matches = [...state.items.values()].filter((i) => filter(i) && norm(i.text) === wanted);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    fail(state, `${quote(ref)} matches ${matches.length} items (${matches.map((m) => m.id).join(', ')}). Use the id.`);
  }
  const close = [...state.items.values()]
    .filter((i) => filter(i) && i.text && norm(i.text).includes(wanted.slice(0, 12)))
    .slice(0, 5)
    .map((i) => `[${i.id}] ${quote(i.text)}`);
  fail(state, `nothing on the map is ${quote(ref)}${close.length ? `. Did you mean ${close.join(', ')}?` : '. Read the map to see the ids.'}`);
}

const shapeFilter = (i: Item) => i.kind !== 'connector' && i.kind !== 'lane';
const laneFilter = (i: Item) => i.kind === 'lane';

function overlaps(a: { x: number; y: number; w: number; h: number }, b: NodeItem, pad = 24): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Slides a rectangle right until it sits clear of every other shape. */
function clearSpot(state: EditState, rect: { x: number; y: number; w: number; h: number }, ignore: string | null) {
  for (let guard = 0; guard < 1000; guard++) {
    const hit = shapesOf(state).find((n) => n.id !== ignore && overlaps(rect, n));
    if (!hit) break;
    rect.x = hit.x + hit.w + GAP;
  }
  return rect;
}

/** Lanes side by side share a width: stretch them all to reach a shape that went past the end. */
function widenLanes(state: EditState, lane: NodeItem, right: number): void {
  const need = right + 80;
  if (need <= lane.x + lane.w) return;
  for (const l of lanesOf(state)) {
    if (Math.abs(l.x - lane.x) > 1 || l.x + l.w >= need) continue;
    put(state, { ...l, w: Math.min(LIMITS.maxSize, need - l.x) });
  }
}

function newLane(state: EditState, name: string, color?: string, id?: string): NodeItem {
  const lanes = lanesOf(state);
  const shapes = shapesOf(state);
  let x = 0;
  let y = 0;
  let w = LANE_W;
  if (lanes.length) {
    x = Math.min(...lanes.map((l) => l.x));
    y = Math.max(...lanes.map((l) => l.y + l.h));
    w = Math.max(...lanes.map((l) => l.x + l.w)) - x;
  } else if (shapes.length) {
    x = Math.min(...shapes.map((s) => s.x)) - LANE_INSET;
    y = Math.max(...shapes.map((s) => s.y + s.h)) + 60;
    w = Math.max(LANE_W, Math.max(...shapes.map((s) => s.x + s.w)) - x + LANE_INSET);
  }
  const lane = put(state, {
    id: id ?? newId(),
    kind: 'lane',
    x,
    y,
    w,
    h: LANE_H,
    z: -1000 + lanes.length,
    text: name,
    color: color ?? DEFAULT_COLOURS.lane,
    size: 'M',
    owner: '',
    system: '',
    duration: '',
    notes: '',
    flag: '',
  }) as NodeItem;
  state.created.push({ id: lane.id, kind: 'lane', text: lane.text });
  state.focus.add(lane.id);
  return lane;
}

/** A lane by id or name; a name nobody has yet makes a new lane at the bottom. */
function laneFor(state: EditState, ref: unknown): NodeItem {
  if (typeof ref === 'string' && ref.trim()) {
    const id = state.items.get(ref.trim());
    if (id?.kind === 'lane') return id as NodeItem;
    const matches = lanesOf(state).filter((l) => norm(l.text) === norm(ref));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) fail(state, `more than one lane is called ${quote(ref)}. Use the lane's id.`);
    const lane = newLane(state, ref.trim().slice(0, LIMITS.field));
    state.notes.push(`Made a new lane ${quote(lane.text)} [${lane.id}].`);
    return lane;
  }
  fail(state, '"lane" must be a lane\'s name or id.');
}

function readColour(state: EditState, kind: Item['kind'], value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(state, '"color" must be a colour name or #rrggbb.');
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const named = palette(kind)[norm(value)];
  if (!named) fail(state, `unknown colour ${quote(value)}. Use one of ${Object.keys(palette(kind)).join(', ')}, or #rrggbb.`);
  return named;
}

function readFlag(state: EditState, value: unknown): Flag | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === false) return '';
  if (typeof value !== 'string') fail(state, `"flag" must be one of ${FLAGS.filter(Boolean).join(', ')}.`);
  const flag = FLAG_ALIASES[norm(value)];
  if (flag === undefined) fail(state, `unknown flag ${quote(value)}. Use one of ${FLAGS.filter(Boolean).join(', ')}, or "" to clear it.`);
  return flag;
}

function readNumber(state: EditState, change: Change, field: string): number | undefined {
  const value = change[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(state, `"${field}" must be a number.`);
  return value;
}

/** The details any shape can carry, read from a change. */
function details(state: EditState, change: Change, kind: Item['kind']) {
  return {
    text: str(state, change, 'text', LIMITS.text) ?? str(state, change, 'name', LIMITS.text),
    owner: str(state, change, 'owner') ?? str(state, change, 'who'),
    system: str(state, change, 'system'),
    duration: str(state, change, 'duration') ?? str(state, change, 'time'),
    notes: str(state, change, 'notes', LIMITS.notes),
    flag: readFlag(state, change.flag),
    color: readColour(state, kind, change.color ?? change.colour),
  };
}

function connect(state: EditState, from: NodeItem, to: NodeItem, label: string | undefined, dashed?: boolean): ConnectorItem {
  if (from.id === to.id) fail(state, 'cannot connect something to itself.');
  const existing = connectorsOf(state).find((c) => endId(c.from) === from.id && endId(c.to) === to.id);
  if (existing) {
    state.focus.add(existing.id);
    return put(state, { ...existing, text: label ?? existing.text, dashed: dashed ?? existing.dashed }) as ConnectorItem;
  }
  const id = newId();
  state.focus.add(id);
  return put(state, {
    id,
    kind: 'connector',
    z: 0,
    from: { id: from.id, side: null },
    to: { id: to.id, side: null },
    text: label ?? '',
    color: DEFAULT_COLOURS.connector,
    dashed: dashed ?? false,
    arrow: 'end',
    route: 'elbow',
  }) as ConnectorItem;
}

function topZ(state: EditState): number {
  return Math.max(0, ...shapesOf(state).map((s) => s.z)) + 1;
}

/** Where a new shape goes: after something, in a lane, or next along the row. */
function place(state: EditState, kind: NodeKind, change: Change, lane: NodeItem | null, after: NodeItem | null, w: number, h: number) {
  const x = readNumber(state, change, 'x');
  const y = readNumber(state, change, 'y');
  if (x !== undefined && y !== undefined) return { x, y };

  if (kind === 'sticky' || kind === 'text') {
    const near = after ?? (change.near !== undefined ? (find(state, change.near, 'near', shapeFilter) as NodeItem) : null);
    const shapes = shapesOf(state);
    // Beside the item and a little above it: clear of the arrow coming in at
    // the top and the one leaving on the right.
    const rect = near
      ? { x: near.x + near.w + 24, y: near.y - h + 16, w, h }
      : {
          x: shapes.length ? Math.max(...shapes.map((s) => s.x + s.w)) + GAP : 0,
          y: shapes.length ? Math.min(...shapes.map((s) => s.y)) : 0,
          w,
          h,
        };
    return clearSpot(state, rect, null);
  }

  const inLane = lane ? shapesOf(state).filter((s) => laneOf(state, s)?.id === lane.id) : [];
  const anchor = after ?? (lane ? null : state.lastPlaced ?? [...shapesOf(state)].sort((a, b) => b.x + b.w - (a.x + a.w))[0] ?? null);
  const rect = { x: 0, y: 0, w, h };
  if (lane) rect.y = lane.y + (lane.h - h) / 2;
  else if (anchor) rect.y = anchor.y + anchor.h / 2 - h / 2;
  if (after) rect.x = after.x + after.w + GAP;
  else if (lane) rect.x = inLane.length ? Math.max(...inLane.map((s) => s.x + s.w)) + GAP : lane.x + LANE_INSET;
  else if (anchor) rect.x = anchor.x + anchor.w + GAP;
  if (x !== undefined) rect.x = x;
  if (y !== undefined) rect.y = y;
  return clearSpot(state, rect, null);
}

function applyAdd(state: EditState, change: Change): void {
  const raw = typeof change.kind === 'string' ? norm(change.kind) : 'step';
  const kind = KIND_ALIASES[raw];
  if (!kind) fail(state, `unknown kind ${quote(String(change.kind))}. Use step, decision, start, end, note, text or lane.`);
  const d = details(state, change, kind);
  const text = d.text ?? (raw === 'start' ? 'Start' : raw === 'end' ? 'End' : undefined);
  if (!text && kind !== 'sticky') fail(state, '"text" is missing.');

  let id: string | undefined;
  if (change.id !== undefined) {
    if (!isItemId(change.id)) fail(state, '"id" may only use letters, digits, - and _ (up to 64).');
    if (state.items.has(change.id)) fail(state, `something already has the id ${quote(change.id)}.`);
    id = change.id;
  }

  if (kind === 'lane') {
    newLane(state, text!, d.color, id);
    return;
  }

  const after = change.after !== undefined ? (find(state, change.after, 'after', shapeFilter) as NodeItem) : null;
  const lane = change.lane !== undefined ? laneFor(state, change.lane) : after && kind !== 'sticky' && kind !== 'text' ? laneOf(state, after) : null;
  const [w, h] = SIZE[kind];
  const spot = place(state, kind, change, lane, after, w, h);
  const node = put(state, {
    id: id ?? newId(),
    kind,
    x: spot.x,
    y: spot.y,
    w,
    h,
    z: topZ(state),
    text: text ?? '',
    color: d.color ?? DEFAULT_COLOURS[kind],
    size: kind === 'sticky' ? 'S' : 'M',
    owner: d.owner ?? '',
    system: d.system ?? '',
    duration: d.duration ?? '',
    notes: d.notes ?? '',
    flag: d.flag ?? '',
  }) as NodeItem;
  if (lane) widenLanes(state, lane, node.x + node.w);
  state.created.push({ id: node.id, kind: node.kind, text: node.text });
  state.focus.add(node.id);
  if (kind !== 'sticky' && kind !== 'text') state.lastPlaced = node;
  if (after && kind !== 'sticky' && kind !== 'text' && change.connect !== false) connect(state, after, node, str(state, change, 'label'));
}

function applyUpdate(state: EditState, change: Change): void {
  const target = find(state, change.item ?? change.id, 'item');
  state.focus.add(target.id);
  if (target.kind === 'connector') {
    const label = str(state, change, 'label') ?? str(state, change, 'text');
    const color = readColour(state, 'connector', change.color ?? change.colour);
    put(state, {
      ...target,
      text: label ?? target.text,
      color: color ?? target.color,
      dashed: typeof change.dashed === 'boolean' ? change.dashed : target.dashed,
    });
    return;
  }
  const d = details(state, change, target.kind);
  let next: NodeItem = {
    ...target,
    text: d.text ?? target.text,
    owner: d.owner ?? target.owner,
    system: d.system ?? target.system,
    duration: d.duration ?? target.duration,
    notes: d.notes ?? target.notes,
    flag: d.flag ?? target.flag,
    color: d.color ?? target.color,
  };
  if (target.kind !== 'lane') {
    const after = change.after !== undefined ? (find(state, change.after, 'after', (i) => shapeFilter(i) && i.id !== target.id) as NodeItem) : null;
    const lane = change.lane !== undefined ? laneFor(state, change.lane) : null;
    const x = readNumber(state, change, 'x');
    const y = readNumber(state, change, 'y');
    if (after || lane || x !== undefined || y !== undefined) {
      const rect = { x: next.x, y: next.y, w: next.w, h: next.h };
      if (after) {
        rect.x = after.x + after.w + GAP;
        rect.y = after.y + after.h / 2 - rect.h / 2;
      }
      if (lane) rect.y = lane.y + (lane.h - rect.h) / 2;
      if (x !== undefined) rect.x = x;
      if (y !== undefined) rect.y = y;
      clearSpot(state, rect, target.id);
      next = { ...next, x: rect.x, y: rect.y };
      const home = lane ?? laneOf({ items: new Map([...state.items, [next.id, next]]) }, next);
      if (home) widenLanes(state, home, next.x + next.w);
    }
  } else {
    const h = readNumber(state, change, 'height');
    if (h !== undefined) next = { ...next, h };
  }
  put(state, next);
}

function applyDelete(state: EditState, change: Change): void {
  const target = find(state, change.item ?? change.id, 'item');
  if (target.kind !== 'connector' && target.kind !== 'lane') {
    for (const c of connectorsOf(state)) if (endId(c.from) === target.id || endId(c.to) === target.id) remove(state, c.id);
  }
  remove(state, target.id);
}

function applyConnect(state: EditState, change: Change): void {
  const from = find(state, change.from, 'from', shapeFilter) as NodeItem;
  const to = find(state, change.to, 'to', shapeFilter) as NodeItem;
  connect(state, from, to, str(state, change, 'label') ?? str(state, change, 'text'), typeof change.dashed === 'boolean' ? change.dashed : undefined);
}

function applyDisconnect(state: EditState, change: Change): void {
  const from = find(state, change.from, 'from', shapeFilter);
  const to = find(state, change.to, 'to', shapeFilter);
  const links = connectorsOf(state).filter(
    (c) => (endId(c.from) === from.id && endId(c.to) === to.id) || (endId(c.from) === to.id && endId(c.to) === from.id),
  );
  if (!links.length) fail(state, `${quote(from.text || from.id)} and ${quote(to.text || to.id)} are not connected.`);
  for (const c of links) remove(state, c.id);
}

const ACTIONS: Record<string, (state: EditState, change: Change) => void> = {
  add: applyAdd,
  update: applyUpdate,
  move: applyUpdate,
  delete: applyDelete,
  remove: applyDelete,
  connect: applyConnect,
  disconnect: applyDisconnect,
};

/**
 * Applies an agent's changes to a map, all or nothing: one bad change refuses
 * the lot with a message naming it, so a map is never left half-edited.
 */
export async function editMapForAgent(store: Store, agent: UserRecord, mapId: string, body: Record<string, unknown>, origin: string) {
  if (!canEdit(agent)) throw new AppError('READ_ONLY');
  const changes = Array.isArray(body.changes) ? body.changes : body.action ? [body] : null;
  if (!changes || !changes.length) {
    refuse('INVALID_REQUEST', { field: 'changes' }, 'Send { "changes": [ ... ] }, a list of changes such as { "action": "add", "kind": "step", "text": "Check the invoice" }.');
  }
  if (changes.length > MAX_CHANGES) refuse('INVALID_REQUEST', { field: 'changes', max: MAX_CHANGES }, `At most ${MAX_CHANGES} changes in one request.`);

  const map = await requireMap(store, mapId);
  if (map.archivedAt) refuse('MAP_ARCHIVED');
  const items = await liveItems(store, mapId);
  const state: EditState = {
    items: new Map(items.map((i) => [i.id, i])),
    touched: new Set(),
    focus: new Set(),
    removed: new Set(),
    created: [],
    notes: [],
    lastPlaced: null,
    index: 0,
    action: '',
  };
  const mapPatch: Record<string, unknown> = {};

  changes.forEach((raw, index) => {
    state.index = index;
    state.action = '';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(state, 'each change must be an object with an "action".');
    const change = raw as Change;
    const action = typeof change.action === 'string' ? norm(change.action) : '';
    state.action = action || '?';
    if (action === 'set_map' || action === 'map') {
      for (const field of ['name', 'description', 'status', 'area']) if (change[field] !== undefined) mapPatch[field] = change[field];
      if (!Object.keys(mapPatch).length) fail(state, 'say what to change: name, description, status or area.');
      return;
    }
    const run = ACTIONS[action];
    if (!run) fail(state, `unknown action ${quote(String(change.action ?? ''))}. Use add, update, move, connect, disconnect, delete or set_map.`);
    run(state, change);
  });

  // Validate map details before touching the board, so a bad status cannot
  // leave the items changed and the details not.
  if (Object.keys(mapPatch).length && typeof mapPatch.status === 'string') {
    mapPatch.status = norm(mapPatch.status).replace(/[\s-]+/g, '_');
  }

  const ops: ItemOp[] = [
    ...[...state.touched].map((id): ItemOp => ({ type: 'put', item: state.items.get(id)! })),
    ...[...state.removed].filter((id) => items.some((i) => i.id === id)).map((id): ItemOp => ({ type: 'delete', id })),
  ];
  if (ops.length > LIMITS.opsPerSync) refuse('INVALID_REQUEST', null, 'That is too many changes for one request. Split it in two.');
  // Map details first: updateMap validates them, and the item changes above
  // are already validated, so either both land or the request is refused.
  if (Object.keys(mapPatch).length) await updateMap(store, agent, mapId, mapPatch);

  let revision = map.revision;
  if (ops.length) {
    const result = await store.maps.apply(mapId, ops, agent.userId, LIMITS.itemsPerMap);
    if (!result.ok) refuse(result.code);
    revision = result.revision;
    const finalItems = [...state.items.values()];
    await store.maps.setPreview(mapId, computePreview(finalItems));
  }
  // Show people on the board what the agent just touched, outlined in its colour.
  await store.maps.touchPresence(mapId, agent.userId, 'agent', [...state.focus].slice(0, 200));

  const fresh = await requireMap(store, mapId);
  const view = outline(fresh, [...state.items.values()], origin, true);
  return {
    revision,
    applied: changes.length,
    created: state.created,
    deleted: [...state.removed],
    notes: state.notes,
    url: view.map.url,
    outline: view.text,
  };
}

