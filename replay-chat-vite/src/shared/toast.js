export function toast(text, { duration = 4500 } = {}) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), duration);
}

/** Show an error from the API (or anything thrown). Aborted requests are not errors. */
export function toastError(err) {
  if (err?.name === 'AbortError') return;
  toast(err?.message || 'Something went wrong. Please try again.');
}
