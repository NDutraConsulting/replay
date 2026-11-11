import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';

/** @param {{mode: 'login'|'signup', error?: string, busy?: boolean, username?: string}} state */
export function loginHTML({ mode, error = '', busy = false, username = '' }) {
  const isSignup = mode === 'signup';
  return `<main class="login-wrap" id="main"><section class="panel login-card" aria-labelledby="login-title">
    <div class="login-brand"><span class="brand-mark"><img src="/replay-chat-150.png" alt="" width="35" height="35"></span>Replay Chat</div>
    <h1 id="login-title">${isSignup ? 'Create your account' : 'Log in'}</h1>
    <p class="subtitle">${isSignup ? 'Your conversations, replays and knowledge bases are saved to your account.' : 'Pick up where you left off.'}</p>
    <form id="login-form" novalidate>
      <div class="login-field"><label for="login-username">Username</label><input id="login-username" type="text" autocomplete="username" value="${esc(username)}" autocapitalize="none" spellcheck="false"></div>
      <div class="login-field"><label for="login-password">Password</label><input id="login-password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></div>
      <p class="login-error" id="login-error" role="alert">${esc(error)}</p>
      <button class="btn yellow login-submit" type="submit" ${busy ? 'disabled' : ''}>${isSignup ? 'Sign up' : 'Log in'}</button>
    </form>
    <p class="small login-switch">${isSignup ? 'Already have an account?' : 'No account yet?'} <button type="button" class="login-link" id="switch-mode">${isSignup ? 'Log in' : 'Sign up'}</button></p>
  </section></main>`;
}

const $ = (id) => document.getElementById(id);

export const readForm = () => ({ username: $('login-username').value, password: $('login-password').value });

export function bindLogin({ onSubmit, onSwitch }) {
  $('login-form').onsubmit = (e) => {
    e.preventDefault();
    onSubmit(readForm());
  };
  $('switch-mode').onclick = () => onSwitch(readForm().username);
  $('login-username').focus();
}

export const showError = (message) => {
  $('login-error').textContent = message;
};
