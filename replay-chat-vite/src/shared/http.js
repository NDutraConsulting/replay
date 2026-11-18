/**
 * The one place that talks to the backend. Every -api.js module goes through `api` (or `request`).
 * Errors are normalized to ApiError { status, code, message }; `message` is user-facing text.
 */

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    /** Machine-readable facts the server sent with the error (for example how many records used a file). */
    this.details = details;
  }
}

const BASE = import.meta.env?.VITE_API_BASE_URL ?? '';

export function redirectToLogin() {
  if (/^\/login(\.html)?$/.test(location.pathname)) return;
  location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

let onUnauthorized = redirectToLogin;
/** Tests replace this so a 401 does not navigate jsdom. */
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/**
 * @param {string} method
 * @param {string} path  e.g. '/api/settings'
 * @param {{body?: unknown, formData?: FormData, signal?: AbortSignal}} [options]
 * @returns the parsed JSON body (null for 204)
 * @throws {ApiError} for HTTP errors and network failures; AbortError is rethrown untouched
 */
export async function request(method, path, { body, formData, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal };
  if (formData) {
    init.body = formData; // the browser sets the multipart boundary
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and that the backend is running.');
  }
  if (response.status === 204) return null;

  let data = null;
  try {
    data = await response.json();
  } catch {
    // non-JSON body (proxy error page, etc.)
  }
  if (!response.ok) {
    const failure = data?.error;
    const error = new ApiError(
      response.status,
      failure?.code || 'http_error',
      failure?.message || `The server returned HTTP ${response.status}.`,
      failure?.details ?? null,
    );
    if (response.status === 401 && (error.code === 'not_logged_in' || error.code === 'session_expired')) onUnauthorized();
    throw error;
  }
  return data;
}

/**
 * A fresh id for one request, so a stop command can name it even if the stop reaches the server first.
 * Only letters, digits, "-" and "_" (what the backend accepts), 8 to 64 characters.
 */
export const newRequestId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  delete: (path, options) => request('DELETE', path, options),
};
