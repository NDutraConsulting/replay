import { describe, expect, it } from 'vitest';
import { cleanUrl, PAGES } from '../build/clean-urls.js';

describe('clean URLs', () => {
  it('serves each page from its .html file without changing the address', () => {
    for (const page of PAGES) expect(cleanUrl(`/${page}`)).toEqual({ rewrite: `/${page}.html` });
    expect(cleanUrl('/login?next=%2Freplay')).toEqual({ rewrite: '/login.html?next=%2Freplay' });
    expect(cleanUrl('/account/')).toEqual({ rewrite: '/account.html' });
  });

  it('redirects the old .html addresses to the clean ones, keeping the query', () => {
    expect(cleanUrl('/account.html')).toEqual({ redirect: '/account' });
    expect(cleanUrl('/replay.html?tab=diff')).toEqual({ redirect: '/replay?tab=diff' });
    expect(cleanUrl('/index.html')).toEqual({ redirect: '/' });
  });

  it('leaves everything else alone', () => {
    for (const url of ['/', '/api/me', '/api/account/login', '/src/main.js', '/favicon.svg', '/lessons/one', '/other', '/@vite/client'])
      expect(cleanUrl(url)).toBeNull();
  });
});
