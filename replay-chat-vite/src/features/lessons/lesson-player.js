import { toast, toastError } from '../../shared/toast.js';
import * as defaultApi from './lessons-api.js';
import { createLayer, placeLayer } from './lesson-ui.js';

const FIND_TIMEOUT_MS = 4000; // the Diff loads its replays from the server after the tab opens

/**
 * Plays a lesson on the live page: a dim layer with a spotlight on the step's target, and a card with the avatar, the
 * words and Back / Next / Skip. Steps come from lessons.db (see backend/db/lesson_seeds); `action` is a fixed vocabulary
 * handled here, never code from the data. Progress is saved on every move and a failed save never blocks the lesson.
 * Escape skips the lesson. A lesson always starts from its first step.
 */
export function createLessonPlayer({ api = defaultApi } = {}) {
  let lesson = null;
  let index = 0;
  let layer = null;
  let target = null;
  let token = 0; // bumped on every step, so a late timer or observer from an earlier step does nothing
  let submitted = false; // a form was submitted during this step (the Start conversation click)
  let cleanups = [];

  const last = () => lesson.steps.at(-1).position;
  const step = () => lesson.steps[index];
  const listen = (el, type, fn, opts) => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };

  function teardownStep() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    target = null;
  }

  function removeLayer() {
    cancelAnimationFrame(frame);
    teardownStep();
    token += 1;
    layer?.remove();
    layer = null;
    lesson = null;
  }

  const save = (position, status) => {
    api.saveProgress(lesson.slug, position, status).catch(toastError);
  };

  function runAction(s, el) {
    if (s.action === 'open-menu') {
      if (document.getElementById('file-menu')?.hidden) document.getElementById('file-menu-btn')?.click();
    } else if (s.action === 'open-select') {
      try {
        el.showPicker?.(); // needs a user gesture: the Next click is one. Where it is missing the card tells the user to open it.
      } catch {
        /* the picker could not open: the highlighted field is still there to click */
      }
    } else if (s.action === 'check-radio') {
      const radio = s.action_arg ? el.querySelector(s.action_arg) : null; // pick the lesson's own sample in a list of radios
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (s.action === 'open-details') {
      if (el.tagName === 'DETAILS') el.open = true;
    } else if (s.action === 'fill') {
      if (el.value === '' && s.action_arg) {
        el.value = s.action_arg;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  /** Bring the target to the middle of whatever scrolls it (the popup, or the page) so the spotlight and card stay on screen. */
  const scrollToTarget = (el) => el.scrollIntoView?.({ block: 'center', inline: 'nearest' });

  let frame = 0;
  function reposition() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!layer || typeof document === 'undefined') return; // the lesson ended, or the page is gone
      placeLayer(layer, target?.isConnected ? target.getBoundingClientRect() : null, step().placement);
    });
  }

  function targetGone() {
    const s = step();
    if (s.on_target_gone === 'next' && submitted) show(index + 1);
    else {
      removeLayer();
      toast('Lesson paused. Start it again from File > Lessons.');
    }
  }

  function ready(s, el, missing) {
    target = el;
    if (el) {
      if (s.action !== 'open-menu') scrollToTarget(el); // before a dropdown opens, so its list opens where the field now is
      runAction(s, el);
      scrollToTarget(el);
    }
    layer.querySelector('.lesson-missing').hidden = !missing;
    placeLayer(layer, el ? el.getBoundingClientRect() : null, s.placement);
    layer.querySelector('[data-lesson-next]').focus();
    const my = token;
    if (!el && !s.advance_on) return;
    // The page redraws whole regions (the Replay page rebuilds its main area on every change), so the target is looked up
    // again by its selector each time something changes rather than held as one element that may have been replaced.
    const check = (records) => {
      if (my !== token || !lesson) return;
      if (records?.every((r) => layer?.contains(r.target))) return; // the lesson's own moves must not trigger another move
      if (s.advance_on && document.querySelector(s.advance_on)) {
        show(index + 1); // what the step was waiting for has appeared (for example the "replay complete" popup)
        return;
      }
      if (!el) return;
      const current = document.querySelector(s.target);
      if (!current) targetGone();
      else {
        target = current;
        reposition();
      }
    };
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true });
    cleanups.push(() => watch.disconnect());
    check();
    if (my !== token || !el) return;
    listen(window, 'resize', reposition);
    listen(window, 'scroll', reposition, true);
    listen(document, 'submit', () => (submitted = true), true);
    if (s.on_next === 'click') {
      listen(
        document,
        'click',
        (e) => {
          if (!e.target.closest?.(s.target)) return;
          setTimeout(() => {
            if (my === token && lesson) show(index + 1); // the user clicked it themselves
          });
        },
        true,
      );
    }
  }

  function show(i) {
    teardownStep();
    token += 1;
    const my = token;
    submitted = false;
    index = i;
    const s = step();
    layer?.remove();
    layer = createLayer(lesson, s, { index: i, last: last(), waiting: Boolean(s.advance_on), canGoBack: i > 0 && lesson.steps[i - 1].on_next !== 'click' });
    layer.onmousedown = (e) => e.stopPropagation(); // a press on the lesson must not close the File menu or the popup under it
    document.body.append(layer);
    layer.querySelector('[data-lesson-next]').onclick = next;
    layer.querySelector('[data-lesson-back]').onclick = back;
    layer.querySelector('[data-lesson-skip]').onclick = skip;
    save(s.position, s.position === last() ? 'completed' : 'in_progress');
    if (!s.target) return ready(s, null, false);
    const found = document.querySelector(s.target);
    if (found) return ready(s, found, false);
    // not on the page yet (the popup is still opening): wait a moment, then carry on without a spotlight
    const watch = new MutationObserver(() => {
      const el = document.querySelector(s.target);
      if (el && my === token) {
        watch.disconnect();
        ready(s, el, false);
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      watch.disconnect();
      if (my === token) ready(s, null, true);
    }, FIND_TIMEOUT_MS);
    cleanups.push(() => {
      watch.disconnect();
      clearTimeout(timer);
    });
    // until it appears the card sits in the middle of a dimmed page
    placeLayer(layer, null);
    return undefined;
  }

  function next() {
    if (!lesson) return;
    if (index >= last()) {
      removeLayer(); // Finish: the last step already saved "completed"
      return;
    }
    if (step().on_next === 'click' && target?.isConnected) target.click();
    show(index + 1);
  }

  function back() {
    if (lesson && index > 0) show(index - 1);
  }

  function skip() {
    if (!lesson) return;
    save(index, 'skipped');
    removeLayer();
  }

  /** Escape skips the lesson (before the popup under it sees the key); Tab stays on the card's buttons. */
  function onKey(e) {
    if (!lesson || !layer) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      skip();
    } else if (e.key === 'Tab' && layer.contains(document.activeElement)) {
      const items = [...layer.querySelectorAll('button')].filter((b) => !b.disabled);
      const at = items.indexOf(document.activeElement);
      const to = (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      e.preventDefault();
      e.stopPropagation();
      items[to].focus();
    }
  }
  window.addEventListener('keydown', onKey, true);

  return {
    /** Load a lesson and start it from the first step. Rejects with the API error when the lesson cannot be loaded. */
    async start(slug) {
      const loaded = await api.getLesson(slug);
      removeLayer();
      lesson = loaded;
      show(0);
    },
    next,
    back,
    skip,
    get active() {
      return lesson !== null;
    },
    get stepPosition() {
      return lesson ? step().position : null;
    },
    /** Stop listening for keys (tests, and a page that is going away). */
    destroy() {
      removeLayer();
      window.removeEventListener('keydown', onKey, true);
    },
  };
}
