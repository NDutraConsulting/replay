import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, settle } from '../../test/mock-api.js';
import { safeNext, validateCredentials } from './login-api.js';

const $ = (id) => document.getElementById(id);

async function boot({ user = null, search = '', tourSeen = null } = {}) {
  vi.resetModules();
  history.replaceState({}, '', '/login.html' + search);
  const go = vi.fn();
  const mock = mockApi({
    'GET /api/me': () => user ?? apiError(401, 'not_logged_in', 'Not logged in.'),
    ...(tourSeen === null ? {} : { 'GET /api/preferences': () => ({ api_tour_seen: tourSeen }) }),
    'POST /api/account/login': ({ body }) =>
      body.password === 'right-password' ? { user_id: 'u1', username: body.username } : apiError(401, 'invalid_credentials', 'Invalid username or password.'),
    'POST /api/account/signup': ({ body }) =>
      body.username === 'taken' ? apiError(409, 'username_taken', 'Username already taken.') : { user_id: 'u2', username: body.username },
  });
  const { initLogin } = await import('./login-controller.js');
  await initLogin({ go });
  return { go, mock };
}
const fill = (username, password) => {
  $('login-username').value = username;
  $('login-password').value = password;
  $('login-form').requestSubmit();
};

describe('login page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the form and logs in, then goes to the home page', async () => {
    const { go, mock } = await boot();
    expect($('login-title').textContent).toBe('Log in');
    fill('demo', 'right-password');
    await settle();
    expect(mock.lastBody('POST /api/account/login')).toEqual({ username: 'demo', password: 'right-password' });
    expect(go).toHaveBeenCalledWith('/');
  });

  it('sends a first login to the Account page, where the API setup tour starts', async () => {
    const { go } = await boot({ tourSeen: false });
    fill('demo', 'right-password');
    await settle();
    expect(go).toHaveBeenCalledWith('/account.html');
  });

  it('does not redirect once the tour was seen, and keeps an explicit ?next=', async () => {
    const seen = await boot({ tourSeen: true });
    fill('demo', 'right-password');
    await settle();
    expect(seen.go).toHaveBeenCalledWith('/');
    document.body.innerHTML = '';
    const deep = await boot({ tourSeen: false, search: '?next=/replay.html' });
    fill('demo', 'right-password');
    await settle();
    expect(deep.go).toHaveBeenCalledWith('/replay.html');
  });

  it('shows the server message for wrong credentials and lets the user retry', async () => {
    const { go } = await boot();
    fill('demo', 'wrong');
    await settle();
    expect($('login-error').textContent).toBe('Invalid username or password.');
    expect(document.querySelector('.login-submit').disabled).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it('checks for empty fields before calling the server', async () => {
    const { mock } = await boot();
    fill('', '');
    expect($('login-error').textContent).toBe('Enter your username.');
    fill('demo', '');
    expect($('login-error').textContent).toBe('Enter your password.');
    expect(mock.called('POST /api/account/login')).toBe(false);
  });

  it('returns to the page the user was sent from, but only a same-site path', async () => {
    const { go } = await boot({ search: '?next=%2Freplay.html%3Ftab%3Ddiff' });
    fill('demo', 'right-password');
    await settle();
    expect(go).toHaveBeenCalledWith('/replay.html?tab=diff');
    const evil = await boot({ search: '?next=%2F%2Fevil.example%2Fx' });
    fill('demo', 'right-password');
    await settle();
    expect(evil.go).toHaveBeenCalledWith('/');
  });

  it('skips the form when already logged in', async () => {
    const { go } = await boot({ user: { user_id: 'u1', username: 'demo' }, search: '?next=%2Fagents.html' });
    expect(go).toHaveBeenCalledWith('/agents.html');
    expect($('login-form')).toBeNull();
  });

  it('switches to sign up, validates, and creates the account', async () => {
    const { go, mock } = await boot();
    $('login-username').value = 'newuser';
    $('switch-mode').click();
    expect($('login-title').textContent).toBe('Create your account');
    expect($('login-username').value).toBe('newuser');
    fill('newuser', 'short');
    expect($('login-error').textContent).toMatch(/at least 8 characters/);
    fill('x!', 'long-enough-pw');
    expect($('login-error').textContent).toMatch(/3 to 40/);
    expect(mock.called('POST /api/account/signup')).toBe(false);
    fill('newuser', 'long-enough-pw');
    await settle();
    expect(go).toHaveBeenCalledWith('/');
    expect(mock.lastBody('POST /api/account/signup')).toEqual({ username: 'newuser', password: 'long-enough-pw' });
  });

  it('shows a taken username', async () => {
    await boot();
    $('switch-mode').click();
    fill('taken', 'long-enough-pw');
    await settle();
    expect($('login-error').textContent).toBe('Username already taken.');
  });
});

describe('login helpers', () => {
  it.each([
    ['', '/'],
    ['?next=/replay.html', '/replay.html'],
    ['?next=%2F%2Fevil.example', '/'],
    ['?next=https%3A%2F%2Fevil.example', '/'],
    ['?next=%2F%5Cevil.example', '/'],
    ['?next=javascript%3Aalert(1)', '/'],
  ])('safeNext(%s) -> %s', (search, expected) => {
    expect(safeNext(search)).toBe(expected);
  });

  it('validates sign-up credentials', () => {
    expect(validateCredentials('abc', 'long-enough-pw', { signup: true })).toBe('');
    expect(validateCredentials('ab', 'long-enough-pw', { signup: true })).toMatch(/3 to 40/);
    expect(validateCredentials('abc', 'short', { signup: true })).toMatch(/8 characters/);
    expect(validateCredentials('a', 'x', { signup: false })).toBe('');
  });
});
