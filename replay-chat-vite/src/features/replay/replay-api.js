import { ApiError, api } from '../../shared/http.js';

export const SLOTS = ['a', 'b'];

// ---- server shapes -> the shapes the UI reads
const toResult = (r) => ({
  content: r.content,
  model: r.model,
  demo: r.demo,
  error: r.error,
  decision_trace: r.decision_trace, // shown in the Diff tab's "Decision tree" collapsible
  kb_summary: r.kb_summary ?? null, // the summary this slot's model wrote, when the run's KB-summary-tool was on
  kb_version_deleted: r.kb_version_deleted ?? false, // the version of the file this answer used has been deleted
});

/**
 * { runId, prompts, selected: [modelA, modelB], cursor, agentId, kbSummaryTool, reasoningLevel, temperature, logprobs, contextSummary,
 *   results: {a: [], b: []}, savedAt, stepRunning }
 * kbSummaryTool is ONE switch for the whole run (both slots); with it on, each slot's own model writes the summary of the
 * file it is routed to and that is sent instead of the file. Both it and the reasoning level lock once the run starts.
 */
export const toReplay = (run) => ({
  runId: run.replay_run_id,
  prompts: run.prompts,
  selected: [run.model_a, run.model_b],
  cursor: run.cursor,
  agentId: run.agent_id,
  kbSummaryTool: run.kb_summary_tool ?? false,
  reasoningLevel: run.reasoning_level ?? 'default',
  temperature: run.temperature ?? 0,
  logprobs: run.logprobs ?? false, // log probabilities requested in every response of the run
  contextSummary: run.context_summary ?? null, // set when the replayed conversation began with a compacted summary
  sourceConversationId: run.source_conversation_id ?? null, // the chat this run was started from
  results: { a: run.results.a.map(toResult), b: run.results.b.map(toResult) },
  savedAt: run.saved_at,
  stepRunning: run.step_running,
});

export const toSummary = (s) => ({
  id: s.id,
  runId: s.replay_run_id,
  slot: s.slot,
  model: s.model,
  agentId: s.agent_id,
  completed: s.completed,
  kbSummaryTool: s.kb_summary_tool ?? false, // which setting the run used (the Diff shows it)
  reasoningLevel: s.reasoning_level ?? 'default',
  temperature: s.temperature ?? 0, // the setting the run used (the Diff shows it)
  logprobs: s.logprobs ?? false,
  sourceConversationId: s.source_conversation_id ?? null, // the chat it came from (null: an older replay)
  promptCount: s.prompt_count,
  responseCount: s.response_count,
  createdAt: s.created_at,
});

export const toSavedDetail = (d) => ({ ...toSummary(d), prompts: d.prompts, responses: d.responses.map(toResult) });

// ---- requests
/** Everything the page needs at the start. `run` is null when the user has no replay run yet. */
export async function loadReplayData() {
  const [conversation, saved, run] = await Promise.all([
    api.get('/api/conversations/current'),
    api.get('/api/saved-replays'),
    currentRun(),
  ]);
  return { conversation, saved: saved.map(toSummary), run };
}

/** The latest run, or null (404 just means "none yet"). */
export async function currentRun() {
  try {
    return toReplay(await api.get('/api/replay-runs/current'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Start a new run. Give at most one prompt source: `prompts` or `conversation_id`
 * (none = the current conversation). With `prompts`, `source_conversation_id` keeps the run tied to its chat. The server saves the previous run if it has results.
 */
export const createRun = async (body = {}) => toReplay(await api.post('/api/replay-runs', body));

/** Change models, agent, KB summary tool, reasoning level, temperature or log probabilities. Only allowed before the first step (409 `replay_locked` after). */
export const updateRun = async (runId, { modelA, modelB, agentId, kbSummaryTool, reasoningLevel, temperature, logprobs }) => {
  const body = {};
  if (modelA !== undefined) body.model_a = modelA;
  if (modelB !== undefined) body.model_b = modelB;
  if (agentId !== undefined) body.agent_id = agentId;
  if (kbSummaryTool !== undefined) body.kb_summary_tool = kbSummaryTool;
  if (reasoningLevel !== undefined) body.reasoning_level = reasoningLevel;
  if (temperature !== undefined) body.temperature = temperature;
  if (logprobs !== undefined) body.logprobs = logprobs;
  return toReplay(await api.patch(`/api/replay-runs/${runId}`, body));
};

/**
 * Run the next prompt on both models. All-or-nothing; the server rejects a stale `expectedCursor` (409).
 * `requestId` names this step so a stop command can target it.
 */
export const stepRun = async (runId, expectedCursor, requestId, signal) =>
  toReplay(
    await api.post(`/api/replay-runs/${runId}/steps`, { expected_cursor: expectedCursor, request_id: requestId }, { signal }),
  );

/**
 * The stop command for one step: it is discarded and the cursor stays. It works even when it reaches the server
 * before the step does (the server remembers the id and refuses that step when it arrives).
 */
export const stopRun = (runId, requestId) => api.post(`/api/replay-runs/${runId}/stop`, { request_id: requestId });

export const saveRun = async (runId) => toReplay(await api.post(`/api/replay-runs/${runId}/save`));

export const listSaved = async () => (await api.get('/api/saved-replays')).map(toSummary);
/** The raw REST calls behind one saved replay: { id, recorded, model, turns: [{turn_index, prompt, calls: [...]}] }. */
export const getApiLog = (id) => api.get(`/api/saved-replays/${encodeURIComponent(id)}/api-log`);
/** The answer tokens' log probabilities behind one saved replay: { id, available, turns: [{turn_index, tokens: [{token, logprob}] | null}] }. */
export const getLogprobs = (id) => api.get(`/api/saved-replays/${encodeURIComponent(id)}/logprobs`);
export const getSaved = async (id) => toSavedDetail(await api.get(`/api/saved-replays/${encodeURIComponent(id)}`));

// ---- Diff tab selection (pure, over the saved-replay summaries)
/** Keep the two diff selectors valid and distinct, among `savedReplays` (the open chat's; all of them by default). */
export function normalizeDiff(state, savedReplays = state.savedReplays) {
  if (savedReplays.length < 2) return;
  if (!savedReplays.some((r) => r.id === state.diffA)) state.diffA = savedReplays.at(-2).id;
  if (!savedReplays.some((r) => r.id === state.diffB) || state.diffB === state.diffA) {
    state.diffB = savedReplays.findLast((r) => r.id !== state.diffA).id;
  }
}

/** Choose a replay on one side; swap if it equals the other side. */
export function selectDiff(state, side, id) {
  const other = side === 'a' ? 'diffB' : 'diffA';
  const mine = side === 'a' ? 'diffA' : 'diffB';
  const previous = state[mine];
  state[mine] = id;
  if (state[mine] === state[other]) state[other] = previous;
}

export function compareWith(state, id, savedReplays = state.savedReplays) {
  state.diffA = id;
  state.diffB = savedReplays.findLast((r) => r.id !== id)?.id || '';
  state.replayTab = 'diff';
}
