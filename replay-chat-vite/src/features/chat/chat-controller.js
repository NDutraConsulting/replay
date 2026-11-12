import '../../shared/styles/base.css';
import './chat.css';
import { copyText } from '../../shared/clipboard.js';
import { newRequestId } from '../../shared/http.js';
import { startPage } from '../../shared/shell-ui.js';
import { mountChatFileMenu } from './chat-file-menu.js';
import { toast, toastError } from '../../shared/toast.js';
import { openApiLogModal } from '../../shared/api-log-ui.js';
import { modelLabel } from '../../shared/model-label.js';
import {
  chatState, compactConversation, conversationFields, createConversation, loadConversation, renameConversation,
  getChatApiLog, listConversations, openConversation, rewindConversation, savePreferences, sendMessage, stopMessage,
} from './chat-api.js';
import {
  answered, applyConversationHidden, bindChat, chatHTML, focusPrompt, openChatPicker, openNewConversationModal, openRenameModal,
  promptLimitReached, promptValue, scrollChat, scrollToMessage, setBusyUI, setCompactingUI, setPrompt, showPending,
} from './chat-ui.js';

/** Orchestrates the chat page: API (conversation on the server) <-> UI (markup + DOM). */
export const initChat = () =>
  startPage('chat', async (main, app) => {
    const state = { ...chatState(app, await loadConversation()), busy: false, abort: null, stopping: null, requestId: null };

    const render = () => {
      main.innerHTML = chatHTML(state);
      bindChat(handlers);
    };
    /** Take everything the server says about a conversation: its messages and its fixed settings. */
    const adopt = (conversation) => Object.assign(state, conversationFields(conversation));
    /**
     * Show what the server has, but never lose the prompt the user just sent: the aborted request may still be
     * on its way, so the server might not have stored it yet. Our own message is recognized by its request id;
     * if the server has not got it (or still calls it pending) it is shown as `status`.
     * @returns {Promise<boolean>} whether the server is known to have the prompt
     */
    async function refresh(local, status) {
      let confirmed = true;
      try {
        adopt(await loadConversation());
      } catch {
        confirmed = false; // keep the messages on screen (they already include the local prompt)
      }
      const i = state.messages.findIndex((m) => m.request_id === local.request_id);
      if (i < 0) {
        state.messages = [...state.messages, { ...local, status }];
        return false;
      }
      if (state.messages[i].status === 'pending') {
        state.messages = state.messages.map((m, n) => (n === i ? { ...m, status } : m));
      }
      return confirmed && state.messages[i].message_id !== 'local';
    }
    /** Stop: tell the server first (so a late reply is ignored), then cancel the request. */
    const stop = () => {
      state.stopping = stopMessage(state.conversationId, state.requestId).catch(() => {});
      state.abort?.abort();
    };
    const remember = (changes) => savePreferences(changes).catch(toastError);

    const handlers = {
      /** What was actually sent to the provider for each prompt of this chat (Log.db), in a popup of collapsible calls. */
      async onApiLog() {
        let log;
        try {
          log = await getChatApiLog(state.conversationId);
        } catch (err) {
          return toastError(err);
        }
        return openApiLogModal(log, `API log · ${state.name} · ${modelLabel(log.model)}`, 'chat');
      },
      onToggleSettings(open) {
        state.settingsOpen = open; // no redraw: the box has already opened or closed; it stays as left when the page redraws
      },
      onToggleConversation(hidden) {
        state.conversationHidden = hidden;
        applyConversationHidden(hidden);
        remember({ chatSidebarHidden: hidden });
      },
      /** The New conversation popup: name, agent, model, reasoning level and the KB summary tool, fixed once it starts. */
      onNewChat() {
        if (state.busy) return;
        openNewConversationModal(
          state,
          { name: '', agentId: state.defaultAgentId, model: state.defaultModel, reasoningLevel: 'default', temperature: 0, kbSummaryTool: false, briefReplies: false },
          async (values) => {
            try {
              adopt(await createConversation(values));
            } catch (err) {
              return err.message; // the popup stays open and says why
            }
            state.defaultAgentId = values.agentId;
            state.defaultModel = values.model;
            remember({ agentId: values.agentId, model: values.model }); // the next popup starts from these
            render();
            focusPrompt();
            return undefined;
          },
        );
      },
      /** File > Open: choose one of this page's chats; it becomes the current conversation (settings stay as it began). */
      async onOpenChat() {
        if (state.busy) return;
        let chats;
        try {
          chats = await listConversations();
        } catch (err) {
          return toastError(err);
        }
        openChatPicker(chats, state.agents, state.conversationId, async (id) => {
          try {
            adopt(await openConversation(id));
          } catch (err) {
            return err.message;
          }
          render();
          focusPrompt();
          return undefined;
        });
      },
      onRename() {
        if (state.busy) return;
        openRenameModal(state.name, async (name) => {
          try {
            state.name = (await renameConversation(state.conversationId, name)).name;
          } catch (err) {
            return err.message;
          }
          render();
          return undefined;
        });
      },
      /** A model summarises this conversation and a new one starts from the summary (this one is kept). */
      async onCompact() {
        if (state.busy || !answered(state)) return;
        state.busy = true;
        setCompactingUI(true);
        try {
          adopt(await compactConversation(state.conversationId));
          toast('Started a new conversation from a summary. The earlier conversation is unchanged.');
        } catch (err) {
          toastError(err);
        } finally {
          state.busy = false;
          render();
          scrollChat();
          focusPrompt();
        }
      },
      async onSubmit() {
        if (state.busy) return;
        if (promptLimitReached(state)) {
          toast(`This conversation has reached its limit of ${state.maxUserPrompts} prompts. Start a new one with File > New.`);
          return;
        }
        const text = promptValue();
        if (!text) return;
        const controller = new AbortController();
        state.abort = controller;
        state.requestId = newRequestId();
        state.busy = true;
        const local = { message_id: 'local', role: 'user', content: text, status: 'pending', request_id: state.requestId };
        state.messages = [...state.messages, local];
        render();
        setBusyUI(true, true, stop);
        scrollChat();
        showPending();
        scrollChat();
        try {
          const { messages } = await sendMessage(
            state.conversationId,
            { content: text, requestId: state.requestId },
            controller.signal,
          );
          state.messages = [...state.messages.slice(0, -1), ...messages];
          state.isSample = false;
        } catch (err) {
          // The prompt is saved on the server in every case, so show what it has.
          const stopped = err.name === 'AbortError' || err.code === 'stopped';
          await state.stopping; // the stop command must reach the server before we ask what it has
          state.stopping = null;
          const saved = await refresh(local, stopped ? 'stopped' : 'failed');
          const answered = state.messages.find((m) => m.request_id === local.request_id)?.status === 'complete';
          if (stopped) {
            // if the reply won the race, just show it; only claim "saved" when the server really has the prompt
            if (!answered) toast(saved ? 'Response stopped. Your prompt is saved.' : 'Response stopped.');
          } else toastError(err);
        } finally {
          state.busy = false;
          state.abort = null;
          render();
          scrollChat();
          focusPrompt();
        }
      },
      async onRewind() {
        if (state.busy) return;
        let rewound;
        try {
          rewound = await rewindConversation(state.conversationId);
        } catch (err) {
          return toastError(err);
        }
        state.messages = rewound.messages;
        state.isSample = false;
        render();
        setPrompt(rewound.removed_prompt);
        focusPrompt();
        scrollChat();
        toast('Stepped back one turn. Edit your prompt and try again.');
      },
      onJump(n) {
        const indexes = state.messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
        scrollToMessage(indexes[n]);
      },
      /** Copy one turn's text: a prompt, a response or a summary. */
      onCopy(i) {
        const m = state.messages[i];
        if (!m) return undefined;
        const what = m.message_type === 'compacted_summary' ? 'Summary' : m.role === 'user' ? 'Prompt' : 'Response';
        return copyText(m.content, `${what} copied.`);
      },
    };

    mountChatFileMenu({ onNew: handlers.onNewChat, onOpen: handlers.onOpenChat });
    render();
  });

initChat();
