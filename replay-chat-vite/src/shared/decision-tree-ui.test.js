import { describe, expect, it } from 'vitest';
import { decisionTreeHTML, decisionTreeIfAny, kbNotesHTML } from './decision-tree-ui.js';

const at = '2026-01-01T00:00:00Z';
const options = [{ id: 'c1', name: 'Networks' }, { id: 'c2', name: 'Cloud' }];
const step = (extra = {}) => ({ step: 'category', options, chosen: { id: 'c1', name: 'Networks' }, model: 'm1', reason: 'It is about networks', outcome: 'chosen', at, ...extra }); // fmt: skip
const render = (html) => {
  document.body.innerHTML = html;
  return document.body;
};

describe('decision tree', () => {
  it('shows each level, what was offered, what was chosen, who chose and why', () => {
    const body = render(decisionTreeHTML([step(), step({ step: 'file', chosen: { id: 'c2', name: 'iam.txt' }, options: [{ id: 'c2', name: 'iam.txt' }] })]));
    expect(body.querySelector('summary').textContent).toContain('2 steps');
    const [first, second] = body.querySelectorAll('.decision-step');
    expect(first.querySelector('.decision-step-name').textContent).toBe('Category');
    expect(first.querySelector('b').textContent).toBe('Networks');
    expect([...first.querySelectorAll('.decision-option')].map((e) => e.textContent)).toEqual(['Networks', 'Cloud']);
    expect(first.querySelector('.decision-option.chosen').textContent).toBe('Networks');
    expect(first.querySelector('.decision-reason').textContent).toBe('It is about networks');
    expect(first.querySelector('.decision-model').textContent).toBe('Decided by m1');
    expect(second.querySelector('.decision-step-name').textContent).toBe('File');
    expect(body.querySelector('details').open).toBe(false); // collapsed by default
  });

  it('says plainly when the agent chose nothing, or gave no usable choice', () => {
    const body = render(decisionTreeHTML([step({ outcome: 'none', chosen: null }), step({ step: 'subcategory', outcome: 'invalid', chosen: null, reason: null })]));
    const [none, invalid] = body.querySelectorAll('.decision-step');
    expect(none.querySelector('b').textContent).toBe('Nothing relevant');
    expect(invalid.querySelector('b').textContent).toBe('No valid choice');
    expect(none.classList.contains('unresolved') && invalid.classList.contains('unresolved')).toBe(true);
    expect(body.querySelector('.decision-option.chosen')).toBeNull(); // nothing is highlighted as chosen
  });

  it('highlights the steps whose choice differs from the other replay', () => {
    const other = [step({ chosen: { id: 'c2', name: 'Cloud' } })];
    const body = render(decisionTreeHTML([step()], other));
    expect(body.querySelector('.decision-step.differs')).not.toBeNull();
    expect(body.querySelector('summary .decision-differs')).not.toBeNull();
    expect(render(decisionTreeHTML([step()], [step()])).querySelector('.differs')).toBeNull();
  });

  it('escapes everything the agent or the knowledge base supplied', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const body = render(decisionTreeHTML([step({ reason: evil, model: evil, chosen: { id: 'c1', name: evil }, options: [{ id: 'c1', name: evil }] })]));
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('.decision-reason').textContent).toBe(evil);
  });

  it('says "none recorded" in the Diff when there is no tree, but shows nothing at all elsewhere', () => {
    expect(render(decisionTreeHTML(null)).textContent).toContain('none recorded');
    expect(render(decisionTreeHTML([])).textContent).toContain('No decision tree was recorded');
    expect(decisionTreeIfAny(null)).toBe('');
    expect(decisionTreeIfAny([])).toBe('');
    expect(decisionTreeIfAny([step()])).toContain('decision-tree');
  });

  it('names the version of the file that was used, and flags a version that has been deleted', () => {
    const body = render(decisionTreeHTML([step({ step: 'file', chosen: { id: 'd1', name: 'net.txt' }, version_number: 3 }), step({ step: 'file', version_number: null, kb_version_deleted: true })]));
    const heads = body.querySelectorAll('.decision-step-head');
    expect(heads[0].querySelector('.decision-version').textContent).toBe('v3');
    expect(heads[0].querySelector('.decision-deleted')).toBeNull();
    expect(heads[1].querySelector('.decision-deleted').textContent).toBe('Version deleted');
    expect(heads[1].querySelector('.decision-version')).toBeNull();
    expect(render(decisionTreeHTML([step()])).querySelector('.decision-version')).toBeNull(); // older records have no version
  });
});

describe('what an answer was built from besides the walk', () => {
  it('shows the KB summary that was sent instead of the file, collapsed and escaped', () => {
    const body = render(kbNotesHTML({ kb_summary: 'Use <b>trust</b> zones.' }));
    const details = body.querySelector('details.kb-summary');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toContain('sent instead of the file');
    expect(details.querySelector('.kb-summary-text').innerHTML).toBe('Use &lt;b&gt;trust&lt;/b&gt; zones.');
    expect(body.querySelector('.kb-deleted-flag')).toBeNull();
  });

  it('flags a deleted version, and shows nothing when there is nothing to say', () => {
    expect(render(kbNotesHTML({ kb_version_deleted: true })).querySelector('.kb-deleted-flag').textContent).toContain('has been deleted');
    expect(kbNotesHTML({})).toBe('');
    expect(kbNotesHTML({ kb_summary: null, kb_version_deleted: false })).toBe('');
    expect(kbNotesHTML(undefined)).toBe('');
  });
});
