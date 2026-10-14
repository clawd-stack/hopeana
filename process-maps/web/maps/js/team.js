import { api } from './api.js';
import { boot } from './shell.js';
import { icons } from './icons.js';
import { confirmDialog, dialog, el, field, formDialog, timeAgo, toast } from './ui.js';

/**
 * The team, for admins: who can sign in and what they can do. Standalone
 * only; inside Peggy this page goes, and Peggy's user management takes over.
 */

const main = document.getElementById('main');
const ROLE_LABELS = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HELP = 'Editors can create and edit maps. Viewers can only look. Admins also manage the team.';
const AGENT_ROLES = { editor: 'Editor', viewer: 'Viewer' };
const AGENT_HELP = 'Agents such as Crocbot read and change maps through the API with an access key, not through the board.';

const me = await boot({ page: 'team' });
if (me.role !== 'admin') {
  main.replaceChildren(el('div', { class: 'pm-notice pm-notice--warn', text: 'Only admins can manage the team.' }));
} else {
  await refresh();
}

async function refresh() {
  try {
    const { team } = await api.get('/api/team');
    render(team);
  } catch (error) {
    main.replaceChildren(el('div', { class: 'pm-notice pm-notice--bad', text: error.message }));
  }
}

function render(team) {
  const rows = team.map((person) => {
    const self = person.userId === me.userId;
    const roles = person.isAgent ? AGENT_ROLES : ROLE_LABELS;
    const role = el('select', { class: 'pm-select', 'aria-label': `Role for ${person.name}`, disabled: self || !person.active },
      Object.entries(roles).map(([value, label]) => el('option', { value, text: label, selected: person.role === value })));
    role.addEventListener('change', () => update(person, { role: role.value }, `${person.name} is now ${ROLE_LABELS[role.value].toLowerCase()}`));
    return el('tr', { class: person.active ? '' : 'is-inactive' }, [
      el('td', {}, [
        el('strong', { text: person.name }),
        self ? el('span', { class: 'pm-muted', text: ' (you)' }) : null,
        person.isAgent ? el('span', { class: 'pm-tag', style: 'margin-left:8px', text: 'Agent' }) : null,
      ]),
      el('td', { text: person.isAgent ? (person.apiKeyCreatedAt ? `Access key made ${timeAgo(person.apiKeyCreatedAt)}` : 'No access key') : person.email }),
      el('td', {}, [role]),
      el('td', { text: person.active ? (person.lastLoginAt ? timeAgo(person.lastLoginAt) : 'Not yet') : 'Deactivated' }),
      el('td', {}, [
        el('div', { class: 'pm-table__actions' }, self ? [] : [
          person.active && person.isAgent ? el('button', { class: 'pm-btn pm-btn--small', type: 'button', text: 'New key', onclick: () => newKey(person) }) : null,
          person.active && !person.isAgent ? el('button', { class: 'pm-btn pm-btn--small', type: 'button', text: 'Reset password', onclick: () => resetPassword(person) }) : null,
          person.active
            ? el('button', { class: 'pm-btn pm-btn--small pm-btn--danger', type: 'button', text: 'Deactivate', onclick: () => deactivate(person) })
            : el('button', { class: 'pm-btn pm-btn--small', type: 'button', text: 'Reactivate', onclick: () => update(person, { active: true }, `${person.name} can sign in again`) }),
        ]),
      ]),
    ]);
  });

  main.replaceChildren(
    el('div', { class: 'pm-page__head' }, [
      el('div', {}, [
        el('h1', { text: 'Team' }),
        el('p', { text: ROLE_HELP }),
        el('p', {}, [`${AGENT_HELP} `, el('a', { href: '/llms.txt', target: '_blank', rel: 'noopener', text: 'Guide for agents' })]),
      ]),
      el('div', { class: 'pm-page__actions' }, [
        el('button', { class: 'pm-btn', type: 'button', html: `${icons.plus}<span>Add agent</span>`, onclick: addAgent }),
        el('button', { class: 'pm-btn pm-btn--primary', type: 'button', html: `${icons.plus}<span>Add person</span>`, onclick: addPerson }),
      ]),
    ]),
    el('div', { class: 'pm-card pm-scroll-x' }, [
      el('table', { class: 'pm-table' }, [
        el('thead', {}, [el('tr', {}, ['Name', 'Email', 'Role', 'Last active', ''].map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows),
      ]),
    ]),
  );
}

async function update(person, patch, message) {
  try {
    await api.patch(`/api/team/${person.userId}`, patch);
    toast(message);
  } catch (error) {
    toast(error.message, 'bad');
  }
  await refresh();
}

async function deactivate(person) {
  const what = person.isAgent
    ? 'Its access key stops working straight away. Its edits stay on the maps.'
    : 'They will be signed out on their next action and cannot sign in again until reactivated. Their edits stay on the maps.';
  if (!(await confirmDialog(`Deactivate ${person.name}?`, what, 'Deactivate', true))) return;
  await update(person, { active: false }, `${person.name} deactivated`);
}

async function resetPassword(person) {
  if (!(await confirmDialog(`Reset ${person.name}'s password?`, 'Their current password stops working straight away. You will get a new one to pass on.', 'Reset password'))) return;
  try {
    const { password } = await api.patch(`/api/team/${person.userId}`, { resetPassword: true });
    await showPassword(person, password);
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function addPerson() {
  const name = el('input', { class: 'pm-input', name: 'name', required: true, maxlength: 80, autofocus: true });
  const email = el('input', { class: 'pm-input', name: 'email', type: 'email', required: true });
  const role = el('select', { class: 'pm-select', name: 'role' },
    Object.entries(ROLE_LABELS).map(([value, label]) => el('option', { value, text: label, selected: value === 'editor' })));
  const result = await formDialog({
    title: 'Add someone to the team',
    lede: 'They get a one-time password from you, and choose their own the first time they sign in.',
    fields: [field('Name', name), field('Work email', email), field('Role', role, ROLE_HELP)],
    submit: 'Add person',
    onSubmit: async (data) => api.post('/api/team', { name: data.get('name'), email: data.get('email'), role: data.get('role') }),
  });
  if (!result) return;
  await refresh();
  await showPassword(result.user, result.password);
}

function showPassword(person, password) {
  const signInUrl = `${location.origin}/maps/`;
  const message = `Hi ${person.name.split(' ')[0]}, you can sign in to Process maps at ${signInUrl} with ${person.email} and this one-time password: ${password}`;
  return dialog((close) => el('div', { class: 'pm-dialog__body' }, [
    el('h2', { text: `Password for ${person.name}` }),
    el('p', { class: 'pm-dialog__lede', text: 'Shown once. Pass it on however suits; they will be asked to change it when they first sign in.' }),
    el('div', { class: 'pm-secret' }, [el('code', { text: password })]),
    el('div', { class: 'pm-dialog__actions' }, [
      el('button', {
        class: 'pm-btn', type: 'button', html: `${icons.copy}<span>Copy invite message</span>`,
        onclick: async () => { await navigator.clipboard?.writeText(message); toast('Invite message copied'); },
      }),
      el('button', { class: 'pm-btn pm-btn--primary', type: 'button', text: 'Done', autofocus: true, onclick: () => close() }),
    ]),
  ]));
}

async function newKey(agent) {
  if (!(await confirmDialog(`Make a new key for ${agent.name}?`, 'The key it has now stops working straight away. You will get a new one to give it.', 'Make new key'))) return;
  try {
    const { apiKey } = await api.patch(`/api/team/${agent.userId}`, { newKey: true });
    await refresh();
    await showKey(agent, apiKey);
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function addAgent() {
  const name = el('input', { class: 'pm-input', name: 'name', required: true, maxlength: 80, autofocus: true, placeholder: 'Crocbot' });
  const role = el('select', { class: 'pm-select', name: 'role' },
    Object.entries(AGENT_ROLES).map(([value, label]) => el('option', { value, text: label, selected: value === 'editor' })));
  const result = await formDialog({
    title: 'Add an agent',
    lede: `${AGENT_HELP} You get its access key next, once.`,
    fields: [field('Name', name, 'Shown on the board next to everything it changes.'), field('Role', role, 'An editor can change maps; a viewer can only read them.')],
    submit: 'Add agent',
    onSubmit: async (data) => api.post('/api/team', { agent: true, name: data.get('name'), role: data.get('role') }),
  });
  if (!result) return;
  await refresh();
  await showKey(result.user, result.apiKey);
}

/** What an agent needs to get going, in words it can follow on its own. */
function setupText(agent, key) {
  const origin = location.origin;
  return [
    `You (${agent.name}) have access to WCC's Process maps, the shared board where the team maps how work gets done.`,
    `The board is drawn by JavaScript, so do not try to read the web page. Read the guide first: ${origin}/llms.txt`,
    `Your access key (keep it secret): ${key}`,
    `MCP server: ${origin}/api/mcp with the header "Authorization: Bearer ${key}"`,
    `HTTP API: ${origin}/api/agent/maps with the same header.`,
  ].join('\n');
}

function showKey(agent, key) {
  return dialog((close) => el('div', { class: 'pm-dialog__body' }, [
    el('h2', { text: `Access key for ${agent.name}` }),
    el('p', { class: 'pm-dialog__lede', text: 'Shown once. Give it to the agent with the setup text, which tells it where the guide and the API are. Anyone with the key can do what this agent can, so keep it out of chats other people read.' }),
    el('div', { class: 'pm-secret' }, [el('code', { text: key })]),
    el('div', { class: 'pm-dialog__actions' }, [
      el('button', {
        class: 'pm-btn', type: 'button', html: `${icons.copy}<span>Copy key</span>`,
        onclick: async () => { await navigator.clipboard?.writeText(key); toast('Key copied'); },
      }),
      el('button', {
        class: 'pm-btn', type: 'button', html: `${icons.copy}<span>Copy setup for the agent</span>`,
        onclick: async () => { await navigator.clipboard?.writeText(setupText(agent, key)); toast('Setup copied'); },
      }),
      el('button', { class: 'pm-btn pm-btn--primary', type: 'button', text: 'Done', autofocus: true, onclick: () => close() }),
    ]),
  ]), { wide: true });
}
