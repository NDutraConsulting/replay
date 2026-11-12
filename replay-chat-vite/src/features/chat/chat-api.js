import { resolveAgent, resolveModel, savePreferences } from '../../shared/app-api.js';
import { listConversations, openConversation } from '../../shared/conversations-api.js';
import { api } from '../../shared/http.js';

export { savePreferences };

/**
 * The user's current conversation: { conversation_id, is_sample, name, agent_id, model, reasoning_level, kb_summary_tool,
 * source_conversation_id, created_at, messages[] }. Its agent, model, reasoning level and KB-summary-tool setting were
 * chosen when it started and never change; only the name can.
 */
export const loadConversation = () => api.get('/api/conversations/current');

export { listConversations, openConversation };

/** The conversation's own fields, as the page keeps them (the server's snake_case becomes camelCase). */
export const conversationFields = (c) => ({
  conversationId: c.conversation_id,
  isSample: c.is_sample,
  name: c.name,
  agentId: c.agent_id,
  model: c.model,
  reasoningLevel: c.reasoning_level,
  temperature: c.temperature ?? 0,
  kbSummaryTool: c.kb_summary_tool,
  briefInstruction: c.brief_instruction ?? '', // the exact text the server adds to the end of each request
  briefReplies: c.brief_replies ?? false, // "Respond in 100 words or less." is added to the end of each request
  sourceConversationId: c.source_conversation_id,
  maxUserPrompts: c.max_user_prompts ?? null, // the most prompts a conversation may hold (null: the server sent no limit)
  messages: c.messages,
});

/** What the chat page renders, from the shared app data and the conversation. */
export function chatState(app, conversation) {
  return {
    ...conversationFields(conversation),
    agents: app.agents,
    models: app.settings.models,
    connected: app.settings.connected,
    // the sidebar always starts closed; opening it is per visit
    conversationHidden: true,
    // what the New conversation popup starts with
    defaultAgentId: resolveAgent(app.agents, app.preferences.agentId),
    defaultModel: resolveModel(app.settings.models, app.preferences.model),
  };
}

/**
 * Send a prompt. The server saves it first, then asks the model with the conversation's own agent, model and
 * reasoning level (a message never carries them).
 * @returns {Promise<{messages: object[]}>} [the user's message, the assistant's reply]
 * @throws ApiError code `stopped` when a stop command won; the prompt is still saved
 */
export const sendMessage = (conversationId, { content, requestId }, signal) =>
  api.post(`/api/conversations/${conversationId}/messages`, { content, request_id: requestId }, { signal });

/**
 * The stop command for one send. It works even when it reaches the server before the prompt does
 * (the server remembers it and refuses the prompt's reply); a late reply is ignored either way.
 */
export const stopMessage = (conversationId, requestId) =>
  api.post(`/api/conversations/${conversationId}/stop`, { request_id: requestId });

/** Remove the last prompt (and what followed). @returns {{messages: object[], removed_prompt: string}} */
export const rewindConversation = (conversationId) => api.post(`/api/conversations/${conversationId}/rewind`);

/**
 * Start a conversation with its fixed settings (the New conversation popup).
 * @param {{name: string, agentId: string, model: string, reasoningLevel: string, temperature: number, kbSummaryTool: boolean, briefReplies: boolean}} settings
 */
export const createConversation = ({ name, agentId, model, reasoningLevel, temperature, kbSummaryTool, briefReplies }) =>
  api.post('/api/conversations', {
    name,
    agent_id: agentId,
    model,
    reasoning_level: reasoningLevel,
    temperature,
    kb_summary_tool: kbSummaryTool,
    brief_replies: briefReplies ?? false,
  });

/** The raw REST calls the Chat page sent to the provider for this conversation, prompt by prompt (read from Log.db). */
export const getChatApiLog = (conversationId) => api.get(`/api/conversations/${encodeURIComponent(conversationId)}/api-log`);

/** The name is only a label: it can repeat and it can change. */
export const renameConversation = (conversationId, name) => api.patch(`/api/conversations/${conversationId}`, { name });

/**
 * Compact: a model summarises this conversation and a NEW conversation starts from the summary, with the same fixed
 * settings. This conversation is left as it is.
 */
export const compactConversation = (conversationId) => api.post(`/api/conversations/${conversationId}/compact`);
