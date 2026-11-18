import { vi } from 'vitest';

/** A route handler's way to answer with a non-200 status. */
export const reply = (status, body) => ({ __status: status, body });
export const apiError = (status, code, message) => reply(status, { error: { code, message } });
export const created = (body) => reply(201, body);
export const noContent = () => reply(204, null);

/**
 * Replaces globalThis.fetch with an in-memory fake of the backend.
 *
 * routes: { 'METHOD /api/path/:param': handler | value }
 *   handler({ params, query, body, formData, signal, method, path }) may return a value (200), reply(status, body),
 *   or a promise. A pending handler rejects with AbortError if the request's signal aborts.
 * Unmatched requests fail the test loudly. Returns { calls, count(key), lastBody(key) } for assertions.
 */
export function mockApi(routes) {
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const source = pattern.replace(/\/:([a-z_]+)/gi, (_, name) => (names.push(name), '/([^/]+)'));  // only "/:name" is a parameter ("documents:upload" is literal)
    return { key, method, names, regex: new RegExp(`^${source}$`), handler };
  });
  const calls = [];

  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost');
    const method = (init.method || 'GET').toUpperCase();
    const path = parsed.pathname;
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const route = table.find((r) => r.method === method && r.regex.test(path));
    let body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const call = { method, path, key: route?.key, body, formData: init.body instanceof FormData ? init.body : undefined };
    calls.push(call);
    if (!route) throw new Error(`mockApi: no route for ${method} ${path}`);

    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(path.match(route.regex)[i + 1])]));
    const query = Object.fromEntries(parsed.searchParams);
    const run = typeof route.handler === 'function' ? route.handler({ params, query, body, formData: call.formData, signal, method, path }) : route.handler;
    const aborted = new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    const result = await Promise.race([Promise.resolve(run), aborted]);

    const status = result?.__status ?? 200;
    const payload = result?.__status ? result.body : result;
    return new Response(status === 204 ? null : JSON.stringify(payload ?? null), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return {
    calls,
    count: (key) => calls.filter((c) => c.key === key).length,
    lastBody: (key) => calls.filter((c) => c.key === key).at(-1)?.body,
    called: (key) => calls.some((c) => c.key === key),
  };
}

/** The four requests every page makes first (user, agents, settings, preferences), with mutable state. */
export function appRoutes(overrides = {}) {
  const state = {
    user: { user_id: 'u1', username: 'demo' },
    agents: [
      { id: 'assistant', name: 'General assistant' },
      { id: 'code', name: 'Code assistant' },
      { id: 'research', name: 'IT Security Assistant' },
    ],
    settings: { models: ['model-a', 'model-b', 'model-c'], connected: false, connections: [] },
    lessons: [],
    preferences: { agent_id: 'assistant', model: null, chat_sidebar_hidden: false, replay_prompts_hidden: true, show_compact_button: false, show_rewind_button: true, api_tour_seen: true, show_page_popups: true },
    ...overrides,
  };
  const routes = {
    'GET /api/me': () => state.user,
    'GET /api/agents': () => state.agents,
    'GET /api/settings': () => state.settings,
    'GET /api/preferences': () => state.preferences,
    'GET /api/lessons': () => state.lessons,
    'GET /api/lessons/:slug': ({ params }) => state.lessonDetails?.[params.slug],
    'PUT /api/lessons/:slug/progress': ({ body }) => ({ status: body.status, current_step: body.step }),
    'PUT /api/preferences': ({ body }) => Object.assign(state.preferences, body),
    'POST /api/account/logout': () => ({ status: 'logged_out' }),
  };
  return { state, routes };
}

/** Let pending promises, timers-at-0 and renders settle. */
export const settle = async (ms = 0) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
};
