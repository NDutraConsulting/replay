import { toast } from './toast.js';

/**
 * Copy text to the clipboard and say so. Uses the clipboard API where the page may (https or localhost), and the older
 * selection route otherwise (a page served over plain http on a network address has no clipboard API).
 * @returns {Promise<boolean>} whether it was copied
 */
export async function copyText(text, done = 'Copied.') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
    toast(done);
    return true;
  } catch {
    toast('Copy unavailable in this browser. Select the text to copy.');
    return false;
  }
}

function legacyCopy(text) {
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(box);
  box.select();
  try {
    if (!document.execCommand?.('copy')) throw new Error('copy refused');
  } finally {
    box.remove();
  }
}
