import { api } from '../js/api.js';
import { boot } from '../js/shell.js';
import { el, toast } from '../js/ui.js';
import { createModel } from './model.js';
import { createCamera } from './camera.js';
import { createRenderer } from './render.js';
import { createEditor } from './editor.js';
import { createChrome } from './chrome.js';
import { createSync } from './sync.js';
import { exportJson, exportPng } from './exporter.js';
import { boundsOf, isNode } from './geometry.js';

/**
 * The board page: load the map, then hand it to the model, renderer, editor,
 * chrome and sync, which only ever talk to each other through the model and
 * the shared ui state below.
 */

const mapId = new URLSearchParams(location.search).get('id');
if (!mapId) location.replace('/maps/');

const user = await boot({ header: false });

function fatal(message, action = el('a', { class: 'pm-btn pm-btn--primary', href: '/maps/', text: 'Back to all maps' })) {
  document.body.classList.remove('pm-board-page');
  document.body.replaceChildren(el('main', { class: 'pm-page' }, [
    el('div', { class: 'pm-card pm-empty' }, [el('h2', { text: message }), el('p', { text: 'Nothing has been changed.' }), action]),
  ]));
}

let data;
try {
  data = await api.get(`/api/maps/${encodeURIComponent(mapId)}`);
} catch (error) {
  fatal(error.code === 'NOT_FOUND' ? 'That map could not be found' : error.message);
  throw error;
}

const stage = document.getElementById('stage');
const dom = {
  lanes: document.getElementById('lanes'),
  links: document.getElementById('links'),
  labels: document.getElementById('labels'),
  nodes: document.getElementById('nodes'),
  overlay: document.getElementById('overlay'),
};

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const ui = {
  tool: 'select',
  selection: new Set(),
  editing: null,
  readOnly: !data.canEdit,
  peers: [],
  gesture: null,
  marquee: null,
  guides: [],
  ghost: null,
  dropTarget: null,
  preview: null,
  pointer: null,
  spaceDown: false,
  wheelZooms: storage.get('pm-wheel') !== null ? storage.get('pm-wheel') === 'zoom' : !/Mac|iPhone|iPad/.test(navigator.platform),
};
const state = { map: data.map, canEdit: data.canEdit };

const model = createModel();
model.load(data.items);

let saveView = null;
let renderer = null;
const camera = createCamera(stage, document.getElementById('world'), () => {
  renderer?.overlay();
  clearTimeout(saveView);
  saveView = setTimeout(() => storage.set(`pm-view:${mapId}`, JSON.stringify(camera.snapshot())), 400);
});
renderer = createRenderer({ model, camera, ui, dom });
const editor = createEditor({ model, camera, renderer, ui, stage, toast, onChange: (what) => { if (what === 'details') chrome.openPanel(); } });

const actions = {
  async patchMap(patch) {
    try {
      const { map } = await api.patch(`/api/maps/${mapId}`, patch);
      state.map = map;
      shownMap = mapKey();
      chrome.setMap();
    } catch (error) {
      toast(error.message, 'bad');
      chrome.setMap();
    }
  },
  async exportPng(onlySelection) {
    try {
      await exportPng(state.map, model.all(), { selection: onlySelection ? ui.selection : null });
    } catch (error) {
      toast(error.message, 'bad');
    }
  },
  exportJson: () => exportJson(state.map, model.all()),
  setWheelZooms(on) {
    ui.wheelZooms = on;
    storage.set('pm-wheel', on ? 'zoom' : 'pan');
    toast(on ? 'Mouse wheel zooms. Hold Space and drag to pan.' : 'Mouse wheel pans. Hold Ctrl to zoom.');
  },
};

const chrome = createChrome({ model, camera, renderer, editor, ui, user, state, actions });
chrome.setMap();
// What the chrome shows of the map. Every sync carries the map, but redrawing
// the toolbars on each one would swap a button out from under a click.
const mapKey = () => [state.map.name, state.map.area, state.map.description, state.map.status, state.map.archivedAt, state.canEdit].join('|');
let shownMap = mapKey();

const sync = createSync({
  mapId,
  model,
  ui,
  revision: data.revision,
  needsPreview: data.canEdit && !data.map.preview && data.items.length > 0,
  onStatus: (status, message) => chrome.setStatus(status, message),
  onPeers: (peers) => {
    editor.setPeers(peers);
    chrome.setPeers(peers);
  },
  onMap: (map, canEdit) => {
    if (map) state.map = map;
    state.canEdit = canEdit;
    editor.setReadOnly(!canEdit);
    if (mapKey() !== shownMap) {
      shownMap = mapKey();
      chrome.setMap();
    }
  },
  onFatal: (error) => {
    if (error.code === 'UNAUTHENTICATED') fatal('You have been signed out', el('a', { class: 'pm-btn pm-btn--primary', href: location.href, text: 'Sign in again' }));
    else fatal('This map is no longer available');
  },
});
chrome.setStatus('saved');

// Where you left this map, or the whole map framed.
let view = null;
try { view = JSON.parse(storage.get(`pm-view:${mapId}`) ?? 'null'); } catch { view = null; }
if (view && Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.k)) camera.set(view.x, view.y, view.k, true);
else {
  const b = boundsOf(model.all().filter(isNode));
  camera.fit(b ? { x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 } : null, { now: true });
}
renderer.invalidateAll();

if (!model.size && data.canEdit) {
  toast('Double-click anywhere to add a note, or pick a shape on the left.');
}

// Exposed for the browser tests and for poking at from the console.
window.processMap = { model, camera, editor, ui, sync, renderer };
