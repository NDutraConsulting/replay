import { bindFileMenu, fileMenuHTML } from '../../shared/file-menu-ui.js';
import { decisionTreeIfAny, kbNotesHTML } from '../../shared/decision-tree-ui.js';
import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';
import { configChipsHTML as chips } from '../../shared/config-chips-ui.js';
import { modelLabel } from '../../shared/model-label.js';
import { showModal } from '../../shared/modal-ui.js';
import { openChatPicker } from '../../shared/chat-picker-ui.js';

export { openChatPicker };
import { reasoningOptionsHTML } from '../../shared/reasoning.js';
import { TEMPERATURE_HINT, parseTemperature } from '../../shared/temperature.js';
import { footerHTML, modeBadgeHTML } from '../../shared/shell-ui.js';
import { userPrompts } from '../../shared/messages.js';

const agentOptionsHTML = (agents, agentId) =>
  agents.map((a) => `<option value="${a.id}" ${a.id === agentId ? 'selected' : ''}>${a.name}</option>`).join('');

const modelOptionsHTML = (models, model) =>
  models.map((m) => `<option value="${esc(m)}" ${m === model ? 'selected' : ''}>${esc(modelLabel(m))}</option>`).join('');

/** A short note for a prompt that has no reply. */
const statusNote = (m) =>
  ({ pending: ' · Sending…', stopped: ' · Stopped', failed: ' · No reply' })[m.status] || '';

const agentName = (s, id) => s.agents.find((a) => a.id === id)?.name ?? id;

/** The conversation's fixed settings, shown read-only (they were chosen in the New conversation popup). */
export const configChipsHTML = (s) =>
  chips({ agentName: agentName(s, s.agentId), model: s.model, reasoningLevel: s.reasoningLevel, temperature: s.temperature, kbSummaryTool: s.kbSummaryTool });

/** @param {{messages: object[], agents: {id: string, name: string}[], name: string, agentId: string, model: string, reasoningLevel: string, kbSummaryTool: boolean, models: string[], connected: boolean, conversationHidden: boolean, isSample: boolean}} s */
export function messageHTML(m, i, s) {
  if (m.message_type === 'compacted_summary') {
    return `<article class="message summary" data-message="${i}"><div class="message-body"><div class="message-meta">Summary of an earlier conversation<span>${m.demo ? 'Demo summary' : esc(modelLabel(m.model || s.model))}</span></div><div class="message-copy">${esc(m.content)}</div><div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy summary">${icon('copy')}Copy summary</button><span>↳ This conversation continues from this summary. The earlier conversation is unchanged.</span></div></div></article>`;
  }
  return `<article class="message ${m.role}" data-message="${i}"><div class="message-body"><div class="message-meta">${m.role==='user'?'You':esc(m.agent||'General assistant')}<span>${m.role==='assistant'?(m.demo?'Demo response':esc(modelLabel(m.model||s.model))):'Prompt '+(s.messages.slice(0,i+1).filter(x=>x.role==='user').length)+statusNote(m)}</span></div>${m.role==='assistant'?decisionTreeIfAny(m.decision_trace)+kbNotesHTML(m):''}<div class="message-copy">${esc(m.content)}</div>${m.role==='assistant'?`<div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy response">${icon('copy')}Copy response</button><span>↳ ${m.demo?'Sample':'Response'}</span></div>`:`<div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy prompt">${icon('copy')}Copy prompt</button></div>`}</div></article>`;
}

/** Compact needs at least one prompt that was answered. */
export const answered = (s) => s.messages.some((m) => m.role === 'assistant' && m.message_type !== 'compacted_summary');

/** Whether this conversation has used all the prompts it is allowed (the server answers 409 past that). */
export const promptLimitReached = (s) => s.maxUserPrompts != null && userPrompts(s.messages).length >= s.maxUserPrompts;

