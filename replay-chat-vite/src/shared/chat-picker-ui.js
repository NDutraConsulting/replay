import { esc } from './html.js';
import { modelLabel } from './model-label.js';
import { showModal } from './modal-ui.js';

/**
 * The File > Open popup: pick one of the chats started here. `chats` come from the server (name, agent, model, prompt
 * count, last used); `onOpen(id)` returns an error message (the popup stays open) or nothing. Choosing the chat that is
 * already open does nothing, unless `reopenCurrent` (the Replay page reloads that chat's prompts into a fresh run).
 */
export function openChatPicker(chats, agents, currentId, onOpen, { reopenCurrent = false } = {}) {
  const when = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const row = (c) => {
    const agent = agents.find((a) => a.id === c.agent_id)?.name || c.agent_id;
    const turns = `${c.prompt_count} ${c.prompt_count === 1 ? 'prompt' : 'prompts'}`;
    return `<label class="chat-option"><input type="radio" name="chat" value="${esc(c.conversation_id)}" ${c.conversation_id === currentId ? 'checked' : ''}><span class="chat-option-body"><span class="chat-option-name">${esc(c.name)}${c.conversation_id === currentId ? ' <span class="badge">Open now</span>' : ''}</span><span class="chat-option-meta">${esc(agent)} · ${esc(modelLabel(c.model))} · ${turns} · ${esc(when(c.updated_at))}</span></span></label>`;
  };
  return showModal({
    title: 'Open a chat',
    submitLabel: 'Open',
    wide: true,
    bodyHTML: chats.length
      ? `<p class="modal-text">Your chats, most recent first. Replays are not listed here.</p><div class="chat-options" role="radiogroup" aria-label="Chats">${chats.map(row).join('')}</div>`
      : '<p class="modal-text">No chats yet. Use File &gt; New to start one.</p>',
    onSubmit(form) {
      const id = form.elements.chat?.value;
      if (!id) return 'Choose a chat to open.';
      return id === currentId && !reopenCurrent ? undefined : onOpen(id);
    },
  });
}
