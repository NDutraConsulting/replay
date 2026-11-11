import { describe, expect, it } from 'vitest';
import { API_PRESETS, DEFAULT_PROVIDER_NOTE, presetById } from './api-presets.js';

describe('API presets', () => {
  it('offers OpenAI, Anthropic, Google Gemini, Fireworks AI, Featherless AI and Custom, in that order', () => {
    expect(API_PRESETS.map((p) => p.name)).toEqual(['OpenAI', 'Anthropic', 'Google Gemini', 'Fireworks AI', 'Featherless AI', 'Custom (local API host)']);
    expect(API_PRESETS.map((p) => p.id)).toEqual(['openai', 'anthropic', 'gemini', 'fireworks', 'featherless', 'custom']);
  });

  it('gives each hosted provider its OpenAI-compatible base URL', () => {
    const url = Object.fromEntries(API_PRESETS.map((p) => [p.id, p.url]));
    expect(url).toEqual({
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
      fireworks: 'https://api.fireworks.ai/inference/v1',
      featherless: 'https://api.featherless.ai/v1',
      custom: '',
    });
  });

  it('keeps every URL as a base: https, no trailing slash, not the chat/completions endpoint (the server adds that)', () => {
    for (const p of API_PRESETS.filter((x) => x.url)) {
      expect(p.url.startsWith('https://'), p.id).toBe(true);
      expect(p.url.endsWith('/'), p.id).toBe(false);
      expect(p.url.includes('chat/completions'), p.id).toBe(false);
    }
  });

  it('needs a key for every hosted provider and not for Custom, which suggests a local address', () => {
    expect(API_PRESETS.filter((p) => p.url).every((p) => p.needsKey)).toBe(true);
    const custom = presetById('custom');
    expect(custom.needsKey).toBe(false);
    expect(custom.label).toBe('');
    expect(custom.placeholder).toBe('http://localhost:11434/v1');
    for (const example of ['localhost:11434', 'localhost:1234', 'localhost:8000']) expect(custom.note).toContain(example);
  });

  it('has a note for each, a distinct suggested label for each hosted one, and unique ids', () => {
    expect(API_PRESETS.every((p) => p.note.length > 20)).toBe(true);
    const labels = API_PRESETS.filter((p) => p.url).map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => l && !l.includes('::') && l.length <= 40)).toBe(true); // valid API labels
    expect(new Set(API_PRESETS.map((p) => p.id)).size).toBe(API_PRESETS.length);
    expect(presetById('anthropic').note).toContain('Chat Completions only');
  });

  it('finds a preset by id, or none', () => {
    expect(presetById('gemini').name).toBe('Google Gemini');
    expect(presetById('nope')).toBeNull();
    expect(presetById('')).toBeNull();
    expect(presetById(undefined)).toBeNull();
    expect(DEFAULT_PROVIDER_NOTE).toContain('Custom');
  });
});
