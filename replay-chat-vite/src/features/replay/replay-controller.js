import '../../shared/styles/base.css';
import './replay.css';
import { savePreferences } from '../../shared/app-api.js';
import { newRequestId } from '../../shared/http.js';
import { getConversation, listConversations, openConversation } from '../../shared/conversations-api.js';
import { userPrompts } from '../../shared/messages.js';
import { openApiLogModal } from '../../shared/api-log-ui.js';
import { modelLabel } from '../../shared/model-label.js';
import { openChatPicker } from '../../shared/chat-picker-ui.js';
import { enableHoverTips } from '../../shared/hover-tip.js';
import { CLIFF_THRESHOLD, parseThreshold } from '../../shared/logprob-cliffs.js';
import { parseTemperature } from '../../shared/temperature.js';
import { bindFileMenu } from '../../shared/file-menu-ui.js';
import { startPage } from '../../shared/shell-ui.js';
import { showModal } from '../../shared/modal-ui.js';
import { toast, toastError } from '../../shared/toast.js';
import {
  compareWith, createRun, currentRun, getApiLog, getLogprobs, getSaved, listSaved, loadReplayData, normalizeDiff,
  selectDiff, stepRun, stopRun, updateRun,
} from './replay-api.js';
import {
  applyPromptsHidden, applySelectorsHidden, bindDiff, bindHistory, bindReplayConfig, bindReplayControls, bindTabs, focusTab, replayConfigHTML,
  chatReplays, currentReplayNumber, diffSettingsHTML, openReplayIntro, replayPageHTML, replayVersions,
} from './replay-ui.js';

