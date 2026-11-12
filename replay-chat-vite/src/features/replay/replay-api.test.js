import { describe, expect, it } from 'vitest';
import { apiError, mockApi } from '../../test/mock-api.js';
import {
  compareWith, createRun, currentRun, getApiLog, getSaved, listSaved, loadReplayData, normalizeDiff, saveRun,
  selectDiff, stepRun, stopRun, toReplay, toSavedDetail, toSummary, updateRun,
} from './replay-api.js';

const run = (extra = {}) => ({
  replay_run_id: 'r1', agent_id: 'assistant', prompts: ['p1', 'p2'], model_a: 'm1', model_b: 'm2', cursor: 1,
  step_running: false, saved_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  results: {
    a: [{ replay_result_id: 'x1', slot: 'a', turn_index: 0, content: 'A0', model: 'm1', demo: true, error: false, decision_trace: null }],
    b: [{ replay_result_id: 'x2', slot: 'b', turn_index: 0, content: 'B0', model: 'm2', demo: false, error: false, decision_trace: [{ step: 'file' }] }],
  },
  ...extra,
}); // fmt: skip

const summary = { id: 'r1:a', replay_run_id: 'r1', slot: 'a', model: 'm1', agent_id: 'assistant', completed: false, prompt_count: 2, response_count: 1, created_at: '2026-01-02T00:00:00Z' };

