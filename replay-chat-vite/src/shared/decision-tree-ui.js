import { esc } from './html.js';

const STEP_LABELS = { category: 'Category', subcategory: 'Sub category', file: 'File' };

/** What to show as the "selection" of a step that did not end in a selection. */
const UNRESOLVED = { none: 'Nothing relevant', invalid: 'No valid choice' };

/**
 * Collapsible "Decision tree" for one answer: the category > sub category > file choices the agent made while
 * walking its knowledge base, with what it was offered at each level.
 *
 * `trace` is the answer's `decision_trace` (recorded by the backend in knowledge_base_choice):
 * [{ step, options: [{id, name}], chosen: {id, name} | null, model, reason, outcome: 'chosen' | 'none' | 'invalid', at,
 *   version_number?, kb_version_deleted? }]   (the file step says which version of the file was used, and whether it is gone)
 * `other` is the same turn's trace in the other replay; steps whose choice differs are highlighted.
 */
export function decisionTreeHTML(trace, other) {
  if (!Array.isArray(trace) || !trace.length) {
    return '<details class="decision-tree"><summary>Decision tree <span class="badge">none recorded</span></summary><p class="small decision-empty">No decision tree was recorded for this response.</p></details>';
  }
  const differs = (step, i) => Array.isArray(other) && other.length > 0 && other[i]?.chosen?.id !== step.chosen?.id;
  const anyDiffers = trace.some(differs);
  const steps = trace
    .map((t, i) => {
      const unresolved = t.outcome === 'none' || t.outcome === 'invalid';
      const selection = unresolved ? UNRESOLVED[t.outcome] : (t.chosen?.name ?? 'No choice');
      return `<li class="decision-step ${differs(t, i) ? 'differs' : ''} ${unresolved ? 'unresolved' : ''}"><div class="decision-step-head"><span class="decision-step-name">${esc(STEP_LABELS[t.step] || t.step)}</span><span class="decision-arrow" aria-hidden="true">→</span><b>${esc(selection)}</b>${t.version_number ? `<span class="badge decision-version">v${esc(t.version_number)}</span>` : ''}${t.kb_version_deleted ? '<span class="badge decision-deleted">Version deleted</span>' : ''}${differs(t, i) ? '<span class="badge decision-differs">Differs</span>' : ''}</div><div class="decision-options" aria-label="Options offered">${(t.options || []).map((o) => `<span class="decision-option ${o.id === t.chosen?.id ? 'chosen' : ''}">${esc(o.name)}</span>`).join('')}</div>${t.reason ? `<p class="small decision-reason">${esc(t.reason)}</p>` : ''}${t.model ? `<div class="small decision-model">Decided by ${esc(t.model)}</div>` : ''}</li>`;
    })
    .join('');
  return `<details class="decision-tree"><summary>Decision tree <span class="badge">${trace.length} ${trace.length === 1 ? 'step' : 'steps'}</span>${anyDiffers ? '<span class="badge decision-differs">Differs</span>' : ''}</summary><ol class="decision-steps">${steps}</ol></details>`;
}

/** The heading line of a step in `traceLines` ("Step 2 · Sub category"); the Diff styles these lines as headings. */
export const STEP_HEADING = /^Step \d+ · /;

/**
 * One answer's walk as labelled plain text lines, so two walks can be compared line by line (the Diff tab). Every step
 * is a heading and four labelled lines (the ones it has):
 *   Step 1 · Category
 *     Chosen: Networks (v2)            (the file step adds the version, and "version deleted" when it is gone)
 *     Offered: Networks, HIPAA
 *     Reason: ...
 *     Decided by: model-x
 * No walk gives no lines.
 */
export function traceLines(trace) {
  if (!Array.isArray(trace)) return [];
  return trace.flatMap((t, i) => {
    const unresolved = t.outcome === 'none' || t.outcome === 'invalid';
    const selection = unresolved ? UNRESOLVED[t.outcome] : (t.chosen?.name ?? 'No choice');
    const version = `${t.version_number ? ` (v${t.version_number})` : ''}${t.kb_version_deleted ? ' (version deleted)' : ''}`;
    const lines = [`Step ${i + 1} · ${STEP_LABELS[t.step] || t.step}`, `  Chosen: ${selection}${version}`];
    if (t.options?.length) lines.push(`  Offered: ${t.options.map((o) => o.name).join(', ')}`);
    if (t.reason) lines.push(`  Reason: ${String(t.reason).replace(/\s+/g, ' ').trim()}`);
    if (t.model) lines.push(`  Decided by: ${t.model}`);
    return lines;
  });
}

/** The collapsible for an answer that has a recorded walk; nothing at all when the knowledge base was not used. */
export const decisionTreeIfAny = (trace) => (Array.isArray(trace) && trace.length ? decisionTreeHTML(trace) : '');

/**
 * What an answer was built from besides the walk: the summary that was sent INSTEAD of the file when the KB-summary-tool
 * was on, and a flag when the version of the file that was used has since been deleted. Nothing when there is neither.
 * `item` is a chat answer or a replay result: { kb_summary?, kb_version_deleted? }.
 */
export function kbNotesHTML(item) {
  const parts = [];
  if (item?.kb_summary) {
    parts.push(
      `<details class="kb-summary"><summary>KB summary <span class="badge">sent instead of the file</span></summary><div class="kb-summary-text">${esc(item.kb_summary)}</div></details>`,
    );
  }
  if (item?.kb_version_deleted) {
    parts.push(
      '<p class="kb-deleted-flag small" role="note">The knowledge base version used for this answer has been deleted. The choice is still shown by name.</p>',
    );
  }
  return parts.join('');
}
