import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindFileMenu, fileMenuHTML } from './file-menu-ui.js';

const items = () => [...document.querySelectorAll('#file-menu .file-menu-item')].map((b) => b.textContent);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('file menu', () => {
  it('has New, Open and Config by default (the Chat page)', () => {
    document.body.innerHTML = fileMenuHTML();
    expect(items()).toEqual(['New', 'Open', 'Config']);
    expect(document.getElementById('file-new')).not.toBeNull();
  });

  it('leaves New out when asked (the Replay page), keeping Open and Config', () => {
    document.body.innerHTML = fileMenuHTML({ withNew: false });
    expect(items()).toEqual(['Open', 'Config']);
    expect(document.getElementById('file-new')).toBeNull();
    expect(document.getElementById('file-open')).not.toBeNull();
    expect(document.getElementById('file-config')).not.toBeNull();
  });

  it('works without a New item: Open and Config still run their actions, and the arrow keys move between the two', () => {
    document.body.innerHTML = fileMenuHTML({ withNew: false });
    const onOpen = vi.fn();
    const onConfig = vi.fn();
    bindFileMenu({ onOpen, onConfig });
    document.getElementById('file-menu-btn').click();
    expect(document.getElementById('file-menu').hidden).toBe(false);
    expect(document.activeElement.id).toBe('file-open'); // the first item is now Open
    const menu = document.getElementById('file-menu');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.id).toBe('file-config');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement.id).toBe('file-open'); // wraps round the two items
    document.getElementById('file-config').click();
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(document.getElementById('file-menu').hidden).toBe(true);
    document.getElementById('file-menu-btn').click();
    document.getElementById('file-open').click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('still runs New on a menu that has it', () => {
    document.body.innerHTML = fileMenuHTML();
    const onNew = vi.fn();
    bindFileMenu({ onNew });
    document.getElementById('file-menu-btn').click();
    document.getElementById('file-new').click();
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
