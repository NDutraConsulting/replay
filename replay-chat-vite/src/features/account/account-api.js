import { toConnection } from '../../shared/app-api.js';
import { api } from '../../shared/http.js';

/** The model-ID textarea: one per line or comma separated, trimmed, deduplicated. */
export const parseModels = (text) => [...new Set(String(text ?? '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

/** Every API the account can call, the server's own last (it is read only). */
export const listConnections = async () => (await api.get('/api/connections')).map(toConnection);

/** Add an API: a label, its URL and key, and optionally its models (they can be added later). The server validates. */
export async function addConnection({ label, url, key, modelsText = '' }) {
  return toConnection(
    await api.post('/api/connections', { label: label.trim(), url: url.trim(), api_key: key.trim(), models: parseModels(modelsText) }),
  );
}

/** Save an API's URL and models. An empty key field means "keep the saved key". The label never changes. */
export async function saveConnection(id, { url, key, modelsText }) {
  const body = { url: url.trim(), models: parseModels(modelsText) };
  if (key.trim()) body.api_key = key.trim();
  return toConnection(await api.put(`/api/connections/${encodeURIComponent(id)}`, body));
}

export const deleteConnection = (id) => api.delete(`/api/connections/${encodeURIComponent(id)}`);

/** Sends one short request to that API through the server. Resolves {ok, message} (a failed test is not an HTTP error). */
export const testConnection = (id) => api.post(`/api/connections/${encodeURIComponent(id)}/test`);
