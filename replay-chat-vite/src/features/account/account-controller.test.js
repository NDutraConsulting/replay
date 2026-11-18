import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, appRoutes, created, mockApi, noContent, settle } from '../../test/mock-api.js';
import { setUnauthorizedHandler } from '../../shared/http.js';

const $ = (id) => document.getElementById(id);
const text = (el) => el?.textContent ?? '';
const toastText = () => document.querySelector('.toast')?.textContent;

const wire = (id, label, extra = {}) => ({
  connection_id: id, label, url: `https://${id}.example.com/v1`, models: [], api_key_set: true, connected: true,
  source: 'account', read_only: false, ...extra,
}); // fmt: skip

/** An in-memory fake of the connections routes. */
async function boot(initial = [], { tourSeen = true } = {}) {
  vi.resetModules();
  setUnauthorizedHandler(vi.fn());
  const base = appRoutes().state.preferences;
  const { routes } = appRoutes({ preferences: { ...base, api_tour_seen: tourSeen } });
  const server = { apis: initial.map((a) => structuredClone(a)), next: 1, tests: [], failTest: null };
  const find = (id) => server.apis.find((a) => a.connection_id === id);
  const mock = mockApi({
    ...routes,
    'GET /api/connections': () => structuredClone(server.apis),
    'POST /api/connections': ({ body }) => {
      if (server.apis.some((a) => a.label.toLowerCase() === body.label.toLowerCase())) {
        return apiError(422, 'validation_error', `You already have an API labelled "${body.label}".`);
      }
      const api = wire(`n${server.next++}`, body.label, { url: body.url, models: body.models });
      server.apis.push(api);
      return created(structuredClone(api));
    },
    'PUT /api/connections/:id': ({ params, body }) => {
      const api = find(params.id);
      if (!api) return apiError(404, 'not_found', 'API not found.');
      if (body.url === 'bad') return apiError(422, 'validation_error', 'Enter a valid HTTP or HTTPS API URL.');
      Object.assign(api, { url: body.url ?? api.url, models: body.models ?? api.models });
      return structuredClone(api);
    },
    'DELETE /api/connections/:id': ({ params }) => {
      server.apis = server.apis.filter((a) => a.connection_id !== params.id);
      return noContent();
    },
    'POST /api/connections/:id/test': ({ params }) => {
      server.tests.push(params.id);
      return server.failTest ?? { ok: true, message: 'Connection verified. Your API returned a response.' };
    },
  });
  await import('./account-controller.js');
  await settle();
  return { server, mock };
}
const addForm = (label, url, key) => {
  $('new-api-label').value = label;
  $('new-api-url').value = url;
  $('new-api-key').value = key;
  $('add-api-form').requestSubmit();
};
const labels = () => [...$('api-label').options].map((o) => o.textContent);

