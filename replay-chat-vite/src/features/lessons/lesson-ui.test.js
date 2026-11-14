import { beforeEach, describe, expect, it } from 'vitest';
import { createLayer, placeLayer } from './lesson-ui.js';

const avatar = { avatar_slug: 'a', file: 'a.webp', alt: 'Rex', facing: 'front' };
const step = { position: 1, title: 'T', body: 'B', avatar };

/** A layer whose card is 300 x 100 (jsdom has no layout), on a 1000 x 800 screen. */
const layer = () => {
  const el = createLayer({ title: 'L' }, step, { index: 1, last: 3, canGoBack: true });
  document.body.append(el);
  const card = el.querySelector('.lesson-card');
  Object.defineProperty(card, 'offsetWidth', { value: 300 });
  Object.defineProperty(card, 'offsetHeight', { value: 100 });
  return { el, card };
};
const rect = { left: 100, right: 900, top: 200, bottom: 260 };

beforeEach(() => {
  document.body.innerHTML = '';
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

describe('card placement', () => {
  it('bottom: under the target, left edges lined up', () => {
    const { el, card } = layer();
    placeLayer(el, rect, 'bottom');
    expect(card.dataset.side).toBe('bottom');
    expect(card.style.left).toBe(`${rect.left - 8}px`);
    expect(card.style.top).toBe(`${rect.bottom + 8 + 14}px`);
  });

  it('bottom-end: under the target, right ends lined up (the right side of a wide target)', () => {
    const { el, card } = layer();
    placeLayer(el, rect, 'bottom-end');
    expect(card.dataset.side).toBe('bottom');
    expect(card.style.left).toBe(`${rect.right + 8 - 300}px`);
    expect(card.style.top).toBe(`${rect.bottom + 8 + 14}px`);
  });

  it('top-end: over the target, right ends lined up; it stays on screen at the edge', () => {
    const { el, card } = layer();
    placeLayer(el, { ...rect, right: 1000 }, 'top-end');
    expect(card.dataset.side).toBe('top');
    expect(Number.parseInt(card.style.left, 10) + 300).toBeLessThanOrEqual(1000 - 16);
  });

  it('bottom-end flips to the top when there is no room below, keeping the right-end alignment only on the named side', () => {
    const { el, card } = layer();
    placeLayer(el, { ...rect, top: 700, bottom: 760 }, 'bottom-end');
    expect(card.dataset.side).toBe('top');
  });

  it('a target taller than the screen: the card floats over the bottom of the screen, on the right with an -end placement', () => {
    const { el, card } = layer();
    placeLayer(el, { left: 100, right: 900, top: -400, bottom: 1400 }, 'top-end');
    expect(card.dataset.side).toBe('over');
    expect(Number.parseInt(card.style.left, 10)).toBe(908 - 300); // the spotlight's right end (900 + 8), minus the card's width
    expect(Number.parseInt(card.style.top, 10)).toBe(800 - 100 - 16);
  });
});
