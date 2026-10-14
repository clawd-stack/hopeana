import { api } from './api.js';
import { boot } from './shell.js';
import { icons } from './icons.js';
import { renderPreview } from './preview.js';
import { STATUS_LABELS, confirmDialog, el, field, fill, formDialog, menu, statusPill, timeAgo, toast } from './ui.js';

/**
 * The maps list: every process the team has mapped, newest edit first, with
 * search, area and status filters, and the archive one click away.
 */

const main = document.getElementById('main');
/** Peggy's modules, offered as areas. Anything typed is accepted too. */
const SUGGESTED_AREAS = ['Workforce', 'HSEQ', 'Finance', 'Projects', 'Plant', 'Commercial', 'Tendering'];

const state = { user: null, maps: [], archived: false, query: '', area: '', status: '' };

const user = await boot({ page: 'maps' });
state.user = user;
const canEdit = user.role !== 'viewer';
const params = new URLSearchParams(location.search);
state.archived = params.get('archived') === '1';
await refresh();

async function refresh() {
  try {
    const { maps } = await api.get(`/api/maps${state.archived ? '?archived=1' : ''}`);
    state.maps = maps;
    render();
  } catch (error) {
    main.replaceChildren(el('div', { class: 'pm-notice pm-notice--bad', text: error.message }));
  }
}

function render() {
  const areas = [...new Set(state.maps.map((m) => m.area).filter(Boolean))].sort();
  if (state.area && !areas.includes(state.area)) state.area = '';

  const search = el('input', { class: 'pm-input', type: 'search', placeholder: 'Search maps', value: state.query, 'aria-label': 'Search maps' });
  search.addEventListener('input', () => {
    state.query = search.value;
    renderGrid();
  });

  const chip = (label, active, onClick) => el('button', { class: 'pm-chip', type: 'button', 'aria-pressed': String(active), text: label, onclick: onClick });
  const areaChips = el('div', { class: 'pm-chips', 'aria-label': 'Area' }, [
    chip('All areas', !state.area, () => { state.area = ''; render(); }),
    ...areas.map((a) => chip(a, state.area === a, () => { state.area = a; render(); })),
  ]);
  const statusSelect = el('select', { class: 'pm-select', style: 'width:auto', 'aria-label': 'Status' }, [
    el('option', { value: '', text: 'Any status' }),
    ...Object.entries(STATUS_LABELS).map(([value, label]) => el('option', { value, text: label, selected: state.status === value })),
  ]);
  statusSelect.addEventListener('change', () => { state.status = statusSelect.value; renderGrid(); });

  const grid = el('div');
  function renderGrid() {
    const q = state.query.trim().toLowerCase();
    const list = state.maps.filter((m) =>
      (!state.area || m.area === state.area) &&
      (!state.status || m.status === state.status) &&
      (!q || `${m.name} ${m.area} ${m.description}`.toLowerCase().includes(q)),
    );
    grid.replaceChildren(list.length ? el('div', { class: 'pm-grid' }, list.map(card)) : emptyState());
  }

  fill(main,
    el('div', { class: 'pm-page__head' }, [
      el('div', {}, [
        el('h1', { text: state.archived ? 'Archived maps' : 'Process maps' }),
        el('p', {
          text: state.archived
            ? 'Archived maps are read-only. Restore one to edit it again.'
            : 'How the work actually gets done, mapped by the people who do it.',
        }),
      ]),
      el('div', { class: 'pm-page__actions' }, [
        el('a', { class: 'pm-btn pm-btn--ghost', href: state.archived ? '/maps/' : '/maps/?archived=1', text: state.archived ? '← All maps' : 'Archive' }),
        canEdit && !state.archived ? importButton() : null,
        canEdit && !state.archived ? el('button', { class: 'pm-btn pm-btn--primary', type: 'button', html: `${icons.plus}<span>New map</span>`, onclick: newMap }) : null,
      ]),
    ]),
    state.maps.length
      ? el('div', { class: 'pm-filters' }, [
          el('label', { class: 'pm-search' }, [el('span', { html: icons.search }), search]),
          statusSelect,
          areas.length ? areaChips : null,
        ])
      : null,
    grid,
  );
  renderGrid();
}

