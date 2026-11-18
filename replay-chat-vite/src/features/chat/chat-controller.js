import '../../shared/styles/base.css';
import './chat.css';
import { copyText } from '../../shared/clipboard.js';
import { newRequestId } from '../../shared/http.js';
import { startPage } from '../../shared/shell-ui.js';
import { choiceDialog } from '../../shared/modal-ui.js';
import { mountChatFileMenu } from './chat-file-menu.js';
import { createLessonPlayer } from '../lessons/lesson-player.js';
import { openLessonsList, tourLesson } from '../lessons/lessons-list-ui.js';
import { toast, toastError } from '../../shared/toast.js';
import { openApiLogModal } from '../../shared/api-log-ui.js';
import { modelLabel } from '../../shared/model-label.js';
import {
  chatState, compactConversation, conversationFields, createConversation, deleteConversation, forkConversation, loadConversation, lockConversation,
  renameConversation, getChatApiLog, listConversations, openConversation, savePreferences, sendMessage, stopMessage,
} from './chat-api.js';
import {
  answered, applyConversationHidden, bindChat, chatHTML, focusPrompt, focusSend, openChatPicker, openConfigModal, openDeleteModal, openForkModal, openLockModal,
  openNewConversationModal, openRenameModal, openRewindModal, promptLimitReached, promptValue, scrollChat, scrollToMessage,
  renderTopbar, setBusyUI, setCompactingUI, showPending, stepMode, visibleMessages, visiblePrompts, totalPrompts,
} from './chat-ui.js';

