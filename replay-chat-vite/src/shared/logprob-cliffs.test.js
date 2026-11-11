import { describe, expect, it } from 'vitest';
import { CLIFF_THRESHOLD, cliffTip, findCliffs } from './logprob-cliffs.js';

const toks = (...pairs) => pairs.map(([token, logprob]) => ({ token, logprob }));

describe('findCliffs', () => {
  it('marks a token whose log probability fell by the threshold or more from the token before', () => {
    const cliffs = findCliffs(toks(['The', -0.1], [' plan', -0.2], [' is', -2.5], [' fine', -2.6]), 'The plan is fine');
    expect(cliffs).toHaveLength(1);
    expect(cliffs[0]).toMatchObject({ start: 8, end: 11, token: ' is', logprob: -2.5, previous: -0.2 });
    expect(cliffs[0].value).toBeCloseTo(2.3, 5);
  });

  it('is measured against the token before, so a token that was already unlikely is not a cliff', () => {
    expect(findCliffs(toks(['a', -5], ['b', -5.5], ['c', -6]), 'abc')).toEqual([]); // low all the way: no drop
  });

  it('never marks the first token (nothing before it) and ignores a rise', () => {
    expect(findCliffs(toks(['a', -9], ['b', -0.1]), 'ab')).toEqual([]);
  });

  it('uses the threshold as the smallest drop, and takes a different one', () => {
    expect(CLIFF_THRESHOLD).toBe(2);
    const t = toks(['a', 0], ['b', -2], ['c', -3.9]);
    expect(findCliffs(t, 'abc').map((c) => c.token)).toEqual(['b']); // exactly 2 counts; 1.9 does not
    expect(findCliffs(t, 'abc', 1.5).map((c) => c.token)).toEqual(['b', 'c']);
    expect(findCliffs(t, 'abc', 3)).toEqual([]);
  });

  it('gives character ranges that point at the right words, across tokens of different lengths', () => {
    const text = 'Hello, wonderful world';
    const cliffs = findCliffs(toks(['Hello', -0.1], [',', -0.1], [' wonderful', -4], [' world', -0.2]), text);
    expect(cliffs.map((c) => text.slice(c.start, c.end))).toEqual([' wonderful']);
  });

  it('stops at the first token that does not line up with the text, rather than marking the wrong words', () => {
    const cliffs = findCliffs(toks(['ab', -0.1], ['XX', -9], ['cd', -9.5], ['ef', -0.1]), 'abcdef');
    expect(cliffs).toEqual([]); // "XX" is not in the text: nothing after it is trusted
    const early = findCliffs(toks(['a', -0.1], ['b', -5], ['ZZ', -9]), 'abcd');
    expect(early.map((c) => c.token)).toEqual(['b']); // what lined up before the mismatch is kept
  });

  it('copes with nothing to work with', () => {
    expect(findCliffs(undefined, 'x')).toEqual([]);
    expect(findCliffs(null, 'x')).toEqual([]);
    expect(findCliffs([], 'x')).toEqual([]);
    expect(findCliffs(toks(['a', 0], ['b', -9]), undefined)).toEqual([]);
    expect(findCliffs(toks(['', 0], ['a', -9]), 'a')).toEqual([]); // an empty token is skipped
  });
});

describe('cliffTip', () => {
  it('shows the cliff value first, then the token and the one before', () => {
    const [c] = findCliffs(toks(['a', -0.14], ['b', -2.45]), 'ab');
    const lines = cliffTip(c).split('\n');
    expect(lines).toEqual(['Log prob cliff: 2.31', 'This token: -2.45 (8.6% likely)', 'Token before: -0.14']);
  });

  it('writes small probabilities with enough digits', () => {
    expect(cliffTip({ value: 9, logprob: -9, previous: 0 })).toContain('(0.012% likely)');
    expect(cliffTip({ value: 2, logprob: -2, previous: 0 })).toContain('(14% likely)');
    expect(cliffTip({ value: 4, logprob: -4, previous: 0 })).toContain('(1.8% likely)');
  });
});

import { MAX_CLIFF_THRESHOLD, divergenceSummary, divergenceTip, findDivergence, likelihood, parseThreshold, tokenSpans } from './logprob-cliffs.js';

describe('parseThreshold', () => {
  it('accepts a number above 0 up to the maximum', () => {
    expect(parseThreshold('2')).toBe(2);
    expect(parseThreshold(' 0.5 ')).toBe(0.5);
    expect(parseThreshold('0.1')).toBe(0.1);
    expect(parseThreshold(String(MAX_CLIFF_THRESHOLD))).toBe(20);
  });
  it('refuses anything else', () => {
    for (const bad of ['', '  ', '0', '-1', '20.1', '1e9', 'abc', 'NaN', 'Infinity', undefined, null]) expect(parseThreshold(bad)).toBeNull();
  });
});

