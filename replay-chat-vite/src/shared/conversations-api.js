import { api } from './http.js';

/** File > Open: the chats started in the chat interface (never replays), most recently used first. */
export const listConversations = () => api.get('/api/conversations');

/** Make a chat the current one (a reload and the Replay page follow it) and return it with its messages. */
export const openConversation = (conversationId) => api.post(`/api/conversations/${conversationId}/open`);

/** One of the user's chats with its full message history (does not change which chat is current). */
export const getConversation = (conversationId) => api.get(`/api/conversations/${encodeURIComponent(conversationId)}`);
