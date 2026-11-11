import { beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceDialog, closeModal, noticeDialog, showModal } from './modal-ui.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const overlay = () => document.querySelector('.modal-overlay');

describe('modals', () => {
  beforeEach(() => {
    closeModal();
    document.body.innerHTML = '<button id="opener">open</button>';
  });

  it('shows a form popup on <body>, focuses its first field and returns focus when closed', () => {
    $('opener').focus();
    const handle = showModal({ title: 'Hello', bodyHTML: '<input name="x" id="x">', submitLabel: 'Go' });
    expect(overlay().querySelector('h2').textContent).toBe('Hello');
    expect(document.activeElement.id).toBe('x');
    expect(overlay().querySelector('[type=submit]').textContent).toBe('Go');
    handle.close();
    expect(overlay()).toBeNull();
    expect(document.activeElement.id).toBe('opener');
  });
  const $ = (id) => document.getElementById(id);

  it('closes on Escape, the close button, Cancel and a backdrop click, and calls onDismiss', () => {
    const onDismiss = vi.fn();
    for (const how of ['escape', 'x', 'cancel', 'backdrop']) {
      showModal({ title: 't', bodyHTML: '<input>', onDismiss });
      if (how === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (how === 'x') overlay().querySelector('.modal-head [data-modal-close]').click();
      if (how === 'cancel') overlay().querySelector('.modal-actions [data-modal-close]').click();
      if (how === 'backdrop') overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(overlay()).toBeNull();
    }
    expect(onDismiss).toHaveBeenCalledTimes(4);
  });

  it('submit closes the popup, unless onSubmit returns a message: then it stays open and shows it', async () => {
    let answer = 'Nope, try again.';
    const onSubmit = vi.fn(async () => answer);
    const handle = showModal({ title: 't', bodyHTML: '<input name="x">', onSubmit });
    handle.form.requestSubmit();
    await settle();
    expect(overlay().querySelector('.modal-error').textContent).toBe('Nope, try again.');
    answer = undefined;
    handle.form.requestSubmit();
    await settle();
    expect(overlay()).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('only one popup is open at a time, and Tab stays inside it', () => {
    showModal({ title: 'first', bodyHTML: '' });
    showModal({ title: 'second', bodyHTML: '<input id="a"><input id="b">' });
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
    expect(overlay().querySelector('h2').textContent).toBe('second');
    const buttons = [...overlay().querySelectorAll('button')];
    buttons.at(-1).focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(overlay().contains(document.activeElement)).toBe(true);
  });

  it('a choice dialog resolves to the chosen id, or null when dismissed', async () => {
    const choices = [{ id: 'keep', label: 'Keep', primary: true }, { id: 'delete', label: 'Delete', danger: true }];
    let answer = choiceDialog({ title: 'Question', message: 'Sure?', choices });
    expect(overlay().textContent).toContain('Sure?');
    overlay().querySelector('[data-choice="delete"]').click();
    expect(await answer).toBe('delete');
    expect(overlay()).toBeNull();
    answer = choiceDialog({ title: 'Question', message: 'Sure?', choices });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await answer).toBeNull();
  });

  it('a notice has one OK button, escapes its text, and resolves when closed', async () => {
    const done = noticeDialog({ title: 'Heads up', message: '<b>not html</b>' });
    expect(overlay().querySelector('.modal-text').innerHTML).toBe('&lt;b&gt;not html&lt;/b&gt;');
    expect(overlay().querySelectorAll('[data-choice]')).toHaveLength(1);
    overlay().querySelector('[data-choice="ok"]').click();
    await expect(done).resolves.toBeUndefined();
  });
});