describe('tokenSpans', () => {
  it('gives each token its character range and says whether all of them lined up', () => {
    const { spans, complete } = tokenSpans(toks(['ab', -1], ['cd', -2]), 'abcd');
    expect(spans).toEqual([{ start: 0, end: 2, token: 'ab', logprob: -1 }, { start: 2, end: 4, token: 'cd', logprob: -2 }]);
    expect(complete).toBe(true);
  });
  it('stops at a token that does not line up and says so', () => {
    const r = tokenSpans(toks(['ab', -1], ['XX', -2], ['cd', -3]), 'abcd');
    expect(r.spans).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(tokenSpans(undefined, 'x')).toEqual({ spans: [], complete: false });
  });
});

describe('findDivergence', () => {
  const A = toks(['Set', -0.1], [' safe', -0.2], [' defaults', -0.41], [' now', -0.1]);
  const B = toks(['Set', -0.1], [' safe', -0.2], [' block', -1.06], [' now', -0.1]);

  it('finds the first token the two answers wrote differently, with each side\'s probability and the token before', () => {
    const d = findDivergence(A, B, 'Set safe defaults now', 'Set safe block now');
    expect(d.index).toBe(2);
    expect(d.a).toMatchObject({ start: 8, end: 17, token: ' defaults', logprob: -0.41, previous: -0.2 });
    expect(d.b).toMatchObject({ start: 8, end: 14, token: ' block', logprob: -1.06, previous: -0.2 });
  });

  it('works when the very first token differs (there is no token before it)', () => {
    const d = findDivergence(toks(['Hi', -0.5]), toks(['Hello', -0.9]), 'Hi', 'Hello');
    expect(d.index).toBe(0);
    expect(d.a.previous).toBeNull();
  });

  it('is null for identical answers, and when either side has no tokens', () => {
    expect(findDivergence(A, A, 'Set safe defaults now', 'Set safe defaults now')).toBeNull();
    expect(findDivergence(A, null, 'x', 'y')).toBeNull();
    expect(findDivergence([], B, 'x', 'y')).toBeNull();
    expect(findDivergence(undefined, undefined, '', '')).toBeNull();
  });

  it('marks only the longer side when one answer is a prefix of the other', () => {
    const d = findDivergence(toks(['Set', -0.1]), toks(['Set', -0.1], [' now', -0.7]), 'Set', 'Set now');
    expect(d.index).toBe(1);
    expect(d.a).toBeNull();
    expect(d.b).toMatchObject({ token: ' now', logprob: -0.7, previous: -0.1 });
  });

  it('says nothing when matching stopped early, rather than point at the wrong word', () => {
    // A's second token does not match its text, so A's matched tokens end where B's still carry on
    expect(findDivergence(toks(['Set', -0.1], ['ZZ', -1]), toks(['Set', -0.1], [' safe', -0.2]), 'Set safe', 'Set safe')).toBeNull();
  });

  it('still finds a split that comes before a later mismatch', () => {
    const d = findDivergence(toks(['a', 0], ['b', -1], ['??', 0]), toks(['a', 0], ['c', -2]), 'abx', 'ac');
    expect(d.index).toBe(1);
    expect(d.a.token).toBe('b');
    expect(d.b.token).toBe('c');
  });
});

describe('divergence wording', () => {
  const d = { index: 2, a: { token: ' defaults', logprob: -0.41 }, b: { token: ' block', logprob: -1.06 } };
  it('says both choices and how likely each was', () => {
    expect(divergenceTip(d, 'A', 'B').split('\n')).toEqual(['Answers diverge here (token 3)', 'A chose " defaults": 66% likely (log prob -0.41)', 'B chose " block": 35% likely (log prob -1.06)']);
    expect(divergenceTip(d, 'B', 'A').split('\n')[1]).toBe('B chose " block": 35% likely (log prob -1.06)'); // each side leads with its own
    expect(divergenceSummary(d)).toBe('Answers diverge at token 3: A chose " defaults": 66% likely (log prob -0.41); B chose " block": 35% likely (log prob -1.06).');
  });
  it('says when one answer had ended', () => {
    const ended = { index: 1, a: null, b: { token: ' now', logprob: -0.7 } };
    expect(divergenceTip(ended, 'B', 'A').split('\n')).toEqual(['Answers diverge here (token 2)', 'B chose " now": 50% likely (log prob -0.70)', "A's answer had already ended"]);
    expect(divergenceSummary(ended)).toBe('Answers diverge at token 2: A\'s answer ends there; B chose " now": 50% likely (log prob -0.70).');
    expect(divergenceSummary({ index: 1, a: { token: 'x', logprob: -1 }, b: null })).toContain("B's answer ends there; A chose");
  });
  it('writes a probability at any size', () => {
    expect(likelihood(0)).toBe('100%');
    expect(likelihood(-0.41)).toBe('66%');
    expect(likelihood(-2)).toBe('14%');
    expect(likelihood(-4)).toBe('1.8%');
    expect(likelihood(-9)).toBe('0.012%');
  });
});
