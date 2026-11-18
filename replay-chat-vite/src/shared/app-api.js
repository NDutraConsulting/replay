import { api } from './http.js';

/** One API an account can call (the key itself never reaches the browser; only whether one is saved). */
export const toConnection = (c) => ({
  id: c.connection_id,
  label: c.label,
  url: c.url,
  models: c.models,
  apiKeySet: c.api_key_set,
  connected: c.connected,
  source: c.source, // "account" (added on the Account page) or "server" (the OPENAI_API_KEY in .env)
  readOnly: c.read_only,
});

/**
 * Settings as the UI uses them: `models` are the choices ("<API label>::<model>", or plain demo names), `connected` says
 * whether any API can be called, `connections` are the APIs.
 */
export const toSettings = (s) => ({ models: s.models, connected: s.connected, connections: (s.connections ?? []).map(toConnection) });

export const toPreferences = (p) => ({
  agentId: p.agent_id,
  model: p.model,
  chatSidebarHidden: p.chat_sidebar_hidden,
  replayPromptsHidden: p.replay_prompts_hidden,
  showCompactButton: p.show_compact_button ?? false, // the Chat page's Compact button: off unless turned on in Config
  showRewindButton: p.show_rewind_button ?? true, // the Chat page's Rewind button: on unless turned off in Config
  showPagePopups: p.show_page_popups ?? true, // popups that open with a page (the drawer's switch)
  apiTourSeen: p.api_tour_seen ?? true, // the first-login API setup tour (Account page) was finished or skipped
});

/** Everything every page needs before it can render: who is logged in, agents, settings, preferences. */
export async function loadApp() {
  const [user, agents, settings, preferences] = await Promise.all([
    api.get('/api/me'),
    api.get('/api/agents'),
    api.get('/api/settings'),
    api.get('/api/preferences'),
  ]);
  return { user, agents, settings: toSettings(settings), preferences: toPreferences(preferences) };
}

/** @param {{agentId?: string, model?: string|null, chatSidebarHidden?: boolean, replayPromptsHidden?: boolean, showCompactButton?: boolean, showRewindButton?: boolean, apiTourSeen?: boolean, showPagePopups?: boolean}} changes */
export async function savePreferences(changes) {
  const body = {};
  if ('agentId' in changes) body.agent_id = changes.agentId;
  if ('model' in changes) body.model = changes.model;
  if ('chatSidebarHidden' in changes) body.chat_sidebar_hidden = changes.chatSidebarHidden;
  if ('replayPromptsHidden' in changes) body.replay_prompts_hidden = changes.replayPromptsHidden;
  if ('showCompactButton' in changes) body.show_compact_button = changes.showCompactButton;
  if ('showRewindButton' in changes) body.show_rewind_button = changes.showRewindButton;
  if ('showPagePopups' in changes) body.show_page_popups = changes.showPagePopups;
  if ('apiTourSeen' in changes) body.api_tour_seen = changes.apiTourSeen;
  return toPreferences(await api.put('/api/preferences', body));
}

export async function logout() {
  await api.post('/api/account/logout');
}

/** The remembered model if it is still configured, otherwise the first configured model. */
export const resolveModel = (models, preferred) => (models.includes(preferred) ? preferred : models[0]);

/** The remembered agent if it still exists, otherwise the first agent. */
export const resolveAgent = (agents, id) => (agents.some((a) => a.id === id) ? id : agents[0]?.id);
