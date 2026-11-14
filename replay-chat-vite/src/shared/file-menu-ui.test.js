import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFileMenu, fileMenuHTML, mountFileMenu } from './file-menu-ui.js';
import { mountChatFileMenu } from '../features/chat/chat-file-menu.js';
import { mountReplayFileMenu } from '../features/replay/replay-file-menu.js';
import { mountAgentsFileMenu } from '../features/agents/agents-file-menu.js';

const items = () => [...document.querySelectorAll('#file-menu .file-menu-item')].map((b) => b.textContent);
const slot = () => document.getElementById('topbar-file');

beforeEach(() => {
  clearFileMenu();
  document.body.innerHTML = '<header class="topbar"><div class="topbar-file" id="topbar-file"></div></header><main id="main"></main>';
});

describe('file menu component', () => {
  it('renders the items it is given, in order, and escapes their labels', () => {
    document.body.innerHTML = fileMenuHTML([{ id: 'a', label: 'One' }, { id: 'b', label: '<b>Two</b>', disabled: true }]);
    expect(items()).toEqual(['One', '<b>Two</b>']);
    expect(document.querySelector('#file-menu b')).toBeNull();
    expect(document.getElementById('b').disabled).toBe(true);
  });

  it('goes into the navbar slot, runs an item and closes; arrow keys wrap and skip disabled items', () => {
    const one = vi.fn();
    mountFileMenu([{ id: 'one', label: 'One', onSelect: one }, { id: 'two', label: 'Two', disabled: true }, { id: 'three', label: 'Three' }]);
    expect(slot().querySelector('#file-menu-btn')).not.toBeNull();
    document.getElementById('file-menu-btn').click();
    expect(document.getElementById('file-menu').hidden).toBe(false);
    expect(document.activeElement.id).toBe('one');
    const menu = document.getElementById('file-menu');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.id).toBe('three'); // Two is disabled
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.id).toBe('one');
    document.getElementById('one').click();
    expect(one).toHaveBeenCalledTimes(1);
    expect(document.getElementById('file-menu').hidden).toBe(true);
    expect(document.activeElement.id).toBe('file-menu-btn');
  });

  it('closes on Escape and on a click outside', () => {
    mountFileMenu([{ id: 'one', label: 'One' }]);
    const open = () => document.getElementById('file-menu-btn').click();
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('file-menu').hidden).toBe(true);
    open();
    document.getElementById('main').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.getElementById('file-menu').hidden).toBe(true);
  });

  it('mounting again replaces the menu (closed) and does not stack listeners', () => {
    const first = vi.fn();
    mountFileMenu([{ id: 'one', label: 'One', onSelect: first }]);
    mountFileMenu([{ id: 'two', label: 'Two' }]);
    expect(items()).toEqual(['Two']);
    expect(document.querySelectorAll('#file-menu')).toHaveLength(1);
    expect(document.getElementById('file-menu').hidden).toBe(true);
  });

  it('does nothing on a page without the navbar slot, and clearFileMenu empties it', () => {
    mountFileMenu([{ id: 'one', label: 'One' }]);
    clearFileMenu();
    expect(slot().innerHTML).toBe('');
    document.body.innerHTML = '';
    expect(() => mountFileMenu([{ id: 'one', label: 'One' }])).not.toThrow();
  });
});

describe('each page has its own File menu', () => {
  it('Chat: New, Open and Config (Config says the settings are locked)', () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    mountChatFileMenu({ onNew, onOpen });
    expect(items()).toEqual(['New', 'Open', 'Lessons', 'Config']);
    document.getElementById('file-menu-btn').click();
    document.getElementById('file-new').click();
    document.getElementById('file-menu-btn').click();
    document.getElementById('file-open').click();
    expect([onNew.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 1]);
  });

  it('Replay: Open and Config, no New', () => {
    const onOpen = vi.fn();
    const onConfig = vi.fn();
    mountReplayFileMenu({ onOpen, onConfig });
    expect(items()).toEqual(['Open', 'Config']);
    document.getElementById('file-menu-btn').click();
    document.getElementById('file-config').click();
    expect(onConfig).toHaveBeenCalledTimes(1);
  });

  it('AI agents: Open agent and the three Add items, which wait for the tree they need', () => {
    const onOpenModal = vi.fn();
    mountAgentsFileMenu({ categories: [] }, { onOpenModal });
    expect(items()).toEqual(['Open agent', 'Add category', 'Add subcategory', 'Add file']);
    expect(['open-add-sub', 'open-add-file'].map((id) => document.getElementById(id).disabled)).toEqual([true, true]);
    mountAgentsFileMenu({ categories: [{ subcategories: [] }] }, { onOpenModal });
    expect(['open-add-sub', 'open-add-file'].map((id) => document.getElementById(id).disabled)).toEqual([false, true]);
    mountAgentsFileMenu({ categories: [{ subcategories: [{}] }] }, { onOpenModal });
    expect(document.getElementById('open-add-file').disabled).toBe(false);
    document.getElementById('file-menu-btn').click();
    document.getElementById('open-add-category').click();
    expect(onOpenModal).toHaveBeenCalledWith('category');
  });
});