/** Orchestrates the replay page: API (runs and saved replays on the server) <-> UI (markup + DOM). */
export const initReplay = () =>
  startPage('replay', async (main, app) => {
    const data = await loadReplayData();
    const models = app.settings.models;
    // The replay's source chat: the chat the current run came from (else the current chat). File > Open changes it.
    let chat = data.conversation;
    let chatPrompts = userPrompts(chat.messages);

    // Same start as before: use the current run, or start one from the current chat when the run is empty.
    let run = data.run;
    // A run that has not started and belongs to no chat (made before runs were tied to chats, or from loose prompts)
    // must not hide the current chat's prompts: start one from the chat instead.
    const strayRun = run && run.cursor === 0 && !run.sourceConversationId && chatPrompts.length > 0
      && JSON.stringify(run.prompts) !== JSON.stringify(chatPrompts);
    if (!run || strayRun || (!run.prompts.length && run.cursor === 0 && chatPrompts.length)) run = await createRun({});
    if (run.sourceConversationId && run.sourceConversationId !== chat.conversation_id) {
      try {
        chat = await getConversation(run.sourceConversationId);
        chatPrompts = userPrompts(chat.messages);
      } catch {
        // the chat is gone: show the current one
      }
    }
    if (run.cursor === 0 && !run.selected.every((m) => models.includes(m))) {
      const [a, b] = run.selected.map((m, i) => (models.includes(m) ? m : (models[i] ?? models[0])));
      run = await updateRun(run.runId, { modelA: a, modelB: b });
    }

    const state = {
      agents: app.agents,
      replay: run,
      promptsHidden: app.preferences.replayPromptsHidden,
      savedReplays: data.saved,
      savedDetails: {}, // id -> full saved replay, loaded on demand for the Diff tab
      cliffThreshold: CLIFF_THRESHOLD, // how big a drop in log probability the Diff marks as a cliff (adjustable there)
      selectorsHidden: false, // the Diff's Select Replays panel, slid into the left edge
      diffView: 'chat', // the Diff tab shows the answers as chat, or the API logs behind them
      apiLogs: {}, // id -> the raw REST calls behind a saved replay, loaded when the API logs view is opened
      savedLogprobs: {}, // id -> the answer tokens' log probabilities, for a replay that asked for them (Diff cliffs)
      replayTab: 'replay',
      activeResult: 'a',
      diffA: '',
      diffB: '',
      diffChosen: false, // true once the user picks a pair; until then the Diff follows the newest saved replays
      replayBusy: false,
      playing: false,
      stepped: false, // the Model responses panel shows only once Step through is used
      playOverlay: null, // 'running' | 'done' while Play all has its popup up
      playVersion: 0,
      abort: null,
      stopping: null,
      stepRequestId: null,
    };
    /** The source chat's own settings, shown read-only in File > Config. */
    const conversationSettings = () => ({
      name: chat.name,
      agentId: chat.agent_id,
      model: chat.model,
      reasoningLevel: chat.reasoning_level,
      temperature: chat.temperature ?? 0,
      kbSummaryTool: chat.kb_summary_tool,
    });
    const view = () => ({ ...state, models, connected: app.settings.connected, prompts: chatPrompts, chat, conversation: conversationSettings() });
    const remember = (changes) => savePreferences(changes).catch(toastError);

    const loading = new Set();
    const loadingLogs = new Set();
    /** Load the two selected saved replays for the Diff tab, then redraw once. */
    function loadDiffDetails() {
      const missing = [state.diffA, state.diffB].filter((id) => id && !state.savedDetails[id] && !loading.has(id));
      if (!missing.length) return;
      missing.forEach((id) => loading.add(id));
      Promise.all(
        missing.map((id) =>
          getSaved(id)
            .then(async (detail) => {
              if (detail.logprobs) {
                // the cliffs are marked from these; if they cannot be loaded the comparison still opens, without cliffs
                state.savedLogprobs[id] = await getLogprobs(id).catch(() => ({ id, available: false, turns: [] }));
              }
              state.savedDetails[id] = detail;
            })
            .catch(toastError)
            .finally(() => loading.delete(id)),
        ),
      ).then(() => state.replayTab === 'diff' && render());
    }

    /** Load the two selected replays' API logs for the Diff's API logs view, then redraw once. */
    function loadApiLogs() {
      const missing = [state.diffA, state.diffB].filter((id) => id && !state.apiLogs[id] && !loadingLogs.has(id));
      if (!missing.length) return;
      missing.forEach((id) => loadingLogs.add(id));
      Promise.all(
        missing.map((id) =>
          getApiLog(id)
            .then((log) => (state.apiLogs[id] = log))
            .catch((err) => {
              state.apiLogs[id] = { id, failed: true, recorded: false, turns: [] }; // shown as such, not asked for again
              toastError(err);
            })
            .finally(() => loadingLogs.delete(id)),
        ),
      ).then(() => {
        if (state.replayTab !== 'diff' || state.diffView !== 'api') return;
        const focused = document.activeElement?.id;
        render();
        if (focused?.startsWith('diff-view-')) document.getElementById(focused)?.focus(); // the redraw must not drop the user's place
      });
    }

    /** File > Config: the chat's settings and the replay's own, in a popup that stays up while a setting changes. */
    function openConfig() {
      showModal({
        title: 'Config',
        bodyHTML: replayConfigHTML(view()),
        submitLabel: 'Done',
        cancelLabel: null,
        wide: true,
        onMount: () => bindReplayConfig(replayHandlers),
      });
    }
    /** Redraw the popup's settings (after a change, a snap-back or a new run) if it is open. */
    function refreshConfig() {
      const box = document.getElementById('replay-config');
      if (!box) return;
      box.outerHTML = replayConfigHTML(view());
      bindReplayConfig(replayHandlers);
    }

    /** The saved replays of the chat on screen: the Diff compares these and no others. */
    const openChatReplays = () => chatReplays(state.savedReplays, chat.conversation_id);

    function render() {
      normalizeDiff(state, openChatReplays());
      main.innerHTML = replayPageHTML(view());
      bindFileMenu({ onConfig: openConfig, onOpen: () => historyHandlers.onOpenChat() });
      refreshConfig();
      bindTabs((tab) => {
        state.replayTab = tab;
        render();
        focusTab(tab);
      });
      if (state.replayTab === 'replay') bindReplayControls(replayHandlers);
      else if (state.replayTab === 'history') bindHistory(historyHandlers);
      else {
        bindDiff(diffHandlers);
        if (state.diffView === 'api') loadApiLogs();
        enableHoverTips(); // the log prob cliffs in the Diff show their value in a tooltip
        loadDiffDetails();
      }
    }

    async function refreshSaved() {
      try {
        state.savedReplays = await listSaved();
      } catch (err) {
        toastError(err);
      }
      state.savedDetails = {}; // a saved run can still grow, so cached details may be stale
      state.savedLogprobs = {};
      state.apiLogs = {};
      if (!state.diffChosen) state.diffA = state.diffB = ''; // re-pick the default: the two newest saved replays
    }
    /** Put the server's latest run on screen again (after a stop, a stale step, ...). */
    async function syncRun() {
      try {
        const latest = await currentRun();
        if (latest) state.replay = latest;
      } catch {
        // keep what is on screen
      }
    }
    /** Start a new run (the server saves the previous one if it has results). */
    async function startRun(body, message, tab = 'replay') {
      await pendingConfig;
      return beginRun(body, message, tab);
    }
    /** `startRun` without waiting for a pending config change (for use inside the config queue itself). */
    async function beginRun(body, message, tab = 'replay') {
      try {
        state.replay = await createRun(body);
      } catch (err) {
        toastError(err);
        return false;
      }
      state.replayTab = tab;
      state.stepped = false;
      state.playOverlay = null;
      state.activeResult = 'a';
      await refreshSaved();
      render();
      if (message) toast(message(state.replay));
      return true;
    }
    /**
     * Change models or agent. On failure the controls snap back to what the server has.
     * Changes are queued: a step, a save or a new run waits for a change that is still in flight, so a late answer
     * to "change the agent" can never overwrite a run that has already moved on.
     */
    let pendingConfig = Promise.resolve();
    function configure(changes) {
      pendingConfig = pendingConfig.then(async () => {
        if (state.replay.cursor > 0) {
          // the replay has started: a changed setting would make its results mean something else, so it starts over
          // (the server keeps the results so far as a saved replay) with the new setting
          const ok = await beginRun(restartBody(changes), null, state.replayTab);
          if (ok) toast('Config changed, so the replay was reset. The results so far are saved. Start a new run.');
          else render(); // the controls go back to what the run has
          return;
        }
        try {
          state.replay = await updateRun(state.replay.runId, changes);
        } catch (err) {
          toastError(err);
        }
        render();
      });
      return pendingConfig;
    }
    /** The body of a new run that has this run's prompts and settings, with `changes` ({modelA, agentId, temperature, ...}) applied. */
    function restartBody(changes = {}) {
      const run = state.replay;
      return {
        prompts: run.prompts,
        model_a: changes.modelA ?? run.selected[0],
        model_b: changes.modelB ?? run.selected[1],
        agent_id: changes.agentId ?? run.agentId,
        kb_summary_tool: changes.kbSummaryTool ?? run.kbSummaryTool,
        reasoning_level: changes.reasoningLevel ?? run.reasoningLevel,
        temperature: changes.temperature ?? run.temperature,
        logprobs: changes.logprobs ?? run.logprobs,
        ...(run.sourceConversationId ? { source_conversation_id: run.sourceConversationId } : {}), // stays tied to its chat
      };
    }

    async function step() {
      await pendingConfig;
      if (state.replayBusy || state.replay.cursor >= state.replay.prompts.length) return false;
      state.replayBusy = true;
      state.abort = new AbortController();
      state.stepRequestId = newRequestId();
      render();
      let ok = true;
      try {
        state.replay = await stepRun(state.replay.runId, state.replay.cursor, state.stepRequestId, state.abort.signal);
        if (state.replay.cursor === state.replay.prompts.length) await refreshSaved();
        else {
          state.savedDetails = {};
          state.savedLogprobs = {};
          state.apiLogs = {};
        }
      } catch (err) {
        ok = false;
        state.playing = false;
        if (err.name === 'AbortError' || err.code === 'stopped') toast('Playback stopped. Resume from this prompt.');
        else toastError(err);
        await state.stopping; // the stop command must reach the server before we ask what it has
        state.stopping = null;
        await syncRun();
      } finally {
        state.replayBusy = false;
        state.abort = null;
        render();
      }
      return ok;
    }

    const replayHandlers = {
      onTogglePrompts(hidden) {
        state.promptsHidden = hidden;
        applyPromptsHidden(hidden);
        remember({ replayPromptsHidden: hidden });
      },
      onAgent: (id) => configure({ agentId: id }),
      onReasoning: (level) => configure({ reasoningLevel: level }),
      onTemperature(text) {
        const temperature = parseTemperature(text);
        if (temperature === null) {
          toast('Temperature must be a number from 0 to 2.');
          render(); // put the box back to what the run has (no server call)
          return undefined;
        }
        return configure({ temperature });
      },
      onKbSummary: (on) => configure({ kbSummaryTool: on }),
      onLogprobs: (on) => configure({ logprobs: on }),
      onModels: ([modelA, modelB]) => configure({ modelA, modelB }),
      onResultTab(slot) {
        state.activeResult = slot;
        render();
      },
      onReset: () => startRun(restartBody()),
      onConfig: () => openConfig(),
      onStep() {
        state.stepped = true;
        return step();
      },
      /** From the Play all popup: open the Diff tab on its Chat or API logs view. */
      onViewDiff(view) {
        state.playOverlay = null;
        state.diffView = view === 'api' ? 'api' : 'chat';
        state.replayTab = 'diff';
        render();
        focusTab('diff');
      },
      async onPlay() {
        if (state.playing) {
          state.playing = false;
          state.stopping = stopRun(state.replay.runId, state.stepRequestId).catch(() => {});
          state.abort?.abort();
          render();
          return;
        }
        state.playing = true;
        state.playVersion = currentReplayNumber(view());
        state.playOverlay = 'running';
        render();
        while (state.playing && state.replay.cursor < state.replay.prompts.length) {
          if (!(await step())) break;
        }
        const finished = state.playing && state.replay.cursor >= state.replay.prompts.length;
        state.playing = false;
        state.playOverlay = finished ? 'done' : null;
        render();
      },
    };

    const historyHandlers = {
      /** File > Open: choose one of the user's chats; its full history is shown and a replay of it is ready. */
      async onOpenChat() {
        if (state.replayBusy) return;
        let chats;
        try {
          chats = await listConversations();
        } catch (err) {
          return toastError(err);
        }
        openChatPicker(chats, state.agents, chat.conversation_id, async (id) => {
          const previous = { chat, chatPrompts };
          try {
            chat = await openConversation(id);
            chatPrompts = userPrompts(chat.messages);
            const [modelA, modelB] = state.replay.selected;
            if (!(await startRun({ conversation_id: id, model_a: modelA, model_b: modelB }, null, 'history'))) {
              ({ chat, chatPrompts } = previous);
              return 'That chat could not be loaded.';
            }
          } catch (err) {
            ({ chat, chatPrompts } = previous);
            return err.message;
          }
          return undefined;
        }, { reopenCurrent: true }); // choosing the chat on screen reloads its prompts into a fresh run
      },
      /** The raw REST calls behind one saved replay, in a popup (each call is its own collapsible). */
      async onApiLog(id) {
        const saved = state.savedReplays.find((r) => r.id === id);
        let log;
        try {
          log = await getApiLog(id);
        } catch (err) {
          return toastError(err);
        }
        const version = saved?.sourceConversationId
          ? replayVersions(state.savedReplays, saved.sourceConversationId).find((v) => v.runId === saved.runId)?.version
          : null;
        return openApiLogModal(log, `API log · ${version ? `Replay v${version} · ` : ''}${saved ? saved.slot.toUpperCase() : ''} · ${modelLabel(log.model)}`);
      },
      onCompare(id) {
        compareWith(state, id, openChatReplays());
        state.diffChosen = true;
        render();
      },
    };

    const diffHandlers = {
      onOpenReplay() {
        state.replayTab = 'replay';
        render();
      },
      onSelect(side, id) {
        selectDiff(state, side, id);
        state.diffChosen = true;
        render();
      },
      onToggleSelectors(hidden) {
        state.selectorsHidden = hidden;
        applySelectorsHidden(hidden);
      },
      /** The gear beside the Chat / API logs tabs: a popup with the cliff threshold box. */
      onDiffSettings() {
        showModal({
          title: 'Diff settings',
          bodyHTML: diffSettingsHTML(view()),
          submitLabel: 'Done',
          cancelLabel: null,
          onMount: (form) => {
            const box = form.querySelector('#cliff-threshold');
            box.onchange = (e) => diffHandlers.onThreshold(e.target.value);
          },
        });
      },
      /** The cliff threshold box (in the Diff settings popup): a drop above 0 and at most 20. The marks are worked out again from the tokens already loaded. */
      onThreshold(text) {
        const threshold = parseThreshold(text);
        if (threshold === null) toast('The cliff threshold must be a number above 0, up to 20.');
        else state.cliffThreshold = threshold;
        render();
        const box = document.getElementById('cliff-threshold');
        if (box) {
          box.value = state.cliffThreshold; // an invalid entry puts the last good value back
          box.focus();
        }
      },
      onView(view) {
        state.diffView = view === 'api' ? 'api' : 'chat';
        render();
        document.getElementById('diff-view-' + state.diffView)?.focus();
      },
    };

    render();
    openReplayIntro(); // what this page is for, shown each time it opens
  });

initReplay();