function emptyState() {
  if (state.maps.length) {
    return el('div', { class: 'pm-card pm-empty' }, [el('h2', { text: 'Nothing matches' }), el('p', { text: 'Try a different search or filter.' })]);
  }
  if (state.archived) {
    return el('div', { class: 'pm-card pm-empty' }, [el('h2', { text: 'The archive is empty' }), el('p', { text: 'Maps you archive land here.' })]);
  }
  return el('div', { class: 'pm-card pm-empty' }, [
    el('h2', { text: 'No maps yet' }),
    el('p', { text: canEdit ? 'Start with a swimlane template, or a blank board.' : 'Nobody has mapped a process yet.' }),
    canEdit ? el('button', { class: 'pm-btn pm-btn--primary', type: 'button', text: 'Create the first map', onclick: newMap }) : null,
  ]);
}

function card(map) {
  const link = el('a', { class: 'pm-card pm-mapcard', href: `/maps/board.html?id=${encodeURIComponent(map.mapId)}` }, [
    el('div', { class: 'pm-mapcard__thumb' }, [renderPreview(map.preview)]),
    el('div', { class: 'pm-mapcard__body' }, [
      el('h3', { class: 'pm-mapcard__name', text: map.name }),
      el('div', { class: 'pm-mapcard__meta' }, [statusPill(map.status), map.area ? el('span', { class: 'pm-tag', text: map.area }) : null]),
      el('div', { class: 'pm-mapcard__meta', text: `Edited ${timeAgo(map.updatedAt)}${map.updatedByName ? ` by ${map.updatedByName}` : ''} · ${map.itemCount} item${map.itemCount === 1 ? '' : 's'}` }),
    ]),
  ]);
  if (!canEdit) return link;
  const more = el('button', { class: 'pm-btn pm-btn--ghost pm-btn--small pm-mapcard__menu', type: 'button', 'aria-label': `Options for ${map.name}`, html: icons.more });
  more.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    menu(more, state.archived
      ? [{ label: 'Restore', run: () => setArchived(map, false) }]
      : [
          { label: 'Open', run: () => { location.href = link.href; } },
          { label: 'Rename and describe', run: () => editMap(map) },
          { label: 'Duplicate', run: () => duplicate(map) },
          'sep',
          { label: 'Archive', danger: true, run: () => setArchived(map, true) },
        ], { align: 'right' });
  });
  return el('div', { style: 'position:relative' }, [link, more]);
}

function areaInput(value = '') {
  const id = `areas-${Math.random().toString(36).slice(2)}`;
  const known = [...new Set([...SUGGESTED_AREAS, ...state.maps.map((m) => m.area).filter(Boolean)])].sort();
  return [
    el('input', { class: 'pm-input', name: 'area', list: id, value, maxlength: 60, placeholder: 'e.g. Workforce' }),
    el('datalist', { id }, known.map((a) => el('option', { value: a }))),
  ];
}

const TEMPLATE_ART = {
  blank: '<svg viewBox="0 0 120 62"><rect x="1" y="1" width="118" height="60" rx="6" fill="#fff" stroke="#d4d4cd" stroke-dasharray="4 3"/></svg>',
  swimlane: '<svg viewBox="0 0 120 62"><rect x="1" y="1" width="118" height="60" rx="4" fill="#f3f5f8" stroke="#c9ced6"/><path d="M1 21h118M1 41h118M13 1v60" stroke="#c9ced6"/><rect x="20" y="6" width="20" height="10" rx="5" fill="#e3f1e4" stroke="#8fbf94"/><rect x="48" y="26" width="22" height="10" rx="2" fill="#fff" stroke="#9aa4b2"/><path d="M86 23l7 8-7 8-7-8z" fill="#fff4e0" stroke="#d9a75c"/><rect x="92" y="46" width="22" height="10" rx="2" fill="#fff" stroke="#9aa4b2"/></svg>',
  'as-is-to-be': '<svg viewBox="0 0 120 62"><rect x="1" y="1" width="118" height="27" rx="4" fill="#f6f1ee" stroke="#d7c9c0"/><rect x="1" y="34" width="118" height="27" rx="4" fill="#eef4f9" stroke="#bccfe0"/><g fill="#fff" stroke="#9aa4b2"><rect x="18" y="9" width="18" height="10" rx="2"/><rect x="48" y="9" width="18" height="10" rx="2"/><rect x="78" y="9" width="18" height="10" rx="2"/><rect x="18" y="42" width="18" height="10" rx="2"/><rect x="48" y="42" width="18" height="10" rx="2"/><rect x="78" y="42" width="18" height="10" rx="2"/></g></svg>',
};