/** Orchestrates the chat page: API (conversation on the server) <-> UI (markup + DOM). */
export const initChat = () =>
  startPage('chat', async (main, app) => {
    const state = { ...chatState(app, await loadConversation()), busy: false, abort: null, stopping: null, requestId: null };

    const render = () => {
      main.innerHTML = chatHTML(state);
      renderTopbar(state); // the name, Rename, the fork note, the badges and New Chat are in the top bar
      bindChat(handlers);
    };
    /** Take everything the server says about a conversation: its messages and its fixed settings. */
    const adopt = (conversation) =>
      Object.assign(state, conversationFields(conversation), { viewPrompts: null, rewindMode: false, cleared: false }); // never in rewind mode on a fresh conversation
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

    /**
     * Copy a conversation into a new one (a fork) and make the fork the current conversation. Nothing is sent to a model, so the
     * fork starts with an empty, enabled composer. Returns an error message (for a popup) or nothing.
     * @param {string} conversationId the conversation to copy
     * @param {string} name its name (for the toast)
     * @param {string} [throughMessageId] copy up to this message; omitted: all of it
     */
    async function forkFrom(conversationId, name, throughMessageId) {
      if (state.busy) return undefined;
      state.busy = true;
      try {
        adopt(await forkConversation(conversationId, throughMessageId));
      } catch (err) {
        return err.message;
      } finally {
        state.busy = false;
      }
      render();
      focusPrompt();
      toast(`Forked from ${name}.`);
      return undefined;
    }
    /** A locked conversation can only be continued as a fork: say so, then copy it (Cancel changes nothing). */
    const offerFork = (conversationId, name) =>
      openForkModal(
        {
          title: 'This conversation is locked',
          message: 'Continuing will create a fork, a copy with a new conversation ID, so any replays stay bound to the original conversation.',
          submitLabel: 'Create fork',
        },
        () => forkFrom(conversationId, name),
      );

    const handlers = {
      /** What was actually sent to the provider for each prompt of this chat (Log.db), in a popup of collapsible calls. */
      async onApiLog() {
        if (state.cleared) return;
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
          const chosen = chats.find((c) => c.conversation_id === id);
          if (chosen?.locked) {
            offerFork(id, chosen.name); // a locked chat is not changed, not even by opening it: continuing it forks it
            return undefined;
          }
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
        if (state.busy || state.cleared) return;
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
        if (state.busy || state.cleared || !answered(state) || stepMode(state)) return;
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
        if (state.busy || state.cleared) return;
        if (stepMode(state)) return handlers.onStartFork(); // stepped back: the button is Start fork, it never sends
        if (state.locked) return offerFork(state.conversationId, state.name);
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
          if (err.code === 'conversation_locked') {
            // it was locked elsewhere (another tab, or a replay started): the prompt was refused and is not saved
            state.messages = state.messages.filter((m) => m !== local);
            state.locked = true;
            toastError(err);
            return;
          }
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
      /**
       * Rewind. Outside rewind mode the click says it is entering the mode (Cancel in that popup enters nothing); entering does
       * NOT step back, the view stays where it is. Inside the mode each click on Rewind steps back one prompt. Nothing is
       * deleted, and the mode lasts until Start fork or Cancel.
       */
      onRewind() {
        if (state.busy || state.cleared || visiblePrompts(state) <= 1) return;
        const show = () => {
          render();
          scrollChat();
          focusSend();
        };
        if (stepMode(state)) {
          state.viewPrompts = visiblePrompts(state) - 1;
          show();
          return;
        }
        openRewindModal(() => {
          state.rewindMode = true;
          state.viewPrompts = null; // at the end, where the user was
          show();
        });
      },
      /** Forward steps toward the end. Reaching the end does not leave rewind mode. */
      onForward() {
        if (state.busy || !stepMode(state) || visiblePrompts(state) >= totalPrompts(state)) return;
        state.viewPrompts = visiblePrompts(state) + 1;
        render();
        scrollChat();
        focusSend();
      },
      /** Cancel: leave rewind mode without forking. The conversation is exactly as it was. */
      onRewindCancel() {
        if (state.busy || !stepMode(state)) return;
        state.rewindMode = false;
        state.viewPrompts = null;
        render();
        scrollChat();
        focusPrompt();
      },
      /** Start fork: after confirming, copy the conversation up to the point on screen into a new one. Sends nothing. */
      onStartFork() {
        if (state.busy || !stepMode(state)) return;
        const through = visibleMessages(state).at(-1)?.message_id;
        openForkModal(
          {
            title: 'Start a fork from this point?',
            message: `Are you sure you want to start the fork from this point? A new conversation is created with the prompts up to prompt ${visiblePrompts(state)} copied into it. Your current conversation is not changed.`,
            submitLabel: 'Start fork',
          },
          () => forkFrom(state.conversationId, state.name, through),
        );
      },
      /** The banner on a locked conversation. */
      onForkContinue() {
        offerFork(state.conversationId, state.name);
      },
      /** File > Config: switches for the optional buttons. A switch takes effect at once and is saved with the user's preferences. */
      onConfig() {
        openConfigModal(state, async (changes) => {
          const before = { showCompactButton: state.showCompactButton, showRewindButton: state.showRewindButton };
          Object.assign(state, changes);
          if (!state.busy) render(); // while a reply is on its way the redraw at the end of the send picks it up
          try {
            await savePreferences(changes);
          } catch (err) {
            Object.assign(state, before);
            if (!state.busy) render();
            return err.message;
          }
          return undefined;
        });
      },
      /** Delete this chat for good (after a warning). The page is cleared and the New conversation popup opens. */
      onDelete() {
        if (state.busy || state.cleared) return;
        openDeleteModal(async () => {
          try {
            await deleteConversation(state.conversationId);
          } catch (err) {
            return err.message; // the popup stays open and says why
          }
          // nothing is open now (no other chat is loaded in its place): a blank interface, and the way on is a new chat
          Object.assign(state, {
            cleared: true, conversationId: null, name: '', messages: [], isSample: false, locked: false, lockReason: null,
            forkedFromConversationId: null, forkedFromName: null, sourceConversationId: null, viewPrompts: null, rewindMode: false,
          }); // fmt: skip
          render();
          toast('Chat deleted.');
          handlers.onNewChat();
          return undefined;
        });
      },
      /** Lock: no more prompts can be added to this conversation, but it stays available for replay. */
      onLock() {
        if (state.busy || state.locked || stepMode(state) || !answered(state)) return;
        openLockModal(async () => {
          try {
            adopt(await lockConversation(state.conversationId));
          } catch (err) {
            return err.message; // the popup stays open and says why
          }
          render();
          toast('Conversation locked.');
          return undefined;
        });
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

    const lessonPlayer = createLessonPlayer();
    handlers.onLessons = () => openLessonsList('chat', lessonPlayer);
    mountChatFileMenu({ onNew: handlers.onNewChat, onOpen: handlers.onOpenChat, onLessons: handlers.onLessons, onConfig: handlers.onConfig });
    render();
    // Returning to the page: ask what to do. Dismissing the popup keeps the chat that is on screen behind it. (A locked chat
    // is not forked here: its banner offers that, and opening a locked chat from the list asks first.)
    if (app.preferences.showPagePopups === false) return; // the drawer's Page popups switch is off: show the chat as it is
    const tour = await tourLesson('chat'); // offered only to someone who has not finished a lesson yet
    choiceDialog({
      title: 'Welcome back',
      message: 'Open one of your chats, or start a new one?',
      choices: [
        { id: 'open', label: 'Open Chat', primary: true },
        { id: 'new', label: 'New Chat' },
        ...(tour ? [{ id: 'tour', label: 'Take the tour' }] : []),
      ],
    }).then((choice) => {
      if (choice === 'open') handlers.onOpenChat();
      else if (choice === 'new') handlers.onNewChat();
      else if (choice === 'tour') lessonPlayer.start(tour.slug).catch(toastError);
    });
  });

initChat();
