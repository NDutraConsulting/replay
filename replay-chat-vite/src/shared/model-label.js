/**
 * A model is chosen as "<API label>::<model>" so the same model name on two APIs stays two choices. This is how one reads
 * on screen: "H100 · llama-3". A plain name (a demo model, or a chat made before there were several APIs) is shown as it is.
 */
export const REF_SEPARATOR = '::';

/** { label, model } for a choice; label is null for a plain name. */
export function splitModel(ref) {
  const text = String(ref ?? '');
  const at = text.indexOf(REF_SEPARATOR);
  return at > 0 && at + REF_SEPARATOR.length < text.length
    ? { label: text.slice(0, at), model: text.slice(at + REF_SEPARATOR.length) }
    : { label: null, model: text };
}

export const modelLabel = (ref) => {
  const { label, model } = splitModel(ref);
  return label === null ? model : `${label} · ${model}`;
};

export const makeModelRef = (label, model) => `${label}${REF_SEPARATOR}${model}`;