export function chatHTML(s) {
  const prompts = userPrompts(s.messages);
  const full = promptLimitReached(s);
  return `${fileMenuHTML()}<div class="layout chat-layout ${s.conversationHidden?'conversation-hidden':''}" id="chat-layout"><aside class="sidebar conversation-sidebar" id="conversation-sidebar" aria-label="This conversation" ${s.conversationHidden?'inert':''}><div class="side-card"><div class="side-top"><div class="row"><span class="side-title">This conversation</span><div class="prompt-head-actions"><span class="badge">${prompts.length} turns</span><button type="button" class="collapse-prompts tooltip" id="hide-conversation" aria-label="Hide this conversation" aria-controls="conversation-sidebar" aria-expanded="${!s.conversationHidden}" data-tip="Slide this conversation into the left edge.">−</button></div></div><div class="small" style="margin-top:5px">${s.isSample?'A creative workspace':prompts.length?'Your current session':'A fresh start'}</div></div><div class="turn-list">${prompts.length?prompts.map((p,i)=>`<button class="turn-item ${i===prompts.length-1?'current':''}" data-jump="${i}"><span class="turn-number">${String(i+1).padStart(2,'0')}</span><span class="turn-text">${esc(p)}</span></button>`).join(''):'<p class="small" style="padding:12px">Your prompts will appear here.</p>'}</div><div class="side-footer small">${icon('check')}Saved to your account</div></div><div class="replay-callout"><div class="circle-icon">${icon('replay')}</div><h3>Same prompts. Different results.</h3><p>Replay this conversation on another model and compare how the output changes.</p><a class="text-link" href="/replay.html">Open Replay ${icon('arrow')}</a></div></aside><section class="chat-card" aria-label="Chat conversation"><div class="chat-toolbar"><div class="agent-icon">${icon('spark')}</div><div class="chat-title"><div class="conversation-name"><h2 id="conversation-name">${esc(s.name)}</h2><button type="button" class="icon-btn tooltip" id="rename-chat" aria-label="Rename this conversation" data-tip="Rename (the name is only a label).">${icon('edit')}</button></div>${configChipsHTML(s)}</div><div class="toolbar-right">${modeBadgeHTML(s.connected)}</div></div><div class="messages" id="messages" aria-label="Conversation messages"><div class="date-separator">${s.messages.some(m=>m.demo)?'Sample conversation':'Current conversation'}</div>${s.messages.length?s.messages.map((m,i)=>messageHTML(m,i,s)).join(''):`<div class="empty"><div class="circle-icon">${icon('spark')}</div><h2>Start with a prompt.</h2><p>Send your first message, then replay it on other models to compare the results.</p></div>`}</div><div class="composer-area"><form id="chat-form" class="composer" data-full="${full}"><textarea id="prompt" aria-label="Message" placeholder="${full?'This conversation is full. Start a new one with File > New.':'Where should we take this next?'}" rows="2" ${full?'disabled':''}></textarea><div class="composer-bottom"><button type="button" id="rewind" class="btn blue tooltip" data-tip="Step back one turn and edit your last prompt." ${!prompts.length?'disabled':''}>${icon('rewind')}Rewind</button><button type="button" id="compact-chat" class="btn tooltip" data-tip="A model summarizes this conversation and a new conversation starts from the summary. This one is kept." ${!answered(s)?'disabled':''}>${icon('doc')}Compact</button><span class="composer-hint ${full?'full':''}" role="status">${s.maxUserPrompts!=null?`${prompts.length} of ${s.maxUserPrompts} prompts${full?': this conversation is full. Start a new one with File > New, or Rewind to step back.':' · Replay it on another model to compare.'}`:'Replay it on another model to compare.'}</span><button class="btn yellow send" id="send" type="submit" ${full?'disabled':''}>Send message ${icon('up')}</button></div></form><div class="below-composer"><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span><span>${s.connected?'Responses come from your configured API.':'Demo responses · Connect your API in Account'}</span></div></div></section></div><button class="prompts-restore ${s.conversationHidden?'visible':''}" id="show-conversation" aria-label="Show this conversation" aria-controls="conversation-sidebar" aria-expanded="${!s.conversationHidden}" ${s.conversationHidden?'':'inert'}><span class="restore-plus" aria-hidden="true">+</span><span>This conversation</span></button>${footerHTML()}`;
}

export const pendingHTML = () =>
  `<div class="message-body"><div class="small" role="status">Thinking through your next take…</div></div>`;

const $ = (id) => document.getElementById(id);

export const promptValue = () => $('prompt').value.trim();

export function setPrompt(text) {
  $('prompt').value = text;
}

export const focusPrompt = () => $('prompt').focus();

export function scrollChat() {
  const el = $('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

export function showPending() {
  const pending = document.createElement('div');
  pending.className = 'message assistant';
  pending.innerHTML = pendingHTML();
  $('messages').append(pending);
}

/** Disable inputs while a reply is in flight; turn Send into Stop. */
export function setBusyUI(busy, hasPrompts, onStop) {
  const full = $('chat-form')?.dataset.full === 'true'; // a full conversation stays closed to new prompts
  ['rename-chat', 'compact-chat', 'rewind', 'prompt'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy || (id === 'rewind' && !hasPrompts) || (id === 'prompt' && full);
  });
  const b = $('send');
  b.type = busy ? 'button' : 'submit';
  b.innerHTML = busy ? `${icon('pause')}Stop` : `Send message ${icon('up')}`;
  b.onclick = busy ? onStop : null;
}

/** While Compact waits for the model: nothing else can be changed, and the button says what is happening. */
export function setCompactingUI(compacting) {
  const full = $('chat-form')?.dataset.full === 'true';
  ['rename-chat', 'compact-chat', 'rewind', 'prompt', 'send'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = compacting || ((id === 'prompt' || id === 'send') && full);
  });
  const b = $('compact-chat');
  if (b) b.innerHTML = compacting ? 'Summarizing…' : `${icon('doc')}Compact`;
}

export function applyConversationHidden(hidden) {
  $('chat-layout').classList.toggle('conversation-hidden', hidden);
  $('conversation-sidebar').inert = hidden;
  const show = $('show-conversation');
  show.classList.toggle('visible', hidden);
  show.inert = !hidden;
  show.setAttribute('aria-expanded', !hidden);
  const hide = $('hide-conversation');
  hide.setAttribute('aria-expanded', !hidden);
  requestAnimationFrame(() => (hidden ? show : hide).focus());
}

