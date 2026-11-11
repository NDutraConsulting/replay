import './styles/file-menu.css';
import { noticeDialog } from './modal-ui.js';

/**
 * The File menu at the top of the Chat and Replay pages: New (Chat only: `withNew: false` leaves it out), Open and Config.
 * Open does nothing yet (UI only). Config explains that a conversation's settings are locked.
 */
export const fileMenuHTML = ({ withNew = true } = {}) =>
  `<div class="file-menu-row"><div class="file-menu"><button type="button" class="file-menu-btn" id="file-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu">File<span class="file-caret" aria-hidden="true">▾</span></button><div class="file-menu-list" id="file-menu" role="menu" aria-label="File" hidden>${withNew ? '<button type="button" role="menuitem" class="file-menu-item" id="file-new">New</button>' : ''}<button type="button" role="menuitem" class="file-menu-item" id="file-open">Open</button><button type="button" role="menuitem" class="file-menu-item" id="file-config">Config</button></div></div></div><hr class="file-rule">`;

export const showConfigLocked = () =>
  noticeDialog({ title: 'Config', message: 'Locked for educational purposes. Start a new chat for different settings.' });

/** @param {{onNew?: () => void, onOpen?: () => void, onConfig?: () => void}} [h]  (Config shows the locked notice unless a page gives its own) */
export function bindFileMenu({ onNew, onOpen, onConfig } = {}) {
  const btn = document.getElementById('file-menu-btn');
  const menu = document.getElementById('file-menu');
  if (!btn || !menu) return;
  const items = [...menu.querySelectorAll('button')];
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open);
  };
  btn.onclick = () => {
    setOpen(menu.hidden);
    if (!menu.hidden) items[0].focus();
  };
  const choose = (id, action) => {
    const item = document.getElementById(id);
    if (!item) return; // this page's menu has no such item
    item.onclick = () => {
      setOpen(false);
      btn.focus();
      action?.();
    };
  };
  choose('file-new', onNew);
  choose('file-open', onOpen);
  choose('file-config', onConfig || showConfigLocked);
  menu.onkeydown = (e) => {
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(at + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length].focus();
    else return;
    e.preventDefault();
  };
  document.onmousedown = (e) => {
    if (!menu.hidden && !e.target.closest?.('.file-menu')) setOpen(false);
  };
  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  };
}
