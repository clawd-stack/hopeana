import { api } from './api.js';
import { icons } from './icons.js';
import { avatar, el, field, formDialog, menu, toast } from './ui.js';

/**
 * The frame every page shares: who is signed in, the header, sign-in when
 * nobody is, and the forced password change after an admin-issued password.
 *
 * Inside Peggy this whole file is replaced by Peggy's own header and session.
 * Pages only need boot() to hand back a user with { userId, name, role }.
 */

export async function boot({ page, header = true } = {}) {
  let user = (await api.get('/api/auth/session')).user;
  if (!user) user = await signIn();
  if (user.mustChangePassword) await changePassword({ forced: true });
  if (header) renderHeader(user, page);
  return user;
}

function signIn() {
  return new Promise((resolve) => {
    const error = el('div', { class: 'pm-notice pm-notice--bad', hidden: true });
    const email = el('input', { class: 'pm-input', type: 'email', name: 'email', autocomplete: 'username', required: true, autofocus: true });
    const password = el('input', { class: 'pm-input', type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    const button = el('button', { class: 'pm-btn pm-btn--primary', type: 'submit', text: 'Sign in', style: 'width:100%' });
    const form = el('form', { class: 'pm-card pm-signin' }, [
      el('div', { class: 'pm-brand', style: 'margin-bottom:18px', html: `<span class="pm-brand__mark">${icons.logo}</span>` }),
      el('h1', { text: 'Process maps' }),
      el('p', { text: 'Sign in to view and map the team’s processes.' }),
      error,
      field('Email', email),
      field('Password', password),
      button,
      el('p', { class: 'pm-hint', style: 'margin-top:14px', text: 'No account yet? Ask an admin to add you.' }),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.hidden = true;
      try {
        const { user } = await api.post('/api/auth/login', { email: email.value, password: password.value });
        form.remove();
        resolve(user);
      } catch (problem) {
        error.textContent = problem.message;
        error.hidden = false;
        password.select();
      } finally {
        button.disabled = false;
      }
    });
    document.body.classList.remove('pm-board-page');
    document.body.prepend(form);
    email.focus();
  });
}

export function changePassword({ forced = false } = {}) {
  const current = el('input', { class: 'pm-input', type: 'password', name: 'current', autocomplete: 'current-password', required: true, autofocus: true });
  const next = el('input', { class: 'pm-input', type: 'password', name: 'next', autocomplete: 'new-password', required: true, minlength: 12 });
  const again = el('input', { class: 'pm-input', type: 'password', name: 'again', autocomplete: 'new-password', required: true });
  return formDialog({
    title: forced ? 'Choose your own password' : 'Change password',
    lede: forced
      ? 'You signed in with a password an admin gave you. Pick one only you know before carrying on.'
      : 'At least 12 characters. A short phrase is easier to remember than a jumble.',
    fields: [
      field(forced ? 'Password you were given' : 'Current password', current),
      field('New password', next, 'At least 12 characters.'),
      field('New password again', again),
    ],
    submit: 'Save password',
    dismissable: !forced,
    onSubmit: async () => {
      if (next.value !== again.value) throw new Error('The two new passwords do not match.');
      await api.post('/api/auth/password', { current: current.value, next: next.value });
      toast('Password changed');
    },
  });
}

export async function signOut() {
  await api.post('/api/auth/session', {});
  location.href = '/maps/';
}

export function userMenu(user, anchor) {
  menu(anchor, [
    { heading: `${user.name} · ${user.role}` },
    { label: 'Change password', run: () => changePassword() },
    'sep',
    { label: 'Sign out', run: signOut },
  ], { align: 'right' });
}

function renderHeader(user, page) {
  const nav = el('nav', { class: 'pm-nav', 'aria-label': 'Process maps' }, [
    el('a', { href: '/maps/', text: 'Maps', 'aria-current': page === 'maps' ? 'page' : null }),
    user.role === 'admin' ? el('a', { href: '/maps/team.html', text: 'Team', 'aria-current': page === 'team' ? 'page' : null }) : null,
  ]);
  const who = el('button', { class: 'pm-usermenu', type: 'button', 'aria-label': 'Account' }, [avatar(user), el('span', { text: user.name })]);
  who.addEventListener('click', () => userMenu(user, who));
  document.body.prepend(
    el('header', { class: 'pm-header' }, [
      el('div', { class: 'pm-header__bar' }, [
        el('a', { class: 'pm-brand', href: '/maps/', html: `<span class="pm-brand__mark">${icons.logo}</span><span>Process maps</span>` }),
        nav,
        el('div', { class: 'pm-header__spacer' }),
        who,
      ]),
    ]),
  );
}
