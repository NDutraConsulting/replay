import { describe, expect, it } from 'vitest';
import { apiDiffHTML, bindDiff, diffSettingsHTML, openReplayIntro, chatReplays, currentReplayNumber, runLabel, versionNumber, decisionTreeHTML, diffHTML, diffViewTabsHTML, historyHTML, lineDiff, replayConfigHTML, replayPageHTML, replayVersions, wordDiff } from './replay-ui.js';

// A saved replay: the summary fields (shown in lists) plus prompts/responses (loaded for the Diff tab).
const saved = (id, model, responses) => ({
  id, runId: `run-${id}`, slot: 'a', model, agentId: 'assistant', prompts: ['p1', 'p2'], responses, createdAt: '2026-01-01T00:00:00Z', completed: true,
  promptCount: 2, responseCount: responses.length, reasoningLevel: 'default', temperature: 0,
});
const view = (o = {}) => ({
  replay: { prompts: ['p1', 'p2'], selected: ['m1', 'm2'], cursor: 1, results: { a: [{ content: 'hi <b>', model: 'm1', demo: true }], b: [] }, agentId: 'assistant' },
  replayTab: 'replay', replayBusy: false, playing: false, stepped: true, playOverlay: null, playVersion: 3, activeResult: 'a', promptsHidden: false,
  chatRecords: [], savedReplays: [], savedDetails: {}, diffA: '', diffB: '', models: ['m1', 'm2'], connected: false, prompts: ['p1', 'p2'],
  agents: [{ id: 'assistant', name: 'General assistant' }, { id: 'code', name: 'Code assistant' }], ...o,
});

describe('wordDiff', () => {
  it('marks added and removed words, escaping html', () => {
    const d = wordDiff('a b <c>', 'a x <c>');
    expect(d.a).toContain('<mark class="diff-removed">b</mark>');
    expect(d.b).toContain('<mark class="diff-added">x</mark>');
    expect(d.a).toContain('&lt;c&gt;');
  });
  it('returns escaped text when equal', () => {
    expect(wordDiff('a&b', 'a&b')).toEqual({ a: 'a&amp;b', b: 'a&amp;b' });
  });
});

describe('lineDiff', () => {
  const view = (rows) => rows.map((r) => [r.type, r.a && r.a.n, r.b && r.b.n]);
  it('keeps unchanged lines on both sides, numbered', () => {
    const rows = lineDiff('one\ntwo', 'one\ntwo');
    expect(view(rows)).toEqual([['equal', 1, 1], ['equal', 2, 2]]);
    expect(rows[0].a.html).toBe('one');
  });
  it('pairs a changed line with its new wording and marks the changed words', () => {
    const rows = lineDiff('keep\nthe old plan\nend', 'keep\nthe new plan\nend');
    expect(view(rows)).toEqual([['equal', 1, 1], ['changed', 2, 2], ['equal', 3, 3]]);
    expect(rows[1].a.html).toContain('<mark class="diff-removed">old</mark>');
    expect(rows[1].b.html).toContain('<mark class="diff-added">new</mark>');
  });
  it('leaves a gap on the other side for a line only one side has', () => {
    expect(view(lineDiff('a\nb\nc', 'a\nc'))).toEqual([['equal', 1, 1], ['removed', 2, null], ['equal', 3, 2]]);
    expect(view(lineDiff('a\nc', 'a\nb\nc'))).toEqual([['equal', 1, 1], ['added', null, 2], ['equal', 2, 3]]);
  });
  it('pairs as many changed lines as it can, then leaves the rest as gaps', () => {
    expect(view(lineDiff('x\n1\n2', 'x\nA'))).toEqual([['equal', 1, 1], ['changed', 2, 2], ['removed', 3, null]]);
  });
  it('handles an empty side and escapes html', () => {
    expect(view(lineDiff('', 'new <b>'))).toEqual([['added', null, 1]]);
    expect(lineDiff('', 'new <b>')[0].b.html).toBe('new &lt;b&gt;');
    expect(lineDiff('', '')).toEqual([]);
  });
  it('keeps blank lines as lines', () => {
    expect(view(lineDiff('a\n\nb', 'a\n\nb'))).toEqual([['equal', 1, 1], ['equal', 2, 2], ['equal', 3, 3]]);
  });
});

