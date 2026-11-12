import { mountFileMenu, showConfigLocked } from '../../shared/file-menu-ui.js';

/** The Chat page's File menu: New, Open, and Config (a chat's settings are locked). */
export const mountChatFileMenu = ({ onNew, onOpen }) =>
  mountFileMenu([
    { id: 'file-new', label: 'New', onSelect: onNew },
    { id: 'file-open', label: 'Open', onSelect: onOpen },
    { id: 'file-config', label: 'Config', onSelect: showConfigLocked },
  ]);
