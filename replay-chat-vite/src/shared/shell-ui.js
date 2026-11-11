import { loadApp, logout } from './app-api.js';
import { redirectToLogin } from './http.js';
import { esc } from './html.js';
import { icon } from './icons.js';
import { toastError } from './toast.js';

const paths = { chat: 'index.html', replay: 'replay.html', agents: 'agents.html', account: 'account.html' };

const navLink = (id, label, page) =>
  `<a href="/${paths[id]}" class="${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}>${icon(id === 'account' ? 'user' : id)}${label}</a>`;

const initials = (user) => (user?.username || 'RC').slice(0, 2).toUpperCase();

export const shellHTML = (page, user) => `<header class="topbar"><a class="brand" href="index.html"><span class="brand-mark"><img src="/replay-chat-150.png" alt="" width="35" height="35"></span>Replay Chat</a><div class="top-end"><span class="avatar" aria-hidden="true">${esc(initials(user))}</span><button class="icon-btn" id="menu" aria-label="Open navigation" aria-controls="drawer" aria-expanded="false">${icon('menu')}</button></div></header><main class="container" id="main"></main><div class="overlay" id="overlay"></div><aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Navigation"><div class="drawer-head"><h2>Replay Chat</h2><button class="icon-btn" id="close-menu" aria-label="Close navigation">${icon('close')}</button></div><div class="eyebrow">Workspace</div>${navLink('chat', 'Chat', page)}${navLink('replay', 'Replay', page)}${navLink('agents', 'AI agents', page)}${navLink('account', 'Account', page)}<div class="drawer-user">${user ? `<span class="drawer-username">${esc(user.username)}</span>` : ''}<button type="button" class="btn" id="logout">Log out</button></div><div class="drawer-bottom">Same prompts, different results.<br>Compare models, GPU hardware, and kernels.</div></aside>`;

export const footerHTML = () =>
  `<footer><div class="footer-left">${icon('lock')}Your conversations are saved to your account.</div><div class="footer-right">Compare models, GPUs, and kernels.<span>•</span>Replay Chat</div></footer>`;

export function toggleDrawer(open) {
  const drawer = document.getElementById('drawer');
  document.body.classList.toggle('drawer-open', open);
  document.getElementById('menu').setAttribute('aria-expanded', open);
  document.getElementById('main').inert = open;
  document.querySelector('.topbar').inert = open;
  document.body.style.overflow = open ? 'hidden' : '';
  drawer.inert = !open;
  if (open) {
    drawer.style.visibility = 'visible';
    document.getElementById('close-menu').focus();
  } else {
    drawer.style.visibility = '';
    document.getElementById('menu').focus();
  }
}

/** Render the shared page chrome and wire the navigation drawer. */
export function mountShell(page, user) {
  document.body.innerHTML = shellHTML(page, user);
  document.getElementById('drawer').inert = true;
  document.getElementById('menu').onclick = () => toggleDrawer(true);
  document.getElementById('close-menu').onclick = () => toggleDrawer(false);
  document.getElementById('overlay').onclick = () => toggleDrawer(false);
  document.getElementById('logout').onclick = async () => {
    try {
      await logout();
    } catch (err) {
      return toastError(err);
    }
    redirectToLogin();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleDrawer(false);
    if (e.key === 'Tab' && document.body.classList.contains('drawer-open')) {
      const f = [...document.querySelectorAll('.drawer button,.drawer a')];
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
        e.preventDefault();
        f[0].focus();
      }
    }
  });
  return document.getElementById('main');
}

export const modeBadgeHTML = (connected) =>
  `<span class="badge"><span class="dot"></span>${connected ? 'API connected' : 'Demo mode'}</span>`;

/** Shown while a page's first requests are in flight. */
export function showLoading(main) {
  main.innerHTML = '<div class="empty" role="status"><p>Loading…</p></div>';
}

/** A page whose first load failed: say why and offer a retry. */
export function showFatal(main, err, retry = () => location.reload()) {
  main.innerHTML = `<div class="empty" role="alert"><div class="circle-icon">${icon('lock')}</div><h2>Could not load this page.</h2><p>${esc(err?.message || 'Something went wrong.')}</p><button type="button" class="btn yellow" id="retry-load">Try again</button></div>`;
  document.getElementById('retry-load').onclick = retry;
}

/**
 * Common page start: load what every page needs (user, agents, settings, preferences), mount the shell with
 * the user, then hand control to the page. A failed load shows an error with a retry (a 401 has already sent
 * the browser to the login page).
 * @param {string} page   nav id, e.g. 'chat'
 * @param {(main: HTMLElement, app: Awaited<ReturnType<typeof loadApp>>) => unknown} build
 */
export async function startPage(page, build) {
  let app;
  try {
    app = await loadApp();
  } catch (err) {
    showFatal(mountShell(page, null), err, () => startPage(page, build));
    return null;
  }
  const main = mountShell(page, app.user);
  try {
    return await build(main, app);
  } catch (err) {
    showFatal(main, err, () => startPage(page, build));
    return null;
  }
}
