import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

const toastText = () => document.querySelector('.toast')?.textContent;
const setClipboard = (value) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  setClipboard(undefined);
  delete document.execCommand;
});

describe('copyText', () => {
  it('writes the text to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    expect(await copyText('hello <b>world</b>', 'Prompt copied.')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello <b>world</b>'); // the text exactly as it is
    expect(toastText()).toBe('Prompt copied.');
  });

  it('says "Copied." when no message is given', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue() });
    await copyText('x');
    expect(toastText()).toBe('Copied.');
  });

  it('says so when the browser refuses', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await copyText('x', 'Copied.')).toBe(false);
    expect(toastText()).toBe('Copy unavailable in this browser. Select the text to copy.');
  });

  it('falls back to selecting the text when there is no clipboard API (a page served over plain http)', async () => {
    setClipboard(undefined);
    let selected = null;
    document.execCommand = vi.fn(() => {
      selected = document.querySelector('textarea').value;
      return true;
    });
    expect(await copyText('plain http text', 'Response copied.')).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('plain http text');
    expect(document.querySelector('textarea')).toBeNull(); // the helper box is removed again
    expect(toastText()).toBe('Response copied.');
  });

  it('says so when even the fallback is refused, and still cleans up', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    expect(await copyText('x')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
    expect(toastText()).toContain('Copy unavailable');
  });

  it('says so when there is no way to copy at all', async () => {
    setClipboard(undefined);
    expect(await copyText('x')).toBe(false); // jsdom has no execCommand
    expect(toastText()).toContain('Copy unavailable');
  });
});
