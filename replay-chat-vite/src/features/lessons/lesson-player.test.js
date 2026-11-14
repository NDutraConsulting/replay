import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLessonPlayer } from './lesson-player.js';

const avatar = { avatar_slug: 'guide', file: 'guide.webp', alt: 'A friendly T. rex', facing: 'front' };
const step = (position, over = {}) => ({
  position,
  title: `Step ${position}`,
  body: `Body **${position}** <b>raw</b>`,
  target: null,
  action: 'none',
  action_arg: null,
  on_next: 'none',
  on_target_gone: 'stop',
  placement: 'top',
  avatar,
  ...over,
});
const lesson = (steps) => ({ slug: 'demo', title: 'Demo', steps, progress: { status: 'not_started', current_step: 0 } });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const layer = () => document.querySelector('.lesson-layer');
const card = () => document.querySelector('.lesson-card');
const title = () => document.querySelector('.lesson-title')?.textContent;
const press = (sel) => document.querySelector(sel).click();

let api;
let player;
const begin = async (steps) => {
  api.getLesson.mockResolvedValue(lesson(steps));
  await player.start('demo');
};

beforeEach(() => {
  document.body.innerHTML =
    '<button id="file-menu-btn" onclick="document.getElementById(\'file-menu\').hidden=!document.getElementById(\'file-menu\').hidden">File</button><div id="file-menu" hidden><button id="file-new">New</button></div><input id="name"><select id="agent"><option>a</option></select><button id="start" type="button">Start</button>';
  api = { getLesson: vi.fn(), saveProgress: vi.fn().mockResolvedValue({}), restartLesson: vi.fn() };
  player = createLessonPlayer({ api });
});
afterEach(() => {
  player.destroy();
  vi.useRealTimers();
});

