import { mountFileMenu } from '../../shared/file-menu-ui.js';

/** The Replay page's File menu: Open (pick a chat), Lessons, and Config (this replay's settings). */
export const mountReplayFileMenu = ({ onOpen, onLessons, onConfig }) =>
  mountFileMenu([
    { id: 'file-open', label: 'Open', onSelect: onOpen },
    { id: 'file-lessons', label: 'Lessons', onSelect: onLessons },
    { id: 'file-config', label: 'Config', onSelect: onConfig },
  ]);