describe('replay templates', () => {
  it('renders the replay tab and escapes results', () => {
    document.body.innerHTML = replayPageHTML(view());
    expect(document.querySelector('.progress-row').textContent).toContain('1 / 2 prompts');
    expect(document.querySelector('#result-content b')).toBeNull();
    expect(document.querySelectorAll('select[id^="model-"]')).toHaveLength(0); // the settings are in File > Config
    expect([...document.querySelectorAll('.result-tabs button')].map((b) => b.textContent)).toEqual(['A · m1', 'B · m2']);
  });
  it('shows the Model responses panel only after Step through was used', () => {
    document.body.innerHTML = replayPageHTML(view({ stepped: false }));
    expect(document.querySelector('.results')).toBeNull();
    expect(document.getElementById('result-content')).toBeNull();
    document.body.innerHTML = replayPageHTML(view({ stepped: true }));
    expect(document.querySelector('.results h2').textContent).toBe('Model responses');
  });
  it('shows a spinner popup naming the replay version while Play all runs, with a way to stop', () => {
    document.body.innerHTML = replayPageHTML(view({ playOverlay: 'running', playing: true, playVersion: 4 }));
    const overlay = document.querySelector('.play-overlay');
    expect(overlay.querySelector('.play-spinner')).not.toBeNull();
    expect(overlay.querySelector('h2').textContent).toBe('Replay v4 is running');
    expect(document.getElementById('stop-play')).not.toBeNull();
    expect(document.getElementById('view-diff-chat')).toBeNull();
    expect(document.getElementById('view-diff-api')).toBeNull();
    const popup = document.getElementById('play-all-popup');
    expect([...popup.querySelectorAll('.play-models li')].map((li) => li.textContent)).toEqual(['Am1', 'Bm2']);
    const chips = [...popup.querySelectorAll('.chip')].map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(['AgentGeneral assistant', 'Temperature0', 'KB summary toolOff', 'Log probsOff']));
  });
  it('swaps the spinner for a View Diff button when Play all has finished', () => {
    document.body.innerHTML = replayPageHTML(view({ playOverlay: 'done', playVersion: 4 }));
    const overlay = document.querySelector('.play-overlay');
    expect(overlay.querySelector('.play-spinner')).toBeNull();
    expect(overlay.querySelector('h2').textContent).toBe('Replay v4 complete');
    expect(document.getElementById('view-diff')).toBeNull();
    expect([...document.querySelectorAll('.play-actions button')].map((b) => b.textContent)).toEqual(['Diff API', 'Diff Chat']);
    expect(document.getElementById('play-all-popup').textContent).toContain('m1'); // still lists the models used
  });
  it('gives the Play all popup one id that no other element on the page uses', () => {
    document.body.innerHTML = replayPageHTML(view({ playOverlay: 'running' }));
    expect(document.querySelectorAll('#play-all-popup')).toHaveLength(1);
    expect(document.querySelector('.play-overlay').id).toBe('play-all-popup');
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('has no popup when Play all is not in use', () => {
    document.body.innerHTML = replayPageHTML(view());
    expect(document.querySelector('.play-overlay')).toBeNull();
  });
  it('has no intro heading on the page: that text is in the popup, and only the status badge is left in the row', () => {
    document.body.innerHTML = replayPageHTML(view());
    expect(document.querySelector('h1')).toBeNull();
    expect(document.body.textContent).not.toContain('Same conversation. Different results.');
    expect(document.body.textContent).not.toContain('Model & hardware comparison');
    expect(document.querySelector('.page-heading .eyebrow')).toBeNull();
    const row = document.querySelector('.page-heading.replay-status-row');
    expect([...row.children].map((c) => c.className)).toEqual(['badge']);
    document.body.innerHTML = replayPageHTML(view({ replayBusy: true }));
    expect(document.querySelector('.replay-status-row .badge').textContent).toContain('Replay in progress');
  });
  it('builds the intro popup from the three lines that used to head the page', () => {
    document.body.innerHTML = '';
    openReplayIntro();
    const modal = document.querySelector('.modal.replay-intro-modal');
    expect(modal.querySelector('h2').textContent).toBe('Model & hardware comparison');
    expect(modal.querySelector('.modal-lead').textContent).toBe('Same conversation. Different results.');
    expect(modal.querySelector('.modal-text').textContent).toBe('Replay your prompts on other models, then compare how the output differs.');
    expect(modal.querySelectorAll('.modal-actions button')).toHaveLength(1);
  });
  it('puts the Config button in the controls row, just to the right of Play all, and not in the results header', () => {
    document.body.innerHTML = replayPageHTML(view());
    const row = document.querySelector('.replay-controls');
    expect([...row.children].map((b) => b.id)).toEqual(['reset-replay', 'step-replay', 'play-replay', 'open-config']);
    expect(document.getElementById('play-replay').nextElementSibling).toBe(document.getElementById('open-config'));
    expect(row.lastElementChild.id).toBe('open-config'); // the far right of the row
    expect(document.querySelector('.results-head #open-config')).toBeNull();
    expect(document.querySelector('.results-head').children).toHaveLength(1); // only the title and its replay number are left
  });
  it('has a Config button where Save replay was, and no Save replay button', () => {
    document.body.innerHTML = replayPageHTML(view());
    expect(document.getElementById('save-replay')).toBeNull();
    const button = document.querySelector('.replay-controls #open-config');
    expect(button.textContent).toBe('Config');
    expect(button.disabled).toBe(false);
    expect(button.querySelector('svg')).not.toBeNull();
    document.body.innerHTML = replayPageHTML(view({ replay: { ...view().replay, cursor: 0 }, replayBusy: true }));
    expect(document.getElementById('open-config').disabled).toBe(false); // it can be opened while a replay runs
  });
  it('lets the settings be changed after the replay has started, with a note saying that resets it', () => {
    const settings = ['replay-agent', 'replay-reasoning', 'replay-temperature', 'replay-kb-summary', 'replay-logprobs', 'model-a', 'model-b'];
    document.body.innerHTML = replayConfigHTML(view()); // the helper's run is at cursor 1
    for (const id of settings) expect(document.getElementById(id).disabled, id).toBe(false);
    expect(document.querySelector('.config-reset-note').textContent).toContain('Changing any setting resets it');
    expect(document.querySelector('[data-tip*="resets the replay"]')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain('Locked once the replay starts');
  });
  it('shows no reset note before the replay starts, and greys the settings out only while it runs', () => {
    const fresh = { ...view().replay, cursor: 0 };
    document.body.innerHTML = replayConfigHTML(view({ replay: fresh }));
    expect(document.querySelector('.config-reset-note')).toBeNull();
    document.body.innerHTML = replayConfigHTML(view({ replay: fresh, replayBusy: true }));
    for (const id of ['replay-agent', 'replay-temperature', 'replay-logprobs', 'model-a']) expect(document.getElementById(id).disabled, id).toBe(true);
  });
  it('renders the settings for the File > Config popup', () => {
    document.body.innerHTML = replayConfigHTML(view());
    expect(document.querySelectorAll('select[id^="model-"]')).toHaveLength(2);
    expect(document.getElementById('model-a').value).toBe('m1');
    expect(document.getElementById('model-b').value).toBe('m2');
    expect(document.getElementById('replay-agent').value).toBe('assistant');
  });
  it('shows a loading note until the two saved replays have been fetched', () => {
    const a = saved('a', 'm1', [{ content: 'one' }]);
    const b = saved('b', 'm2', [{ content: 'one' }]);
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a }, diffA: 'a', diffB: 'b' }));
    expect(document.querySelector('[role="status"]').textContent).toContain('Loading the comparison');
    expect(document.querySelector('.diff-turn')).toBeNull();
    expect(document.getElementById('diff-a')).not.toBeNull(); // the selectors stay usable while loading
    expect(document.getElementById('diff-b')).not.toBeNull();
  });

  const slotSummary = (runId, slot, extra = {}) => ({
    id: `${runId}:${slot}`, runId, slot, model: slot === 'a' ? 'm1' : 'm2', agentId: 'code', completed: false, kbSummaryTool: false,
    reasoningLevel: 'default', sourceConversationId: 'c1', promptCount: 5, responseCount: 2, createdAt: '2026-01-01T00:00:00Z', ...extra,
  }); // fmt: skip
  const chat = {
    conversation_id: 'c1', name: 'Launch <plan>',
    messages: [
      { role: 'user', content: 'first <b>question</b>', status: 'complete', message_type: 'chat' },
      { role: 'assistant', content: 'an answer\nover two lines', status: 'complete', message_type: 'chat', agent: 'IT Security Assistant', model: 'm1' },
      { role: 'user', content: 'second question', status: 'complete', message_type: 'chat' },
    ],
  };
  it('has no Chat History heading or Replay this chat button, only the saved replays', () => {
    document.body.innerHTML = historyHTML(view({ chat }));
    expect(document.body.textContent).not.toContain('Chat History');
    expect(document.getElementById('replay-current')).toBeNull();
    expect(document.querySelector('.history-details')).toBeNull();
    expect(document.querySelector('h2').textContent).toBe('Saved replays');
  });
  it('says so when the chat is empty', () => {
    document.body.innerHTML = historyHTML(view({ chat: { ...chat, messages: [] } }));
    expect(document.body.textContent).toContain('Nothing here yet');
  });
  it("lists this chat's saved replays as numbered versions, newest first, with their A and B slots", () => {
    const savedReplays = [slotSummary('r1', 'a'), slotSummary('r1', 'b'), slotSummary('r2', 'a', { completed: true, responseCount: 5 }), slotSummary('r2', 'b')];
    document.body.innerHTML = historyHTML(view({ chat, savedReplays }));
    expect([...document.querySelectorAll('.version-head h3')].map((h) => h.textContent)).toEqual(['Replay v2', 'Replay v1']);
    expect(document.querySelector('.saved-records-heading .badge').textContent).toBe('2 versions');
    expect(document.querySelectorAll('.record-row')).toHaveLength(4);
    expect(document.body.textContent).toContain('2 / 5 prompts');
    expect(document.body.textContent).toContain('Code assistant');
    expect(document.body.textContent).toContain('Partial replay');
    expect(document.body.textContent).toContain('A · m1');
    expect(document.querySelector('[data-compare-record="r2:b"]')).not.toBeNull();
  });
  it('puts an API log button beside Diff on every saved replay, including earlier ones', () => {
    const savedReplays = [slotSummary('r1', 'a'), slotSummary('r1', 'b'), slotSummary('r2', 'a', { sourceConversationId: null })];
    document.body.innerHTML = historyHTML(view({ chat, savedReplays }));
    expect([...document.querySelectorAll('[data-api-log]')].map((b) => b.dataset.apiLog)).toEqual(['r1:a', 'r1:b', 'r2:a']);
    expect(document.querySelector('[data-api-log="r1:a"]').textContent).toBe('API log');
    expect(document.querySelector('[data-api-log="r1:a"]').nextElementSibling.dataset.compareRecord).toBe('r1:a');
  });
  it("leaves other chats' replays out and puts unlinked ones under Earlier replays", () => {
    const savedReplays = [slotSummary('r1', 'a', { sourceConversationId: 'other' }), slotSummary('r2', 'a', { sourceConversationId: null }), slotSummary('r3', 'a')];
    document.body.innerHTML = historyHTML(view({ chat, savedReplays }));
    expect([...document.querySelectorAll('.version-head h3')].map((h) => h.textContent)).toEqual(['Replay v1', 'Earlier replay']);
    expect(document.querySelector('[data-compare-record="r1:a"]')).toBeNull();
    expect(document.body.textContent).toContain('Earlier replays');
  });
  it('shows an empty state when the chat has no saved replays yet', () => {
    document.body.innerHTML = historyHTML(view({ chat }));
    expect(document.body.textContent).toContain('No replay versions yet');
    expect(document.body.textContent).not.toContain('Earlier replays');
  });
  it('numbers versions per chat by when the runs were created', () => {
    const list = [slotSummary('r1', 'a'), slotSummary('r1', 'b'), slotSummary('x', 'a', { sourceConversationId: 'other' }), slotSummary('r2', 'a')];
    expect(replayVersions(list, 'c1').map((v) => [v.version, v.runId, v.slots.length])).toEqual([[1, 'r1', 2], [2, 'r2', 1]]);
    expect(replayVersions(list, 'nope')).toEqual([]);
  });

  it('renders the diff as aligned side-by-side lines, with gaps and line numbers', () => {
    const a = saved('a', 'm1', [{ content: 'same\nonly in A\nthe old end' }]);
    const b = saved('b', 'm2', [{ content: 'same\nthe new end\nnew line\n<i>extra</i>' }]);
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
    expect([...document.querySelectorAll('.diff-turn .diff-head .diff-cell')].map((c) => c.textContent)).toEqual(['Replay A · m1 · Temperature 0 · Reasoning Default', 'Replay B · m2 · Temperature 0 · Reasoning Default']); // the models, temperature and reasoning level, above the lines
    const rows = [...document.querySelectorAll('.diff-turn .diff-row:not(.diff-head)')];
    expect(rows.map((r) => r.className.replace('diff-row ', ''))).toEqual(['equal', 'changed', 'changed', 'added']);
    expect(rows[0].querySelectorAll('.diff-num')[0].textContent).toBe('1');
    expect(rows[3].querySelector('.diff-cell.a').classList.contains('gap')).toBe(true);
    expect(rows[3].querySelector('.diff-cell.b').textContent).toBe('<i>extra</i>');
    expect(document.querySelector('.diff-turn i')).toBeNull();
    expect(document.querySelector('.diff-turn .diff-row.equal .diff-cell.a').classList.contains('removed')).toBe(false);
  });
  it('names every side of the Diff with its model, temperature and reasoning level', () => {
    const a = { ...saved('a', 'm1', [{ content: 'one' }]), temperature: 0, reasoningLevel: 'default' };
    const b = { ...saved('b', 'm2', [{ content: 'two' }]), temperature: 1.2, reasoningLevel: 'high' };
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
    expect([...document.querySelectorAll('.diff-turn:first-child .result-label span:first-child')].map((e) => e.textContent)).toEqual(['REPLAY A · m1 · Temperature 0 · Reasoning Default', 'REPLAY B · m2 · Temperature 1.2 · Reasoning High']);
    expect([...document.querySelectorAll('.diff-turn:first-child > .diff-lines .diff-head .diff-cell')].map((e) => e.textContent)).toEqual(['Replay A · m1 · Temperature 0 · Reasoning Default', 'Replay B · m2 · Temperature 1.2 · Reasoning High']);
    expect(document.getElementById('diff-b').textContent).toContain('m2 · temp 1.2 · reasoning high');
  });
  it('names a saved replay\'s model with its temperature and reasoning level', () => {
    const summary = { id: 'r1:a', runId: 'r1', slot: 'a', model: 'm1', agentId: 'code', completed: true, promptCount: 2, responseCount: 2, createdAt: '2026-01-01T00:00:00Z', sourceConversationId: 'c1', temperature: 0.7, reasoningLevel: 'xhigh' };
    document.body.innerHTML = historyHTML(view({ chat: { conversation_id: 'c1', name: 'x', messages: [] }, savedReplays: [summary] }));
    expect(document.querySelector('.record-detail h3').textContent).toBe('A · m1 · Temperature 0.7 · Reasoning Extra high');
  });
  describe('log prob cliffs in the Diff', () => {
    const tokens = (...pairs) => pairs.map(([token, logprob]) => ({ token, logprob }));
    const cliffDiff = (contentA, tokensA, contentB, tokensB, extra = {}) => {
      const a = { ...saved('a', 'm1', [{ content: contentA }]), logprobs: true };
      const b = { ...saved('b', 'm2', [{ content: contentB }]), logprobs: true };
      const turns = (t) => ({ turns: [{ turn_index: 0, tokens: t }] });
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, savedLogprobs: { a: turns(tokensA), b: turns(tokensB) }, diffA: 'a', diffB: 'b', ...extra }));
    };
    const cliffs = (side) => [...document.querySelectorAll(`.diff-turn:first-child > .diff-lines .diff-cell.${side} .logprob-cliff`)];

    it('marks the cliff words in red, with the cliff value in the tooltip', () => {
      cliffDiff('Plan the launch today', tokens(['Plan', -0.1], [' the', -0.1], [' launch', -3.4], [' today', -0.3]), 'Plan the launch today', tokens(['Plan', -0.1], [' the', -0.1], [' launch', -0.2], [' today', -0.3]));
      expect(cliffs('a').map((e) => e.textContent)).toEqual([' launch']);
      expect(cliffs('b')).toEqual([]);
      const tip = cliffs('a')[0].dataset.cliffTip;
      expect(tip.split('\n')[0]).toBe('Log prob cliff: 3.30');
      expect(tip).toContain('This token: -3.40');
      expect(tip).toContain('Token before: -0.10');
      expect(cliffs('a')[0].getAttribute('tabindex')).toBe('0'); // reachable by keyboard
    });

    it('keeps the diff marks and puts the cliff inside them, on the right side', () => {
      // the answers split at " the" / " a" (a divergence); " old" comes later and is a cliff that sits inside a diff mark
      cliffDiff('keep the old plan today', tokens(['keep', -0.1], [' the', -0.1], [' old', -4], [' plan', -0.1], [' today', -0.1]), 'keep a new plan today', tokens(['keep', -0.1], [' a', -0.1], [' new', -0.2], [' plan', -0.1], [' today', -0.1]));
      const cellA = document.querySelector('.diff-turn:first-child .diff-row:not(.diff-head) .diff-cell.a');
      expect(cellA.textContent).toBe('keep the old plan today'); // nothing lost or doubled
      expect(cliffs('a').map((e) => e.textContent).join('')).toBe(' old');
      expect(cliffs('a').some((e) => e.closest('mark.diff-removed'))).toBe(true); // the cliff sits inside the diff mark
      expect(cliffs('b')).toEqual([]);
      expect([...document.querySelectorAll('.diff-turn:first-child .diff-cell.b mark.diff-added')].map((e) => e.textContent).join('')).toContain('new');
    });

    it('finds a cliff on a later line by its place in the whole answer, and none on the lines around it', () => {
      const text = 'line one\nline two goes wrong\nline three';
      cliffDiff(text, tokens(['line one\nline two', -0.1], [' goes', -0.1], [' wrong', -5], ['\nline three', -0.1]), text, tokens(['line one\nline two goes wrong\nline three', -0.1]));
      expect(cliffs('a').map((e) => e.textContent)).toEqual([' wrong']);
      const rows = [...document.querySelectorAll('.diff-turn:first-child .diff-row:not(.diff-head)')];
      expect(rows.map((r) => r.querySelectorAll('.diff-cell.a .logprob-cliff').length)).toEqual([0, 1, 0]);
    });

    it('draws a cliff that spans two words as one red run, and escapes the text', () => {
      cliffDiff('a <b>x</b> c', tokens(['a', -0.1], [' <b>x</b>', -6], [' c', -0.1]), 'a <b>x</b> c', null);
      expect(cliffs('a').map((e) => e.textContent)).toEqual([' <b>x</b>']);
      expect(document.querySelector('.diff-turn b')).toBeNull();
    });

    it('counts the cliffs in the label of each side and adds a legend entry', () => {
      cliffDiff('x y', tokens(['x', 0], [' y', -9]), 'x y', tokens(['x', 0], [' y', 0]));
      const labels = [...document.querySelectorAll('.diff-turn:first-child .result-label span:last-child')].map((e) => e.textContent);
      expect(labels).toEqual(['Unchanged · 1 log prob cliff', 'Unchanged · 0 log prob cliffs']); // 0 is said, not left blank
      expect(document.querySelector('.diff-legend').textContent).toContain('Log prob cliff');
      expect(document.querySelector('.diff-legend .logprob-cliff-swatch')).not.toBeNull();
    });

    it('shows nothing extra for replays without log probabilities', () => {
      const a = saved('a', 'm1', [{ content: 'one two' }]);
      const b = saved('b', 'm2', [{ content: 'one three' }]);
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
      expect(document.querySelector('.logprob-cliff')).toBeNull();
      expect(document.querySelector('.diff-legend').textContent).not.toContain('Log prob cliff');
      expect(document.querySelector('.result-label').textContent).not.toContain('cliff');
    });

    it('survives log probabilities that do not match the text', () => {
      cliffDiff('hello world', tokens(['zzz', 0], [' qqq', -9]), 'hello world', tokens(['hello world', 0]));
      expect(cliffs('a')).toEqual([]);
      expect(document.querySelector('.diff-turn:first-child .diff-row:not(.diff-head) .diff-cell.a').textContent).toBe('hello world');
    });
  });
  describe('replays are numbered per chat, and the Diff compares one chat\'s replays', () => {
    const slot = (runId, chat, s = 'a', extra = {}) => ({
      ...saved(`${runId}:${s}`, 'm1', [{ content: `${runId} ${s}` }]), runId, slot: s, sourceConversationId: chat, ...extra,
    }); // fmt: skip
    const everything = [slot('r1', 'x'), slot('r1', 'x', 'b'), slot('r2', 'y'), slot('r2', 'y', 'b'), slot('r3', 'x'), slot('r3', 'x', 'b'), slot('r4', 'y'), slot('r4', 'y', 'b')];

    it('keeps only the chat\'s own replays, or all of them when no chat is on screen', () => {
      expect(chatReplays(everything, 'x').map((r) => r.runId)).toEqual(['r1', 'r1', 'r3', 'r3']);
      expect(chatReplays(everything, 'y').map((r) => r.runId)).toEqual(['r2', 'r2', 'r4', 'r4']);
      expect(chatReplays(everything, 'nobody')).toEqual([]);
      expect(chatReplays(everything, undefined)).toHaveLength(8);
      expect(chatReplays(everything, null)).toHaveLength(8);
    });

    it('numbers a replay from 1 within its chat, both of its slots alike', () => {
      const x = chatReplays(everything, 'x');
      const y = chatReplays(everything, 'y');
      expect(x.map((r) => versionNumber(x, r))).toEqual([1, 1, 2, 2]);
      expect(y.map((r) => versionNumber(y, r))).toEqual([1, 1, 2, 2]); // chat y starts at 1 too, though r2 is the 2nd replay overall
    });

    it('writes the number, the slot and the model into the Diff\'s picker labels', () => {
      const x = chatReplays(everything, 'x');
      expect(runLabel(x[2], x).startsWith('Replay v2 · A · m1 · temp 0 · reasoning default · ')).toBe(true);
      expect(runLabel(x[2], x)).toMatch(/ · \d+ turns$/);
      expect(runLabel(x[3], x).startsWith('Replay v2 · B · ')).toBe(true);
      expect(runLabel(x[0], x).startsWith('Replay v1 · A · ')).toBe(true);
    });

    it('offers only the open chat\'s replays in the Diff, numbered from 1', () => {
      const chatX = { conversation_id: 'x', name: 'X', messages: [] };
      document.body.innerHTML = diffHTML(view({ chat: chatX, savedReplays: everything, savedDetails: {}, diffA: 'r1:a', diffB: 'r3:a' }));
      const options = [...document.querySelectorAll('#diff-a option')];
      expect(options.map((o) => o.value)).toEqual(['r3:b', 'r3:a', 'r1:b', 'r1:a']); // newest first, chat X only
      expect(options.map((o) => o.textContent.split(' · ').slice(0, 2).join(' '))).toEqual(['Replay v2 B', 'Replay v2 A', 'Replay v1 B', 'Replay v1 A']);
      const chatY = { conversation_id: 'y', name: 'Y', messages: [] };
      document.body.innerHTML = diffHTML(view({ chat: chatY, savedReplays: everything, savedDetails: {}, diffA: 'r2:a', diffB: 'r4:a' }));
      expect([...document.querySelectorAll('#diff-a option')].map((o) => o.value)).toEqual(['r4:b', 'r4:a', 'r2:b', 'r2:a']);
      expect(document.querySelector('#diff-a option[value="r4:a"]').textContent).toContain('Replay v2 · A');
    });

    it('says two replays of this chat are needed when it has fewer, however many other chats have', () => {
      const lonely = { conversation_id: 'z', name: 'Z', messages: [] };
      document.body.innerHTML = diffHTML(view({ chat: lonely, savedReplays: everything }));
      expect(document.body.textContent).toContain('Two replays make a comparison');
      expect(document.body.textContent).toContain('of this chat are needed');
      expect(document.getElementById('diff-a')).toBeNull();
      const one = [slot('only', 'z')];
      document.body.innerHTML = diffHTML(view({ chat: lonely, savedReplays: [...everything, ...one] }));
      expect(document.body.textContent).toContain('Two replays make a comparison'); // one is still not two
    });

    it('compares a chat\'s two replays once it has them', () => {
      const chatX = { conversation_id: 'x', name: 'X', messages: [] };
      const a = chatReplays(everything, 'x');
      const details = Object.fromEntries(a.map((r) => [r.id, r]));
      document.body.innerHTML = diffHTML(view({ chat: chatX, savedReplays: everything, savedDetails: details, diffA: 'r1:a', diffB: 'r3:a' }));
      expect(document.querySelectorAll('.diff-turn').length).toBeGreaterThan(0);
    });

    it('enables Diff on a version row only when its chat has two replays, and never on an earlier one', () => {
      const chatX = { conversation_id: 'x', name: 'X', messages: [{ role: 'user', content: 'q', status: 'complete', message_type: 'chat' }] };
      const earlier = slot('old', null);
      document.body.innerHTML = historyHTML(view({ chat: chatX, savedReplays: [...everything, earlier] }));
      expect(document.querySelector('[data-compare-record="r1:a"]').disabled).toBe(false); // x has two replays
      document.body.innerHTML = historyHTML(view({ chat: chatX, savedReplays: [slot('r1', 'x'), slot('r2', 'y'), slot('r4', 'y')] }));
      expect(document.querySelector('[data-compare-record="r1:a"]').disabled).toBe(true); // others have plenty, x has one
      document.body.innerHTML = historyHTML(view({ chat: chatX, savedReplays: [...everything, earlier] }));
      const old = document.querySelector('[data-compare-record="old:a"]');
      expect(old.disabled).toBe(true);
      expect(old.title).toContain('not tied to a chat');
      expect(document.querySelector('.saved-records-heading:last-of-type .small').textContent).toContain('cannot be compared');
    });

    it('numbers the run on screen: the next version of its chat, or its own once it is saved', () => {
      const chatX = { conversation_id: 'x', name: 'X', messages: [] };
      const run = (runId) => ({ ...view().replay, runId });
      expect(currentReplayNumber(view({ chat: chatX, savedReplays: [], replay: run('fresh') }))).toBe(1);
      expect(currentReplayNumber(view({ chat: chatX, savedReplays: everything, replay: run('fresh') }))).toBe(3); // r1 and r3 are saved
      expect(currentReplayNumber(view({ chat: chatX, savedReplays: everything, replay: run('r3') }))).toBe(2); // saved: its own number
      expect(currentReplayNumber(view({ chat: { conversation_id: 'y', name: 'Y', messages: [] }, savedReplays: everything, replay: run('fresh') }))).toBe(3);
      expect(currentReplayNumber(view({ chat: { conversation_id: 'new', name: 'N', messages: [] }, savedReplays: everything, replay: run('fresh') }))).toBe(1); // a chat never replayed starts at 1
    });

    it('shows that number as a badge on the Replay tab', () => {
      const chatX = { conversation_id: 'x', name: 'X', messages: [] };
      document.body.innerHTML = replayPageHTML(view({ chat: chatX, savedReplays: everything, replay: { ...view().replay, runId: 'fresh' } }));
      const badge = document.querySelector('.results-head #replay-number');
      expect(badge.textContent).toBe('Replay v3');
      document.body.innerHTML = replayPageHTML(view({ chat: { conversation_id: 'n', name: 'N', messages: [] }, savedReplays: everything }));
      expect(document.getElementById('replay-number').textContent).toBe('Replay v1');
    });
  });

  describe('the Diff views: Chat and API logs', () => {
    const call = (purpose, model = 'm1') => ({
      at: '2026-01-01T00:00:00Z', purpose, method: 'POST', url: 'https://api.openai.com/v1/chat/completions', duration_ms: 20,
      request: { headers: { Authorization: 'Bearer <redacted>' }, body: { model } }, response: { status: 200, body: '{"ok":true}', truncated: false }, error: null,
    }); // fmt: skip
    const log = (id, turns, extra = {}) => ({ id, recorded: true, model: 'm', temperature: 0, reasoning_level: 'default', logprobs: false, turns, ...extra });
    const turn = (n, calls, prompt = `p${n + 1}`) => ({ turn_index: n, prompt, calls });
    const page = (apiLogs, which = 'api') => {
      const a = saved('a', 'm1', [{ content: 'one' }]);
      const b = saved('b', 'm2', [{ content: 'two' }]);
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b', diffView: which, apiLogs }));
    };

    it('offers Chat and API logs as tabs, Chat selected by default', () => {
      page({}, 'chat');
      const tabs = [...document.querySelectorAll('.diff-views [role="tab"]')];
      expect(tabs.map((t) => t.textContent)).toEqual(['Chat', 'API logs']);
      expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
      expect(document.querySelector('.diff-views').getAttribute('role')).toBe('tablist');
      expect(document.querySelector('.diff-table')).not.toBeNull();
      expect(document.querySelector('.api-diff')).toBeNull();
    });

    it('selects API logs and swaps the answers for the API calls', () => {
      page({ a: log('a', [turn(0, [call('answer')])]), b: log('b', [turn(0, [call('answer', 'm2')])]) });
      expect([...document.querySelectorAll('.diff-views [role="tab"]')].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
      expect(document.querySelector('.diff-table')).toBeNull();
      expect(document.querySelector('.api-diff')).not.toBeNull();
      expect(document.querySelector('.diff-selectors')).not.toBeNull(); // the pickers stay above both views
    });

    it('shows a loading note until both logs have arrived', () => {
      page({ a: log('a', []) });
      expect(document.querySelector('[role="status"]').textContent).toContain('Loading the API logs');
      expect(document.querySelector('.api-pair')).toBeNull();
    });

    const rowsOf = (pair) => [...pair.querySelectorAll('.diff-row:not(.diff-head)')];
    const cell = (row, side) => row.querySelector(`.diff-cell.${side}`).textContent;
    const withBody = (purpose, body, extra = {}) => ({ ...call(purpose), request: { headers: { Authorization: 'Bearer <redacted>' }, body }, ...extra });

    it('puts A\'s call beside B\'s, prompt by prompt, open, headed by the models, with no collapsibles', () => {
      page({
        a: log('a', [turn(0, [call('kb_route:category'), call('kb_route:file'), call('answer')]), turn(1, [call('answer')])]),
        b: log('b', [turn(0, [call('kb_route:category', 'm2'), call('answer', 'm2')]), turn(1, [call('answer', 'm2')])]),
      });
      expect(document.querySelector('.api-diff-head').textContent).toContain('Replay A · m1 · Temperature 0 · Reasoning Default');
      expect(document.querySelector('.api-diff-head').textContent).toContain('Replay B · m2');
      expect(document.querySelector('details')).toBeNull(); // nothing is collapsed
      const turns = [...document.querySelectorAll('.api-diff-turn')];
      expect(turns.map((t) => t.querySelector('.eyebrow').textContent)).toEqual(['Prompt 01', 'Prompt 02']);
      expect(turns[0].querySelector('.small').textContent).toBe('A made 3 calls, B made 2');
      const pairs = [...turns[0].querySelectorAll('.api-pair')];
      expect(pairs).toHaveLength(3);
      expect(pairs.map((p) => p.querySelector('h4').textContent)).toEqual(['#1 KB routing · Category', '#2 KB routing · File / Answer', '#3 Answer']);
      expect(pairs[0].querySelector('.api-pair-brief').textContent).toBe('A · 200 · 20 msB · 200 · 20 ms');
      expect(pairs[2].querySelector('.api-pair-brief').textContent).toContain('B · no call');
    });

    it('compares each pair line by line: same lines level, differing lines marked, the model changed', () => {
      page({ a: log('a', [turn(0, [call('answer', 'm1')])]), b: log('b', [turn(0, [call('answer', 'm2')])]) });
      const pair = document.querySelector('.api-pair');
      expect(pair.querySelector('.diff-head')).toBeNull(); // the sides are named once, at the top
      const rows = rowsOf(pair);
      expect(rows.some((r) => r.classList.contains('equal'))).toBe(true);
      const changed = rows.filter((r) => r.classList.contains('changed'));
      expect(changed.map((r) => [cell(r, 'a').trim(), cell(r, 'b').trim()])).toEqual([['"model": "m1"', '"model": "m2"']]);
      expect(changed[0].querySelector('.diff-cell.a mark.diff-removed').textContent).toContain('m1');
      expect(changed[0].querySelector('.diff-cell.b mark.diff-added').textContent).toContain('m2');
      expect(rows.map((r) => cell(r, 'a').trim())).toContain('POST https://api.openai.com/v1/chat/completions');
    });

    it('lists the settings, the request line, headers and body, and the response, under headings', () => {
      page({ a: log('a', [turn(0, [call('answer')])]), b: log('b', [turn(0, [call('answer')])]) });
      const texts = rowsOf(document.querySelector('.api-pair')).map((r) => cell(r, 'a'));
      expect(texts.filter((t) => !t.startsWith(' '))).toEqual(['Settings', 'Request', 'Response']);
      expect(texts.some((t) => t.includes('Temperature: not in this request'))).toBe(true);
      expect(texts.some((t) => t.includes('Authorization: Bearer <redacted>'))).toBe(true);
      expect(texts.some((t) => t.includes('Status 200'))).toBe(true);
      expect(texts.some((t) => t.includes('"ok": true'))).toBe(true); // the response, indented
      const headings = [...document.querySelectorAll('.api-pair .diff-cell.a.heading')].map((c) => c.textContent);
      expect(headings).toEqual(['Settings', 'Request', 'Response']);
    });

    it('shows where the requests differ: a setting that went out on one side only', () => {
      page({
        a: log('a', [turn(0, [withBody('answer', { model: 'm1', temperature: 0, messages: [] })])]),
        b: log('b', [turn(0, [withBody('answer', { model: 'm1', messages: [] })])]),
      });
      const rows = rowsOf(document.querySelector('.api-pair'));
      const removed = rows.filter((r) => r.classList.contains('removed'));
      expect(removed.map((r) => cell(r, 'a').trim())).toEqual(['"temperature": 0,']);
      expect(removed[0].querySelector('.diff-cell.b').classList.contains('gap')).toBe(true);
    });

    it('leaves a gap on the side that made no call', () => {
      page({ a: log('a', [turn(0, [call('answer'), call('kb_route:file')])]), b: log('b', [turn(0, [call('answer')])]) });
      const second = document.querySelectorAll('.api-pair')[1];
      const rows = rowsOf(second);
      expect(rows.every((r) => r.classList.contains('removed'))).toBe(true);
      expect(rows.every((r) => r.querySelector('.diff-cell.b').classList.contains('gap'))).toBe(true);
      expect(second.querySelector('h4').textContent).toBe('#2 KB routing · File');
    });

    it('keeps a log prob list to one line per token so the comparison stays readable', () => {
      const tokens = Array.from({ length: 50 }, (_, i) => ({ token: `w${i}`, logprob: -0.1, bytes: [1, 2], top_logprobs: [] }));
      const body = JSON.stringify({ choices: [{ message: { content: 'x' }, logprobs: { content: tokens } }] });
      const withTokens = { ...call('answer'), response: { status: 200, body, truncated: false } };
      page({ a: log('a', [turn(0, [withTokens])]), b: log('b', [turn(0, [withTokens])]) });
      const lines = rowsOf(document.querySelector('.api-pair')).map((r) => cell(r, 'a'));
      expect(lines.filter((l) => l.includes('"token":"w')).length).toBe(50); // one line each
      expect(lines.length).toBeLessThan(80);
    });

    it('numbers the calls within each prompt', () => {
      page({ a: log('a', [turn(0, [call('answer')]), turn(1, [call('answer')])]), b: log('b', [turn(0, [call('answer')]), turn(1, [call('answer')])]) });
      const second = document.querySelectorAll('.api-diff-turn')[1];
      expect(second.querySelector('.api-pair h4').textContent).toBe('#1 Answer');
    });

    it('skips a prompt neither side made a call for', () => {
      page({ a: log('a', [turn(0, []), turn(1, [call('answer')])]), b: log('b', [turn(0, []), turn(1, [call('answer')])]) });
      expect(document.querySelectorAll('.api-diff-turn')).toHaveLength(1);
      expect(document.querySelector('.api-diff-turn .eyebrow').textContent).toBe('Prompt 02');
    });

    it('says why a side has no log, and explains an empty one', () => {
      page({ a: log('a', [turn(0, [call('answer')])]), b: log('b', [turn(0, [])], { recorded: false }) });
      expect(document.querySelector('.api-diff-note').textContent).toBe('Replay B: no API log was kept (it was saved before API logs existed).');
      expect(document.querySelectorAll('.api-diff-turn')).toHaveLength(1);
      page({ a: log('a', [turn(0, [])]), b: log('b', [turn(0, [])]) });
      expect(document.querySelector('.api-diff').textContent).toContain('demo mode');
      page({ a: { id: 'a', failed: true, recorded: false, turns: [] }, b: log('b', [turn(0, [call('answer')])]) });
      expect(document.querySelector('.api-diff-note').textContent).toBe('Replay A: the API log could not be loaded.');
    });

    it('binds the tabs: a click picks the view, the arrow keys move between them', () => {
      page({}, 'chat');
      const picked = [];
      bindDiff({ onSelect() {}, onView: (v) => picked.push(v) });
      document.getElementById('diff-view-api').click();
      document.getElementById('diff-view-chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      document.getElementById('diff-view-api').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      expect(picked).toEqual(['api', 'api', 'chat']);
    });

    it('escapes prompts from the data', () => {
      const a = { ...saved('a', 'm1', [{ content: 'x' }]), prompts: ['<b>hi</b>'] };
      const b = { ...saved('b', 'm2', [{ content: 'y' }]), prompts: ['<b>hi</b>'] };
      document.body.innerHTML = apiDiffHTML(view({ diffA: 'a', diffB: 'b', apiLogs: { a: log('a', [turn(0, [call('answer')])]), b: log('b', [turn(0, [call('answer')])]) } }), a, b);
      expect(document.querySelector('.api-diff-turn .diff-prompt p').textContent).toBe('<b>hi</b>');
      expect(document.querySelector('.api-diff-turn .diff-prompt b')).toBeNull();
      expect(diffViewTabsHTML({ diffView: 'weird' })).toContain('aria-selected="true"'); // an unknown view falls back to Chat
    });
  });
  describe('where the answers diverge, the cliff threshold and the honest counts', () => {
    const tokens = (...pairs) => pairs.map(([token, logprob]) => ({ token, logprob }));
    const ONE = tokens(['Set', -0.1], [' safe', -0.2], [' defaults', -0.41], [' now', -0.1]);
    const TWO = tokens(['Set', -0.1], [' safe', -0.2], [' block', -1.06], [' now', -0.1]);
    const page = ({ contentA = 'Set safe defaults now', contentB = 'Set safe block now', tokensA = ONE, tokensB = TWO, asked = true, extra = {} } = {}) => {
      const a = { ...saved('a', 'm1', [{ content: contentA }]), logprobs: asked };
      const b = { ...saved('b', 'm2', [{ content: contentB }]), logprobs: asked };
      const turns = (t) => ({ turns: [{ turn_index: 0, tokens: t }] });
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, savedLogprobs: { a: turns(tokensA), b: turns(tokensB) }, diffA: 'a', diffB: 'b', ...extra }));
    };
    const first = (sel) => [...document.querySelectorAll(`.diff-turn:first-child ${sel}`)];

    it('marks the first word the two answers wrote differently, on both sides, with each side\'s probability', () => {
      page();
      const a = first('.diff-row:not(.diff-head) .diff-cell.a .logprob-diverge');
      const b = first('.diff-row:not(.diff-head) .diff-cell.b .logprob-diverge');
      expect(a.map((e) => e.textContent).join('')).toBe(' defaults'); // the space and the word, one purple run
      expect(b.map((e) => e.textContent).join('')).toBe(' block');
      expect(a[0].dataset.cliffTip.split('\n')).toEqual(['Answers diverge here (token 3)', 'A chose " defaults": 66% likely (log prob -0.41)', 'B chose " block": 35% likely (log prob -1.06)']);
      expect(new Set(a.map((e) => e.dataset.cliffTip)).size).toBe(1); // every piece of the run has the one tooltip
      expect(b[0].dataset.cliffTip.split('\n')[1]).toBe('B chose " block": 35% likely (log prob -1.06)'); // each tooltip leads with its own side
      expect(a[0].getAttribute('tabindex')).toBe('0');
    });

    it('says it in a line above the comparison too, and escapes the tokens', () => {
      page({ contentA: 'a <b>x</b>', contentB: 'a <i>y</i>', tokensA: tokens(['a', 0], [' <b>x</b>', -0.5]), tokensB: tokens(['a', 0], [' <i>y</i>', -0.9]) });
      const note = document.querySelector('.diff-turn:first-child .diverge-note');
      expect(note.textContent).toBe('Answers diverge at token 2: A chose " <b>x</b>": 61% likely (log prob -0.50); B chose " <i>y</i>": 41% likely (log prob -0.90).');
      expect(document.querySelector('.diff-turn b, .diff-turn i')).toBeNull();
    });

    it('does not mark a divergence for identical answers, answers without tokens, or tokens that do not match the text', () => {
      page({ contentB: 'Set safe defaults now', tokensB: ONE });
      expect(document.querySelector('.logprob-diverge')).toBeNull();
      expect(document.querySelector('.diverge-note')).toBeNull();
      page({ tokensB: null });
      expect(document.querySelector('.logprob-diverge')).toBeNull();
      page({ tokensA: tokens(['zzz', 0]) });
      expect(document.querySelector('.logprob-diverge')).toBeNull();
    });

    it('marks only the side that carries on when one answer ends first', () => {
      page({ contentA: 'Set safe', tokensA: tokens(['Set', -0.1], [' safe', -0.2]), contentB: 'Set safe now', tokensB: tokens(['Set', -0.1], [' safe', -0.2], [' now', -0.7]) });
      expect(first('.diff-cell.a .logprob-diverge')).toHaveLength(0);
      expect(first('.diff-cell.b .logprob-diverge').map((e) => e.textContent).join('')).toBe(' now');
      expect(document.querySelector('.diverge-note').textContent).toBe('Answers diverge at token 3: A\'s answer ends there; B chose " now": 50% likely (log prob -0.70).');
    });

    it('lets the divergence win where the same word is also a cliff, and keeps other cliffs red', () => {
      page({ tokensA: tokens(['Set', -0.1], [' safe', -0.2], [' defaults', -3], [' now', -0.1]), tokensB: tokens(['Set', -0.1], [' safe', -0.2], [' block', -3], [' now', -0.1]) });
      expect(first('.diff-cell.a .logprob-cliff')).toHaveLength(0); // that word is purple, once
      expect(first('.diff-cell.a .logprob-diverge').map((e) => e.textContent).join('')).toBe(' defaults');
      expect(document.querySelector('.diff-turn:first-child .diff-row:not(.diff-head) .diff-cell.a').textContent).toBe('Set safe defaults now');
    });

    it('adds a legend entry for the divergence beside the cliff one, only when log probabilities were asked for', () => {
      page();
      expect(document.querySelector('.diff-legend').textContent).toContain('Where A and B diverge');
      expect(document.querySelector('.diff-legend .logprob-diverge-swatch')).not.toBeNull();
      page({ asked: false });
      expect(document.querySelector('.diff-legend').textContent).not.toContain('diverge');
    });

    it('has a gear at the far right of the Chat / API logs tabs, and the threshold box is not on the page itself', () => {
      page();
      const tabs = document.querySelector('.diff-views');
      expect(tabs.lastElementChild.id).toBe('diff-settings'); // the last thing in the row, pushed to the right edge by CSS
      expect(tabs.lastElementChild.getAttribute('aria-label')).toBe('Diff settings');
      expect(tabs.querySelector('svg')).not.toBeNull();
      expect(document.getElementById('cliff-threshold')).toBeNull();
    });

    it('shows the model name in each list and highlights only the settings that differ between A and B', () => {
      const a = { ...saved('a', 'm1', [{ content: 'x' }]), temperature: 0, reasoningLevel: 'high', logprobs: true };
      const b = { ...saved('b', 'm2', [{ content: 'x' }]), temperature: 1, reasoningLevel: 'high', logprobs: true };
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, savedLogprobs: {}, diffA: 'a', diffB: 'b' }));
      const lists = [...document.querySelectorAll('.diff-settings')];
      expect(lists[0].querySelector('.badge').textContent).toBe('A · Model m1'); // the model comes first
      expect(lists[1].querySelector('.badge').textContent).toBe('B · Model m2');
      const marked = (el) => [...el.querySelectorAll('.badge.diff-changed')].map((x) => x.textContent);
      expect(marked(lists[0])).toEqual(['A · Model m1', 'A · Temperature 0']);
      expect(marked(lists[1])).toEqual(['B · Model m2', 'B · Temperature 1']);
    });

    it('keeps the replay selection in a left panel titled Select Replays, with a left-edge slider button to bring it back', () => {
      page();
      expect(document.querySelector('#selectors-panel h2').textContent).toBe('Select Replays');
      expect(document.querySelector('#selectors-panel #diff-a')).not.toBeNull();
      expect(document.querySelector('#selectors-panel #diff-b')).not.toBeNull();
      const show = document.getElementById('show-selectors');
      expect(show.classList.contains('prompts-restore')).toBe(true); // the same button as Your prompts
      expect(show.textContent).toContain('Select Replays');
      expect(show.classList.contains('visible')).toBe(false);
      expect(document.getElementById('diff-layout').classList.contains('prompts-hidden')).toBe(false);
      page({ extra: { selectorsHidden: true } });
      expect(document.getElementById('diff-layout').classList.contains('prompts-hidden')).toBe(true);
      expect(document.getElementById('show-selectors').classList.contains('visible')).toBe(true);
      expect(document.getElementById('selectors-slot').hasAttribute('inert')).toBe(true);
    });

    it('binds the hide and show buttons of the Select Replays panel', () => {
      page();
      const seen = [];
      bindDiff({ onSelect() {}, onView() {}, onDiffSettings() {}, onToggleSelectors: (hidden) => seen.push(hidden) });
      document.getElementById('hide-selectors').click();
      document.getElementById('show-selectors').click();
      expect(seen).toEqual([true, false]);
    });

    it("puts each replay's settings directly under its own drop down, A on the left and B on the right", () => {
      page();
      const cols = [...document.querySelectorAll('.diff-selector-list > .diff-selector')];
      expect(cols).toHaveLength(2);
      for (const [i, side] of ['a', 'b'].entries()) {
        const select = cols[i].querySelector('select');
        expect(select.id).toBe('diff-' + side);
        expect(select.nextElementSibling.classList.contains('diff-settings')).toBe(true); // right under the drop down
        expect(select.nextElementSibling.dataset.side).toBe(side);
        expect(select.nextElementSibling.textContent).toContain(side.toUpperCase() + ' · Temperature');
        expect(select.nextElementSibling.textContent).not.toContain((side === 'a' ? 'B' : 'A') + ' ·');
      }
    });

    it('puts the cliff threshold box, set to 2 by default, in the Diff settings popup', () => {
      document.body.innerHTML = diffSettingsHTML({});
      const box = document.getElementById('cliff-threshold');
      expect(box.type).toBe('number');
      expect(box.value).toBe('2');
      expect(box.step).toBe('0.1');
      expect(document.querySelector('label[for="cliff-threshold"]').textContent).toContain('Cliff threshold');
      document.body.innerHTML = diffSettingsHTML({ cliffThreshold: 0.5 });
      expect(document.getElementById('cliff-threshold').value).toBe('0.5');
    });

    it('uses the threshold it is given: the same tokens are flagged at a low one and not at a high one', () => {
      const t = tokens(['a', 0], [' b', -1.2], [' c', -1.2], [' d', -4]);
      const flagged = (threshold) => {
        page({ contentA: 'a b c d', contentB: 'a b c d', tokensA: t, tokensB: t, extra: { cliffThreshold: threshold } });
        return first('.diff-cell.a .logprob-cliff').map((e) => e.textContent);
      };
      expect(flagged(1)).toEqual([' b', ' d']); // -1.2 after 0 is a drop of 1.2; -4 after -1.2 is 2.8; -1.2 after -1.2 is none
      expect(flagged(2)).toEqual([' d']);
      expect(flagged(3)).toEqual([]);
      expect(flagged(0.1).length).toBe(2);
    });

    it('says how many it found, zero included, or that none came back, or nothing when none were asked for', () => {
      const labels = () => first('.result-label span:last-child').map((e) => e.textContent);
      page({ tokensA: tokens(['Set safe defaults now', -0.2]), tokensB: tokens(['Set safe defaults now', -0.2]), contentB: 'Set safe defaults now' });
      expect(labels()).toEqual(['Unchanged · 0 log prob cliffs', 'Unchanged · 0 log prob cliffs']);
      page({ tokensA: null });
      expect(labels()[0]).toContain('Changed · no log probabilities returned');
      expect(labels()[1]).toContain('log prob cliff'); // B did return some
      page({ asked: false });
      expect(labels()).toEqual(['Changed', 'Changed']);
    });

    it('says "no log probabilities returned" when they could not be loaded', () => {
      const a = { ...saved('a', 'm1', [{ content: 'x' }]), logprobs: true };
      const b = { ...saved('b', 'm2', [{ content: 'x' }]), logprobs: true };
      document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, savedLogprobs: { a: { available: false, turns: [] }, b: { available: false, turns: [] } }, diffA: 'a', diffB: 'b' }));
      expect(first('.result-label span:last-child').map((e) => e.textContent)).toEqual(['Unchanged · no log probabilities returned', 'Unchanged · no log probabilities returned']);
    });

    it('binds the gear', () => {
      page();
      let opened = 0;
      bindDiff({ onSelect() {}, onView() {}, onDiffSettings: () => (opened += 1) });
      document.getElementById('diff-settings').click();
      expect(opened).toBe(1);
    });
  });
  it('renders the diff empty state and a real diff', () => {
    expect(diffHTML(view())).toContain('Two replays make a comparison');
    const a = saved('a', 'm1', [{ content: 'one two' }]);
    const b = saved('b', 'm2', [{ content: 'one three' }]);
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
    expect(document.querySelector('.diff-summary .badge').textContent).toBe('1 changed turn');
  });
});

