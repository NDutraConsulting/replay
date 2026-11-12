import { mountFileMenu } from '../../shared/file-menu-ui.js';

/** The Replay page's File menu: Open (pick a chat) and Config (this replay's settings). */
export const mountReplayFileMenu = ({ onOpen, onConfig }) =>
  mountFileMenu([
    { id: 'file-open', label: 'Open', onSelect: onOpen },
    { id: 'file-config', label: 'Config', onSelect: onConfig },
  ]);
