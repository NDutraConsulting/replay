/** The text of every user prompt in a conversation, in order. */
export const userPrompts = (messages) => messages.filter((m) => m.role === 'user').map((m) => m.content);
