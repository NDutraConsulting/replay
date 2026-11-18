import { decisionTreeIfAny, kbNotesHTML } from '../../shared/decision-tree-ui.js';
import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';
import { reasoningLabel } from '../../shared/reasoning.js';
import { temperatureLabel } from '../../shared/temperature.js';
import { modelLabel, splitModel } from '../../shared/model-label.js';
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
export const settingsListHTML = (s) =>
  `<ul class="side-settings-list" aria-label="Settings (read-only)">${[
    ['Agent', agentName(s, s.agentId)],
    ['Model', s.model ? modelLabel(s.model) : ''],
    ['Reasoning', reasoningLabel(s.reasoningLevel)],
    ['Temperature', temperatureLabel(s.temperature)],
    ['KB summary tool', s.kbSummaryTool ? 'On' : 'Off'],
    ['Brief replies', s.briefReplies ? 'On' : 'Off'],
  ].filter(([, value]) => value !== '').map(([name, value]) => `<li><b>${name}</b>${esc(value)}</li>`).join('')}</ul>`;

/** @param {{messages: object[], agents: {id: string, name: string}[], name: string, agentId: string, model: string, reasoningLevel: string, kbSummaryTool: boolean, models: string[], connected: boolean, conversationHidden: boolean, isSample: boolean}} s */
export function messageHTML(m, i, s) {
  if (m.message_type === 'compacted_summary') {
    return `<article class="message summary" data-message="${i}"><div class="message-body"><div class="message-meta">Summary of an earlier conversation<span>${m.demo ? 'Demo summary' : esc(modelLabel(m.model || s.model))}</span></div><div class="message-copy">${esc(m.content)}</div><div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy summary">${icon('copy')}Copy summary</button><span>↳ This conversation continues from this summary. The earlier conversation is unchanged.</span></div></div></article>`;
  }
  return `<article class="message ${m.role}" data-message="${i}"><div class="message-body"><div class="message-meta">${m.role==='user'?'You':esc(m.agent||'General assistant')}<span>${m.role==='assistant'?(m.demo?'Demo response':esc(modelLabel(m.model||s.model))):'Prompt '+(s.messages.slice(0,i+1).filter(x=>x.role==='user').length)+statusNote(m)}</span></div>${m.role==='assistant'?decisionTreeIfAny(m.decision_trace)+kbNotesHTML(m):''}<div class="message-copy">${esc(m.content)}</div>${m.role==='user'&&s.briefReplies&&s.briefInstruction?`<div class="message-appended"><span class="appended-label">Added to the end when this was sent to the model</span>${esc(s.briefInstruction)}</div>`:''}${m.role==='assistant'?`<div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy response">${icon('copy')}Copy response</button><span>↳ ${m.demo?'Sample':'Response'}</span></div>`:`<div class="message-tools"><button class="copy-btn" data-copy="${i}" aria-label="Copy prompt">${icon('copy')}Copy prompt</button></div>`}</div></article>`;
}

/** Compact needs at least one prompt that was answered. */
export const answered = (s) => s.messages.some((m) => m.role === 'assistant' && m.message_type !== 'compacted_summary');

/** Whether this conversation has used all the prompts it is allowed (the server answers 409 past that). */
export const promptLimitReached = (s) => s.maxUserPrompts != null && userPrompts(s.messages).length >= s.maxUserPrompts;

/** How many prompts the conversation holds, and how many the page shows (fewer while the user has stepped back). */
export const totalPrompts = (s) => userPrompts(s.messages).length;
export const visiblePrompts = (s) => Math.min(s.viewPrompts ?? totalPrompts(s), totalPrompts(s));
/**
 * Rewind mode (step mode): entered with Rewind, and left only by Start fork or Cancel, however far the user steps back or
 * forward. While it lasts the page shows the point the user has reached, Send is Start fork and the message box is closed.
 */
export const stepMode = (s) => s.rewindMode === true;