describe('lesson player', () => {
  it('starts on the welcome card, shows the avatar with its alt text and the copy escaped', async () => {
    await begin([step(0), step(1), step(2)]);
    expect(title()).toBe('Step 0');
    expect(document.querySelector('.lesson-avatar').alt).toBe('A friendly T. rex');
    expect(document.querySelector('.lesson-avatar').src).toContain('lessons/avatars/guide.webp');
    expect(document.querySelector('.lesson-body').innerHTML).toBe('Body <strong>0</strong> &lt;b&gt;raw&lt;/b&gt;');
    expect(document.querySelector('[data-lesson-next]').textContent).toBe('Start');
    expect(document.querySelector('.lesson-kicker')).toBeNull(); // the welcome is not a numbered step
  });

  it('numbers the middle steps, goes Next and Back, and labels the last Finish', async () => {
    await begin([step(0), step(1), step(2), step(3)]);
    press('[data-lesson-next]');
    expect(document.querySelector('.lesson-kicker').textContent).toBe('Step 1 of 2');
    expect(document.querySelector('[data-lesson-back]').disabled).toBe(false);
    press('[data-lesson-next]');
    expect(title()).toBe('Step 2');
    press('[data-lesson-back]');
    expect(title()).toBe('Step 1');
    press('[data-lesson-next]');
    press('[data-lesson-next]');
    expect(document.querySelector('[data-lesson-next]').textContent).toBe('Finish');
    press('[data-lesson-next]');
    expect(layer()).toBeNull();
    expect(player.active).toBe(false);
  });

  it('disables Back on the first step', async () => {
    await begin([step(0), step(1)]);
    expect(document.querySelector('[data-lesson-back]').disabled).toBe(true);
  });

  it('saves progress on every move, "completed" on the last step, and "skipped" on skip', async () => {
    await begin([step(0), step(1), step(2)]);
    expect(api.saveProgress).toHaveBeenLastCalledWith('demo', 0, 'in_progress');
    press('[data-lesson-next]');
    expect(api.saveProgress).toHaveBeenLastCalledWith('demo', 1, 'in_progress');
    press('[data-lesson-next]');
    expect(api.saveProgress).toHaveBeenLastCalledWith('demo', 2, 'completed');
    await begin([step(0), step(1)]);
    press('[data-lesson-next]');
    press('[data-lesson-skip]');
    expect(api.saveProgress).toHaveBeenLastCalledWith('demo', 1, 'skipped');
    expect(layer()).toBeNull();
  });

  it('never blocks on a failed save', async () => {
    api.saveProgress.mockRejectedValue(new Error('offline'));
    await begin([step(0), step(1)]);
    press('[data-lesson-next]');
    await settle();
    expect(title()).toBe('Step 1');
  });

  it('Escape skips the lesson and the popup underneath never sees the key', async () => {
    const seen = vi.fn();
    document.addEventListener('keydown', seen, true);
    await begin([step(0), step(1)]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(layer()).toBeNull();
    expect(api.saveProgress).toHaveBeenLastCalledWith('demo', 0, 'skipped');
    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener('keydown', seen, true);
  });

  it('spotlights the target: ring shown, card placed, dim panels leave a hole', async () => {
    await begin([step(0), step(1, { target: '#name' })]);
    press('[data-lesson-next]');
    expect(document.querySelector('.lesson-ring').hidden).toBe(false);
    expect(card().dataset.side).toBeTruthy();
    expect(document.querySelectorAll('.lesson-dim')).toHaveLength(4);
  });

  it('scrolls each target to the middle of the screen, and the spotlight follows when the popup scrolls', async () => {
    const scrolled = vi.fn();
    document.getElementById('name').scrollIntoView = scrolled;
    await begin([step(0), step(1, { target: '#name' })]);
    press('[data-lesson-next]');
    expect(scrolled).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    const before = document.querySelector('.lesson-ring').style.top;
    const spy = vi.spyOn(document.getElementById('name'), 'getBoundingClientRect').mockReturnValue({ left: 10, right: 110, top: 300, bottom: 330, width: 100, height: 30 });
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.querySelector('.lesson-ring').style.top).not.toBe(before);
    spy.mockRestore();
  });

  it('fill types the sample only into an empty field', async () => {
    await begin([step(0), step(1, { target: '#name', action: 'fill', action_arg: 'My first conversation' })]);
    press('[data-lesson-next]');
    expect(document.getElementById('name').value).toBe('My first conversation');
    player.destroy();
    document.getElementById('name').value = 'mine';
    player = createLessonPlayer({ api });
    await begin([step(0), step(1, { target: '#name', action: 'fill', action_arg: 'Sample' })]);
    press('[data-lesson-next]');
    expect(document.getElementById('name').value).toBe('mine');
  });

  it('open-select uses showPicker when it exists and carries on when it does not or it throws', async () => {
    const select = document.getElementById('agent');
    select.showPicker = vi.fn();
    await begin([step(0), step(1, { target: '#agent', action: 'open-select' })]);
    press('[data-lesson-next]');
    expect(select.showPicker).toHaveBeenCalledOnce();
    player.destroy();
    select.showPicker = vi.fn(() => {
      throw new Error('needs a gesture');
    });
    player = createLessonPlayer({ api });
    await begin([step(0), step(1, { target: '#agent', action: 'open-select' })]);
    press('[data-lesson-next]');
    expect(title()).toBe('Step 1');
    player.destroy();
    delete select.showPicker; // jsdom has none
    player = createLessonPlayer({ api });
    await begin([step(0), step(1, { target: '#agent', action: 'open-select' })]);
    press('[data-lesson-next]');
    expect(title()).toBe('Step 1');
  });

  it('open-menu opens the File menu, and Next clicks the target for the user (on_next: click)', async () => {
    const clicked = vi.fn();
    document.getElementById('file-new').onclick = clicked;
    await begin([step(0), step(1, { target: '#file-new', action: 'open-menu', on_next: 'click' }), step(2), step(3)]);
    press('[data-lesson-next]');
    expect(document.getElementById('file-menu').hidden).toBe(false);
    press('[data-lesson-next]');
    expect(clicked).toHaveBeenCalledOnce();
    expect(title()).toBe('Step 2');
    expect(document.querySelector('[data-lesson-back]').disabled).toBe(true); // the click cannot be undone
  });

  it('advances when the user clicks the target themselves', async () => {
    await begin([step(0), step(1, { target: '#file-new', on_next: 'click' }), step(2)]);
    press('[data-lesson-next]');
    document.getElementById('file-new').click();
    await settle();
    expect(title()).toBe('Step 2');
  });

  it('a press on the lesson does not reach the page (so the File menu stays open)', async () => {
    const onPage = vi.fn();
    document.addEventListener('mousedown', onPage);
    await begin([step(0)]);
    card().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onPage).not.toHaveBeenCalled();
    document.removeEventListener('mousedown', onPage);
  });

  it('waits for a target that is still opening, then spotlights it', async () => {
    await begin([step(0), step(1, { target: '#later' })]);
    press('[data-lesson-next]');
    expect(document.querySelector('.lesson-ring').hidden).toBe(true); // centred, dimmed, until it appears
    document.body.insertAdjacentHTML('beforeend', '<input id="later">');
    await settle();
    expect(document.querySelector('.lesson-ring').hidden).toBe(false);
  });

  it('a target that never appears falls back to a centred card that says so', async () => {
    vi.useFakeTimers();
    await begin([step(0), step(1, { target: '#nope' }), step(2)]);
    press('[data-lesson-next]');
    vi.advanceTimersByTime(2100);
    expect(document.querySelector('.lesson-missing').hidden).toBe(false);
    press('[data-lesson-next]'); // the user is never trapped
    expect(title()).toBe('Step 2');
  });

  it('on_target_gone next: moves on after the form was submitted and the popup went away', async () => {
    document.body.insertAdjacentHTML('beforeend', '<form id="f"><button id="go" type="submit">Go</button></form>');
    document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());
    await begin([step(0), step(1, { target: '#go', on_target_gone: 'next' }), step(2)]);
    press('[data-lesson-next]');
    document.getElementById('f').requestSubmit();
    document.getElementById('f').remove();
    await settle();
    expect(title()).toBe('Step 2');
  });

  it('pauses (no jump to the end) when the popup is closed without submitting', async () => {
    document.body.insertAdjacentHTML('beforeend', '<form id="f"><button id="go" type="submit">Go</button></form>');
    await begin([step(0), step(1, { target: '#go', on_target_gone: 'next' }), step(2)]);
    press('[data-lesson-next]');
    document.getElementById('f').remove();
    await settle();
    expect(layer()).toBeNull();
    expect(document.querySelector('.toast').textContent).toMatch(/paused/i);
    expect(api.saveProgress).not.toHaveBeenCalledWith('demo', 2, 'completed');
  });

  it('keeps Tab on the card buttons', async () => {
    await begin([step(0), step(1)]);
    const buttons = [...document.querySelectorAll('.lesson-card button')].filter((b) => !b.disabled);
    buttons.at(-1).focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('starting a lesson that cannot load rejects and shows nothing', async () => {
    api.getLesson.mockRejectedValue(new Error('gone'));
    await expect(player.start('demo')).rejects.toThrow('gone');
    expect(layer()).toBeNull();
  });
});
