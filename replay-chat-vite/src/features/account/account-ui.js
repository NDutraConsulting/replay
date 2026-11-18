import { API_PRESETS, DEFAULT_PROVIDER_NOTE, presetById } from '../../shared/api-presets.js';
import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';
import { footerHTML } from '../../shared/shell-ui.js';

const keyField = (id, placeholder, hint) =>
  `<div class="field"><label class="field-label" for="${id}">API key</label><div class="password-wrap"><input id="${id}" type="password" placeholder="${esc(placeholder)}" value="" autocomplete="off" spellcheck="false"><button type="button" class="icon-btn show-key" data-for="${id}" aria-label="Show API key" aria-pressed="false">${icon('eye')}</button></div><small>${hint}</small></div>`;

/** The form that adds an API: its label, URL and key. Models are added afterwards, under the label (see apiPanelHTML). */
export const addApiHTML = () =>
  `<section class="panel" id="add-api"><div class="panel-head"><h2>Add an API</h2><p>Works with OpenAI-compatible Chat Completions APIs. You can add as many as you like.</p></div><form id="add-api-form" class="form-content" novalidate><div class="field"><label class="field-label" for="new-api-provider">Provider</label><select id="new-api-provider" class="model-select api-label-select"><option value="">Choose a provider…</option>${API_PRESETS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><small id="new-api-provider-note">${DEFAULT_PROVIDER_NOTE}</small></div><div class="field"><label class="field-label" for="new-api-label">API label <span class="info-dot tooltip" tabindex="0" data-tip="A name you choose, like “H100 server”. Models are picked as label · model, so the same model name on two APIs stays two choices. The label cannot be changed later.">i</span></label><input id="new-api-label" type="text" maxlength="40" placeholder="e.g. H100 server" autocomplete="off"><small>Up to 40 characters. It cannot contain “::”.</small></div><div class="field"><label class="field-label" for="new-api-url">API URL <span class="info-dot tooltip" tabindex="0" data-tip="Enter a base URL ending in /v1, or the complete /chat/completions endpoint.">i</span></label><input id="new-api-url" type="url" placeholder="https://your-api.example.com/v1" autocomplete="off"><small>Base URL or full Chat Completions endpoint.</small></div>${keyField('new-api-key', 'Enter this API’s key', 'Your key is encrypted on the server and never sent back to your browser.')}<div class="form-actions"><button class="btn yellow" type="submit">${icon('plus')}Add API</button></div></form></section>`;

/**
 * The models of one API. A drop-down of the account's API labels picks which API this panel is about; under it are that
 * API's URL, a field to replace its key, and its models (one per line). The server's own API (OPENAI_API_KEY in .env) is
 * listed too but read only.
 * @param {{connections: {id: string, label: string, url: string, models: string[], apiKeySet: boolean, readOnly: boolean}[], selectedId: string|null}} state
 */
export function apiPanelHTML(state) {
  const { connections, selectedId } = state;
  const head = '<div class="panel-head"><h2>Models for an API</h2><p>Choose an API by its label, then add the models it serves.</p></div>';
  if (!connections.length) {
    return `<section class="panel" id="api-panel">${head}<div class="form-content"><div class="empty" id="no-apis"><p>No API yet. Add one on the left, then choose its label here to add its models. Until then, demo models answer.</p></div><div class="connection-status" id="connection-status" role="status">Demo mode is active. No API requests are being sent.</div></div></section>`;
  }
  const current = connections.find((c) => c.id === selectedId) ?? connections[0];
  const options = connections
    .map((c) => `<option value="${esc(c.id)}" ${c.id === current.id ? 'selected' : ''}>${esc(c.label)}${c.readOnly ? ' (server, read only)' : ''}</option>`)
    .join('');
  const off = current.readOnly ? 'disabled' : '';
  const actions = current.readOnly
    ? `<button type="button" class="btn" id="test-api">${icon('link')}Test connection</button>`
    : `<button type="button" class="btn" id="add-models">${icon('plus')}Add models</button><button class="btn yellow" type="submit">${icon('check')}Save API</button><button type="button" class="btn" id="test-api">${icon('link')}Test connection</button><button type="button" class="btn danger" id="delete-api">${icon('trash')}Delete API</button>`;
  const note = current.readOnly
    ? '<p class="small api-read-only">This API comes from the server’s .env (OPENAI_API_KEY). It is shared by every account and cannot be changed here.</p>'
    : '';
  return `<section class="panel" id="api-panel">${head}<form id="api-form" class="form-content" novalidate><div class="field"><label class="field-label" for="api-label">API label</label><select id="api-label" class="model-select api-label-select">${options}</select><small>${connections.length} ${connections.length === 1 ? 'API' : 'APIs'} · ${current.models.length} ${current.models.length === 1 ? 'model' : 'models'} on this one</small></div>${note}<div class="field"><label class="field-label" for="api-url">API URL</label><input id="api-url" type="url" value="${esc(current.url)}" autocomplete="off" ${off}></div>${current.readOnly ? '' : keyField('api-key', current.apiKeySet ? 'API key saved. Enter a new key to replace it' : 'Enter this API’s key', 'Leave this empty to keep the saved key.')}<div class="field"><label class="field-label" for="model-ids">Models on ${esc(current.label)}</label><textarea id="model-ids" spellcheck="false" placeholder="model-a&#10;model-b" ${off}>${esc(current.models.join('\n'))}</textarea><small>One model ID per line. Use the exact IDs this API accepts. They are offered as “${esc(current.label)} · model”.</small></div><div class="form-actions">${actions}</div><div class="connection-status" id="connection-status" role="status">${current.models.length ? 'Test it to verify access.' : 'No models yet. Add the model IDs this API accepts, then save.'}</div></form></section>`;
}

