/**
 * Reading the token log probabilities of two replays' answers (the Diff page).
 *
 * Two marks are made from them:
 *  - Where the answers DIVERGE: the first token the two replays wrote differently, with the probability each side gave
 *    its own choice. This is the reliable one for comparing replays: even at temperature 0 two runs can split on a close
 *    call (for example 66% against 35%), which no other mark would show.
 *  - Log prob cliffs: a token whose log probability fell by CLIFF_THRESHOLD or more compared with the token before it
 *    (a drop of 2 means about 7 times less likely). It is a measure of surprise, not a prediction of where replays split,
 *    and it only fires when the model wrote something it found unlikely. A model at temperature 0 almost never does.
 *    The threshold is adjustable on the Diff page.
 */
export const CLIFF_THRESHOLD = 2;
export const MAX_CLIFF_THRESHOLD = 20;

/** What the user typed as a cliff threshold: a number above 0 and at most MAX_CLIFF_THRESHOLD, else null. */
export function parseThreshold(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_CLIFF_THRESHOLD ? n : null;
}

/**
 * The tokens of an answer as character ranges of its text: [{start, end, token, logprob}], in order.
 * Tokens are matched to the text one after the other. Matching stops at the first token that does not line up with it
 * (for example one that is half of a multi-byte character), so a mismatch can only lose marks, never put one on the wrong
 * words. `complete` says whether every token was matched.
 */
export function tokenSpans(tokens, text) {
  const spans = [];
  if (!Array.isArray(tokens) || typeof text !== 'string') return { spans, complete: false };
  let position = 0;
  for (const t of tokens) {
    if (!t.token) continue;
    if (!text.startsWith(t.token, position)) return { spans, complete: false };
    spans.push({ start: position, end: position + t.token.length, token: t.token, logprob: t.logprob });
    position += t.token.length;
  }
  return { spans, complete: true };
}

/**
 * The log prob cliffs of one answer, as character ranges of its text.
 * Returns [{start, end, value, token, logprob, previous}] where `value` is the drop (always positive).
 */
export function findCliffs(tokens, text, threshold = CLIFF_THRESHOLD) {
  const { spans } = tokenSpans(tokens, text);
  const cliffs = [];
  for (let i = 1; i < spans.length; i++) {
    const drop = spans[i - 1].logprob - spans[i].logprob;
    if (drop >= threshold) {
      cliffs.push({ start: spans[i].start, end: spans[i].end, value: drop, token: spans[i].token, logprob: spans[i].logprob, previous: spans[i - 1].logprob });
    }
  }
  return cliffs;
}

/**
 * Where two answers first differ, token by token. Returns null when they do not differ, when either has no tokens, or when
 * the tokens could not be matched to the text far enough to be sure (it would rather say nothing than point at the wrong word).
 * Otherwise { index, a, b } where `index` counts from 0 and `a` / `b` are { start, end, token, logprob, previous } for the
 * token each side wrote there, or null for a side whose answer had already ended.
 */
export function findDivergence(tokensA, tokensB, textA, textB) {
  const a = tokenSpans(tokensA, textA);
  const b = tokenSpans(tokensB, textB);
  if (!a.spans.length || !b.spans.length) return null;
  let i = 0;
  while (i < a.spans.length && i < b.spans.length && a.spans[i].token === b.spans[i].token) i++;
  const atEndA = i >= a.spans.length;
  const atEndB = i >= b.spans.length;
  if (atEndA && atEndB) return null; // the same tokens all the way
  if ((atEndA && !a.complete) || (atEndB && !b.complete)) return null; // matching stopped early: cannot tell where they split
  const side = (x) => (i < x.spans.length ? { ...x.spans[i], previous: i > 0 ? x.spans[i - 1].logprob : null } : null);
  return { index: i, a: side(a), b: side(b) };
}

const fixed = (n) => (Math.round(n * 100) / 100).toFixed(2);

/** How likely a token was, from its log probability: "66%", "8.6%", "0.012%". */
export function likelihood(logprob) {
  const percent = Math.exp(logprob) * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent >= 1 ? percent.toFixed(1) : percent.toPrecision(2)}%`;
}

/** The tooltip for one cliff: its value first, then what it was made of. */
export function cliffTip(c) {
  return `Log prob cliff: ${fixed(c.value)}\nThis token: ${fixed(c.logprob)} (${likelihood(c.logprob)} likely)\nToken before: ${fixed(c.previous)}`;
}

const quoted = (token) => JSON.stringify(token);
const chose = (name, s) => `${name} chose ${quoted(s.token)}: ${likelihood(s.logprob)} likely (log prob ${fixed(s.logprob)})`;

/** The tooltip on the word where one side diverges from the other. `name` and `other` are "A" / "B". */
export function divergenceTip(d, name, other) {
  const mine = d[name.toLowerCase()];
  const theirs = d[other.toLowerCase()];
  const head = `Answers diverge here (token ${d.index + 1})`;
  if (!theirs) return `${head}\n${chose(name, mine)}\n${other}'s answer had already ended`;
  return `${head}\n${chose(name, mine)}\n${chose(other, theirs)}`;
}

/** One line saying where the answers diverge, for above the comparison. */
export function divergenceSummary(d) {
  const where = `Answers diverge at token ${d.index + 1}`;
  if (d.a && d.b) return `${where}: ${chose('A', d.a)}; ${chose('B', d.b)}.`;
  const [name, s, other] = d.a ? ['A', d.a, 'B'] : ['B', d.b, 'A'];
  return `${where}: ${other}'s answer ends there; ${chose(name, s)}.`;
}