const trace = (category, file) => [
  { step: 'category', options: [{ id: 'c1', name: 'Networks' }, { id: 'c2', name: 'HIPAA' }], chosen: { id: category, name: category === 'c1' ? 'Networks' : 'HIPAA' }, model: 'm1', reason: 'Question is about <firewalls>' },
  { step: 'file', options: [{ id: 'f1', name: 'a.txt' }, { id: 'f2', name: 'b.txt' }], chosen: { id: file, name: file === 'f1' ? 'a.txt' : 'b.txt' }, model: 'm1' },
];

describe('decision tree collapsible in Diff', () => {
  const diff = (ta, tb) => {
    const a = saved('a', 'm1', [{ content: 'one', decision_trace: ta }]);
    const b = saved('b', 'm2', [{ content: 'one', decision_trace: tb }]);
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
  };
  const treeRows = () => [...document.querySelectorAll('.diff-turn:first-child details.diff-tree .diff-row:not(.diff-head)')];
  const cellText = (row, side) => row.querySelector(`.diff-cell.${side}`).textContent;

  it('renders one collapsed Decision tree per turn, above the answer lines, comparing both walks side by side', () => {
    diff(trace('c1', 'f1'), trace('c1', 'f1'));
    const trees = document.querySelectorAll('.diff-turn:first-child details.decision-tree');
    expect(trees).toHaveLength(1);
    const tree = trees[0];
    expect(tree.open).toBe(false);
    expect(tree.querySelector('summary').textContent).toContain('A · 2 steps');
    expect(tree.querySelector('summary').textContent).toContain('B · 2 steps');
    expect(tree.querySelector('summary .decision-differs')).toBeNull();
    expect([...tree.querySelectorAll('.diff-head .diff-cell')].map((c) => c.textContent)).toEqual(['Replay A · m1 · Temperature 0 · Reasoning Default', 'Replay B · m2 · Temperature 0 · Reasoning Default']);
    expect(tree.compareDocumentPosition(document.querySelector('.diff-turn > .diff-lines')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists each step, the options offered, the reason (escaped) and the deciding model, line by line on both sides', () => {
    diff(trace('c1', 'f1'), trace('c1', 'f1'));
    expect(treeRows().map((r) => cellText(r, 'a'))).toEqual([
      'Step 1 · Category', '  Chosen: Networks', '  Offered: Networks, HIPAA', '  Reason: Question is about <firewalls>', '  Decided by: m1',
      'Step 2 · File', '  Chosen: a.txt', '  Offered: a.txt, b.txt', '  Decided by: m1',
    ]);
    expect(treeRows().every((r) => r.classList.contains('equal'))).toBe(true);
    expect(document.querySelector('.diff-tree firewalls')).toBeNull();
  });

  it('labels every step with a numbered heading and a label on each line', () => {
    diff(trace('c1', 'f1'), trace('c1', 'f1'));
    const headings = [...document.querySelectorAll('.diff-tree .diff-cell.heading')].map((c) => c.textContent);
    expect(headings).toEqual(['Step 1 · Category', 'Step 1 · Category', 'Step 2 · File', 'Step 2 · File']); // each step, on both sides
    const labels = treeRows().map((r) => cellText(r, 'a').trim().split(':')[0]).filter((t) => !t.startsWith('Step'));
    expect(new Set(labels)).toEqual(new Set(['Chosen', 'Offered', 'Reason', 'Decided by']));
    expect(document.querySelector('.diff-turn > .diff-lines .diff-cell.heading')).toBeNull(); // only the tree has headings
  });

  it('marks the lines where the two walks differ', () => {
    diff(trace('c1', 'f1'), trace('c2', 'f1'));
    const changed = treeRows().filter((r) => r.classList.contains('changed'));
    expect(changed).toHaveLength(1);
    expect(cellText(changed[0], 'a')).toBe('  Chosen: Networks');
    expect(cellText(changed[0], 'b')).toBe('  Chosen: HIPAA');
    expect(document.querySelector('.diff-tree summary .decision-differs')).not.toBeNull();
  });

  it('leaves gaps where one walk has steps the other does not', () => {
    diff(trace('c1', 'f1'), trace('c1', 'f1').slice(0, 1));
    const gaps = treeRows().filter((r) => r.classList.contains('removed'));
    expect(gaps).toHaveLength(4); // the second step: its heading and three labelled lines
    expect(gaps[0].querySelector('.diff-cell.b').classList.contains('gap')).toBe(true);
    expect(document.querySelector('.diff-tree summary').textContent).toContain('B · 1 step');
  });

  it('says so when no decision tree was recorded, and omits it for turns that were not replayed', () => {
    diff(undefined, undefined);
    expect(document.querySelector('.decision-tree summary').textContent).toContain('none recorded');
    expect(document.querySelector('.decision-empty').textContent).toMatch(/No decision tree/);
    expect(decisionTreeHTML([], [])).toContain('none recorded');
    const a = saved('a', 'm1', [{ content: 'x' }]);
    const b = saved('b', 'm2', []);
    document.body.innerHTML = diffHTML(view({ savedReplays: [a, b], savedDetails: { a, b }, diffA: 'a', diffB: 'b' }));
    expect(document.querySelectorAll('.diff-turn:first-child details.decision-tree')).toHaveLength(1);
    const none = saved('c', 'm1', []);
    const none2 = saved('d', 'm2', []);
    document.body.innerHTML = diffHTML(view({ savedReplays: [none, none2], savedDetails: { c: none, d: none2 }, diffA: 'c', diffB: 'd' }));
    expect(document.querySelector('details.decision-tree')).toBeNull(); // neither side replayed this turn: no tree
  });
});