/** The messages shown: everything before the first hidden prompt. Nothing is removed; Rewind only hides. */
export function visibleMessages(s) {
  if (!stepMode(s)) return s.messages;
  let seen = 0;
  const cut = s.messages.findIndex((m) => m.role === 'user' && ++seen > visiblePrompts(s));
  return cut < 0 ? s.messages : s.messages.slice(0, cut);
}

/** The line beside the buttons under the message box. */
function hintHTML(s, shown, full, step) {
  if (step) return `Rewind mode · prompt ${userPrompts(shown).length} of ${totalPrompts(s)}. Click Start fork to continue from here, or Cancel.`;
  if (s.cleared) return 'Start a new chat to begin.';
  if (s.locked) return 'Locked: replay it, or fork it to keep going.';
  if (s.maxUserPrompts == null) return 'Replay it on another model to compare.';
  const count = `${totalPrompts(s)} of ${s.maxUserPrompts} prompts`;
  return full
    ? `${count}: this conversation is full. Start a new one with File > New, or Rewind and start a fork.`
    : `${count} · Replay it on another model to compare.`;
}

/**
 * The conversation's name, its Rename button and (on a fork) where it came from. They live in the top bar, to the right of the
 * File menu, not in the chat card. The ids are the same as before: `conversation-name`, `rename-chat`, `fork-note`.
 */
export const topbarTitleHTML = (s) =>
  `<div class="conversation-name"><h2 id="conversation-name">${s.cleared?'No chat open':esc(s.name)}</h2><button type="button" class="icon-btn tooltip" id="rename-chat" aria-label="Rename this conversation" data-tip="Rename (the name is only a label)." ${s.cleared?'disabled data-off="true"':''}>${icon('edit')}</button></div>${s.forkedFromConversationId?`<div class="small fork-note" id="fork-note">Forked from ${esc(s.forkedFromName||'a deleted conversation')}</div>`:''}`;

/**
 * The connection badge, the Locked badge (on a locked chat) and New Chat. They take the avatar's place at the right end of the top
 * bar, not the chat card's header. The ids are the same as before (`new-chat`, `lock-badge`).
 */
export const topbarActionsHTML = (s) =>
  `${s.locked?`<span class="badge lock-badge" id="lock-badge">${icon('lock')}Locked</span>`:''}${modeBadgeHTML(s.connected)}<button type="button" class="btn" id="new-chat">${icon('plus')}New Chat</button>`;

function renderTopbarActions(s) {
  let el = document.getElementById('topbar-actions');
  if (!el) {
    el = document.createElement('div');
    el.id = 'topbar-actions';
    el.className = 'topbar-actions';
    const avatar = document.querySelector('.top-end .avatar');
    if (avatar) avatar.replaceWith(el); // the avatar is replaced on this page
    else document.querySelector('.top-end')?.prepend(el);
  }
  el.innerHTML = topbarActionsHTML(s);
}

/** Draw the title and the actions in the top bar (the bar is outside the page's main area, so it is kept up to date separately). */
export function renderTopbar(s) {
  renderTopbarTitle(s);
  renderTopbarActions(s);
}

function renderTopbarTitle(s) {
  let el = document.getElementById('topbar-title');
  if (!el) {
    el = document.createElement('div');
    el.id = 'topbar-title';
    el.className = 'topbar-title';
    const file = document.getElementById('topbar-file');
    if (file) file.after(el);
    else document.querySelector('.topbar')?.append(el);
  }
  el.innerHTML = topbarTitleHTML(s);
}

