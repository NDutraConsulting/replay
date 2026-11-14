import './styles/file-menu.css';
import { esc } from './html.js';

/**
 * The File menu, one component for every page that has one. It lives in the top navbar (the `#topbar-file` slot that the
 * shell renders in place of the brand text), so a page's re-render never touches it. Each page says which items it has and
 * what they do (see chat-file-menu.js, replay-file-menu.js, agents-file-menu.js).
 *
 * An item is `{id, label, onSelect, disabled?}`.
 */
export const fileMenuHTML = (items) =>
  `<div class="file-menu"><button type="button" class="file-menu-btn" id="file-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu">File<span class="file-caret" aria-hidden="true">▾</span></button><div class="file-menu-list" id="file-menu" role="menu" aria-label="File" hidden>${items.map((i) => `<button type="button" role="menuitem" class="file-menu-item" id="${esc(i.id)}" ${i.disabled ? 'disabled' : ''}>${esc(i.label)}</button>`).join('')}</div></div>`;

let teardown = null;

/** Empty the navbar slot and stop listening (a page without a File menu, or before a new one is mounted). */
export function clearFileMenu() {
  teardown?.();
  teardown = null;
  const slot = document.getElementById('topbar-file');
  if (slot) slot.innerHTML = '';
}

/**
 * Put the menu in the navbar slot and wire it. Calling it again replaces the menu (use it to change which items are
 * enabled); it comes back closed.
 * @param {{id: string, label: string, onSelect?: () => void, disabled?: boolean}[]} items
 */
export function mountFileMenu(items) {
  clearFileMenu();
  const slot = document.getElementById('topbar-file');
  if (!slot) return;
  slot.innerHTML = fileMenuHTML(items);
  const btn = document.getElementById('file-menu-btn');
  const menu = document.getElementById('file-menu');
  const buttons = [...menu.querySelectorAll('button')];
  const enabled = () => buttons.filter((b) => !b.disabled);
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open);
  };
  btn.onclick = () => {
    setOpen(menu.hidden);
    if (!menu.hidden) enabled()[0]?.focus();
  };
  for (const item of items) {
    document.getElementById(item.id).onclick = () => {
      setOpen(false);
      btn.focus();
      item.onSelect?.();
    };
  }
  menu.onkeydown = (e) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
    else return;
    e.preventDefault();
  };
  const onMouseDown = (e) => {
    if (!menu.hidden && !e.target.closest?.('.file-menu')) setOpen(false);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  };
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  teardown = () => {
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
  };
}
