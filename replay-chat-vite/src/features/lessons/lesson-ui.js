import { esc } from '../../shared/html.js';
import './lessons.css';

/** Lesson copy is plain text; only **double stars** make bold. Everything else is escaped. */
export const lessonText = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const PAD = 8; // space between the spotlight and the control
const GAP = 14; // space between the spotlight and the card
const MARGIN = 16; // space between the card and the screen edge

const base = () => import.meta.env?.BASE_URL ?? '/';
export const avatarSrc = (file) => `${base()}lessons/avatars/${file}`;

/**
 * The lesson layer: four dim panels around the spotlighted control (so the control itself stays clickable), a ring, and the
 * card. `numbered` is how many steps are counted ("Step 3 of 10"); the first and last steps are the welcome and the finish.
 */
export function createLayer(lesson, step, { index, last, canGoBack, waiting = false }) {
  const layer = document.createElement('div');
  layer.className = 'lesson-layer';
  const numbered = last - 1;
  const kicker = index > 0 && index < last ? `<p class="lesson-kicker">Step ${index} of ${numbered}</p>` : '';
  const nextLabel = waiting ? 'Waiting…' : index === 0 ? 'Start' : index === last ? 'Finish' : 'Next';
  layer.innerHTML =
    '<div class="lesson-dim" data-dim="top"></div><div class="lesson-dim" data-dim="left"></div><div class="lesson-dim" data-dim="right"></div><div class="lesson-dim" data-dim="bottom"></div>' +
    '<div class="lesson-ring" hidden></div>' +
    `<section class="lesson-card" role="dialog" aria-label="${esc(lesson.title)} lesson" tabindex="-1">` +
    `<img class="lesson-avatar" src="${esc(avatarSrc(step.avatar.file))}" alt="${esc(step.avatar.alt)}" data-facing="${esc(step.avatar.facing)}">` +
    `<div class="lesson-text">${kicker}<h3 class="lesson-title">${esc(step.title)}</h3><p class="lesson-body" aria-live="polite">${lessonText(step.body)}</p>` +
    '<p class="lesson-missing" hidden>I can\'t find this on the page right now, but you can keep going.</p></div>' +
    `<div class="lesson-foot"><button type="button" class="btn lesson-skip" data-lesson-skip>Skip lesson</button><span class="lesson-spacer"></span>` +
    `<button type="button" class="btn" data-lesson-back ${canGoBack ? '' : 'disabled'}>Back</button>` +
    `<button type="button" class="btn yellow" data-lesson-next ${waiting ? 'disabled' : ''}>${nextLabel}</button></div></section>`;
  return layer;
}

const px = (n) => `${Math.round(n)}px`;

/** Put the dim panels, ring and card where the target is. `rect` null: dim everything, card in the middle. */
export function placeLayer(layer, rect, placement = 'auto') {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dims = Object.fromEntries([...layer.querySelectorAll('[data-dim]')].map((d) => [d.dataset.dim, d]));
  const ring = layer.querySelector('.lesson-ring');
  const card = layer.querySelector('.lesson-card');
  const set = (el, left, top, width, height) => {
    el.style.left = px(left);
    el.style.top = px(top);
    el.style.width = px(Math.max(0, width));
    el.style.height = px(Math.max(0, height));
  };
  if (!rect) {
    set(dims.top, 0, 0, vw, vh);
    for (const k of ['left', 'right', 'bottom']) set(dims[k], 0, 0, 0, 0);
    ring.hidden = true;
    card.style.left = px(Math.max(MARGIN, (vw - card.offsetWidth) / 2));
    card.style.top = px(Math.max(MARGIN, (vh - card.offsetHeight) / 2));
    return;
  }
  const hole = { left: rect.left - PAD, top: rect.top - PAD, right: rect.right + PAD, bottom: rect.bottom + PAD };
  set(dims.top, 0, 0, vw, hole.top);
  set(dims.bottom, 0, hole.bottom, vw, vh - hole.bottom);
  set(dims.left, 0, hole.top, hole.left, hole.bottom - hole.top);
  set(dims.right, hole.right, hole.top, vw - hole.right, hole.bottom - hole.top);
  ring.hidden = false;
  set(ring, hole.left, hole.top, hole.right - hole.left, hole.bottom - hole.top);

  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const fits = {
    top: hole.top - GAP - h >= MARGIN,
    bottom: hole.bottom + GAP + h <= vh - MARGIN,
    right: hole.right + GAP + w <= vw - MARGIN,
    left: hole.left - GAP - w >= MARGIN,
  };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const first = placement === 'auto' ? 'bottom' : placement;
  const side = [first, opposite[first], 'bottom', 'top', 'right', 'left'].find((s) => fits[s]) ?? null;
  const clamp = (v, max) => Math.min(Math.max(MARGIN, v), Math.max(MARGIN, max));
  let left;
  let top;
  if (side === 'top' || side === 'bottom') {
    left = clamp(hole.left, vw - w - MARGIN);
    top = side === 'top' ? hole.top - GAP - h : hole.bottom + GAP;
  } else if (side === 'left' || side === 'right') {
    left = side === 'right' ? hole.right + GAP : hole.left - GAP - w;
    top = clamp(hole.top, vh - h - MARGIN);
  } else {
    left = clamp((vw - w) / 2, vw - w - MARGIN); // nowhere beside it: over the bottom of the screen
    top = clamp(vh - h - MARGIN, vh - h - MARGIN);
  }
  card.style.left = px(left);
  card.style.top = px(top);
  card.dataset.side = side ?? 'over';
}
