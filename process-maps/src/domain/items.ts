import { refuse } from '../lib/errors.ts';

/**
 * What can sit on a map, and the server's check on every item a browser sends.
 *
 * The browser owns the shape of an item; the server owns its limits. Every
 * item is rebuilt here from known fields only, with numbers clamped and text
 * capped, so the database never holds anything the editor could not have
 * produced, whatever a caller puts in the request.
 */

export const NODE_KINDS = ['sticky', 'step', 'decision', 'terminal', 'text', 'lane'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type Kind = NodeKind | 'connector';

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type Side = (typeof SIDES)[number];

export const FLAGS = ['', 'pain', 'idea', 'automated', 'manual', 'question'] as const;
export type Flag = (typeof FLAGS)[number];

export const SIZES = ['S', 'M', 'L', 'XL'] as const;
export type TextSize = (typeof SIZES)[number];

export interface NodeItem {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  text: string;
  color: string;
  size: TextSize;
  /** Process detail, edited in the side panel. */
  owner: string;
  system: string;
  duration: string;
  notes: string;
  flag: Flag;
}

export type ConnectorEnd = { id: string; side: Side | null } | { x: number; y: number };

export interface ConnectorItem {
  id: string;
  kind: 'connector';
  z: number;
  from: ConnectorEnd;
  to: ConnectorEnd;
  text: string;
  color: string;
  dashed: boolean;
  arrow: 'end' | 'both' | 'none';
  route: 'elbow' | 'straight';
}

export type Item = NodeItem | ConnectorItem;

export const LIMITS = {
  itemsPerMap: 4000,
  opsPerSync: 1500,
  text: 4000,
  notes: 8000,
  field: 160,
  /** The canvas is large but not unbounded: far-flung coordinates are a bug. */
  coordinate: 1_000_000,
  minSize: 8,
  maxSize: 20_000,
} as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function num(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse('INVALID_REQUEST', { field });
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
}

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') refuse('INVALID_REQUEST', { field });
  // Over-long text is truncated rather than refused: a pasted essay should not
  // make the whole batch fail and lose everybody else's edits with it.
  return value.slice(0, max);
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback;
}

function colour(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;
}

function end(value: unknown, field: string): ConnectorEnd {
  if (!value || typeof value !== 'object') refuse('INVALID_REQUEST', { field });
  const v = value as Record<string, unknown>;
  if (v.id !== undefined) {
    if (!isItemId(v.id)) refuse('INVALID_REQUEST', { field });
    const side = v.side === null || v.side === undefined ? null : oneOf(v.side, SIDES, 'right');
    return { id: v.id, side };
  }
  return {
    x: num(v.x, `${field}.x`, -LIMITS.coordinate, LIMITS.coordinate),
    y: num(v.y, `${field}.y`, -LIMITS.coordinate, LIMITS.coordinate),
  };
}

export const DEFAULT_COLOURS: Record<Kind, string> = {
  sticky: '#fff1a8',
  step: '#ffffff',
  decision: '#fff4e0',
  terminal: '#e3f1e4',
  text: '#1f2328',
  lane: '#f3f5f8',
  connector: '#4b5563',
};

/** Rebuilds an item from known fields, or refuses the request. */
export function sanitiseItem(raw: unknown): Item {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INVALID_REQUEST', { field: 'item' });
  const r = raw as Record<string, unknown>;
  if (!isItemId(r.id)) refuse('INVALID_REQUEST', { field: 'id' });
  const z = num(r.z ?? 0, 'z', -1e9, 1e9);

  if (r.kind === 'connector') {
    return {
      id: r.id,
      kind: 'connector',
      z,
      from: end(r.from, 'from'),
      to: end(r.to, 'to'),
      text: text(r.text, 'text', LIMITS.field),
      color: colour(r.color, DEFAULT_COLOURS.connector),
      dashed: r.dashed === true,
      arrow: oneOf(r.arrow, ['end', 'both', 'none'] as const, 'end'),
      route: oneOf(r.route, ['elbow', 'straight'] as const, 'elbow'),
    };
  }

  if (typeof r.kind !== 'string' || !(NODE_KINDS as readonly string[]).includes(r.kind)) {
    refuse('INVALID_REQUEST', { field: 'kind' });
  }
  const kind = r.kind as NodeKind;
  return {
    id: r.id,
    kind,
    x: num(r.x, 'x', -LIMITS.coordinate, LIMITS.coordinate),
    y: num(r.y, 'y', -LIMITS.coordinate, LIMITS.coordinate),
    w: num(r.w, 'w', LIMITS.minSize, LIMITS.maxSize),
    h: num(r.h, 'h', LIMITS.minSize, LIMITS.maxSize),
    z,
    text: text(r.text, 'text', LIMITS.text),
    color: colour(r.color, DEFAULT_COLOURS[kind]),
    size: oneOf(r.size, SIZES, 'M'),
    owner: text(r.owner, 'owner', LIMITS.field),
    system: text(r.system, 'system', LIMITS.field),
    duration: text(r.duration, 'duration', LIMITS.field),
    notes: text(r.notes, 'notes', LIMITS.notes),
    flag: oneOf(r.flag, FLAGS, ''),
  };
}

export type ItemOp = { type: 'put'; item: Item } | { type: 'delete'; id: string };

/**
 * Validates a batch of changes. A later op on the same id wins, so the batch
 * collapses to one change per item before it reaches the database.
 */
export function sanitiseOps(raw: unknown): ItemOp[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) refuse('INVALID_REQUEST', { field: 'ops' });
  if (raw.length > LIMITS.opsPerSync) refuse('INVALID_REQUEST', { field: 'ops', max: LIMITS.opsPerSync });
  const byId = new Map<string, ItemOp>();
  for (const op of raw) {
    if (!op || typeof op !== 'object') refuse('INVALID_REQUEST', { field: 'op' });
    const o = op as Record<string, unknown>;
    if (o.type === 'delete') {
      if (!isItemId(o.id)) refuse('INVALID_REQUEST', { field: 'id' });
      byId.delete(o.id);
      byId.set(o.id, { type: 'delete', id: o.id });
    } else if (o.type === 'put') {
      const item = sanitiseItem(o.item);
      byId.delete(item.id);
      byId.set(item.id, { type: 'put', item });
    } else {
      refuse('INVALID_REQUEST', { field: 'type' });
    }
  }
  return [...byId.values()];
}

export function opId(op: ItemOp): string {
  return op.type === 'put' ? op.item.id : op.id;
}
