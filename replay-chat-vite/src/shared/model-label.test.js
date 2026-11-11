import { describe, expect, it } from 'vitest';
import { REF_SEPARATOR, makeModelRef, modelLabel, splitModel } from './model-label.js';

describe('model labels', () => {
  it('splits an API-qualified choice into its label and model, at the first separator only', () => {
    expect(REF_SEPARATOR).toBe('::');
    expect(splitModel('H100 server::llama-3')).toEqual({ label: 'H100 server', model: 'llama-3' });
    expect(splitModel('Fast::org/model:70b::x')).toEqual({ label: 'Fast', model: 'org/model:70b::x' });
  });

  it('treats a plain name, and a malformed one, as a model with no label', () => {
    for (const plain of ['model-a', 'gpt-6-luna', '', '::x', 'x::', '::']) expect(splitModel(plain)).toEqual({ label: null, model: plain });
    expect(splitModel(undefined)).toEqual({ label: null, model: '' });
    expect(splitModel(null)).toEqual({ label: null, model: '' });
  });

  it('reads as "label · model" on screen, and a plain name as it is', () => {
    expect(modelLabel('H100::llama')).toBe('H100 · llama');
    expect(modelLabel('model-a')).toBe('model-a');
    expect(modelLabel('OpenAI (server key)::gpt-6-luna')).toBe('OpenAI (server key) · gpt-6-luna');
    expect(modelLabel('')).toBe('');
  });

  it('builds a choice from a label and a model, which splits back', () => {
    expect(makeModelRef('A100', 'llama')).toBe('A100::llama');
    expect(splitModel(makeModelRef('A100', 'llama'))).toEqual({ label: 'A100', model: 'llama' });
  });
});
