/**
 * The board's items, its undo history, and the outbox of changes not yet
 * sent to the server.
 *
 * Items are treated as immutable: a change is a new object put in place of
 * the old one, which keeps undo exact and lets the renderer tell what moved.
 *
 * Every local change goes through a transaction. A transaction records each
 * touched item's state from before it began, so a drag of twenty steps is one
 * undo, and a cancelled gesture can be rolled back exactly. A transaction
 * marked `hold` (a drag in progress) keeps its changes out of the outbox until
 * it ends, so collaborators see the move land rather than sixty half-moves.
 *
 * Undo is a three-way merge per field, not a snapshot restore: it puts back
 * only the fields this browser's action changed, and only where nobody has
 * changed them since. Undoing a colour change never reverts the text a
 * collaborator typed in the meantime, and never resurrects what they deleted.
 */

const clone = (value) => (value ? structuredClone(value) : null);

export function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => same(a[k], b[k]));
}

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createModel() {
  const items = new Map();
  const outbox = new Map();
  const inflight = new Map();
  const undoStack = [];
  const redoStack = [];
  /** Remote changes held back while a gesture had the item; settled when it ends. */
  const deferred = new Map();
  const changeListeners = new Set();
  const commitListeners = new Set();
  let txn = null;
  let pendingIds = new Set();
  let flushQueued = false;

  function deliver() {
    if (!flushQueued) return;
    flushQueued = false;
    const ids = pendingIds;
    pendingIds = new Set();
    for (const fn of changeListeners) fn(ids);
  }

  function emit(id) {
    pendingIds.add(id);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(deliver);
  }

  function write(id, value) {
    if (txn && !txn.before.has(id)) txn.before.set(id, clone(items.get(id)));
    if (value) items.set(id, value);
    else items.delete(id);
    if (!txn?.hold) outbox.set(id, value);
    emit(id);
  }

  function put(id, value) {
    if (value) items.set(id, value);
    else items.delete(id);
    outbox.set(id, value);
    emit(id);
  }

  /** Moves items from the state an action left (`from`) back to `target`, field by field. */
  function revert(target, from) {
    for (const [id, want] of target) {
      const was = from.get(id) ?? null;
      const now = items.get(id) ?? null;
      if (!want) {
        // Undoing a creation: remove it, if it is still there.
        if (now) put(id, null);
        continue;
      }
      if (!was) {
        // Undoing a deletion: bring it back, unless it already is.
        if (!now) put(id, clone(want));
        continue;
      }
      // Deleted by somebody else since: leave it deleted.
      if (!now) continue;
      const next = { ...now };
      let changed = false;
      for (const key of new Set([...Object.keys(want), ...Object.keys(was)])) {
        if (same(want[key], was[key]) || !same(now[key], was[key])) continue;
        next[key] = clone(want[key]);
        changed = true;
      }
      if (changed) put(id, next);
    }
  }

  /** Applies remote changes that arrived mid-gesture, unless the gesture's own change won. */
  function settleDeferred() {
    for (const [id, item] of deferred) {
      if (outbox.has(id) || inflight.has(id)) continue;
      const current = items.get(id);
      if (item ? same(current, item) : !current) continue;
      if (item) items.set(id, item);
      else items.delete(id);
      emit(id);
    }
    deferred.clear();
  }

  const model = {
    get: (id) => items.get(id),
    has: (id) => items.has(id),
    all: () => [...items.values()],
    get size() { return items.size; },

    /** Replaces everything, with no history: the initial load and a server reset. */
    load(list) {
      for (const id of items.keys()) emit(id);
      items.clear();
      for (const item of list) {
        items.set(item.id, item);
        emit(item.id);
      }
    },

    begin(label, { hold = false } = {}) {
      if (txn) model.commit();
      txn = { label, hold, before: new Map() };
    },
    get inTransaction() { return Boolean(txn); },
    get holding() { return Boolean(txn?.hold); },
    touched(id) { return Boolean(txn?.before.has(id)); },

    put(item) {
      const auto = !txn;
      if (auto) model.begin('Change');
      write(item.id, item);
      if (auto) model.commit();
    },
    remove(id) {
      if (!items.has(id)) return;
      const auto = !txn;
      if (auto) model.begin('Delete');
      write(id, null);
      if (auto) model.commit();
    },

    commit() {
      if (!txn) return;
      const t = txn;
      txn = null;
      const before = new Map();
      const after = new Map();
      for (const [id, prev] of t.before) {
        const now = clone(items.get(id));
        if (same(prev, now)) continue;
        before.set(id, prev);
        after.set(id, now);
        // A held transaction kept these back; release the final state now.
        if (t.hold) outbox.set(id, items.get(id) ?? null);
      }
      if (after.size) {
        undoStack.push({ label: t.label, before, after });
        if (undoStack.length > 300) undoStack.shift();
        redoStack.length = 0;
      }
      settleDeferred();
      for (const fn of commitListeners) fn(after.size > 0);
    },

    /** Rolls an open transaction back as if it never happened. */
    cancel() {
      if (!txn) return;
      const t = txn;
      txn = null;
      for (const [id, prev] of t.before) {
        if (prev) items.set(id, prev);
        else items.delete(id);
        if (!t.hold) outbox.set(id, prev);
        emit(id);
      }
      settleDeferred();
    },

    transact(label, run) {
      model.begin(label);
      try {
        run();
      } finally {
        model.commit();
      }
    },

    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    undo() {
      if (txn) model.commit();
      const entry = undoStack.pop();
      if (!entry) return null;
      revert(entry.before, entry.after);
      redoStack.push(entry);
      for (const fn of commitListeners) fn(true);
      return entry;
    },
    redo() {
      if (txn) model.commit();
      const entry = redoStack.pop();
      if (!entry) return null;
      revert(entry.after, entry.before);
      undoStack.push(entry);
      for (const fn of commitListeners) fn(true);
      return entry;
    },

    /**
     * A change from somebody else. Ignored while this browser has its own
     * unsent or in-flight change to the same item, or is mid-gesture on it:
     * the local change is newer and will reach the server after this one.
     */
    applyRemote(id, item) {
      if (outbox.has(id) || inflight.has(id)) return false;
      if (txn?.before.has(id)) {
        // Mid-gesture on this item: decide when the gesture ends, so a
        // cancelled drag still picks up what changed elsewhere.
        deferred.set(id, item);
        return false;
      }
      const current = items.get(id);
      if (item ? same(current, item) : !current) return false;
      if (item) items.set(id, item);
      else items.delete(id);
      emit(id);
      return true;
    },

    get pending() { return outbox.size + inflight.size; },
    get hasUnsent() { return outbox.size > 0; },
    /** Moves up to `limit` unsent changes in flight; the rest wait for the next request. */
    takeOutbox(limit = Infinity) {
      const ops = [];
      for (const [id, value] of outbox) {
        if (ops.length >= limit) break;
        inflight.set(id, value);
        outbox.delete(id);
        ops.push(value ? { type: 'put', item: value } : { type: 'delete', id });
      }
      return ops;
    },
    /** A copy of unsent changes, leaving them unsent: for a best-effort save on the way out. */
    peekOutbox(limit = Infinity) {
      const ops = [];
      for (const [id, value] of [...inflight, ...outbox]) {
        if (ops.length >= limit) break;
        ops.push(value ? { type: 'put', item: value } : { type: 'delete', id });
      }
      return ops;
    },
    /** Drops every unsent change, after the server has refused them for good. */
    discardOutbox() {
      outbox.clear();
      inflight.clear();
    },
    ackInflight() {
      inflight.clear();
    },
    /** A send failed: put its changes back, unless something newer replaced them. */
    failInflight() {
      for (const [id, value] of inflight) if (!outbox.has(id)) outbox.set(id, value);
      inflight.clear();
    },

    /** Delivers queued change notifications now rather than at the end of the task. */
    flush: deliver,
    onChange(fn) { changeListeners.add(fn); },
    onCommit(fn) { commitListeners.add(fn); },
  };
  return model;
}
