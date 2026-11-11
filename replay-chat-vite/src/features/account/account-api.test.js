import { describe, expect, it } from 'vitest';
import { mockApi, noContent } from '../../test/mock-api.js';
import { addConnection, deleteConnection, listConnections, parseModels, saveConnection, testConnection } from './account-api.js';

const wire = (extra = {}) => ({
  connection_id: 'c1', label: 'Fast', url: 'https://x.test/v1', models: ['m1'], api_key_set: true, connected: true,
  source: 'account', read_only: false, ...extra,
}); // fmt: skip

describe('account api', () => {
  it('parses model IDs from lines or commas, trimmed and deduplicated', () => {
    expect(parseModels(' a \nb, a ,,c')).toEqual(['a', 'b', 'c']);
    expect(parseModels(' \n ')).toEqual([]);
    expect(parseModels(undefined)).toEqual([]);
  });

  it('lists the APIs in the UI shape', async () => {
    mockApi({ 'GET /api/connections': () => [wire(), wire({ connection_id: 'server', label: 'OpenAI (server key)', source: 'server', read_only: true })] });
    const list = await listConnections();
    expect(list[0]).toEqual({ id: 'c1', label: 'Fast', url: 'https://x.test/v1', models: ['m1'], apiKeySet: true, connected: true, source: 'account', readOnly: false });
    expect(list[1]).toMatchObject({ id: 'server', readOnly: true, source: 'server' });
  });

  it('adds an API with a trimmed label, URL and key, and models only when given', async () => {
    const mock = mockApi({ 'POST /api/connections': () => wire() });
    await addConnection({ label: '  Fast  ', url: ' https://x.test/v1 ', key: ' sk-new ' });
    expect(mock.lastBody('POST /api/connections')).toEqual({ label: 'Fast', url: 'https://x.test/v1', api_key: 'sk-new', models: [] });
    await addConnection({ label: 'Fast', url: 'u', key: 'k', modelsText: 'a\nb' });
    expect(mock.lastBody('POST /api/connections').models).toEqual(['a', 'b']);
  });

  it("saves an API's URL and models, sending the key only when one was typed, never the label", async () => {
    const mock = mockApi({ 'PUT /api/connections/:id': () => wire() });
    await saveConnection('c1', { url: ' https://x.test/v1 ', key: ' sk-new ', modelsText: 'm1\nm2' });
    expect(mock.lastBody('PUT /api/connections/:id')).toEqual({ url: 'https://x.test/v1', models: ['m1', 'm2'], api_key: 'sk-new' });
    await saveConnection('c1', { url: 'https://x.test/v1', key: '', modelsText: 'm1' });
    expect(mock.lastBody('PUT /api/connections/:id')).toEqual({ url: 'https://x.test/v1', models: ['m1'] }); // keep the saved key
    expect(mock.calls.at(-1).path).toBe('/api/connections/c1');
  });

  it('deletes and tests an API by its id', async () => {
    const mock = mockApi({
      'DELETE /api/connections/:id': () => noContent(),
      'POST /api/connections/:id/test': () => ({ ok: true, message: 'Connection verified. Your API returned a response.' }),
    });
    await deleteConnection('c1');
    expect(await testConnection('c1')).toEqual({ ok: true, message: 'Connection verified. Your API returned a response.' });
    expect(mock.called('DELETE /api/connections/:id') && mock.called('POST /api/connections/:id/test')).toBe(true);
  });
});
