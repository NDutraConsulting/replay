import '../../shared/styles/base.css';
import './login.css';
import { apiTourSeen, currentUser, login, safeNext, signup, validateCredentials } from './login-api.js';
import { bindLogin, loginHTML, showError } from './login-ui.js';

/** Orchestrates the login page: API (session endpoints) <-> UI (form). */
export async function initLogin({ go = (url) => location.assign(url) } = {}) {
  const next = safeNext(location.search);
  document.title = 'Log in · Replay Chat';

  try {
    if (await currentUser()) return go(next); // already logged in
  } catch {
    // the backend is unreachable: show the form anyway; submitting will explain
  }

  const state = { mode: 'login', username: '' };
  const render = () => {
    document.body.innerHTML = loginHTML(state);
    bindLogin({ onSubmit: submit, onSwitch });
  };

  function onSwitch(username) {
    state.mode = state.mode === 'login' ? 'signup' : 'login';
    state.username = username;
    render();
  }

  async function submit({ username, password }) {
    state.username = username;
    const problem = validateCredentials(username, password, { signup: state.mode === 'signup' });
    if (problem) return showError(problem);
    document.querySelector('.login-submit').disabled = true;
    try {
      await (state.mode === 'signup' ? signup : login)(username.trim(), password);
    } catch (err) {
      document.querySelector('.login-submit').disabled = false;
      return showError(err.message);
    }
    // A first login lands on the Account page, which starts the API setup tour (unless the user was heading somewhere specific).
    go(next === '/' && !(await apiTourSeen()) ? '/account' : next);
  }

  render();
}

if (document.body?.dataset.page === 'login') initLogin();
