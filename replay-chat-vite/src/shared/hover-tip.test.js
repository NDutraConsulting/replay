import { beforeEach, describe, expect, it } from 'vitest';
import { enableHoverTips } from './hover-tip.js';

const over = (el, extra = {}) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 40, clientY: 50, ...extra }));
const out = (el, to = document.body) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
const tip = () => document.querySelector('.hover-tip');

beforeEach(() => {
  document.body.innerHTML = '<p>text <span id="a" data-cliff-tip="Cliff: 2.31\nmore"><b id="inner">word</b></span> and <span id="b" data-cliff-tip="Cliff: 5">other</span></p><i id="plain">none</i>';
  enableHoverTips();
});

describe('hover tip', () => {
  it('is on the page, hidden, and described as a tooltip', () => {
    expect(tip()).not.toBeNull();
    expect(tip().hidden).toBe(true);
    expect(tip().getAttribute('role')).toBe('tooltip');
  });

  it('shows the text of the element under the pointer, even from a child, and hides when the pointer leaves', () => {
    over(document.getElementById('inner'));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe('Cliff: 2.31\nmore');
    out(document.getElementById('a'));
    expect(tip().hidden).toBe(true);
  });

  it('follows the pointer and moves to the next element without hiding in between', () => {
    over(document.getElementById('a'));
    document.getElementById('a').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 90, clientY: 120 }));
    expect(tip().style.left).toBe('102px');
    out(document.getElementById('a'), document.getElementById('b'));
    over(document.getElementById('b'));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe('Cliff: 5');
  });

  it('ignores elements without a tip', () => {
    over(document.getElementById('plain'));
    expect(tip().hidden).toBe(true);
  });

  it('works for keyboard focus too', () => {
    const el = document.getElementById('b');
    el.tabIndex = 0;
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tip().hidden).toBe(false);
    expect(tip().textContent).toBe('Cliff: 5');
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tip().hidden).toBe(true);
  });

  it('comes back after the page is cleared, and does not bind twice', () => {
    document.body.innerHTML = '<span id="c" data-cliff-tip="again">x</span>';
    enableHoverTips();
    expect(document.querySelectorAll('.hover-tip')).toHaveLength(1);
    over(document.getElementById('c'));
    expect(tip().textContent).toBe('again');
    enableHoverTips();
    expect(document.querySelectorAll('.hover-tip')).toHaveLength(1);
  });
});
