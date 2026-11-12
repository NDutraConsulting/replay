import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, settle } from '../test/mock-api.js';

vi.mock('./http.js', async (importOriginal) => ({ ...(await importOriginal()), redirectToLogin: vi.fn() }));

const { redirectToLogin } = await import('./http.js');
const { mountShell, showFatal, showLoading, shellHTML } = await import('./shell-ui.js');

describe('shell', () => {
  beforeEach(() => {
    redirectToLogin.mockClear();
  });

  it('shows who is logged in and says conversations are saved to the account', () => {
    mountShell('chat', { user_id: 'u1', username: 'nikko' });
    expect(document.querySelector('.drawer-username').textContent).toBe('nikko');
    expect(document.querySelector('.avatar').textContent).toBe('NI');
    expect(document.body.innerHTML).not.toMatch(/stay in this browser/);
  });

  it('drops the brand text for the pages with a File menu, and gives them its slot beside the logo', () => {
    for (const page of ['chat', 'replay', 'agents']) {
      document.body.innerHTML = shellHTML(page, null);
      expect(document.querySelector('.brand').textContent).toBe('');
      expect(document.querySelector('.brand').getAttribute('aria-label')).toBe('Replay Chat');
      expect(document.querySelector('.brand img')).not.toBeNull(); // the logo stays
      expect(document.querySelector('.brand + #topbar-file')).not.toBeNull();
    }
  });

  it('keeps the brand text, and has no File menu slot, on Account', () => {
    document.body.innerHTML = shellHTML('account', null);
    expect(document.querySelector('.brand').textContent).toBe('Replay Chat');
    expect(document.getElementById('topbar-file')).toBeNull();
  });

  it('escapes the username', () => {
    const html = shellHTML('chat', { username: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('logs out through the API and then goes to the login page', async () => {
    const mock = mockApi({ 'POST /api/account/logout': { status: 'logged_out' } });
    mountShell('chat', { user_id: 'u1', username: 'nikko' });
    document.getElementById('logout').click();
    await settle();
    expect(mock.called('POST /api/account/logout')).toBe(true);
    expect(redirectToLogin).toHaveBeenCalled();
  });

  it('stays put and says why when logging out fails', async () => {
    mockApi({ 'POST /api/account/logout': apiError(500, 'oops', 'Server error.') });
    mountShell('chat', { user_id: 'u1', username: 'nikko' });
    document.getElementById('logout').click();
    await settle();
    expect(redirectToLogin).not.toHaveBeenCalled();
    expect(document.querySelector('.toast').textContent).toBe('Server error.');
  });

  it('renders loading and fatal states', () => {
    const main = mountShell('chat', null);
    showLoading(main);
    expect(main.textContent).toContain('Loading');
    const retry = vi.fn();
    showFatal(main, new Error('Could not reach the server.'), retry);
    expect(main.querySelector('[role="alert"]').textContent).toContain('Could not reach the server.');
    document.getElementById('retry-load').click();
    expect(retry).toHaveBeenCalled();
  });
});