describe('replay api', () => {
  it('maps a run to the shape the UI reads', () => {
    expect(toReplay(run())).toEqual({
      runId: 'r1',
      prompts: ['p1', 'p2'],
      selected: ['m1', 'm2'],
      cursor: 1,
      agentId: 'assistant',
      kbSummaryTool: false,
      reasoningLevel: 'default',
      temperature: 0,
      logprobs: false,
      briefReplies: false,
      contextSummary: null,
      sourceConversationId: null,
      results: {
        a: [{ content: 'A0', model: 'm1', demo: true, error: false, decision_trace: null, kb_summary: null, kb_version_deleted: false }],
        b: [{ content: 'B0', model: 'm2', demo: false, error: false, decision_trace: [{ step: 'file' }], kb_summary: null, kb_version_deleted: false }],
      },
      savedAt: null,
      stepRunning: false,
    });
  });

  it('maps saved replay summaries and details', () => {
    expect(toSummary(summary)).toEqual({
      id: 'r1:a', runId: 'r1', slot: 'a', model: 'm1', agentId: 'assistant', completed: false, kbSummaryTool: false, reasoningLevel: 'default', temperature: 0, logprobs: false, briefReplies: false, sourceConversationId: null,
      promptCount: 2, responseCount: 1, createdAt: '2026-01-02T00:00:00Z',
    }); // fmt: skip
    const detail = toSavedDetail({ ...summary, prompts: ['p1', 'p2'], responses: run().results.a });
    expect(detail.prompts).toEqual(['p1', 'p2']);
    expect(detail.responses[0]).toMatchObject({ content: 'A0', model: 'm1' });
    expect(detail.responseCount).toBe(1);
  });

  it('keeps the log probabilities switch (off when the server sends none) and sends a change, off included', async () => {
    expect(toReplay(run({ logprobs: true })).logprobs).toBe(true);
    expect(toReplay(run()).logprobs).toBe(false);
    expect(toSummary({ ...summary, logprobs: true }).logprobs).toBe(true);
    const mock = mockApi({ 'PATCH /api/replay-runs/:id': () => run() });
    await updateRun('r1', { logprobs: false });
    expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ logprobs: false }); // false is a real value, not "unset"
    await updateRun('r1', { logprobs: true });
    expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ logprobs: true });
  });

  it('keeps the temperature, 0 when the server sends none, and sends a changed one', async () => {
    expect(toReplay(run({ temperature: 0.7 })).temperature).toBe(0.7);
    expect(toReplay(run()).temperature).toBe(0);
    expect(toSummary({ ...summary, temperature: 1.5 }).temperature).toBe(1.5);
    const mock = mockApi({ 'PATCH /api/replay-runs/:id': () => run() });
    await updateRun('r1', { temperature: 0 });
    expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ temperature: 0 }); // 0 is a real value, not "unset"
  });

  it('fetches a saved replay\'s API log by its id (colon encoded)', async () => {
    const mock = mockApi({ 'GET /api/saved-replays/:id/api-log': () => ({ id: 'r1:a', recorded: true, model: 'm1', turns: [] }) });
    expect((await getApiLog('r1:a')).recorded).toBe(true);
    expect(mock.calls.at(-1).path).toBe('/api/saved-replays/r1%3Aa/api-log');
  });

  it('keeps the chat a run and its saved replays came from', () => {
    expect(toReplay(run({ source_conversation_id: 'c1' })).sourceConversationId).toBe('c1');
    expect(toSummary({ ...summary, source_conversation_id: 'c1' }).sourceConversationId).toBe('c1');
  });

  it('maps the KB summary tool, reasoning level, summaries and deleted-version flags', () => {
    const mapped = toReplay(run({
      kb_summary_tool: true, reasoning_level: 'high', context_summary: 'EARLIER',
      results: { a: [{ content: 'A0', model: 'm1', demo: false, error: false, decision_trace: null, kb_summary: 'summary by m1', kb_version_deleted: true }], b: [] },
    })); // fmt: skip
    expect(mapped).toMatchObject({ kbSummaryTool: true, reasoningLevel: 'high', contextSummary: 'EARLIER' });
    expect(mapped.results.a[0]).toMatchObject({ kb_summary: 'summary by m1', kb_version_deleted: true });
    expect(toSummary({ ...summary, kb_summary_tool: true, reasoning_level: 'low' })).toMatchObject({ kbSummaryTool: true, reasoningLevel: 'low' });
  });

  it('treats "no run yet" (404) as null but surfaces other errors', async () => {
    mockApi({ 'GET /api/replay-runs/current': apiError(404, 'not_found', 'Replay run not found.') });
    expect(await currentRun()).toBeNull();
    mockApi({ 'GET /api/replay-runs/current': apiError(500, 'oops', 'The server hit a problem.') });
    await expect(currentRun()).rejects.toMatchObject({ status: 500 });
  });

  it('loads everything the page needs in one go', async () => {
    mockApi({
      'GET /api/conversations/current': () => ({ conversation_id: 'c1', is_sample: false, messages: [] }),
      'GET /api/saved-replays': () => [summary],
      'GET /api/replay-runs/current': () => run(),
    });
    const data = await loadReplayData();
    expect(data.conversation.conversation_id).toBe('c1');
    expect(data.records).toBeUndefined(); // saved prompt lists are no longer shown
    expect(data.saved[0].id).toBe('r1:a');
    expect(data.run.runId).toBe('r1');
  });

  it('sends the right bodies', async () => {
    const mock = mockApi({
      'POST /api/replay-runs': () => run(),
      'PATCH /api/replay-runs/:id': () => run(),
      'POST /api/replay-runs/:id/steps': () => run(),
      'POST /api/replay-runs/:id/stop': () => ({ stopped: true }),
      'POST /api/replay-runs/:id/save': () => run(),
      'GET /api/saved-replays': () => [summary],
      'GET /api/saved-replays/:id': () => ({ ...summary, prompts: [], responses: [] }),
    });
    await createRun({ conversation_id: 'c1', model_a: 'm1' });
    expect(mock.lastBody('POST /api/replay-runs')).toEqual({ conversation_id: 'c1', model_a: 'm1' });
    await createRun();
    expect(mock.lastBody('POST /api/replay-runs')).toEqual({});
    await updateRun('r1', { modelA: 'm2', agentId: 'code' });
    expect(mock.lastBody('PATCH /api/replay-runs/:id')).toEqual({ model_a: 'm2', agent_id: 'code' });
    await stepRun('r1', 3, 'step-id-0001');
    expect(mock.lastBody('POST /api/replay-runs/:id/steps')).toEqual({ expected_cursor: 3, request_id: 'step-id-0001' });
    expect(await stopRun('r1', 'step-id-0001')).toEqual({ stopped: true });
    expect(mock.lastBody('POST /api/replay-runs/:id/stop')).toEqual({ request_id: 'step-id-0001' });
    await saveRun('r1');
    expect((await listSaved())[0].id).toBe('r1:a');
    await getSaved('r1:a');
    expect(mock.calls.at(-1).path).toBe('/api/saved-replays/r1%3Aa'); // the id contains a colon; the server decodes it
  });

  it('keeps the two diff selectors valid, distinct and swappable', () => {
    const state = { savedReplays: ['x', 'y', 'z'].map((id) => ({ id })), diffA: '', diffB: '' };
    normalizeDiff(state);
    expect([state.diffA, state.diffB]).toEqual(['y', 'z']);
    selectDiff(state, 'a', 'z');
    expect([state.diffA, state.diffB]).toEqual(['z', 'y']);
    compareWith(state, 'x');
    expect([state.diffA, state.diffB, state.replayTab]).toEqual(['x', 'z', 'diff']);
    const few = { savedReplays: [{ id: 'only' }], diffA: '', diffB: '' };
    normalizeDiff(few);
    expect([few.diffA, few.diffB]).toEqual(['', '']);
  });
});
