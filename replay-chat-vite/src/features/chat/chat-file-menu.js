import { mountFileMenu } from '../../shared/file-menu-ui.js';

/** The Chat page's File menu: New, Open, and Config (which optional buttons the page shows). */
export const mountChatFileMenu = ({ onNew, onOpen, onConfig }) =>
  mountFileMenu([
    { id: 'file-new', label: 'New', onSelect: onNew },
    { id: 'file-open', label: 'Open', onSelect: onOpen },
    { id: 'file-config', label: 'Config', onSelect: onConfig },
  ]);
