import '../../shared/styles/base.css';
import './account.css';
import { choiceDialog } from '../../shared/modal-ui.js';
import { startPage } from '../../shared/shell-ui.js';
import { toast, toastError } from '../../shared/toast.js';
import { addConnection, deleteConnection, listConnections, saveConnection, testConnection } from './account-api.js';
import {
  accountHTML, applyPreset, els, readAddForm, readApiForm, renderApiPanel, setStatus, setTesting, toggleKeyVisibility,
} from './account-ui.js';

/** Orchestrates the account page: API (the account's APIs on the server) <-> UI (add form + the models panel). */
export const initAccount = () =>
  startPage('account', async (main, app) => {
    const state = { connections: app.settings.connections ?? [], selectedId: null };
    state.connections = await listConnections().catch(() => state.connections);
    state.selectedId = state.connections.find((c) => !c.readOnly)?.id ?? state.connections[0]?.id ?? null;

    const current = () => state.connections.find((c) => c.id === state.selectedId) ?? state.connections[0];

    /** Draw the page, or just the models panel when `panelOnly` (so what was typed in the add form stays). */
    const render = (panelOnly = false) => {
      if (panelOnly) renderApiPanel(state);
      else main.innerHTML = accountHTML(state);
      bind();
    };

    const replace = (connection) => {
      state.connections = state.connections.map((c) => (c.id === connection.id ? connection : c));
    };

    async function add() {
      let made;
      try {
        made = await addConnection(readAddForm());
      } catch (err) {
        return toastError(err);
      }
      const server = state.connections.filter((c) => c.readOnly); // the server's own API stays last
      state.connections = [...state.connections.filter((c) => !c.readOnly), made, ...server];
      state.selectedId = made.id;
      render(); // a fresh add form, and the models panel on the new API
      setStatus('Added. Now add the models this API serves, then save.');
      els().models?.focus();
      toast(`Added the API “${made.label}”.`);
    }

    /** @returns {Promise<boolean>} true when saved; otherwise the server's message is shown. */
    async function save() {
      const api = current();
      try {
        replace(await saveConnection(api.id, readApiForm()));
      } catch (err) {
        toastError(err);
        return false;
      }
      render(true);
      return true;
    }

    function bind() {
      const e = els();
      e.addForm.onsubmit = (ev) => {
        ev.preventDefault();
        return add();
      };
      e.provider.onchange = () => applyPreset(e.provider.value);
      document.querySelectorAll('.show-key').forEach((b) => (b.onclick = () => toggleKeyVisibility(b)));
      if (!e.form) return;
      e.label.onchange = () => {
        state.selectedId = e.label.value;
        render(true);
      };
      if (current().readOnly) {
        e.test.onclick = () => runTest(current());
        return;
      }
      e.form.onsubmit = async (ev) => {
        ev.preventDefault();
        if (await save()) {
          setStatus('Saved. Test it to verify access.');
          toast(`Saved “${current().label}”.`);
        }
      };
      e.test.onclick = async () => {
        if (!(await save())) return;
        await runTest(current());
      };
      e.remove.onclick = async () => {
        const api = current();
        const answer = await choiceDialog({
          title: `Delete “${api.label}”?`,
          message: `Chats and replays that use a model from this API will not be able to send until you start new ones. The saved key is removed from the server.`,
          choices: [
            { id: 'cancel', label: 'Keep it' },
            { id: 'delete', label: 'Delete API', primary: true, danger: true },
          ],
        });
        if (answer !== 'delete') return;
        try {
          await deleteConnection(api.id);
        } catch (err) {
          return toastError(err);
        }
        state.connections = state.connections.filter((c) => c.id !== api.id);
        state.selectedId = state.connections.find((c) => !c.readOnly)?.id ?? state.connections[0]?.id ?? null;
        render(true);
        toast(`Deleted “${api.label}”.`);
      };
    }

    async function runTest(api) {
      if (!api.models.length) return setStatus('Add a model to this API before testing it.');
      setStatus(`Testing ${api.label} · ${api.models[0]}…`);
      setTesting(true);
      try {
        setStatus((await testConnection(api.id)).message);
      } catch (err) {
        setStatus(err.message);
      } finally {
        setTesting(false);
      }
    }

    render();
  });

initAccount();