async function newMap() {
  const name = el('input', { class: 'pm-input', name: 'name', required: true, maxlength: 120, autofocus: true, placeholder: 'e.g. Employee onboarding' });
  const templates = el('div', { class: 'pm-templates', role: 'radiogroup', 'aria-label': 'Start from' },
    [['swimlane', 'Swimlanes'], ['as-is-to-be', 'As-is / to-be'], ['blank', 'Blank']].map(([value, label], i) =>
      el('label', { class: 'pm-template' }, [
        el('input', { type: 'radio', name: 'template', value, checked: i === 0 }),
        el('span', { html: TEMPLATE_ART[value] }),
        el('span', { text: label }),
      ])),
  );
  const created = await formDialog({
    title: 'New process map',
    lede: 'Give it the name people would search for.',
    wide: true,
    fields: [field('Name', name), field('Area', el('div', {}, areaInput()), 'Which part of the business this process belongs to.'), el('div', { class: 'pm-field' }, [el('span', { text: 'Start from' }), templates])],
    submit: 'Create map',
    onSubmit: async (data) => {
      const { map } = await api.post('/api/maps', { name: data.get('name'), area: data.get('area') || '', template: data.get('template') || 'blank' });
      return map;
    },
  });
  if (created) location.href = `/maps/board.html?id=${encodeURIComponent(created.mapId)}`;
}

async function editMap(map) {
  const name = el('input', { class: 'pm-input', name: 'name', required: true, maxlength: 120, value: map.name, autofocus: true });
  const description = el('textarea', { class: 'pm-textarea', name: 'description', maxlength: 1000 }, [map.description]);
  const statusSelect = el('select', { class: 'pm-select', name: 'status' },
    Object.entries(STATUS_LABELS).map(([value, label]) => el('option', { value, text: label, selected: map.status === value })));
  const saved = await formDialog({
    title: 'Map details',
    fields: [field('Name', name), field('Area', el('div', {}, areaInput(map.area))), field('Status', statusSelect), field('Description', description, 'What this process covers, and who owns it.')],
    submit: 'Save',
    onSubmit: async (data) => (await api.patch(`/api/maps/${map.mapId}`, {
      name: data.get('name'), area: data.get('area') || '', status: data.get('status'), description: data.get('description') || '',
    })).map,
  });
  if (saved) {
    toast('Saved');
    await refresh();
  }
}

async function duplicate(map) {
  try {
    const { map: copy } = await api.post(`/api/maps/${map.mapId}/duplicate`, {});
    toast(`Created “${copy.name}”`);
    await refresh();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function setArchived(map, archived) {
  if (archived && !(await confirmDialog('Archive this map?', `“${map.name}” moves to the archive and becomes read-only. You can restore it any time.`, 'Archive', true))) return;
  try {
    await api.patch(`/api/maps/${map.mapId}`, { archived });
    toast(archived ? 'Archived' : 'Restored');
    await refresh();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function importButton() {
  const input = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'process-map' || !Array.isArray(data.items)) throw new Error('That file is not a process map export.');
      const { map } = await api.post('/api/maps', {
        name: String(data.map?.name || file.name.replace(/\.json$/i, '')).slice(0, 120),
        area: String(data.map?.area || '').slice(0, 60),
        description: String(data.map?.description || '').slice(0, 1000),
      });
      let revision = map.revision;
      for (let i = 0; i < data.items.length; i += 1000) {
        const ops = data.items.slice(i, i + 1000).map((item) => ({ type: 'put', item }));
        revision = (await api.post(`/api/maps/${map.mapId}/sync`, { since: revision, ops })).revision;
      }
      location.href = `/maps/board.html?id=${encodeURIComponent(map.mapId)}`;
    } catch (error) {
      toast(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message, 'bad');
    }
  });
  return el('span', {}, [
    input,
    el('button', { class: 'pm-btn', type: 'button', html: `${icons.upload}<span>Import</span>`, title: 'Import a map exported from a board', onclick: () => input.click() }),
  ]);
}
