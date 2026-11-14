import { api } from '../../shared/http.js';

/** The lessons for a page ("chat"), each with the user's progress: { slug, page, title, summary, step_count, progress: { status, current_step } }. */
export const listLessons = (page) => api.get('/api/lessons').then((all) => (page ? all.filter((l) => l.page === page) : all));

/** One lesson with its steps (title, body, target selector, action, placement, avatar) and the user's progress. */
export const getLesson = (slug) => api.get(`/api/lessons/${encodeURIComponent(slug)}`);

/** Remember where the user is. status: 'in_progress' | 'completed' | 'skipped'. */
export const saveProgress = (slug, step, status = 'in_progress') =>
  api.put(`/api/lessons/${encodeURIComponent(slug)}/progress`, { step, status });

export const restartLesson = (slug) => api.post(`/api/lessons/${encodeURIComponent(slug)}/restart`);
