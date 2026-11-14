import { esc } from '../../shared/html.js';
import { showModal } from '../../shared/modal-ui.js';
import { toastError } from '../../shared/toast.js';
import { listLessons } from './lessons-api.js';
import './lessons.css';

const STATUS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', skipped: 'Skipped' };

/** The lessons that exist for a page, and whether the user has finished any (the "Take the tour" button only shows if none). */
export async function tourLesson(page) {
  try {
    const lessons = await listLessons(page);
    if (!lessons.length || lessons.some((l) => l.progress.status === 'completed')) return null;
    return lessons[0];
  } catch {
    return null; // the tour is an extra: the page works without it
  }
}

/** The first lesson for a page (shown or not, finished or not), or null when it has none or the list cannot be loaded. */
export async function firstLesson(page) {
  try {
    return (await listLessons(page))[0] ?? null;
  } catch {
    return null;
  }
}

/** File > Lessons: the lessons for this page. Choosing one closes the popup and starts it. */
export async function openLessonsList(page, player) {
  let lessons;
  try {
    lessons = await listLessons(page);
  } catch (err) {
    toastError(err);
    return;
  }
  const items = lessons.length
    ? `<ul class="lesson-list">${lessons
        .map(
          (l) =>
            `<li><div class="lesson-list-text"><h3>${esc(l.title)}</h3><p>${esc(l.summary)}</p></div><span class="lesson-status">${STATUS[l.progress.status]}</span><button type="button" class="btn yellow" data-lesson="${esc(l.slug)}">${l.progress.status === 'completed' ? 'Redo' : 'Start'}</button></li>`,
        )
        .join('')}</ul>`
    : '<p class="modal-text">There are no lessons for this page yet.</p>';
  showModal({
    title: 'Lessons',
    submitLabel: 'Close',
    cancelLabel: null,
    bodyHTML: `<p class="modal-text">Short walk-throughs that show you around, using the real page.</p>${items}`,
    onMount(form, handle) {
      form.querySelectorAll('[data-lesson]').forEach((b) => {
        b.onclick = () => {
          handle.close();
          player.start(b.dataset.lesson).catch(toastError);
        };
      });
    },
  });
}
