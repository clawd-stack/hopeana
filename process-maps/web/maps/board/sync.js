import { api } from '../js/api.js';
import { computePreview } from '../js/preview.js';
import { newId } from './model.js';

/**
 * Keeps this browser's board and the server's in step.
 *
 * One request does everything: send what changed here, say what is selected,
 * and receive what changed elsewhere. How often it runs depends on what is
 * going on: quickly after a local edit or while others are on the board,
 * slowly when alone, rarely when the tab is hidden, and with a growing pause
 * while the network is down. Nothing is lost while offline: unsent changes
 * wait in the model's outbox and go with the next successful request.
 */

const FAST = 1500;
const ALONE = 6000;
const HIDDEN = 30000;
const SOON = 300;
const PREVIEW_EVERY = 20000;

export function createSync({ mapId, model, ui, revision, needsPreview, onStatus, onPeers, onMap, onFatal }) {
  let since = revision;
  let timer = null;
  let busy = false;
  let failures = 0;
  let stopped = false;
  let peers = 0;
  let lastPreview = needsPreview ? 0 : Date.now();
  let previewDue = needsPreview;
  let lastSelection = '';
  /** This tab, so two tabs of the same person are two presences, not one flickering one. */
  const client = newId();
  /** After a refused write, the next answer replaces the board outright. */
  let resync = false;

  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  function nextDelay() {
    if (failures) return Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
    if (document.hidden) return HIDDEN;
    if (model.hasUnsent) return SOON;
    return peers ? FAST : ALONE;
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    // A drag in progress keeps its changes back until it lands.
    const ops = model.holding ? [] : model.takeOutbox();
    const selection = [...ui.selection].slice(0, 200);
    lastSelection = selection.join(',');
    const body = { since, ops, selection, client };
    if (!ui.readOnly && (previewDue || (ops.length && Date.now() - lastPreview > PREVIEW_EVERY))) {
      body.preview = computePreview(model.all());
      lastPreview = Date.now();
      previewDue = false;
    }
    if (ops.length) onStatus('saving');
    try {
      const res = await api.post(`/api/maps/${mapId}/sync`, body);
      model.ackInflight();
      if (res.reset || resync) {
        resync = false;
        model.load(res.items.filter((row) => row.item).map((row) => row.item));
      } else {
        for (const row of res.items) model.applyRemote(row.id, row.deleted ? null : row.item);
      }
      for (const id of [...ui.selection]) if (!model.has(id)) ui.selection.delete(id);
      since = res.revision;
      failures = 0;
      peers = res.presence.length;
      onPeers(res.presence);
      onMap(res.map, res.canEdit);
      onStatus(model.pending ? 'saving' : 'saved');
    } catch (error) {
      model.failInflight();
      if (error.code === 'UNAUTHENTICATED' || error.code === 'NOT_FOUND') {
        stopped = true;
        onFatal(error);
      } else if (error.code === 'READ_ONLY' || error.code === 'MAP_ARCHIVED') {
        // Somebody changed our access or archived the map mid-edit. Drop the
        // edits that can no longer be saved and reload what is really there.
        model.takeOutbox();
        model.ackInflight();
        onMap(null, false);
        onStatus('readonly', error.message);
        failures = 0;
        since = 0;
        resync = true;
      } else if (error.code === 'INVALID_REQUEST' || error.code === 'MAP_FULL') {
        // A change the server will never accept would otherwise be retried
        // forever and block everything behind it.
        model.takeOutbox();
        model.ackInflight();
        onStatus('error', error.message);
        failures = 0;
        since = 0;
        resync = true;
      } else {
        failures += 1;
        onStatus('offline');
      }
    } finally {
      busy = false;
      schedule(nextDelay());
    }
  }

  model.onCommit((changed) => {
    if (changed) schedule(SOON);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(50);
    else if (model.hasUnsent) schedule(0);
  });

  // Selection is cheap to share and useful to see: send it soon after it
  // changes rather than at the next slow tick.
  setInterval(() => {
    if (busy || stopped || document.hidden) return;
    const now = [...ui.selection].slice(0, 200).join(',');
    if (now !== lastSelection && peers) schedule(150);
  }, 400);

  addEventListener('beforeunload', (event) => {
    if (!model.pending) return;
    // Best effort to save on the way out, and a prompt if that may not land.
    const ops = model.holding ? [] : model.takeOutbox();
    if (ops.length) {
      fetch(`/api/maps/${mapId}/sync`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ since, ops, selection: [] }),
      }).catch(() => {});
    }
    event.preventDefault();
    event.returnValue = '';
  });

  schedule(200);

  return {
    now: () => schedule(0),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    previewSoon() {
      previewDue = true;
      schedule(SOON);
    },
  };
}