export function chatHTML(s) {
  const shown = visibleMessages(s);
  const step = stepMode(s);
  const prompts = userPrompts(shown);
  const full = promptLimitReached(s);
  const closed = (full || s.locked || s.cleared) && !step; // a locked or full conversation takes no prompt (a stepped-back view starts a fork)
  const lockOff = s.locked || step || !answered(s);
  return `<div class="layout chat-layout ${s.conversationHidden?'conversation-hidden':''}" id="chat-layout"><aside class="sidebar conversation-sidebar" id="conversation-sidebar" aria-label="This conversation" ${s.conversationHidden?'inert':''}><div class="side-card"><div class="side-top"><div class="row"><span class="side-title">This conversation</span><div class="prompt-head-actions"><span class="badge">${prompts.length} turns</span><button type="button" class="collapse-prompts tooltip" id="hide-conversation" aria-label="Hide this conversation" aria-controls="conversation-sidebar" aria-expanded="${!s.conversationHidden}" data-tip="Slide this conversation into the left edge.">−</button></div></div><div class="small" style="margin-top:5px">${s.isSample?'A creative workspace':prompts.length?'Your current session':'A fresh start'}</div></div><div class="side-settings-wrap"><details class="side-settings" id="side-settings" ${s.settingsOpen?'open':''}><summary>Settings</summary>${s.cleared?'<p class="small" style="padding:0 0 14px 16px">No chat open.</p>':settingsListHTML(s)}</details><button type="button" class="icon-btn tooltip delete-chat" id="delete-chat" aria-label="Delete this chat" data-tip="Delete this chat" ${s.cleared?'disabled data-off="true"':''}>${icon('trash')}</button></div><div class="turn-list">${prompts.length?prompts.map((p,i)=>`<button class="turn-item ${i===prompts.length-1?'current':''}" data-jump="${i}"><span class="turn-number">${String(i+1).padStart(2,'0')}</span><span class="turn-text">${esc(p)}</span></button>`).join(''):'<p class="small" style="padding:12px">Your prompts will appear here.</p>'}</div><div class="side-footer small">${icon('check')}Saved to your account</div></div><div class="replay-callout"><div class="circle-icon">${icon('replay')}</div><h3>Same prompts. Different results.</h3><p>Replay this conversation on another model and compare how the output changes.</p><a class="text-link" href="/replay">Open Replay ${icon('arrow')}</a><button type="button" class="btn replay-callout-log" id="chat-api-log" aria-haspopup="dialog" ${s.cleared?'disabled':''}>API log</button></div></aside><section class="chat-card" aria-label="Chat conversation"><div class="messages" id="messages" aria-label="Conversation messages"><div class="date-separator">${s.messages.some(m=>m.demo)?'Sample conversation':'Current conversation'}</div>${shown.length?shown.map((m,i)=>messageHTML(m,i,s)).join(''):`<div class="empty"><div class="circle-icon">${icon('spark')}</div>${s.cleared?'<h2>No chat open.</h2><p>Start a new chat, or open one from File &gt; Open.</p>':'<h2>Start with a prompt.</h2><p>Send your first message, then replay it on other models to compare the results.</p>'}</div>`}</div><div class="composer-area">${s.locked&&!step?`<div class="lock-banner" role="status">${icon('lock')}<span>This conversation is locked. Replay it, or fork it to keep going.</span><button type="button" class="btn" id="fork-continue">Fork to continue</button></div>`:''}<form id="chat-form" class="composer" data-full="${full}" data-locked="${s.locked}" data-step="${step}" data-cleared="${s.cleared}"><textarea id="prompt" aria-label="Message" placeholder="${step?'Start a fork to continue from here.':s.cleared?'Start a new chat with File > New.':s.locked?'This conversation is locked.':full?'This conversation is full. Start a new one with File > New.':'Where should we take this next?'}" rows="2" ${step||closed?'disabled':''}></textarea><div class="composer-bottom">${s.showRewindButton||step?`<button type="button" id="rewind" class="btn blue tooltip" data-tip="Step back one turn. Sending from an earlier point forks this conversation." ${prompts.length<=1?'disabled data-off="true"':''}>${icon('rewind')}Rewind</button>`:''}${step?`<button type="button" id="forward" class="btn blue tooltip" data-tip="Step forward one turn." ${prompts.length>=totalPrompts(s)?'disabled data-off="true"':''}>${icon('step')}Forward</button><button type="button" id="rewind-cancel" class="btn tooltip" data-tip="Leave rewind mode without forking. Nothing changes.">Cancel</button>`:''}${step||!s.showCompactButton?'':`<button type="button" id="compact-chat" class="btn tooltip" data-tip="A model summarizes this conversation and a new conversation starts from the summary. This one is kept." ${!answered(s)?'disabled data-off="true"':''}>${icon('doc')}Compact</button>`}<span class="composer-hint ${full&&!step?'full':''}" role="status">${hintHTML(s,shown,full,step)}</span><button type="button" id="lock-chat" class="btn tooltip lock-chat" data-tip="Lock this conversation" aria-label="Lock this conversation" ${lockOff?'disabled data-off="true"':''}>${icon('lock')}</button><button class="btn yellow send" id="send" type="submit" ${closed?'disabled':''}>${step?'Start fork':'Send message'} ${icon('up')}</button></div></form><div class="below-composer"><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span><span>${s.connected?'Responses come from your configured API.':'Demo responses · Connect your API in Account'}</span></div></div></section></div><button class="prompts-restore ${s.conversationHidden?'visible':''}" id="show-conversation" aria-label="Show this conversation" aria-controls="conversation-sidebar" aria-expanded="${!s.conversationHidden}" ${s.conversationHidden?'':'inert'}><span class="restore-plus" aria-hidden="true">+</span><span>This conversation</span></button>${footerHTML()}`;
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

/** The form's own state: full (the prompt limit), locked, or step mode (rewound: Send is Start fork). */
const formState = () => {
  const d = $('chat-form')?.dataset ?? {};
  const step = d.step === 'true';
  const closed = (d.full === 'true' || d.locked === 'true' || d.cleared === 'true') && !step;
  return { full: d.full === 'true', locked: d.locked === 'true', step, closed };
};
const sendLabel = (step) => `${step ? 'Start fork' : 'Send message'} ${icon('up')}`;
/** A button that was rendered disabled (data-off) stays disabled whatever else changes. */
const setOff = (el, busy) => (el.disabled = busy || el.dataset.off === 'true');

/** Disable inputs while a reply is in flight; turn Send into Stop. */
export function setBusyUI(busy, hasPrompts, onStop) {
  const { closed, step } = formState();
  ['rename-chat', 'compact-chat', 'rewind', 'forward', 'rewind-cancel', 'lock-chat', 'delete-chat'].forEach((id) => {
    const el = $(id);
    if (el) setOff(el, busy);
  });
  $('prompt').disabled = busy || closed || step;
  const b = $('send');
  b.type = busy ? 'button' : 'submit';
  b.innerHTML = busy ? `${icon('pause')}Stop` : sendLabel(step);
  b.onclick = busy ? onStop : null;
}

/** While Compact waits for the model: nothing else can be changed, and the button says what is happening. */
export function setCompactingUI(compacting) {
  const { closed, step } = formState();
  ['rename-chat', 'compact-chat', 'rewind', 'forward', 'rewind-cancel', 'lock-chat', 'delete-chat'].forEach((id) => {
    const el = $(id);
    if (el) setOff(el, compacting);
  });
  $('prompt').disabled = compacting || closed || step;
  $('send').disabled = compacting || closed;
  const b = $('compact-chat');
  if (b) b.innerHTML = compacting ? 'Summarizing…' : `${icon('doc')}Compact`;
}

export const focusSend = () => $('send')?.focus();

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
  $('side-settings').ontoggle = (e) => h.onToggleSettings(e.target.open);
  $('hide-conversation').onclick = () => h.onToggleConversation(true);
  $('show-conversation').onclick = () => h.onToggleConversation(false);
  $('rename-chat').onclick = h.onRename;
  $('new-chat').onclick = h.onNewChat;
  $('chat-api-log').onclick = h.onApiLog;
  if ($('compact-chat')) $('compact-chat').onclick = h.onCompact; // not drawn in rewind mode
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
  if ($('rewind')) $('rewind').onclick = h.onRewind; // not drawn when the Rewind button is switched off in Config
  $('lock-chat').onclick = h.onLock;
  $('delete-chat').onclick = h.onDelete;
  if ($('forward')) $('forward').onclick = h.onForward;
  if ($('rewind-cancel')) $('rewind-cancel').onclick = h.onRewindCancel;
  if ($('fork-continue')) $('fork-continue').onclick = h.onForkContinue;
  document.querySelectorAll('[data-jump]').forEach((b) => (b.onclick = () => h.onJump(Number(b.dataset.jump))));
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => h.onCopy(Number(b.dataset.copy))));
}

