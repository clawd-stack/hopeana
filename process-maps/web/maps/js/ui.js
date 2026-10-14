import { api } from './api.js';

/**
 * Small shared pieces: element building, dialogs, menus, toasts, and the few
 * formatting helpers every page needs.
 */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only ever our own icon markup
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastHost = null;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = el('div', { class: 'pm-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `pm-toast ${kind ? `pm-toast--${kind}` : ''}`, text: message });
  toastHost.append(node);
  setTimeout(() => node.remove(), kind === 'bad' ? 5000 : 2600);
}

/**
 * A modal dialog. `build(close)` returns the dialog's content; the promise
 * resolves with whatever close() is called with (undefined on Escape).
 */
export function dialog(build, { wide = false, dismissable = true } = {}) {
  return new Promise((resolve) => {
    const node = el('dialog', { class: `pm-dialog ${wide ? 'pm-dialog--wide' : ''}` });
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      node.close();
      node.remove();
      resolve(value);
    };
    node.addEventListener('cancel', (event) => {
      if (!dismissable) event.preventDefault();
      else close(undefined);
    });
    node.addEventListener('click', (event) => {
      if (dismissable && event.target === node) close(undefined);
    });
    node.append(build(close));
    document.body.append(node);
    node.showModal();
    node.querySelector('[autofocus]')?.focus();
  });
}

/** A form inside a dialog, with an error line and a busy state while submitting. */
export function formDialog({ title, lede, fields, submit, cancel = 'Cancel', onSubmit, wide, dismissable = true }) {
  return dialog((close) => {
    const error = el('div', { class: 'pm-notice pm-notice--bad', hidden: true });
    const button = el('button', { class: 'pm-btn pm-btn--primary', type: 'submit', text: submit });
    const form = el('form', { method: 'dialog' }, [
      el('h2', { text: title }),
      lede ? el('p', { class: 'pm-dialog__lede', text: lede }) : null,
      error,
      ...fields,
      el('div', { class: 'pm-dialog__actions' }, [
        dismissable ? el('button', { class: 'pm-btn', type: 'button', text: cancel, onclick: () => close(undefined) }) : null,
        button,
      ]),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.hidden = true;
      try {
        const result = await onSubmit(new FormData(form), form);
        if (result !== false) close(result ?? true);
      } catch (problem) {
        error.textContent = problem.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    return form;
  }, { wide, dismissable });
}

export function field(label, control, hint) {
  return el('label', { class: 'pm-field' }, [el('span', { text: label }), control, hint ? el('p', { class: 'pm-hint', text: hint }) : null]);
}

export function confirmDialog(title, message, action = 'Confirm', danger = false) {
  return dialog((close) =>
    el('div', { class: 'pm-dialog__body' }, [
      el('h2', { text: title }),
      el('p', { class: 'pm-dialog__lede', text: message }),
      el('div', { class: 'pm-dialog__actions' }, [
        el('button', { class: 'pm-btn', type: 'button', text: 'Cancel', onclick: () => close(false) }),
        el('button', { class: `pm-btn ${danger ? 'pm-btn--danger' : 'pm-btn--primary'}`, type: 'button', text: action, autofocus: true, onclick: () => close(true) }),
      ]),
    ]),
  );
}

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * A popup menu anchored to an element. Items are { label, run, danger } or
 * 'sep', or a ready-made node.
 */
export function menu(anchor, items, { align = 'left', above = false } = {}) {
  closeMenu();
  const node = el('div', { class: 'pm-menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item === 'sep') node.append(el('hr'));
    else if (item.nodeType) node.append(item);
    else if (item.heading) node.append(el('div', { class: 'pm-menu__label', text: item.heading }));
    else {
      node.append(el('button', {
        type: 'button', role: 'menuitem', class: item.danger ? 'is-danger' : '', text: item.label,
        onclick: () => { closeMenu(); item.run(); },
      }));
    }
  }
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left = align === 'right' ? rect.right - width : align === 'center' ? rect.left + rect.width / 2 - width / 2 : rect.left;
  let top = above ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > innerHeight - 8) top = rect.top - height - 6;
  if (top < 8) top = 8;
  left = Math.max(8, Math.min(left, innerWidth - width - 8));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  openMenu = node;
  setTimeout(() => node.querySelector('button')?.focus({ preventScroll: true }), 0);
  return node;
}

addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}, true);
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenu) {
    closeMenu();
    event.stopPropagation();
  }
}, true);

export function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** A stable colour per person, so the same teammate is the same colour everywhere. */
export function personColour(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 44%)`;
}

export function avatar(person, extra = {}) {
  return el('span', { class: 'pm-avatar', style: `background:${personColour(person.userId)}`, title: person.name, text: initials(person.name), ...extra });
}

export const STATUS_LABELS = { draft: 'Draft', in_review: 'In review', agreed: 'Agreed' };
export function statusPill(status) {
  return el('span', { class: `pm-status pm-status--${status}`, text: STATUS_LABELS[status] ?? status });
}

/**
 * replaceChildren for lists that may hold nothing-to-show entries. The DOM
 * method itself turns a null into the text "null".
 */
export function fill(host, ...children) {
  host.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

export { api };
