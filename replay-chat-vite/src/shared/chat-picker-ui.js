import { esc } from './html.js';
import { modelLabel } from './model-label.js';
import { showModal } from './modal-ui.js';

/**
 * The File > Open popup: pick one of the chats started here. `chats` come from the server (name, agent, model, prompt
 * count, last used); `onOpen(id)` returns an error message (the popup stays open) or nothing. Choosing the chat that is
 * already open does nothing, unless `reopenCurrent` (the Replay page reloads that chat's prompts into a fresh run).
 *
 * With `configure` the popup has two steps: 1 choose a chat (the button says Select), 2 the settings the page wants (the
 * button says Open, and Back returns to the list). `configure.html(chat)` is step 2's markup, `read(form)` its values,
 * `onMount?.(form, chat)` wires it, and `onOpen(id, values, chat)` returns an error message or nothing. `onOpen` above is
 * then unused.
 */
export function openChatPicker(chats, agents, currentId, onOpen, { reopenCurrent = false, configure = null } = {}) {
  const when = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const row = (c) => {
    const agent = agents.find((a) => a.id === c.agent_id)?.name || c.agent_id;
    const turns = `${c.prompt_count} ${c.prompt_count === 1 ? 'prompt' : 'prompts'}`;
    return `<label class="chat-option"><input type="radio" name="chat" value="${esc(c.conversation_id)}" ${c.conversation_id === currentId ? 'checked' : ''}><span class="chat-option-body"><span class="chat-option-name">${esc(c.name)}${c.conversation_id === currentId ? ' <span class="badge">Open now</span>' : ''}${c.locked ? ' <span class="badge lock-badge">Locked</span>' : ''}${c.forked_from_conversation_id ? ` <span class="badge">Fork of ${esc(chats.find((o) => o.conversation_id === c.forked_from_conversation_id)?.name ?? 'a deleted chat')}</span>` : ''}</span><span class="chat-option-meta">${esc(agent)} · ${esc(modelLabel(c.model))} · ${turns} · ${esc(when(c.updated_at))}</span></span></label>`;
  };
  const stepsOf = (n) => `<p class="modal-step">Step ${n} of 2</p>`;
  const listHTML = chats.length
    ? `<p class="modal-text">Your chats, most recent first. Replays are not listed here.</p><div class="chat-options" role="radiogroup" aria-label="Chats">${chats.map(row).join('')}</div>`
    : '<p class="modal-text">No chats yet. Use File &gt; New to start one.</p>';
  let chosen = null;
  let handle;
  const part = (name) => handle.form.querySelector(name);
  const showList = () => {
    part('#picker-step').innerHTML = (configure ? stepsOf(1) : '') + listHTML;
    const back = chosen && [...handle.form.querySelectorAll('input[name="chat"]')].find((r) => r.value === chosen.conversation_id);
    if (back) back.checked = true; // the chat that was chosen stays chosen
    part('[data-picker-back]')?.remove();
    part('button[type="submit"]').textContent = configure ? 'Select' : 'Open';
    chosen = null;
  };
  const showConfigure = (chat) => {
    chosen = chat;
    part('#picker-step').innerHTML = `${stepsOf(2)}<p class="modal-text">Settings for the replay of “${esc(chat.name)}”. They start from this chat's settings.</p>${configure.html(chat)}`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn';
    back.dataset.pickerBack = '';
    back.textContent = 'Back';
    back.onclick = showList;
    part('button[type="submit"]').before(back);
    part('button[type="submit"]').textContent = 'Open';
    configure.onMount?.(handle.form, chat);
  };
  handle = showModal({
    title: 'Open a chat',
    submitLabel: configure ? 'Select' : 'Open',
    wide: true,
    bodyHTML: `<div id="picker-step">${configure ? stepsOf(1) : ''}${listHTML}</div>`,
    onSubmit(form) {
      if (chosen) return configure.onOpen(chosen.conversation_id, configure.read(form), chosen); // step 2
      const id = form.elements.chat?.value;
      if (!id) return configure ? 'Choose a chat to select.' : 'Choose a chat to open.';
      if (configure) {
        showConfigure(chats.find((c) => c.conversation_id === id));
        return false;
      }
      return id === currentId && !reopenCurrent ? undefined : onOpen(id);
    },
  });
  return handle;
}