const agentOptions = (agents, selected) =>
  agents.map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
const NO_API = ''; // the group of plain model names (demo models, no API behind them)
const DEMO_LABEL = 'Demo (no API)';
const providerOf = (ref) => splitModel(ref).label ?? NO_API;
/** The API choices: each API label that serves a model, in the order the models list them. */
const providerList = (models) => [...new Set(models.map(providerOf))];
const providerOptions = (models, selected) =>
  providerList(models)
    .map((p) => `<option value="${esc(p)}" ${p === selected ? 'selected' : ''}>${esc(p === NO_API ? DEMO_LABEL : p)}</option>`)
    .join('');
/** The models of one API only; the option value stays the full "<API>::<model>" the server expects. */
const modelOptions = (models, provider, selected) =>
  models
    .filter((m) => providerOf(m) === provider)
    .map((m) => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(splitModel(m).model)}</option>`)
    .join('');

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
    briefReplies: form.elements.briefreplies.checked,
  });
  return showModal({
    title: 'New conversation',
    submitLabel: 'Start conversation',
    wide: true,
    bodyHTML: `<p class="modal-text">Choose how this conversation runs. The agent, API provider, model, reasoning level, temperature, KB summary tool and brief replies settings are fixed once it starts, so you can compare conversations against each other. Only the name can change later.</p><div class="modal-field"><label for="new-chat-name">Conversation name</label><input type="text" id="new-chat-name" name="name" maxlength="80" autocomplete="off" placeholder="e.g. Segmentation, high reasoning" value="${esc(values.name)}"><p class="modal-hint">Just a label. It can repeat.</p></div><div class="modal-grid"><div class="modal-field"><label for="new-chat-agent">AI agent</label><select id="new-chat-agent" name="agent">${agentOptions(s.agents, values.agentId)}</select></div><div class="modal-field"><label for="new-chat-provider">API provider</label><select id="new-chat-provider" name="provider">${providerOptions(s.models, providerOf(values.model))}</select></div><div class="modal-field"><label for="new-chat-model">Model</label><select id="new-chat-model" name="model">${modelOptions(s.models, providerOf(values.model), values.model)}</select></div><div class="modal-field"><label for="new-chat-reasoning">Reasoning level</label><select id="new-chat-reasoning" name="reasoning">${reasoningOptionsHTML(values.reasoningLevel)}</select><p class="modal-hint">Sent to the model as OpenAI's reasoning effort. A model that does not support the level you pick will say so when you send a message.</p></div><div class="modal-field"><label for="new-chat-temperature">Temperature</label><input type="number" id="new-chat-temperature" name="temperature" min="0" max="2" step="0.1" inputmode="decimal" value="${values.temperature ?? 0}"><p class="modal-hint">${TEMPERATURE_HINT}</p></div></div><div class="modal-grid"><div class="modal-field modal-check"><input type="checkbox" class="switch" role="switch" id="new-chat-kbsummary" name="kbsummary" ${values.kbSummaryTool ? 'checked' : ''}><div><label for="new-chat-kbsummary">KB summary tool</label><p class="modal-hint">Off: the whole knowledge base file the agent chooses is sent to the model. On: a model first writes a summary of the file for this conversation (under 1000 words) and that is sent instead.</p></div></div><div class="modal-field modal-check"><input type="checkbox" class="switch" role="switch" id="new-chat-brief" name="briefreplies" ${values.briefReplies ? 'checked' : ''}><div><label for="new-chat-brief">Brief replies</label><p class="modal-hint">On: "Respond in 100 words or less." is added to the end of each request sent to the model. Off: requests are sent as you wrote them.</p></div></div></div>${s.cleared?'':'<button type="button" class="btn modal-prefill" id="use-chat-settings">Use this chat\'s settings</button>'}`,
    onMount(form) {
      const fillModels = (provider, selected) => {
        form.elements.model.innerHTML = modelOptions(s.models, provider, selected);
      };
      form.elements.provider.onchange = () => fillModels(form.elements.provider.value);
      const useSettings = form.querySelector('#use-chat-settings'); // not offered when no chat is open
      if (useSettings) useSettings.onclick = () => {
        form.elements.name.value = `${s.name} 2`.slice(0, 80);
        form.elements.agent.value = s.agentId;
        form.elements.provider.value = providerOf(s.model);
        fillModels(providerOf(s.model), s.model);
        form.elements.reasoning.value = s.reasoningLevel;
        form.elements.temperature.value = s.temperature ?? 0;
        form.elements.kbsummary.checked = s.kbSummaryTool;
        form.elements.briefreplies.checked = s.briefReplies;
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

/** The Lock popup. `onConfirm()` returns an error message (the popup stays open) or nothing. */
export const openLockModal = (onConfirm) =>
  showModal({
    title: 'Lock this conversation?',
    submitLabel: 'Lock conversation',
    bodyHTML: '<p class="modal-text">You will not be able to add more prompts to this conversation. It will still be available for replay. To keep going later, open it and Replay Chat will create a fork, a copy with its own conversation ID.</p>',
    onSubmit: onConfirm,
  });

/** The popup on entering rewind mode. Cancel (in the popup) does not enter it. */
export const openRewindModal = (onConfirm) =>
  showModal({
    title: 'Entering rewind mode',
    submitLabel: 'Enter rewind mode',
    bodyHTML: '<p class="modal-text">Click Rewind to step back through this conversation, and Forward to step forward again. Your current conversation is kept as it is. Click Start fork to create a new conversation with the prompts up to the point you reach copied into it, or Cancel to leave rewind mode without forking.</p>',
    onSubmit: onConfirm,
  });

/** A fork popup: `message` explains it, `onConfirm()` creates the fork (it returns an error message or nothing). */
export const openForkModal = ({ title, message, submitLabel }, onConfirm) =>
  showModal({ title, submitLabel, bodyHTML: `<p class="modal-text">${esc(message)}</p>`, onSubmit: onConfirm });

/** The Delete popup. `onConfirm()` deletes the conversation and returns an error message (the popup stays open) or nothing. */
export const openDeleteModal = (onConfirm) =>
  showModal({
    title: 'Delete this chat?',
    submitLabel: 'Confirm deletion',
    bodyHTML: '<p class="modal-text"><strong>Warning:</strong> deleting this chat can not be undone. Confirm deletion to continue.</p>',
    onSubmit: onConfirm,
  });

/**
 * The Config popup: iOS-style switches for the optional buttons. A switch applies at once (the page behind changes and the
 * choice is saved), there is nothing to confirm. `onChange({showCompactButton?, showRewindButton?})` returns an error message
 * (the switch goes back and the popup says why) or nothing. The popup used to say a chat's settings are locked; that text is gone.
 */
export function openConfigModal(s, onChange) {
  const row = (id, name, label, hint, checked) =>
    `<li class="config-row"><div class="config-text"><label for="${id}">${label}</label><p class="modal-hint">${hint}</p></div><input type="checkbox" role="switch" class="ios-switch" id="${id}" name="${name}" ${checked ? 'checked' : ''}></li>`;
  return showModal({
    title: 'Config',
    submitLabel: 'OK',
    cancelLabel: null,
    bodyHTML: `<ul class="config-switches">${row('config-compact', 'compact', 'Show Compact button', 'Puts a Compact button under the message box. Off by default.', s.showCompactButton)}${row('config-rewind', 'rewind', 'Show Rewind button', 'Puts a Rewind button under the message box, which enters rewind mode. On by default.', s.showRewindButton)}</ul>`,
    onMount(form, handle) {
      const wire = (name, key) => {
        const input = form.elements[name];
        input.onchange = async () => {
          const problem = await onChange({ [key]: input.checked });
          if (problem) {
            input.checked = !input.checked; // the change was not saved: put the switch back
            handle.setError(problem);
          } else handle.setError('');
        };
      };
      wire('compact', 'showCompactButton');
      wire('rewind', 'showRewindButton');
    },
  });
}