describe('account page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('first-login API setup tour', () => {
    const tour = () => document.querySelector('.modal');
    const click = (label) => [...document.querySelectorAll('.modal button')].find((b) => b.textContent === label).click();

    it('does not open for someone who has already seen it', async () => {
      await boot([], { tourSeen: true });
      expect(tour()).toBeNull();
    });

    it('opens on step 1 with the provider dashboard links, OpenAI first', async () => {
      await boot([], { tourSeen: false });
      expect(text(tour().querySelector('h2'))).toBe('Set up your API · 1 of 2');
      const hrefs = [...tour().querySelectorAll('a')].map((a) => a.href);
      expect(hrefs[0]).toBe('https://platform.openai.com/login');
      expect(hrefs.length).toBeGreaterThan(1);
      expect(tour().querySelector('a').target).toBe('_blank');
    });

    it('goes to step 2, then finishing marks it seen and focuses the provider picker', async () => {
      const { mock } = await boot([], { tourSeen: false });
      click('Next');
      await settle();
      expect(text(tour().querySelector('h2'))).toBe('Set up your API · 2 of 2');
      expect(mock.count('PUT /api/preferences')).toBe(0); // nothing saved until the tour ends
      click('Add my API');
      await settle();
      expect(tour()).toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ api_tour_seen: true });
      expect(document.activeElement).toBe($('new-api-provider'));
    });

    it('skipping marks it seen too, so it never comes back', async () => {
      const { mock } = await boot([], { tourSeen: false });
      click('Skip tour');
      await settle();
      expect(tour()).toBeNull();
      expect(mock.lastBody('PUT /api/preferences')).toEqual({ api_tour_seen: true });
    });
  });

  it('has no intro heading, shows who is logged in, and offers to add an API', async () => {
    await boot();
    expect(document.querySelector('.page-heading')).toBeNull();
    expect(document.querySelector('.drawer-username').textContent).toBe('demo');
    expect(text(document.querySelector('#add-api h2'))).toBe('Add an API');
    expect($('new-api-label')).not.toBeNull();
    expect($('new-api-url')).not.toBeNull();
    expect($('new-api-key').type).toBe('password');
  });

  it('with no API yet, says demo mode is on and to add one first', async () => {
    await boot();
    expect($('no-apis')).not.toBeNull();
    expect(text($('connection-status'))).toContain('Demo mode is active');
    expect($('api-label')).toBeNull();
  });

  describe('choosing a provider', () => {
    const choose = (id) => {
      $('new-api-provider').value = id;
      $('new-api-provider').dispatchEvent(new Event('change'));
    };

    it('fills in the default URL and label from the chosen provider', async () => {
      await boot();
      choose('anthropic');
      expect($('new-api-url').value).toBe('https://api.anthropic.com/v1');
      expect($('new-api-label').value).toBe('Anthropic');
      expect(text($('new-api-provider-note'))).toContain('Claude API key');
    });

    it('adds the API with the provider\'s URL, only the key still to type', async () => {
      const { mock } = await boot();
      choose('fireworks');
      $('new-api-key').value = 'fw-secret';
      $('add-api-form').requestSubmit();
      await settle();
      expect(mock.lastBody('POST /api/connections')).toEqual({ label: 'Fireworks', url: 'https://api.fireworks.ai/inference/v1', api_key: 'fw-secret', models: [] });
      expect(labels()).toEqual(['Fireworks']);
    });

    it('keeps a label the user typed when another provider is chosen', async () => {
      await boot();
      choose('openai');
      $('new-api-label').value = 'Work OpenAI';
      choose('gemini');
      expect($('new-api-label').value).toBe('Work OpenAI');
      expect($('new-api-url').value).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    });

    it('lets Custom take a local URL with no key, and adds it', async () => {
      const { mock } = await boot();
      choose('custom');
      expect($('new-api-url').placeholder).toBe('http://localhost:11434/v1');
      $('new-api-label').value = 'Ollama';
      $('new-api-url').value = 'http://localhost:11434/v1';
      $('add-api-form').requestSubmit();
      await settle();
      expect(mock.lastBody('POST /api/connections')).toEqual({ label: 'Ollama', url: 'http://localhost:11434/v1', api_key: '', models: [] });
      expect(labels()).toEqual(['Ollama']);
    });

    it('is a blank choice again, with a clear form, after an API is added', async () => {
      await boot();
      choose('openai');
      $('new-api-key').value = 'sk-x';
      $('add-api-form').requestSubmit();
      await settle();
      expect($('new-api-provider').value).toBe('');
      expect($('new-api-url').value).toBe('');
      expect($('new-api-label').value).toBe('');
    });

    it('keeps the form and the provider when the server refuses the API', async () => {
      await boot([wire('c1', 'OpenAI')]);
      choose('openai'); // its label "OpenAI" is already taken
      $('new-api-key').value = 'sk-x';
      $('add-api-form').requestSubmit();
      await settle();
      expect(toastText()).toBe('You already have an API labelled "OpenAI".');
      expect($('new-api-provider').value).toBe('openai');
      expect($('new-api-url').value).toBe('https://api.openai.com/v1');
    });

    it('keeps the provider choice while another API is chosen in the models panel', async () => {
      await boot([wire('c1', 'Fast'), wire('c2', 'Slow')]);
      choose('gemini');
      $('api-label').value = 'c2';
      $('api-label').dispatchEvent(new Event('change'));
      expect($('new-api-provider').value).toBe('gemini');
      expect($('new-api-url').value).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    });
  });

  it('adds an API from its label, URL and key, then selects it so models can be added', async () => {
    const { mock } = await boot();
    addForm('H100 server', 'https://h100.example.com/v1', 'sk-secret');
    await settle();
    expect(mock.lastBody('POST /api/connections')).toEqual({ label: 'H100 server', url: 'https://h100.example.com/v1', api_key: 'sk-secret', models: [] });
    expect(toastText()).toBe('Added the API “H100 server”.');
    expect(labels()).toEqual(['H100 server']);
    expect($('api-label').value).toBe('n1');
    expect($('api-url').value).toBe('https://h100.example.com/v1');
    expect($('model-ids').value).toBe('');
    expect(text($('connection-status'))).toContain('Now add the models');
    expect($('new-api-label').value).toBe(''); // the form is clear again
    expect($('new-api-key').value).toBe('');
    expect(document.activeElement).toBe($('model-ids'));
  });

  it('shows the server message and keeps what was typed when adding fails', async () => {
    await boot([wire('c1', 'Fast')]);
    addForm('fast', 'https://x.test/v1', 'sk-x');
    await settle();
    expect(toastText()).toBe('You already have an API labelled "fast".');
    expect($('new-api-label').value).toBe('fast');
    expect($('new-api-url').value).toBe('https://x.test/v1');
    expect(labels()).toEqual(['Fast']);
  });

  it('lists the APIs by label in a drop-down and shows the chosen one\'s URL and models', async () => {
    await boot([wire('c1', 'Fast', { models: ['m1', 'm2'] }), wire('c2', 'Slow', { url: 'https://slow.test/v1', models: ['z'] })]);
    expect(labels()).toEqual(['Fast', 'Slow']);
    expect($('api-label').value).toBe('c1');
    expect($('model-ids').value).toBe('m1\nm2');
    expect(text(document.querySelector('#api-label + small'))).toBe('2 APIs · 2 models on this one');
    $('api-label').value = 'c2';
    $('api-label').dispatchEvent(new Event('change'));
    expect($('api-url').value).toBe('https://slow.test/v1');
    expect($('model-ids').value).toBe('z');
    expect($('api-key').placeholder).toMatch(/saved/);
    expect($('api-key').value).toBe('');
  });

  it('adds models to the chosen API by saving them under its label', async () => {
    const { mock } = await boot([wire('c1', 'Fast'), wire('c2', 'Slow')]);
    $('api-label').value = 'c2';
    $('api-label').dispatchEvent(new Event('change'));
    $('model-ids').value = 'llama\nmixtral';
    $('api-form').requestSubmit();
    await settle();
    expect(mock.calls.at(-1).path).toBe('/api/connections/c2');
    expect(mock.lastBody('PUT /api/connections/:id')).toEqual({ url: 'https://c2.example.com/v1', models: ['llama', 'mixtral'] });
    expect(toastText()).toBe('Saved “Slow”.');
    expect($('model-ids').value).toBe('llama\nmixtral');
    expect($('api-label').value).toBe('c2'); // still on the same API
    expect(text($('connection-status'))).toBe('Saved. Test it to verify access.');
  });

  it('preloads the OpenAI models when OpenAI is chosen as the provider', async () => {
    const { mock } = await boot();
    $('new-api-provider').value = 'openai';
    $('new-api-provider').dispatchEvent(new Event('change'));
    $('new-api-key').value = 'sk-x';
    $('add-api-form').requestSubmit();
    await settle();
    const models = mock.lastBody('POST /api/connections').models;
    expect(models).toContain('gpt-5.5');
    expect(models.length).toBeGreaterThan(3);
    expect($('model-ids').value.split('\n')).toEqual(models);
  });

  it('adds extra models from a popup and saves them next to the existing ones', async () => {
    const { mock } = await boot([wire('c1', 'Fast', { models: ['m1'] })]);
    $('add-models').click();
    document.getElementById('extra-models').value = 'm2, m1\nm3';
    document.querySelector('.modal-form').requestSubmit();
    await settle();
    expect(mock.lastBody('PUT /api/connections/:id').models).toEqual(['m1', 'm2', 'm3']);
    expect($('model-ids').value).toBe('m1\nm2\nm3');
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('keeps the Add models popup open when no model ID is entered', async () => {
    await boot([wire('c1', 'Fast')]);
    $('add-models').click();
    document.querySelector('.modal-form').requestSubmit();
    await settle();
    expect(document.querySelector('.modal-error').textContent).toMatch(/at least one/);
  });

  it('sends a new key only when one is typed, and forgets it afterwards', async () => {
    const { mock } = await boot([wire('c1', 'Fast', { models: ['m1'] })]);
    $('api-form').requestSubmit();
    await settle();
    expect(mock.lastBody('PUT /api/connections/:id')).not.toHaveProperty('api_key');
    $('api-key').value = 'sk-new';
    $('api-form').requestSubmit();
    await settle();
    expect(mock.lastBody('PUT /api/connections/:id').api_key).toBe('sk-new');
    expect($('api-key').value).toBe('');
  });

  it('shows the server message and keeps what the user typed when saving fails', async () => {
    await boot([wire('c1', 'Fast')]);
    $('api-url').value = 'bad';
    $('model-ids').value = 'kept';
    $('api-form').requestSubmit();
    await settle();
    expect(toastText()).toBe('Enter a valid HTTP or HTTPS API URL.');
    expect($('api-url').value).toBe('bad');
    expect($('model-ids').value).toBe('kept');
  });

  it('tests the chosen API through the server and shows its answer', async () => {
    const { server } = await boot([wire('c1', 'Fast', { models: ['m1'] }), wire('c2', 'Slow', { models: ['z'] })]);
    $('api-label').value = 'c2';
    $('api-label').dispatchEvent(new Event('change'));
    $('test-api').click();
    await settle();
    expect(server.tests).toEqual(['c2']);
    expect(text($('connection-status'))).toBe('Connection verified. Your API returned a response.');
    expect($('test-api').disabled).toBe(false);
  });

  it('saves what is typed before testing, and reports a failed test as text', async () => {
    const { server, mock } = await boot([wire('c1', 'Fast', { models: ['m1'] })]);
    server.failTest = { ok: false, message: 'API returned HTTP 401. Check your key, model ID, and endpoint in Account.' };
    $('model-ids').value = 'm1\nm9';
    $('test-api').click();
    await settle();
    expect(mock.lastBody('PUT /api/connections/:id').models).toEqual(['m1', 'm9']);
    expect(text($('connection-status'))).toContain('HTTP 401');
  });

  it('does not test an API that has no models, and says to add one', async () => {
    const { server } = await boot([wire('c1', 'Fast', { models: [] })]);
    expect(text($('connection-status'))).toContain('No models yet');
    $('test-api').click();
    await settle();
    expect(server.tests).toEqual([]);
    expect(text($('connection-status'))).toBe('Add a model to this API before testing it.');
  });

  it('asks before deleting an API, and deleting removes it from the drop-down', async () => {
    const { server } = await boot([wire('c1', 'Fast'), wire('c2', 'Slow')]);
    $('delete-api').click();
    await settle();
    expect(text(document.querySelector('.modal h2'))).toBe('Delete “Fast”?');
    document.querySelector('.modal [data-choice="cancel"]').click();
    await settle();
    expect(server.apis).toHaveLength(2); // kept
    $('delete-api').click();
    await settle();
    document.querySelector('.modal [data-choice="delete"]').click();
    await settle();
    expect(server.apis.map((a) => a.label)).toEqual(['Slow']);
    expect(labels()).toEqual(['Slow']);
    expect(toastText()).toBe('Deleted “Fast”.');
  });

  it('deleting the last API goes back to the demo-mode panel', async () => {
    await boot([wire('c1', 'Only')]);
    $('delete-api').click();
    await settle();
    document.querySelector('.modal [data-choice="delete"]').click();
    await settle();
    expect($('no-apis')).not.toBeNull();
    expect($('api-label')).toBeNull();
  });

  it('shows the server\'s own API read only: it can be looked at and tested, not changed or deleted', async () => {
    const { server } = await boot([wire('c1', 'Mine', { models: ['m1'] }), wire('server', 'OpenAI (server key)', { source: 'server', read_only: true, models: ['gpt-x'], url: 'https://api.openai.com/v1' })]);
    expect(labels()).toEqual(['Mine', 'OpenAI (server key) (server, read only)']);
    expect($('api-label').value).toBe('c1'); // starts on one of the account's own APIs
    $('api-label').value = 'server';
    $('api-label').dispatchEvent(new Event('change'));
    expect($('api-url').disabled).toBe(true);
    expect($('model-ids').disabled).toBe(true);
    expect($('api-key')).toBeNull();
    expect($('delete-api')).toBeNull();
    expect(document.querySelector('#api-form button[type="submit"]')).toBeNull();
    expect(text(document.querySelector('.api-read-only'))).toContain('OPENAI_API_KEY');
    $('test-api').click();
    await settle();
    expect(server.tests).toEqual(['server']);
  });

  it('starts on the server API when it is the only one', async () => {
    await boot([wire('server', 'OpenAI (server key)', { source: 'server', read_only: true, models: ['gpt-x'] })]);
    expect($('api-label').value).toBe('server');
    expect($('api-url').disabled).toBe(true);
  });

  it('keeps the server API last when an API is added', async () => {
    await boot([wire('server', 'OpenAI (server key)', { source: 'server', read_only: true })]);
    addForm('Mine', 'https://m.test/v1', 'k');
    await settle();
    expect(labels()).toEqual(['Mine', 'OpenAI (server key) (server, read only)']);
    expect($('api-label').value).toBe('n1');
  });

  it('shows and hides a typed key with the eye button, in either form', async () => {
    await boot([wire('c1', 'Fast')]);
    const buttons = [...document.querySelectorAll('.show-key')];
    expect(buttons).toHaveLength(2); // the add form and the models panel
    buttons[0].click();
    expect($('new-api-key').type).toBe('text');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    buttons[0].click();
    expect($('new-api-key').type).toBe('password');
    document.querySelector('.show-key[data-for="api-key"]').click();
    expect($('api-key').type).toBe('text');
  });

  it('keeps what was typed in the add form while another API is chosen', async () => {
    await boot([wire('c1', 'Fast'), wire('c2', 'Slow')]);
    $('new-api-label').value = 'half typed';
    $('api-label').value = 'c2';
    $('api-label').dispatchEvent(new Event('change'));
    expect($('new-api-label').value).toBe('half typed');
  });
});
