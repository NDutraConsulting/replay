import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, noContent } from '../test/mock-api.js';
import { api, ApiError, request, setUnauthorizedHandler } from './http.js';

describe('http client', () => {
  const unauthorized = vi.fn();
  beforeEach(() => {
    unauthorized.mockClear();
    setUnauthorizedHandler(unauthorized);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends JSON with the session cookie and returns the parsed body', async () => {
    const mock = mockApi({ 'POST /api/things': ({ body }) => ({ echoed: body }) });
    expect(await api.post('/api/things', { a: 1 })).toEqual({ echoed: { a: 1 } });
    const [, init] = fetch.mock.calls[0];
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(mock.calls[0].body).toEqual({ a: 1 });
  });

  it('does not send a content type or body for GET and DELETE', async () => {
    mockApi({ 'GET /api/x': { ok: true }, 'DELETE /api/x': noContent });
    await api.get('/api/x');
    await api.delete('/api/x');
    for (const [, init] of fetch.mock.calls) {
      expect(init.body).toBeUndefined();
      expect(init.headers['Content-Type']).toBeUndefined();
    }
  });

  it('returns null for 204', async () => {
    mockApi({ 'DELETE /api/x': noContent });
    expect(await api.delete('/api/x')).toBeNull();
  });

  it('sends multipart bodies untouched so the browser sets the boundary', async () => {
    const mock = mockApi({ 'POST /api/upload': () => ({ ok: true }) });
    const form = new FormData();
    form.append('files', new File(['x'], 'a.txt'));
    await request('POST', '/api/upload', { formData: form });
    expect(fetch.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
    expect(mock.calls[0].formData).toBe(form);
  });

  it('turns the error envelope into an ApiError with status, code and message', async () => {
    mockApi({ 'GET /api/x': apiError(409, 'duplicate_name', 'A category named "X" already exists.') });
    const error = await api.get('/api/x').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 409,
      code: 'duplicate_name',
      message: 'A category named "X" already exists.',
    });
  });

  it('gives a generic message for a non-JSON error (for example a proxy error page)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await api.get('/api/x').catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.code).toBe('http_error');
    expect(error.message).toBe('The server returned HTTP 502.');
  });

  it('reports an unreachable server in plain words', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await api.get('/api/x').catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: 'network' });
    expect(error.message).toMatch(/Could not reach the server/);
  });

  it('rethrows an aborted request untouched', async () => {
    mockApi({ 'GET /api/x': () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = api.get('/api/x', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('goes to the login page when the session is missing or expired, but not for wrong credentials', async () => {
    mockApi({
      'GET /api/a': apiError(401, 'not_logged_in', 'Not logged in.'),
      'GET /api/b': apiError(401, 'session_expired', 'Session expired or invalid.'),
      'POST /api/account/login': apiError(401, 'invalid_credentials', 'Invalid username or password.'),
    });
    await api.get('/api/a').catch(() => {});
    await api.get('/api/b').catch(() => {});
    expect(unauthorized).toHaveBeenCalledTimes(2);
    const error = await api.post('/api/account/login', {}).catch((e) => e);
    expect(error.code).toBe('invalid_credentials');
    expect(unauthorized).toHaveBeenCalledTimes(2);
  });
});

describe('app bootstrap and preferences', () => {
  it('loads user, agents, settings and preferences together, in UI shapes', async () => {
    const { appRoutes } = await import('../test/mock-api.js');
    const { loadApp, resolveAgent, resolveModel, savePreferences } = await import('./app-api.js');
    const { state, routes } = appRoutes({
      settings: {
        models: ['Fast::m1', 'Fast::m2'], connected: true,
        connections: [{ connection_id: 'c1', label: 'Fast', url: 'https://x.test/v1', models: ['m1', 'm2'], api_key_set: true, connected: true, source: 'account', read_only: false }],
      },
    }); // fmt: skip
    const mock = mockApi(routes);
    const app = await loadApp();
    expect(app.user.username).toBe('demo');
    expect(app.agents.map((a) => a.id)).toEqual(['assistant', 'code', 'research']);
    expect(app.settings).toEqual({
      models: ['Fast::m1', 'Fast::m2'], connected: true,
      connections: [{ id: 'c1', label: 'Fast', url: 'https://x.test/v1', models: ['m1', 'm2'], apiKeySet: true, connected: true, source: 'account', readOnly: false }],
    }); // fmt: skip
    expect(app.preferences).toEqual({ agentId: 'assistant', model: null, chatSidebarHidden: false, replayPromptsHidden: true, showCompactButton: false, showRewindButton: true });

    const saved = await savePreferences({ agentId: 'code', replayPromptsHidden: false });
    expect(mock.lastBody('PUT /api/preferences')).toEqual({ agent_id: 'code', replay_prompts_hidden: false });
    expect(saved.agentId).toBe('code');
    expect(state.preferences.agent_id).toBe('code');
    await savePreferences({ showCompactButton: true, showRewindButton: false });
    expect(mock.lastBody('PUT /api/preferences')).toEqual({ show_compact_button: true, show_rewind_button: false });
    expect(state.preferences).toMatchObject({ show_compact_button: true, show_rewind_button: false });

    expect(resolveModel(['m1', 'm2'], 'm2')).toBe('m2');
    expect(resolveModel(['m1', 'm2'], 'gone')).toBe('m1');
    expect(resolveAgent(app.agents, 'research')).toBe('research');
    expect(resolveAgent(app.agents, 'gone')).toBe('assistant');
  });
});

describe('request ids', () => {
  it('are accepted by the backend format and unique', async () => {
    const { newRequestId } = await import('./http.js');
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('fall back to a random id when crypto.randomUUID is missing', async () => {
    const { newRequestId } = await import('./http.js');
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      expect(newRequestId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
