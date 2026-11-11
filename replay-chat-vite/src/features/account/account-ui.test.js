import { describe, expect, it } from 'vitest';
import { accountHTML, addApiHTML, apiPanelHTML, applyPreset, els, readAddForm, readApiForm, toggleKeyVisibility } from './account-ui.js';

const api = (id, label, extra = {}) => ({ id, label, url: `https://${id}.test/v1`, models: [], apiKeySet: true, connected: true, source: 'account', readOnly: false, ...extra });
const state = (connections = [], selectedId = null) => ({ connections, selectedId });

describe('account ui', () => {
  it('has no intro heading above the forms, and both forms are there', () => {
    document.body.innerHTML = accountHTML(state([api('a', 'Fast')]));
    const text = document.body.textContent;
    for (const gone of ['Make it your own', 'Your models. Your connection.', 'bring your own intelligence']) expect(text).not.toContain(gone);
    expect(document.querySelector('.page-heading')).toBeNull();
    expect([...document.querySelectorAll('.account-main h2')].map((h) => h.textContent)).toEqual(['Add an API', 'Models for an API']);
    expect(els().addForm).not.toBeNull();
    expect(els().form).not.toBeNull();
  });

  it('describes server-side storage, not the browser', () => {
    document.body.innerHTML = accountHTML(state());
    expect(document.body.textContent).toMatch(/keys stay on the server/i);
    expect(document.body.textContent).toMatch(/encrypted at rest/);
    expect(document.body.textContent).not.toMatch(/saved in your browser|stored in your browser/);
  });

  it('the add form asks for a label, a URL and a key, and nothing about models', () => {
    document.body.innerHTML = addApiHTML();
    expect(els().newLabel.maxLength).toBe(40);
    expect(els().newUrl.type).toBe('url');
    expect(els().newKey.type).toBe('password');
    expect(els().newKey.value).toBe('');
    expect(document.querySelector('#add-api-form textarea')).toBeNull();
    expect(document.querySelector('#add-api-form button[type="submit"]').textContent).toBe('Add API');
    expect(els().addForm.noValidate).toBe(true); // the server explains what is wrong
  });

  describe('the provider drop-down', () => {
    const open = () => {
      document.body.innerHTML = addApiHTML();
    };

    it('lists the providers after a blank choice, with their ids as values', () => {
      open();
      expect([...els().provider.options].map((o) => o.textContent)).toEqual(['Choose a provider…', 'OpenAI', 'Anthropic', 'Google Gemini', 'Fireworks AI', 'Featherless AI', 'Custom (local API host)']);
      expect([...els().provider.options].map((o) => o.value)).toEqual(['', 'openai', 'anthropic', 'gemini', 'fireworks', 'featherless', 'custom']);
      expect(els().provider.value).toBe('');
      expect(els().providerNote.textContent).toContain('Pick one to fill in its default URL');
      expect(els().newUrl.value).toBe(''); // nothing is filled in until a provider is chosen
      expect(els().newLabel.value).toBe('');
    });

    it.each([
      ['openai', 'https://api.openai.com/v1', 'OpenAI'],
      ['anthropic', 'https://api.anthropic.com/v1', 'Anthropic'],
      ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini'],
      ['fireworks', 'https://api.fireworks.ai/inference/v1', 'Fireworks'],
      ['featherless', 'https://api.featherless.ai/v1', 'Featherless'],
    ])('choosing %s fills in its URL, a label, a key hint and its note', (id, url, label) => {
      open();
      applyPreset(id);
      expect(els().newUrl.value).toBe(url);
      expect(els().newLabel.value).toBe(label);
      expect(els().newKey.placeholder).toBe('Enter this API’s key');
      expect(els().providerNote.textContent).toContain('API key');
      expect(readAddForm()).toEqual({ label, url, key: '' });
    });

    it('choosing Custom clears the URL, offers a local example, and says no key is needed', () => {
      open();
      applyPreset('openai');
      applyPreset('custom');
      expect(els().newUrl.value).toBe('');
      expect(els().newUrl.placeholder).toBe('http://localhost:11434/v1');
      expect(els().newLabel.value).toBe(''); // the user names a local host themselves
      expect(els().newKey.placeholder).toBe('Leave empty if this API needs no key');
      expect(els().providerNote.textContent).toContain('Ollama');
      expect(els().providerNote.textContent).toContain('needs no key');
    });

    it('replaces the label only while it is empty or still the last provider\'s own', () => {
      open();
      applyPreset('openai');
      applyPreset('gemini');
      expect(els().newLabel.value).toBe('Gemini'); // it was still "OpenAI", so it follows
      els().newLabel.value = 'My H100 box';
      applyPreset('fireworks');
      expect(els().newLabel.value).toBe('My H100 box'); // typed by the user: kept
      expect(els().newUrl.value).toBe('https://api.fireworks.ai/inference/v1'); // the URL still follows the provider
    });

    it('goes back to the plain note when the blank choice is picked, and keeps what was filled in', () => {
      open();
      applyPreset('openai');
      applyPreset('');
      expect(els().providerNote.textContent).toContain('Pick one to fill in its default URL');
      expect(els().newUrl.value).toBe('https://api.openai.com/v1');
    });

    it('ignores an unknown provider', () => {
      open();
      applyPreset('nope');
      expect(els().newUrl.value).toBe('');
      expect(els().providerNote.textContent).toContain('Pick one');
    });
  });

  it('with no API, the models panel explains what to do and has no drop-down', () => {
    document.body.innerHTML = apiPanelHTML(state());
    expect(document.getElementById('no-apis').textContent).toContain('Add one on the left');
    expect(els().label).toBeNull();
    expect(els().status.textContent).toContain('Demo mode is active');
  });

  it('lists the API labels in a drop-down with the chosen one selected, escaped', () => {
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast <b>'), api('b', 'Slow')], 'b'));
    expect([...els().label.options].map((o) => o.textContent)).toEqual(['Fast <b>', 'Slow']);
    expect(els().label.value).toBe('b');
    expect(document.querySelector('#api-panel b')).toBeNull();
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast'), api('b', 'Slow')], 'nope'));
    expect(els().label.value).toBe('a'); // an unknown selection falls back to the first
  });

  it('shows the chosen API\'s URL, an empty key field that says one is saved, and its models one per line', () => {
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast', { models: ['m1', 'm2'], url: 'https://"><b>' })], 'a'));
    expect(els().url.value).toBe('https://"><b>');
    expect(document.querySelector('#api-panel b')).toBeNull();
    expect(els().models.value).toBe('m1\nm2');
    expect(els().key.value).toBe('');
    expect(els().key.placeholder).toMatch(/API key saved/);
    expect(document.querySelector('label[for="model-ids"]').textContent).toBe('Models on Fast');
    expect(document.querySelector('#api-label + small').textContent).toBe('1 API · 2 models on this one');
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast', { apiKeySet: false })], 'a'));
    expect(els().key.placeholder).toBe('Enter this API’s key');
  });

  it('offers Save, Test and Delete for an API of the account, and says when it has no models yet', () => {
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast')], 'a'));
    expect(document.querySelector('#api-form button[type="submit"]').textContent).toBe('Save API');
    expect(els().test).not.toBeNull();
    expect(els().remove.textContent).toBe('Delete API');
    expect(els().status.textContent).toContain('No models yet');
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast', { models: ['m1'] })], 'a'));
    expect(els().status.textContent).toBe('Test it to verify access.');
  });

  it('shows the server\'s own API read only: fields disabled, no key field, no Save or Delete', () => {
    const server = api('server', 'OpenAI (server key)', { source: 'server', readOnly: true, models: ['gpt-x'] });
    document.body.innerHTML = apiPanelHTML(state([api('a', 'Fast'), server], 'server'));
    expect(els().label.selectedOptions[0].textContent).toBe('OpenAI (server key) (server, read only)');
    expect(els().url.disabled).toBe(true);
    expect(els().models.disabled).toBe(true);
    expect(els().key).toBeNull();
    expect(els().remove).toBeNull();
    expect(document.querySelector('#api-form button[type="submit"]')).toBeNull();
    expect(els().test).not.toBeNull();
    expect(document.querySelector('.api-read-only').textContent).toContain('.env');
  });

  it('reads what was typed in each form', () => {
    document.body.innerHTML = accountHTML(state([api('a', 'Fast', { models: ['m1'] })], 'a'));
    els().newLabel.value = ' L ';
    els().newUrl.value = 'https://n.test';
    els().newKey.value = 'k1';
    expect(readAddForm()).toEqual({ label: ' L ', url: 'https://n.test', key: 'k1' });
    els().url.value = 'https://u.test';
    els().key.value = 'k2';
    els().models.value = 'x\ny';
    expect(readApiForm()).toEqual({ url: 'https://u.test', key: 'k2', modelsText: 'x\ny' });
  });

  it('reads a read-only API\'s form without a key field', () => {
    document.body.innerHTML = apiPanelHTML(state([api('server', 'S', { readOnly: true, source: 'server' })], 'server'));
    expect(readApiForm().key).toBe('');
  });

  it('toggles a key field between hidden and shown', () => {
    document.body.innerHTML = addApiHTML();
    const button = document.querySelector('.show-key');
    toggleKeyVisibility(button);
    expect(els().newKey.type).toBe('text');
    expect(button.getAttribute('aria-label')).toBe('Hide API key');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    toggleKeyVisibility(button);
    expect(els().newKey.type).toBe('password');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});
