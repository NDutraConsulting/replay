import './styles/modal.css';
import { esc } from './html.js';
import { icon } from './icons.js';

/**
 * Popup modals that live on <body>, so a page re-render never removes one. Escape, the close button and a click on the
 * backdrop dismiss it; Tab stays inside it; focus returns to whatever had it before. Only one is open at a time.
 */
let active = null;

export function closeModal() {
  active?.close();
}

function mount(overlay, { onDismiss }) {
  const opener = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (active?.overlay === overlay) active = null;
    if (opener?.isConnected) opener.focus?.();
  };
  const dismiss = () => {
    close();
    onDismiss?.();
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'Tab') {
      const items = [...overlay.querySelectorAll('button,input,select,textarea,a[href]')].filter((el) => !el.disabled);
      if (!items.length) return;
      if (e.shiftKey && document.activeElement === items[0]) {
        e.preventDefault();
        items.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
        e.preventDefault();
        items[0].focus();
      }
    }
  }
  closeModal();
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.onmousedown = (e) => {
    if (e.target === overlay) dismiss();
  };
  overlay.querySelectorAll('[data-modal-close]').forEach((b) => (b.onclick = dismiss));
  active = { overlay, close };
  return { close, dismiss };
}

const frame = (title, inner, wide, className = '') =>
  `<div class="modal ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="icon-btn" data-modal-close aria-label="Close">${icon('close')}</button></div>${inner}</div>`;

/**
 * A form popup.
 * @param {{title: string, bodyHTML: string, submitLabel?: string, cancelLabel?: string|null, wide?: boolean, className?: string,
 *   onSubmit?: (form: HTMLFormElement) => (string|void|Promise<string|void>), onMount?: (form: HTMLFormElement, handle: object) => void,
 *   onDismiss?: () => void}} options
 *   `onSubmit` may return a message (shown in the popup, which stays open), `false` (stays open, no message: the popup
 *   changed step) or nothing (the popup closes).
 * @returns {{close: () => void, form: HTMLFormElement, setError: (message: string) => void}}
 */
export function showModal({ title, bodyHTML, submitLabel = 'OK', cancelLabel = 'Cancel', wide = false, className = '', onSubmit, onMount, onDismiss }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = frame(
    title,
    `<form class="modal-form" novalidate>${bodyHTML}<p class="modal-error" role="alert"></p><div class="modal-actions">${cancelLabel === null ? '' : `<button type="button" class="btn" data-modal-close>${esc(cancelLabel)}</button>`}<button class="btn yellow" type="submit">${esc(submitLabel)}</button></div></form>`,
    wide,
    className,
  );
  const { close } = mount(overlay, { onDismiss });
  const form = overlay.querySelector('form');
  const setError = (message) => {
    overlay.querySelector('.modal-error').textContent = message || '';
  };
  const handle = { close, form, setError };
  let submitting = false;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    setError('');
    try {
      const problem = await onSubmit?.(form);
      if (problem === false) return; // the popup moved to another step: it stays open, with no message
      if (problem) setError(problem);
      else close();
    } finally {
      submitting = false;
    }
  };
  onMount?.(form, handle);
  (form.querySelector('input,select,textarea') || form.querySelector('button[type=submit]')).focus();
  return handle;
}

/**
 * A question with several answers. Resolves to the chosen id, or null when dismissed.
 * @param {{title: string, message: string, choices: {id: string, label: string, primary?: boolean, danger?: boolean}[]}} options
 */
export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = frame(
      title,
      `<div class="modal-form"><p class="modal-text">${esc(message)}</p><div class="modal-actions">${choices.map((c) => `<button type="button" class="btn ${c.primary ? 'yellow' : ''} ${c.danger ? 'danger' : ''}" data-choice="${esc(c.id)}">${esc(c.label)}</button>`).join('')}</div></div>`,
    );
    const { close } = mount(overlay, { onDismiss: () => resolve(null) });
    overlay.querySelectorAll('[data-choice]').forEach((b) => {
      b.onclick = () => {
        close();
        resolve(b.dataset.choice);
      };
    });
    (overlay.querySelector('.btn.yellow') || overlay.querySelector('[data-choice]')).focus();
  });
}

/** A notice with one OK button. Resolves when it is closed. */
export const noticeDialog = ({ title, message, label = 'OK' }) =>
  choiceDialog({ title, message, choices: [{ id: 'ok', label, primary: true }] }).then(() => undefined);
