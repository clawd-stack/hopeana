import { icons } from '../js/icons.js';
import { STATUS_LABELS, avatar, closeMenu, dialog, el, fill, menu, timeAgo, toast } from '../js/ui.js';
import { userMenu } from '../js/shell.js';
import { COLOURS, FLAGS, KIND_LABELS, colourGroup } from './palette.js';
import { boundsOf, isNode, pointsBounds } from './geometry.js';

/**
 * Everything around the board: the tool rail, the title bar, zoom, the
 * context toolbar that floats over a selection, and the details panel.
 * It reads the board through the model and acts through editor commands.
 */

const TOOLS = [
  ['select', 'Select', 'V'],
  ['hand', 'Pan', 'H'],
  null,
  ['sticky', 'Sticky note', 'N'],
  ['step', 'Process step', 'R'],
  ['decision', 'Decision', 'D'],
  ['terminal', 'Start / end', 'O'],
  ['text', 'Text', 'T'],
  ['lane', 'Swimlane', 'L'],
  ['connector', 'Connector', 'C'],
];
const SHAPE_KINDS = ['step', 'decision', 'terminal', 'sticky'];
const ARROWS = { end: 'Arrow at end', both: 'Arrows both ends', none: 'No arrows' };

export function createChrome({ model, camera, renderer, editor, ui, user, state, actions }) {
  const root = document.body;

  /* Tool rail ---------------------------------------------------------- */

  const toolButtons = new Map();
  const tools = el('div', { class: 'pm-float pm-tools', role: 'toolbar', 'aria-label': 'Tools' });
  for (const entry of TOOLS) {
    if (!entry) {
      tools.append(el('hr'));
      continue;
    }
    const [tool, label, key] = entry;
    const button = el('button', { class: 'pm-tool', type: 'button', 'data-tip': `${label}  ${key}`, 'aria-label': label, html: icons[tool], onclick: () => editor.setTool(tool) });
    toolButtons.set(tool, button);
    tools.append(button);
  }
  tools.append(el('hr'));
  const undoButton = el('button', { class: 'pm-tool', type: 'button', 'data-tip': 'Undo  Ctrl Z', 'aria-label': 'Undo', html: icons.undo, onclick: () => editor.undo() });
  const redoButton = el('button', { class: 'pm-tool', type: 'button', 'data-tip': 'Redo  Ctrl Shift Z', 'aria-label': 'Redo', html: icons.redo, onclick: () => editor.redo() });
  tools.append(undoButton, redoButton);
  root.append(tools);

  /* Title bar ---------------------------------------------------------- */

  const title = el('span', { class: 'pm-title', role: 'textbox', 'aria-label': 'Map name', spellcheck: 'false' });
  const statusButton = el('button', { class: 'pm-btn pm-btn--ghost pm-btn--small', type: 'button', 'aria-label': 'Status' });
  const saveState = el('span', { class: 'pm-savestate', 'aria-live': 'polite' });
  const readOnlyPill = el('span', { class: 'pm-readonly', hidden: true });
  const people = el('div', { class: 'pm-people' });
  const detailsButton = el('button', { class: 'pm-btn pm-btn--ghost pm-btn--small', type: 'button', html: `${icons.details}<span>Details</span>`, onclick: () => togglePanel() });
  const moreButton = el('button', { class: 'pm-btn pm-btn--ghost pm-btn--small', type: 'button', 'aria-label': 'More', html: icons.more });
  const meButton = el('button', { class: 'pm-usermenu', type: 'button', 'aria-label': 'Account' }, [avatar(user)]);
  meButton.addEventListener('click', () => userMenu(user, meButton));

  root.append(el('div', { class: 'pm-float pm-topbar' }, [
    el('div', { class: 'pm-titlebox' }, [
      el('a', { class: 'pm-tool', href: '/maps/', 'aria-label': 'All maps', title: 'All maps', html: icons.back, style: 'width:32px;height:32px' }),
      title,
      statusButton,
      saveState,
    ]),
    el('div', { class: 'pm-topbar__right' }, [readOnlyPill, people, detailsButton, moreButton, meButton]),
  ]));

  let titleBefore = '';
  title.addEventListener('focus', () => { titleBefore = title.textContent; });
  title.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.textContent = titleBefore; title.blur(); }
  });
  title.addEventListener('blur', async () => {
    const name = title.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) { title.textContent = titleBefore; return; }
    if (name !== state.map.name) await actions.patchMap({ name });
  });

  statusButton.addEventListener('click', () => {
    if (!state.canEdit) return;
    menu(statusButton, Object.entries(STATUS_LABELS).map(([value, label]) => ({
      label: `${value === state.map.status ? '✓ ' : '   '}${label}`,
      run: () => actions.patchMap({ status: value }),
    })));
  });

  moreButton.addEventListener('click', () => {
    menu(moreButton, [
      { label: 'Copy link to this map', run: async () => { await navigator.clipboard?.writeText(location.href); toast('Link copied'); } },
      'sep',
      { label: 'Export image (PNG)', run: () => actions.exportPng(false) },
      ui.selection.size ? { label: 'Export selection as image', run: () => actions.exportPng(true) } : null,
      { label: 'Export backup (JSON)', run: () => actions.exportJson() },
      'sep',
      { label: 'Keyboard shortcuts', run: showShortcuts },
    ], { align: 'right' });
  });

  /* Zoom ---------------------------------------------------------------- */

  const zoomValue = el('button', { class: 'pm-zoom__value', type: 'button', 'aria-label': 'Zoom options' });
  root.append(el('div', { class: 'pm-float pm-zoom' }, [
    el('button', { class: 'pm-tool', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', html: icons.minus, onclick: () => editor.zoomOut() }),
    zoomValue,
    el('button', { class: 'pm-tool', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', html: icons.plus, onclick: () => editor.zoomIn() }),
    el('button', { class: 'pm-tool', type: 'button', 'aria-label': 'Fit to screen', title: 'Fit to screen  Shift 1', html: icons.fit, onclick: () => editor.fit() }),
  ]));
  zoomValue.addEventListener('click', () => {
    menu(zoomValue, [
      { label: 'Fit everything', run: () => editor.fit() },
      { label: 'Zoom to selection', run: () => editor.fitSelection() },
      'sep',
      { label: '50%', run: () => camera.zoomTo(0.5) },
      { label: '100%', run: () => camera.zoomTo(1) },
      { label: '200%', run: () => camera.zoomTo(2) },
      'sep',
      { label: `${ui.wheelZooms ? '✓ ' : '   '}Mouse wheel zooms`, run: () => actions.setWheelZooms(!ui.wheelZooms) },
    ], { above: true, align: 'right' });
  });

  /* Context toolbar ---------------------------------------------------- */

  const context = el('div', { class: 'pm-float pm-context', role: 'toolbar', 'aria-label': 'Selection', hidden: true });
  root.append(context);
  let contextKey = '';

  const toolButton = (icon, label, run, pressed) =>
    el('button', { class: 'pm-tool', type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed === undefined ? null : String(pressed), html: icon, onclick: run });
  const sep = () => el('span', { class: 'pm-context__sep' });

  function colourButton(items) {
    const group = colourGroup(items[0].kind);
    const current = items[0].color;
    const button = el('button', { class: 'pm-tool', type: 'button', title: 'Colour', 'aria-label': 'Colour' }, [
      el('span', { class: 'pm-swatch', style: `background:${current}` }),
    ]);
    button.addEventListener('click', () => {
      const grid = el('div', { class: 'pm-swatches' }, COLOURS[group].map((colour) => el('button', {
        type: 'button', style: `background:${colour}`, 'aria-label': colour, 'aria-pressed': String(colour === current),
        onclick: () => {
          closeMenu();
          editor.update('Change colour', (item) => (colourGroup(item.kind) === group ? { ...item, color: colour } : item));
        },
      })));
      menu(button, [grid], { align: 'center' });
    });
    return button;
  }

  function buildContext(items) {
    const nodes = items.filter(isNode);
    const links = items.filter((i) => i.kind === 'connector');
    const out = [];
    if (ui.readOnly) {
      if (items.length === 1) out.push(toolButton(icons.details, 'Details', () => openPanel()));
      return out;
    }
    if (nodes.length && !links.length) {
      out.push(colourButton(nodes));
      const sized = nodes.every((n) => n.kind !== 'lane') || nodes.length === 1;
      if (sized) {
        const size = nodes[0].size;
        out.push(el('div', { class: 'pm-sizes', role: 'group', 'aria-label': 'Text size' }, ['S', 'M', 'L', 'XL'].map((s) =>
          el('button', { type: 'button', text: s, title: `Text size ${s}`, 'aria-pressed': String(size === s), onclick: () => editor.update('Text size', (item) => (isNode(item) ? { ...item, size: s } : item)) }))));
      }
      if (nodes.every((n) => SHAPE_KINDS.includes(n.kind))) {
        const shape = toolButton(icons[nodes[0].kind], 'Change shape', () => {
          menu(shape, SHAPE_KINDS.map((kind) => ({
            label: KIND_LABELS[kind],
            run: () => editor.update('Change shape', (item) => (SHAPE_KINDS.includes(item.kind) ? convert(item, kind) : item)),
          })));
        });
        out.push(shape);
      }
      if (nodes.length === 1 && nodes[0].kind === 'lane') {
        out.push(el('button', { class: 'pm-btn pm-btn--ghost pm-btn--small', type: 'button', html: `${icons.plus}<span>Lane below</span>`, onclick: () => editor.addLaneBelow(nodes[0].id) }));
      }
      out.push(sep());
      out.push(toolButton(icons.front, 'Bring to front  ]', () => editor.front()));
      out.push(toolButton(icons.backward, 'Send to back  [', () => editor.back()));
    }
    if (links.length && !nodes.length) {
      out.push(colourButton(links));
      const dashed = links.every((l) => l.dashed);
      out.push(toolButton(icons.dashed, 'Dashed line', () => editor.update('Line style', (item) => (item.kind === 'connector' ? { ...item, dashed: !dashed } : item)), dashed));
      const arrowButton = toolButton(icons.arrow, 'Arrowheads', () => {
        menu(arrowButton, Object.entries(ARROWS).map(([value, label]) => ({
          label, run: () => editor.update('Arrowheads', (item) => (item.kind === 'connector' ? { ...item, arrow: value } : item)),
        })));
      });
      out.push(arrowButton);
      const straight = links.every((l) => l.route === 'straight');
      out.push(toolButton(icons.elbow, straight ? 'Use elbow lines' : 'Use straight lines', () => editor.update('Line shape', (item) => (item.kind === 'connector' ? { ...item, route: straight ? 'elbow' : 'straight' } : item)), !straight));
      out.push(sep());
    }
    if (items.length === 1) out.push(toolButton(icons.details, 'Details', () => openPanel()));
    out.push(toolButton(icons.copy, 'Duplicate  Ctrl D', () => editor.duplicate()));
    out.push(toolButton(icons.trash, 'Delete  Del', () => editor.delete()));
    return out;
  }

  function convert(item, kind) {
    if (item.kind === kind) return item;
    const colourFits = colourGroup(item.kind) === colourGroup(kind);
    return { ...item, kind, color: colourFits ? item.color : kind === 'sticky' ? COLOURS.sticky[0] : kind === 'decision' ? '#fff4e0' : kind === 'terminal' ? '#e3f1e4' : '#ffffff' };
  }

  function placeContext(items) {
    const nodes = items.filter(isNode);
    const rects = nodes.length ? nodes : items.map((i) => (renderer.route(i.id) ? pointsBounds(renderer.route(i.id)) : null)).filter(Boolean);
    const b = boundsOf(rects);
    if (!b) {
      context.hidden = true;
      return;
    }
    const s = camera.rectToScreen(b);
    const x = Math.max(context.offsetWidth / 2 + 8, Math.min(innerWidth - context.offsetWidth / 2 - 8, s.x + s.w / 2));
    // Clear of the blue + above a single selected step.
    const clearance = nodes.length ? 42 : 14;
    let y = s.y - clearance;
    let below = false;
    if (y - context.offsetHeight < 64) {
      y = s.y + s.h + clearance;
      below = true;
    }
    context.style.left = `${x}px`;
    context.style.top = `${y}px`;
    context.style.transform = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
  }

  /* Details panel ------------------------------------------------------ */

  const panelBody = el('div', { class: 'pm-panel__body' });
  const panelTitle = el('h2');
  const panel = el('aside', { class: 'pm-float pm-panel', hidden: true, 'aria-label': 'Details' }, [
    el('div', { class: 'pm-panel__head' }, [panelTitle, el('button', { class: 'pm-tool', type: 'button', 'aria-label': 'Close details', html: icons.close, style: 'width:30px;height:30px', onclick: () => togglePanel(false) })]),
    panelBody,
  ]);
  root.append(panel);
  let panelKey = '';
  const bound = [];

  function openPanel() { togglePanel(true); }
  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    detailsButton.setAttribute('aria-pressed', String(open));
    try { localStorage.setItem('pm-panel', open ? '1' : '0'); } catch { /* private mode */ }
    panelKey = '';
    update();
  }

  function input(value, attrs = {}) {
    return el('input', { class: 'pm-input', value: value ?? '', ...attrs });
  }
  function area(value, attrs = {}) {
    const node = el('textarea', { class: 'pm-textarea', ...attrs });
    node.value = value ?? '';
    return node;
  }
  function labelled(text, control, hint) {
    return el('label', { class: 'pm-field' }, [el('span', { text }), control, hint ? el('p', { class: 'pm-hint', text: hint }) : null]);
  }

  /** Two-way binding between a field and an item: one undo step per visit to the field. */
  function bindItem(control, id, field, max) {
    control.disabled = ui.readOnly;
    control.addEventListener('focus', () => model.begin('Edit details'));
    control.addEventListener('input', () => {
      const item = model.get(id);
      if (item) model.put({ ...item, [field]: control.value.slice(0, max) });
    });
    control.addEventListener('blur', () => model.commit());
    bound.push({ control, id, field });
    return control;
  }

  function flagPicker(item) {
    const wrap = el('div', { class: 'pm-flags', role: 'group', 'aria-label': 'Flag' });
    const entries = [['', 'None', '#ced4da'], ...Object.entries(FLAGS).map(([k, f]) => [k, f.label, f.colour])];
    for (const [value, label, colour] of entries) {
      wrap.append(el('button', {
        type: 'button', 'aria-pressed': String(item.flag === value), disabled: ui.readOnly,
        onclick: () => { editor.setField(item.id, 'flag', value, 'Flag'); panelKey = ''; },
      }, [el('i', { style: `background:${colour}` }), label]));
    }
    return wrap;
  }

  function renderPanel(items) {
    bound.length = 0;
    if (items.length > 1) {
      panelTitle.textContent = `${items.length} items selected`;
      panelBody.replaceChildren(el('p', { class: 'pm-muted', text: 'Select a single item to see and edit its details.' }));
      return;
    }
    if (items.length === 0) return renderMapPanel();
    const item = items[0];
    panelTitle.textContent = KIND_LABELS[item.kind];
    const fields = [];
    if (item.kind === 'connector') {
      fields.push(labelled('Label', bindItem(input(item.text, { maxlength: 160, placeholder: 'e.g. Yes, No, Approved' }), item.id, 'text', 160)));
    } else if (item.kind === 'lane') {
      fields.push(labelled('Lane name', bindItem(input(item.text, { maxlength: 160, placeholder: 'A role, team or system' }), item.id, 'text', 160)));
      fields.push(labelled('Notes', bindItem(area(item.notes, { maxlength: 8000 }), item.id, 'notes', 8000)));
    } else if (item.kind === 'text') {
      fields.push(labelled('Text', bindItem(area(item.text, { maxlength: 4000 }), item.id, 'text', 4000)));
    } else {
      fields.push(labelled(item.kind === 'sticky' ? 'Note' : 'What happens', bindItem(area(item.text, { maxlength: 4000, rows: 3, style: 'min-height:72px' }), item.id, 'text', 4000)));
      fields.push(labelled('Who does it', bindItem(input(item.owner, { maxlength: 160, placeholder: 'Role or person, e.g. Payroll officer' }), item.id, 'owner', 160)));
      fields.push(labelled('System or tool', bindItem(input(item.system, { maxlength: 160, placeholder: 'e.g. Xero, Assignar, Excel, Peggy' }), item.id, 'system', 160)));
      fields.push(labelled('Time it takes', bindItem(input(item.duration, { maxlength: 160, placeholder: 'e.g. 15 min per employee, weekly' }), item.id, 'duration', 160)));
      fields.push(el('div', { class: 'pm-field' }, [el('span', { text: 'Flag' }), flagPicker(item)]));
      fields.push(labelled('Notes', bindItem(area(item.notes, { maxlength: 8000, placeholder: 'Pain points, exceptions, links to documents, questions to ask…' }), item.id, 'notes', 8000)));
    }
    fill(panelBody, fields);
  }

  function renderMapPanel() {
    const map = state.map;
    panelTitle.textContent = 'Map details';
    const items = model.all();
    const count = (fn) => items.filter(fn).length;
    const owners = [...new Set(items.filter((i) => isNode(i) && i.owner).map((i) => i.owner.trim()))].filter(Boolean);
    const systems = [...new Set(items.filter((i) => isNode(i) && i.system).map((i) => i.system.trim()))].filter(Boolean);
    const name = input(map.name, { maxlength: 120, disabled: !state.canEdit });
    const areaInput = input(map.area, { maxlength: 60, disabled: !state.canEdit, placeholder: 'e.g. Workforce' });
    const description = area(map.description, { maxlength: 1000, disabled: !state.canEdit, placeholder: 'What this process covers, who owns it, and what is still to confirm.' });
    const save = (field, control) => control.addEventListener('change', () => {
      const value = control.value.trim();
      if (field === 'name' && !value) { control.value = state.map.name; return; }
      if (value !== (state.map[field] ?? '')) actions.patchMap({ [field]: value });
    });
    save('name', name);
    save('area', areaInput);
    save('description', description);
    fill(panelBody,
      el('div', { class: 'pm-panel__stats' }, [
        el('div', {}, [el('strong', { text: String(count((i) => i.kind === 'step' || i.kind === 'decision')) }), el('span', { text: 'Steps and decisions' })]),
        el('div', {}, [el('strong', { text: String(count((i) => i.kind === 'sticky')) }), el('span', { text: 'Sticky notes' })]),
        el('div', {}, [el('strong', { text: String(count((i) => i.flag === 'pain')) }), el('span', { text: 'Pain points' })]),
        el('div', {}, [el('strong', { text: String(count((i) => i.flag === 'idea' || i.flag === 'question')) }), el('span', { text: 'Ideas and questions' })]),
      ]),
      labelled('Name', name),
      labelled('Area', areaInput),
      labelled('Description', description),
      owners.length ? el('div', { class: 'pm-field' }, [el('span', { text: 'Who is involved' }), el('p', { style: 'margin:0', text: owners.join(', ') })]) : null,
      systems.length ? el('div', { class: 'pm-field' }, [el('span', { text: 'Systems used' }), el('p', { style: 'margin:0', text: systems.join(', ') })]) : null,
      el('p', { class: 'pm-hint', text: `Created by ${map.createdByName ?? 'someone'}. Last edited ${timeAgo(map.updatedAt)}${map.updatedByName ? ` by ${map.updatedByName}` : ''}.` }),
    );
  }

  /** Keeps unfocused panel fields in step with edits made elsewhere. */
  function refreshPanelValues() {
    for (const { control, id, field } of bound) {
      if (document.activeElement === control) continue;
      const item = model.get(id);
      if (item && control.value !== (item[field] ?? '')) control.value = item[field] ?? '';
    }
  }

  function showShortcuts() {
    const keys = [
      ['V / H', 'Select / pan'], ['N', 'Sticky note'], ['R', 'Process step'], ['D', 'Decision'], ['O', 'Start / end'],
      ['T', 'Text'], ['L', 'Swimlane'], ['C', 'Connector'], ['Double-click', 'Edit text, or add a sticky on empty board'],
      ['Blue +', 'Click: next step. Drag: connect'], ['Space + drag', 'Pan'], ['Ctrl + wheel / pinch', 'Zoom'],
      ['Shift 1 / Shift 2', 'Fit all / fit selection'], ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'], ['Ctrl C / V / D', 'Copy / paste / duplicate'],
      ['Alt + drag', 'Drag a copy'], ['Arrows', 'Nudge (Shift for 10)'], ['[ / ]', 'Send to back / bring to front'], ['Delete', 'Delete'],
      ['Ctrl while dragging', 'Turn off snapping'],
    ];
    dialog((close) => el('div', { class: 'pm-dialog__body' }, [
      el('h2', { text: 'Keyboard shortcuts' }),
      el('p', { class: 'pm-dialog__lede', text: 'On a Mac, use Cmd for Ctrl.' }),
      el('dl', { class: 'pm-keys' }, keys.flatMap(([k, v]) => [el('dt', {}, [el('kbd', { text: k })]), el('dd', { text: v })])),
      el('div', { class: 'pm-dialog__actions' }, [el('button', { class: 'pm-btn pm-btn--primary', type: 'button', text: 'Done', autofocus: true, onclick: () => close() })]),
    ]), { wide: true });
  }
  addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === '?') showShortcuts();
    if (e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey) togglePanel();
  });

  /* Per-frame update --------------------------------------------------- */

  function update() {
    for (const [tool, button] of toolButtons) {
      button.setAttribute('aria-pressed', String(ui.tool === tool));
      button.hidden = ui.readOnly && tool !== 'select' && tool !== 'hand';
    }
    undoButton.disabled = ui.readOnly || !model.canUndo;
    redoButton.disabled = ui.readOnly || !model.canRedo;
    zoomValue.textContent = `${Math.round(camera.k * 100)}%`;

    const items = [...ui.selection].map((id) => model.get(id)).filter(Boolean);
    // Out of the way while dragging, drawing a selection, or typing.
    if (!items.length || ui.gesture?.started || ui.editing) {
      context.hidden = true;
    } else {
      const key = `${ui.readOnly}|${items.map((i) => `${i.id}:${i.kind}:${i.color}:${i.size}:${i.dashed}:${i.arrow}:${i.route}`).join(',')}`;
      if (key !== contextKey) {
        contextKey = key;
        fill(context, buildContext(items));
      }
      context.hidden = !context.childElementCount;
      if (!context.hidden) placeContext(items);
    }

    if (!panel.hidden) {
      // With nothing selected the panel summarises the map, so it follows the item count.
      const key = `${ui.readOnly}|${[...ui.selection].join(',')}|${items.length === 1 ? `${items[0].kind}:${items[0].flag}` : items.length ? '' : model.size}`;
      const typing = panel.contains(document.activeElement) && document.activeElement.matches('input, textarea');
      if (key !== panelKey && !typing) {
        panelKey = key;
        renderPanel(items);
      } else {
        refreshPanelValues();
      }
    }
  }

  renderer.onFrame(update);
  try { if (localStorage.getItem('pm-panel') === '1') togglePanel(true); } catch { /* private mode */ }

  return {
    update,
    openPanel,
    setStatus(status, message) {
      saveState.classList.toggle('is-bad', status === 'offline' || status === 'error');
      saveState.textContent = { saved: 'All changes saved', saving: 'Saving…', offline: 'Offline, retrying…', error: 'A change was refused', readonly: 'View only' }[status] ?? '';
      if (message && (status === 'error' || status === 'readonly')) toast(message, 'bad');
    },
    setPeers(peers) {
      // One avatar per person, however many tabs they have open.
      const people_ = [...new Map(peers.map((p) => [p.userId, p])).values()];
      people.replaceChildren(...people_.slice(0, 6).map((p) => avatar(p, { title: `${p.name} is here` })));
      if (people_.length > 6) people.append(el('span', { class: 'pm-avatar', style: 'background:#8a9099', text: `+${people_.length - 6}` }));
    },
    setMap() {
      const map = state.map;
      if (document.activeElement !== title) title.textContent = map.name;
      title.contentEditable = state.canEdit ? 'plaintext-only' : 'false';
      if (state.canEdit && title.contentEditable !== 'plaintext-only') title.contentEditable = 'true';
      statusButton.replaceChildren(el('span', { class: `pm-status pm-status--${map.status}`, text: STATUS_LABELS[map.status] }));
      statusButton.disabled = !state.canEdit;
      readOnlyPill.hidden = state.canEdit;
      readOnlyPill.textContent = map.archivedAt ? 'Archived, view only' : 'View only';
      document.title = `${map.name} · Process maps`;
      panelKey = '';
      update();
    },
  };
}
