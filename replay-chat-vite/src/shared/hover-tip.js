/**
 * One tooltip for any element with data-cliff-tip, shown next to the pointer (or the focused element). It lives on <body>
 * and is placed with fixed positioning, so a panel that clips its contents (overflow: hidden) cannot cut it off.
 */
let tip = null;
let bound = false;

function element() {
  if (!tip?.isConnected) {
    tip = document.createElement('div');
    tip.className = 'hover-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

const source = (target) => target?.closest?.('[data-cliff-tip]') ?? null;

function place(x, y) {
  const el = element();
  const margin = 12;
  const left = Math.min(x + margin, Math.max(margin, window.innerWidth - el.offsetWidth - margin));
  const below = y + 18;
  const top = below + el.offsetHeight + margin > window.innerHeight ? Math.max(margin, y - el.offsetHeight - margin) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function enableHoverTips() {
  element();
  if (bound) return;
  bound = true;
  document.addEventListener('mouseover', (e) => {
    const el = source(e.target);
    if (!el) return;
    const t = element();
    t.textContent = el.dataset.cliffTip;
    t.hidden = false;
    place(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => {
    if (source(e.target) && !element().hidden) place(e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', (e) => {
    if (source(e.target) && source(e.target) !== source(e.relatedTarget)) element().hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = source(e.target);
    if (!el) return;
    const t = element();
    t.textContent = el.dataset.cliffTip;
    t.hidden = false;
    const r = el.getBoundingClientRect();
    place(r.left, r.bottom);
  });
  document.addEventListener('focusout', (e) => {
    if (source(e.target)) element().hidden = true;
  });
}