export function scrollToMessage(index) {
  document.querySelector(`[data-message="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Wire DOM events of a freshly rendered chat page to controller handlers. */
export function bindChat(h) {
  bindFileMenu({ onNew: h.onNewChat, onOpen: h.onOpenChat });
  $('hide-conversation').onclick = () => h.onToggleConversation(true);
  $('show-conversation').onclick = () => h.onToggleConversation(false);
  $('rename-chat').onclick = h.onRename;
  $('compact-chat').onclick = h.onCompact;
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    h.onSubmit();
  };
  $('prompt').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('chat-form').requestSubmit();
    }
  };
  $('rewind').onclick = h.onRewind;
  document.querySelectorAll('[data-jump]').forEach((b) => (b.onclick = () => h.onJump(Number(b.dataset.jump))));
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => h.onCopy(Number(b.dataset.copy))));
}

const agentOptions = (agents, selected) =>
  agents.map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
const modelOptions = (models, selected) =>
  models.map((m) => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(modelLabel(m))}</option>`).join('');

/**
 * The New conversation popup: the name (a free label) and the settings that stay fixed for the conversation.
 * `values` are what it starts with; `onCreate(values)` returns an error message (the popup stays open) or nothing.
 * "Use this chat's settings" fills the form from the conversation on screen, to start another one to compare against.
 */
export function openNewConversationModal(s, values, onCreate) {
  const read = (form) => ({
    name: form.elements.name.value,
    agentId: form.elements.agent.value,
    model: form.elements.model.value,
    reasoningLevel: form.elements.reasoning.value,
    temperature: parseTemperature(form.elements.temperature.value),
    kbSummaryTool: form.elements.kbsummary.checked,
  });
  return showModal({
    title: 'New conversation',
    submitLabel: 'Start conversation',
    wide: true,
    bodyHTML: `<p class="modal-text">Choose how this conversation runs. The agent, model, reasoning level, temperature and KB summary tool setting are fixed once it starts, so you can compare conversations against each other. Only the name can change later.</p><div class="modal-field"><label for="new-chat-name">Conversation name</label><input type="text" id="new-chat-name" name="name" maxlength="80" autocomplete="off" placeholder="e.g. Segmentation, high reasoning" value="${esc(values.name)}"><p class="modal-hint">Just a label. It can repeat.</p></div><div class="modal-grid"><div class="modal-field"><label for="new-chat-agent">AI agent</label><select id="new-chat-agent" name="agent">${agentOptions(s.agents, values.agentId)}</select></div><div class="modal-field"><label for="new-chat-model">Model</label><select id="new-chat-model" name="model">${modelOptions(s.models, values.model)}</select></div><div class="modal-field"><label for="new-chat-reasoning">Reasoning level</label><select id="new-chat-reasoning" name="reasoning">${reasoningOptionsHTML(values.reasoningLevel)}</select><p class="modal-hint">Sent to the model as OpenAI's reasoning effort. A model that does not support the level you pick will say so when you send a message.</p></div><div class="modal-field"><label for="new-chat-temperature">Temperature</label><input type="number" id="new-chat-temperature" name="temperature" min="0" max="2" step="0.1" inputmode="decimal" value="${values.temperature ?? 0}"><p class="modal-hint">${TEMPERATURE_HINT}</p></div></div><div class="modal-field modal-check"><input type="checkbox" class="switch" role="switch" id="new-chat-kbsummary" name="kbsummary" ${values.kbSummaryTool ? 'checked' : ''}><div><label for="new-chat-kbsummary">KB summary tool</label><p class="modal-hint">Off: the whole knowledge base file the agent chooses is sent to the model. On: a model first writes a summary of the file for this conversation (under 1000 words) and that is sent instead.</p></div></div><button type="button" class="btn modal-prefill" id="use-chat-settings">Use this chat's settings</button>`,
    onMount(form) {
      form.querySelector('#use-chat-settings').onclick = () => {
        form.elements.name.value = `${s.name} 2`.slice(0, 80);
        form.elements.agent.value = s.agentId;
        form.elements.model.value = s.model;
        form.elements.reasoning.value = s.reasoningLevel;
        form.elements.temperature.value = s.temperature ?? 0;
        form.elements.kbsummary.checked = s.kbSummaryTool;
      };
    },
    onSubmit(form) {
      const values = read(form);
      if (values.temperature === null) return 'Temperature must be a number from 0 to 2.';
      return onCreate(values);
    },
  });
}

/** Rename popup. `onSave(name)` returns an error message or nothing. */
export const openRenameModal = (name, onSave) =>
  showModal({
    title: 'Rename conversation',
    submitLabel: 'Save name',
    bodyHTML: `<div class="modal-field"><label for="rename-input">Name</label><input type="text" id="rename-input" name="name" maxlength="80" autocomplete="off" value="${esc(name)}"><p class="modal-hint">The name is only a label. The agent, model, reasoning level and KB summary tool setting stay as they are.</p></div>`,
    onSubmit: (form) => onSave(form.elements.name.value),
  });
