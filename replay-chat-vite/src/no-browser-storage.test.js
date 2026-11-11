import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.js$/.test(name) && !/\.test\.js$/.test(name) ? [path] : [];
  });

describe('the browser keeps no data (the server does)', () => {
  const files = sources(join(import.meta.dirname));

  it('finds the application sources (guards this test against scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('shared/http.js'))).toBe(true);
  });

  it('uses no localStorage, sessionStorage or IndexedDB', () => {
    const offenders = files.filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('reaches the backend only through the shared http client', () => {
    const offenders = files.filter((f) => !f.endsWith('shared/http.js') && /\bfetch\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no longer carries the old browser-side engine (demo replies, local providers)', () => {
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/demoResponse|buildHistory|archiveReplay|replay-saved-runs|replay-api-key/);
  });
});
