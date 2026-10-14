import { describe, expect, it } from 'vitest';
import { createModel } from '../web/maps/board/model.js';
import { routeConnector } from '../web/maps/board/geometry.js';

/**
 * The board's model in the browser: undo, the outbox, and how changes from
 * other people meet this person's own. Plain JavaScript, so it runs here
 * exactly as it runs in the page.
 */

const note = (id, extra = {}) => ({ id, kind: 'sticky', x: 0, y: 0, w: 100, h: 100, z: 1, text: 'hello', color: '#fff1a8', size: 'M', owner: '', system: '', duration: '', notes: '', flag: '', ...extra });

function loaded(...items) {
  const model = createModel();
  model.load(items);
  return model;
}

/** Pretends a sync round trip happened: our changes reached the server. */
function sent(model) {
  const ops = model.takeOutbox();
  model.ackInflight();
  return ops;
}

describe('undo with collaborators', () => {
  it('reverts only the fields this person changed', () => {
    const model = loaded(note('a'));
    model.transact('Colour', () => model.put({ ...model.get('a'), color: '#d0ebff' }));
    sent(model);
    model.applyRemote('a', { ...model.get('a'), text: 'typed by Sarah' });
    model.undo();
    expect(model.get('a')).toMatchObject({ color: '#fff1a8', text: 'typed by Sarah' });
    model.redo();
    expect(model.get('a')).toMatchObject({ color: '#d0ebff', text: 'typed by Sarah' });
  });

  it('leaves a field alone if somebody else has changed it since', () => {
    const model = loaded(note('a'));
    model.transact('Move', () => model.put({ ...model.get('a'), x: 50 }));
    sent(model);
    model.applyRemote('a', { ...model.get('a'), x: 300 });
    model.undo();
    expect(model.get('a').x).toBe(300);
  });

  it('does not bring back something deleted elsewhere', () => {
    const model = loaded(note('a'));
    model.transact('Move', () => model.put({ ...model.get('a'), x: 50 }));
    sent(model);
    model.applyRemote('a', null);
    model.undo();
    expect(model.has('a')).toBe(false);
  });

  it('undoes a creation and a deletion', () => {
    const model = loaded(note('a'));
    model.transact('Add', () => model.put(note('b')));
    model.undo();
    expect(model.has('b')).toBe(false);
    model.redo();
    expect(model.has('b')).toBe(true);
    model.transact('Delete', () => model.remove('a'));
    model.undo();
    expect(model.get('a')).toMatchObject({ text: 'hello' });
    expect(sent(model).map((op) => op.type)).toContain('put');
  });
});

describe('changes that arrive mid-gesture', () => {
  it('are applied when the gesture is cancelled', () => {
    const model = loaded(note('a'));
    model.begin('Move', { hold: true });
    model.put({ ...model.get('a'), x: 40 });
    expect(model.applyRemote('a', { ...note('a'), text: 'changed elsewhere' })).toBe(false);
    model.cancel();
    expect(model.get('a')).toMatchObject({ x: 0, text: 'changed elsewhere' });
    expect(model.pending).toBe(0);
  });

  it('are applied when the gesture ends where it started', () => {
    const model = loaded(note('a'));
    model.begin('Move', { hold: true });
    model.put({ ...model.get('a'), x: 40 });
    model.applyRemote('a', { ...note('a'), text: 'changed elsewhere' });
    model.put({ ...model.get('a'), x: 0 });
    model.commit();
    expect(model.get('a').text).toBe('changed elsewhere');
  });

  it('lose to the gesture when it changed the item, which then goes to the server', () => {
    const model = loaded(note('a'));
    model.begin('Move', { hold: true });
    model.put({ ...model.get('a'), x: 40 });
    model.applyRemote('a', { ...note('a'), x: 999 });
    model.commit();
    expect(model.get('a').x).toBe(40);
    expect(sent(model)).toEqual([{ type: 'put', item: expect.objectContaining({ x: 40 }) }]);
  });
});

describe('the outbox', () => {
  it('sends in batches and keeps the rest for the next request', () => {
    const model = loaded();
    model.transact('Paste', () => { for (let i = 0; i < 2500; i++) model.put(note(`n${i}`)); });
    expect(model.takeOutbox(1000)).toHaveLength(1000);
    expect(model.hasUnsent).toBe(true);
    model.ackInflight();
    expect(model.takeOutbox(1000)).toHaveLength(1000);
    model.ackInflight();
    expect(model.takeOutbox(1000)).toHaveLength(500);
    expect(model.hasUnsent).toBe(false);
  });

  it('can be copied for a last-minute save without being marked as sent', () => {
    const model = loaded();
    model.transact('Add', () => model.put(note('a')));
    expect(model.peekOutbox()).toHaveLength(1);
    expect(model.hasUnsent).toBe(true);
  });

  it('puts a failed send back, unless something newer replaced it', () => {
    const model = loaded(note('a'), note('b'));
    model.transact('Edit', () => { model.put({ ...model.get('a'), text: 'one' }); model.put({ ...model.get('b'), text: 'one' }); });
    model.takeOutbox();
    model.transact('Edit', () => model.put({ ...model.get('a'), text: 'two' }));
    model.failInflight();
    const ops = model.takeOutbox();
    expect(ops.find((op) => op.item.id === 'a').item.text).toBe('two');
    expect(ops.find((op) => op.item.id === 'b').item.text).toBe('one');
  });

  it('keeps a local change over an older remote one until it is sent', () => {
    const model = loaded(note('a'));
    model.transact('Edit', () => model.put({ ...model.get('a'), text: 'mine' }));
    expect(model.applyRemote('a', { ...note('a'), text: 'theirs' })).toBe(false);
    expect(model.get('a').text).toBe('mine');
  });
});

describe('connector routing', () => {
  const nodes = new Map([
    ['a', note('a', { x: 0, y: 0, w: 100, h: 50 })],
    ['b', note('b', { x: 300, y: 0, w: 100, h: 50 })],
    ['c', note('c', { x: 0, y: 300, w: 100, h: 50 })],
  ]);
  const link = (from, to, extra = {}) => ({ id: 'l', kind: 'connector', from, to, route: 'elbow', ...extra });

  it('runs straight between steps side by side', () => {
    expect(routeConnector(link({ id: 'a', side: null }, { id: 'b', side: null }), nodes)).toEqual([{ x: 100, y: 25 }, { x: 300, y: 25 }]);
  });

  it('goes bottom to top between stacked steps', () => {
    expect(routeConnector(link({ id: 'a', side: null }, { id: 'c', side: null }), nodes)).toEqual([{ x: 50, y: 50 }, { x: 50, y: 300 }]);
  });

  it('bends round a corner when told which sides to use', () => {
    const points = routeConnector(link({ id: 'b', side: 'bottom' }, { id: 'c', side: 'right' }), nodes);
    expect(points).toEqual([{ x: 350, y: 50 }, { x: 350, y: 325 }, { x: 100, y: 325 }]);
  });

  it('draws nothing when an end has gone', () => {
    expect(routeConnector(link({ id: 'a', side: null }, { id: 'gone', side: null }), nodes)).toBeNull();
  });
});
