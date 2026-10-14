import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.ts';
import { LIMITS, sanitiseItem, sanitiseOps } from '../src/domain/items.ts';

/**
 * The server's check on everything a browser sends. Whatever is in the
 * request, what reaches the database is something the editor could have made.
 */

const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : 'THREW';
  }
};

describe('sanitiseItem', () => {
  it('keeps known fields and drops everything else', () => {
    const item = sanitiseItem({ id: 'a1', kind: 'step', x: 1, y: 2, w: 100, h: 50, text: 'Hi', script: '<x>', __proto__: { evil: 1 } });
    expect(item).toMatchObject({ id: 'a1', kind: 'step', x: 1, y: 2, w: 100, h: 50, text: 'Hi', color: '#ffffff', size: 'M', flag: '' });
    expect(Object.keys(item)).not.toContain('script');
  });

  it('refuses unknown kinds and malformed ids', () => {
    expect(code(() => sanitiseItem({ id: 'a1', kind: 'iframe', x: 0, y: 0, w: 10, h: 10 }))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseItem({ id: 'has space', kind: 'step', x: 0, y: 0, w: 10, h: 10 }))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseItem({ id: 'x'.repeat(65), kind: 'step', x: 0, y: 0, w: 10, h: 10 }))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseItem(null))).toBe('INVALID_REQUEST');
  });

  it('refuses non-numeric geometry and clamps extreme values', () => {
    expect(code(() => sanitiseItem({ id: 'a', kind: 'step', x: 'left', y: 0, w: 10, h: 10 }))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseItem({ id: 'a', kind: 'step', x: Number.NaN, y: 0, w: 10, h: 10 }))).toBe('INVALID_REQUEST');
    const item = sanitiseItem({ id: 'a', kind: 'step', x: 1e12, y: -1e12, w: 1, h: 1e9 });
    expect(item).toMatchObject({ x: LIMITS.coordinate, y: -LIMITS.coordinate, w: LIMITS.minSize, h: LIMITS.maxSize });
  });

  it('truncates long text rather than failing the batch', () => {
    const item = sanitiseItem({ id: 'a', kind: 'sticky', x: 0, y: 0, w: 10, h: 10, text: 'x'.repeat(LIMITS.text + 50) });
    expect(item.kind === 'sticky' && item.text.length).toBe(LIMITS.text);
  });

  it('removes NULs and repairs half an emoji, either of which Postgres would refuse', () => {
    const emoji = '\u{1F600}';
    const item = sanitiseItem({ id: 'a', kind: 'sticky', x: 0, y: 0, w: 10, h: 10, text: `a\u0000b${emoji[0]}`, owner: emoji[1] });
    expect(item.kind === 'sticky' && item.text).toBe('ab\uFFFD');
    expect(item.kind === 'sticky' && item.owner).toBe('\uFFFD');
    // Cutting at the limit must not leave the first half of a pair behind.
    const long = sanitiseItem({ id: 'c', kind: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, text: `${'x'.repeat(LIMITS.field - 1)}${emoji}` });
    expect(long.text.endsWith('\uFFFD')).toBe(true);
    expect(long.text.length).toBe(LIMITS.field);
  });

  it('only accepts hex colours, falling back to the default for the kind', () => {
    expect(sanitiseItem({ id: 'a', kind: 'sticky', x: 0, y: 0, w: 10, h: 10, color: 'red;background:url(x)' }).color).toBe('#fff1a8');
    expect(sanitiseItem({ id: 'a', kind: 'sticky', x: 0, y: 0, w: 10, h: 10, color: '#ABCDEF' }).color).toBe('#abcdef');
  });

  it('accepts connectors attached to items or to free points', () => {
    const c = sanitiseItem({ id: 'c', kind: 'connector', from: { id: 'a', side: 'top' }, to: { x: 5, y: 6 }, arrow: 'both', route: 'straight' });
    expect(c).toMatchObject({ kind: 'connector', from: { id: 'a', side: 'top' }, to: { x: 5, y: 6 }, arrow: 'both', route: 'straight', dashed: false });
    expect(code(() => sanitiseItem({ id: 'c', kind: 'connector', from: { id: 'bad id' }, to: { x: 0, y: 0 } }))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseItem({ id: 'c', kind: 'connector', from: 'a', to: { x: 0, y: 0 } }))).toBe('INVALID_REQUEST');
  });
});

describe('sanitiseOps', () => {
  it('collapses a batch to the last change per item', () => {
    const ops = sanitiseOps([
      { type: 'put', item: { id: 'a', kind: 'step', x: 0, y: 0, w: 10, h: 10, text: 'one' } },
      { type: 'put', item: { id: 'a', kind: 'step', x: 0, y: 0, w: 10, h: 10, text: 'two' } },
      { type: 'put', item: { id: 'b', kind: 'step', x: 0, y: 0, w: 10, h: 10 } },
      { type: 'delete', id: 'b' },
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: 'put', item: { id: 'a', text: 'two' } });
    expect(ops[1]).toEqual({ type: 'delete', id: 'b' });
  });

  it('refuses oversized batches and unknown op types', () => {
    expect(code(() => sanitiseOps(new Array(LIMITS.opsPerSync + 1).fill({ type: 'delete', id: 'a' })))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseOps([{ type: 'truncate' }]))).toBe('INVALID_REQUEST');
    expect(code(() => sanitiseOps('nope'))).toBe('INVALID_REQUEST');
    expect(sanitiseOps(undefined)).toEqual([]);
  });
});