/** @param {{connections: object[], selectedId: string|null}} state */
export const accountHTML = (state) =>
  `<div class="account-grid"><div class="account-main">${addApiHTML()}<div id="api-panel-slot">${apiPanelHTML(state)}</div></div><aside class="account-aside"><button type="button" class="btn" id="restart-tour">${icon('link')}Take the API setup tour again</button><div class="circle-icon">${icon('lock')}</div><h3>Your keys stay on the server.</h3><p>Replay Chat’s server calls the APIs you configure on your behalf, so your keys never have to live in your browser.</p><ul><li>Use your provider’s model IDs.</li><li>Use HTTPS for hosted APIs.</li><li>The server must be able to reach each API URL.</li></ul><div class="account-notice">Your API keys are encrypted at rest. Conversations and replay results are saved to your account.</div><p class="account-cost-note">API requests may incur charges with your provider. Test connection sends one short request.</p></aside></div>${footerHTML()}`;

/** The tour's steps: what to read, and what the next button says. Each is the body of a popup. */
export const TOUR_STEPS = [
  {
    title: 'Set up your API · 1 of 2',
    next: 'Next',
    bodyHTML: () =>
      `<p>Replay Chat calls your own API account, so you need an API key from a provider. Sign in to its dashboard, create a key, and keep the tab open to copy it.</p><ul class="tour-links">${API_PRESETS.filter((p) => p.dashboardUrl)
        .map((p) => `<li><a href="${esc(p.dashboardUrl)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}<span class="tour-url">${esc(p.dashboardUrl.replace('https://', ''))}</span></a></li>`)
        .join('')}</ul><small>Running a model on your own machine (Ollama, LM Studio, vLLM)? It needs no key. Choose Custom in the next step.</small>`,
  },
  {
    title: 'Set up your API · 2 of 2',
    next: 'Add my API',
    bodyHTML: () =>
      '<ol class="tour-steps"><li>Pick your provider under <strong>Add an API</strong>. Its URL is filled in for you.</li><li>Paste your key. It is encrypted on the server and never sent back to your browser.</li><li>Choose <strong>Add API</strong>, then <strong>Test connection</strong>.</li></ol><small>You can add more APIs at any time.</small>',
  },
];

export const els = () => ({
  addForm: document.getElementById('add-api-form'),
  restartTour: document.getElementById('restart-tour'),
  provider: document.getElementById('new-api-provider'),
  providerNote: document.getElementById('new-api-provider-note'),
  newLabel: document.getElementById('new-api-label'),
  newUrl: document.getElementById('new-api-url'),
  newKey: document.getElementById('new-api-key'),
  slot: document.getElementById('api-panel-slot'),
  form: document.getElementById('api-form'),
  label: document.getElementById('api-label'),
  url: document.getElementById('api-url'),
  key: document.getElementById('api-key'),
  models: document.getElementById('model-ids'),
  test: document.getElementById('test-api'),
  remove: document.getElementById('delete-api'),
  addModels: document.getElementById('add-models'),
  status: document.getElementById('connection-status'),
});

/**
 * Fill the add form from a provider: its default URL, a label to start from (when the label is empty or still the last
 * provider's), a key hint, and a note about it. Custom clears the URL and offers local examples. No provider: nothing is
 * filled in, and the note says how this works.
 */
export function applyPreset(id) {
  const e = els();
  const preset = presetById(id);
  const previous = presetById(e.provider.dataset.preset);
  e.provider.dataset.preset = preset ? preset.id : '';
  if (!preset) {
    e.providerNote.textContent = DEFAULT_PROVIDER_NOTE;
    return;
  }
  e.newUrl.value = preset.url;
  e.newUrl.placeholder = preset.placeholder ?? 'https://your-api.example.com/v1';
  const typed = e.newLabel.value.trim();
  if (!typed || (previous && typed === previous.label)) e.newLabel.value = preset.label;
  e.newKey.placeholder = preset.needsKey ? 'Enter this API’s key' : 'Leave empty if this API needs no key';
  e.providerNote.textContent = preset.note;
}

export const readAddForm = () => {
  const e = els();
  return { label: e.newLabel.value, url: e.newUrl.value, key: e.newKey.value, modelsText: (presetById(e.provider.dataset.preset)?.models ?? []).join('\n') };
};

export const readApiForm = () => {
  const e = els();
  return { url: e.url.value, key: e.key ? e.key.value : '', modelsText: e.models.value };
};

export const setStatus = (text) => {
  const { status } = els();
  if (status) status.textContent = text;
};

export const setTesting = (testing) => {
  const { test } = els();
  if (test) test.disabled = testing;
};

/** Swap just the models panel (the add form keeps what was typed in it). */
export function renderApiPanel(state) {
  els().slot.innerHTML = apiPanelHTML(state);
}

export function toggleKeyVisibility(button) {
  const input = document.getElementById(button.dataset.for);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  button.setAttribute('aria-pressed', show);
}
