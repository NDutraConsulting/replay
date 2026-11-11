import { api } from '../../shared/http.js';

/** The logged-in user, or null. (On the login page a 401 does not redirect.) */
export async function currentUser() {
  try {
    return await api.get('/api/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export const login = (username, password) => api.post('/api/account/login', { username, password });
export const signup = (username, password) => api.post('/api/account/signup', { username, password });

/** Where to go after logging in: a same-site path from ?next=, otherwise the home page. */
export function safeNext(search) {
  const next = new URLSearchParams(search).get('next') || '/';
  return /^\/(?![/\\])/.test(next) && !next.includes('\\') ? next : '/';
}

/** Client-side checks that give friendlier messages than the server's field errors. */
export function validateCredentials(username, password, { signup: isSignup }) {
  username = username.trim();
  if (!username) return 'Enter your username.';
  if (!password) return 'Enter your password.';
  if (isSignup) {
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
      return 'Choose a username of 3 to 40 letters, numbers, dots, dashes or underscores.';
    }
    if (password.length < 8) return 'Choose a password of at least 8 characters.';
  }
  return '';
}
