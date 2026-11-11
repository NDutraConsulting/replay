import '../../shared/styles/base.css';
import './agents.css';
import { choiceDialog, noticeDialog } from '../../shared/modal-ui.js';
import { startPage } from '../../shared/shell-ui.js';
import { toast, toastError } from '../../shared/toast.js';
import {
  addCategory, addDocument, addSubcategory, deleteCategory, deleteDocument, deleteSubcategory,
  findDocument, findSubcategory, loadKnowledgeBase, resetKnowledgeBase, updateDocument, uploadDocuments,
} from './agents-api.js';
import {
  agentsPageHTML, bindAgents, bindModal, focusModal, focusOpener, showModalError,
} from './agents-ui.js';

/*
 * HOW AN AGENT USES ITS KNOWLEDGE BASE (done by the backend; this page only edits the knowledge base)
 * ---------------------------------------------------------------------------------------------------
 * When an agent answers (in chat or in a replay) it walks this knowledge base one level at a time:
 *   1. CATEGORY      it is shown the categories and picks one (or none)
 *   2. SUB CATEGORY  it is shown that category's sub categories and picks one (or none)
 *   3. FILE          it is shown that sub category's files and picks one (or none)
 *   4. ANSWER        the chosen file is given to the model as reference material
 * Only files whose status is "current" are ever offered: pending-review, quarantined, malicious-active and archived
 * files never reach a model, so the status set on this page is what controls what an agent can see.
 * Each level is recorded (what was offered, what was chosen, by which model, why) and shown as a collapsible
 * "Decision tree" with the answer: in chat, on the Replay tab and in the Replay Diff, where each slot (A and B) has
 * its own tree. The selections already made in the same conversation are shown to the agent as a hint.
 * See ../../../../backend/README.md ("Knowledge base routing").
 *
 * FILES, VERSIONS AND SIZE
 * A file holds at most 10 KB, because the whole file is sent to the model. Saving more shows a popup that says to split it
 * (this tool has no semantic search; a vector DB would be the way to handle large text). Every real change to a file's text
 * is a new version; conversations and replays record which version they used. Deleting a file that was used asks whether
 * to delete those records too; if they stay they are flagged "version deleted".
 */

/** Orchestrates the AI agents page: API (knowledge bases on the server) <-> UI (markup + DOM). */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Raised when the user answers "Cancel" to the question about records that used a file: nothing was deleted. */
class Cancelled extends Error {}

const TOO_LARGE = 'kb_document_too_large';

export const initAgents = ({
  confirm = (msg) => window.confirm(msg),
  choose = choiceDialog,
  notice = noticeDialog,
} = {}) =>
  startPage('agents', async (main, app) => {
    const agentId = app.agents.some((a) => a.id === 'research') ? 'research' : app.agents[0]?.id;
    const state = {
      agents: app.agents,
      agentId,
      kb: await loadKnowledgeBase(agentId),
      selectedDocId: '',
      filter: '',
      open: new Set(),
      modal: '',
      modalParent: '',
    };

    const render = () => {
      main.innerHTML = agentsPageHTML(state);
      bindAgents(handlers);
      bindModal(handlers);
      if (state.modal) focusModal();
    };
    /** The server is the source of truth: after every change, reload the tree and drop a selection that is gone. */
    async function reload() {
      state.kb = await loadKnowledgeBase(state.agentId);
      if (state.selectedDocId && !findDocument(state.kb, state.selectedDocId)) state.selectedDocId = '';
    }
    /** A file over the size limit: a popup that says to split it (this tool has no semantic search). */
    const tooLarge = (message) => notice({ title: 'Split your content into smaller documents', message });

    /**
     * Deleting files that conversations or replays were answered with: the server refuses first and says how many used
     * them; ask the user whether those records should go too (they stay flagged "version deleted" if not), then repeat.
     * @param {(opts?: {deleteConversations: boolean}) => Promise<unknown>} action
     */
    async function settleRecords(action) {
      try {
        return await action();
      } catch (err) {
        if (err.code !== 'kb_version_in_use') throw err;
        const { conversations = 0, replays = 0 } = err.details || {};
        const answer = await choose({
          title: 'Records used this',
          message: `${plural(conversations, 'conversation')} and ${plural(replays, 'replay')} were answered with it. If you delete it, they stay but are flagged as using a deleted version. Delete those records too?`,
          choices: [
            { id: 'keep', label: 'Keep them (flagged)', primary: true },
            { id: 'delete', label: 'Delete them too', danger: true },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        if (answer !== 'keep' && answer !== 'delete') throw new Cancelled();
        return action({ deleteConversations: answer === 'delete' });
      }
    }

    /** Run a change, reload, re-render and toast. A failure shows the server's message and changes nothing. */
    async function change(action, { message, after } = {}) {
      let result;
      try {
        result = await action();
        await reload();
      } catch (err) {
        if (err instanceof Cancelled) return null;
        if (err.code === TOO_LARGE) await tooLarge(err.message);
        else toastError(err);
        return null;
      }
      after?.(result);
      render();
      if (message) toast(message);
      return result ?? true;
    }

    async function upload(subcategoryId, status, files) {
      const owner = findSubcategory(state.kb, subcategoryId);
      let results;
      try {
        results = await uploadDocuments(subcategoryId, files, status);
        await reload();
      } catch (err) {
        return toastError(err);
      }
      const added = results.filter((r) => r.ok);
      const large = results.find((r) => r.error_code === TOO_LARGE);
      const errors = results.filter((r) => !r.ok && r.error_code !== TOO_LARGE).map((r) => r.error);
      if (added.length) {
        state.selectedDocId = added.at(-1).document.id;
        if (owner) state.open.add(owner.category.id).add(subcategoryId);
      }
      state.modal = '';
      render();
      if (errors.length) toast(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''));
      else if (!large) toast(`Added ${added.length} file${added.length === 1 ? '' : 's'}.`);
      if (large) await tooLarge(large.error);
    }

    const handlers = {
      async onAgent(id) {
        try {
          const kb = await loadKnowledgeBase(id);
          Object.assign(state, { agentId: id, kb, selectedDocId: '', filter: '', modalParent: '', modal: '' });
        } catch (err) {
          toastError(err);
        }
        render();
      },
      onFilter(value) {
        state.filter = value;
        render();
      },
      async onReset() {
        if (!confirm('Replace this knowledge base with its defaults? Your changes for this agent will be lost.')) return;
        let kb;
        try {
          kb = await settleRecords((opts) => resetKnowledgeBase(state.agentId, opts));
        } catch (err) {
          return err instanceof Cancelled ? undefined : toastError(err);
        }
        state.kb = kb;
        state.selectedDocId = '';
        state.open.clear();
        render();
        toast('Defaults restored.');
      },
      onOpenModal(kind) {
        state.modal = kind;
        state.modalParent = kind === 'sub' ? state.modalParent || state.kb.categories[0]?.id || '' : '';
        render();
      },
      onCloseModal() {
        const kind = state.modal;
        state.modal = '';
        render();
        focusOpener(kind);
      },
      async onAddCategory(name) {
        let category;
        try {
          category = await addCategory(state.agentId, name);
          await reload();
        } catch (err) {
          return showModalError(err.message);
        }
        state.open.add(category.id);
        state.modal = '';
        render();
        toast('Category added.');
      },
      async onAddSubcategory(categoryId, name) {
        let sub;
        try {
          sub = await addSubcategory(categoryId, name);
          await reload();
        } catch (err) {
          return showModalError(err.message);
        }
        state.open.add(categoryId).add(sub.id);
        state.modalParent = categoryId;
        state.modal = '';
        render();
        toast('Sub category added.');
      },
      onAddDocument(subcategoryId, title, status) {
        return change(() => addDocument(subcategoryId, { title, status }), {
          message: 'File added. Add its content on the right.',
          after: (doc) => {
            state.modal = '';
            state.selectedDocId = doc.id;
            const found = findDocument(state.kb, doc.id);
            if (found) state.open.add(found.category.id).add(found.subcategory.id);
          },
        });
      },
      onUpload: upload,
      onToggleNode(id, open) {
        if (state.filter) return;
        if (open) state.open.add(id);
        else state.open.delete(id);
      },
      onSelectDocument(id) {
        state.selectedDocId = id;
        render();
      },
      onSaveDocument: (values) => change(() => updateDocument(state.selectedDocId, values), { message: 'File saved.' }),
      onDeleteDocument() {
        const found = findDocument(state.kb, state.selectedDocId);
        if (!found || !confirm(`Delete "${found.document.title}"?`)) return;
        return change(() => settleRecords((opts) => deleteDocument(found.document.id, opts)), { message: 'File deleted.' });
      },
      onDeleteCategory(id) {
        const category = state.kb.categories.find((c) => c.id === id);
        if (!category || !confirm(`Delete category "${category.name}" and everything in it?`)) return;
        return change(() => settleRecords((opts) => deleteCategory(id, opts)), { message: 'Category deleted.' });
      },
      onDeleteSubcategory(id) {
        const found = findSubcategory(state.kb, id);
        if (!found || !confirm(`Delete sub category "${found.subcategory.name}" and its files?`)) return;
        return change(() => settleRecords((opts) => deleteSubcategory(id, opts)), { message: 'Sub category deleted.' });
      },
    };

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.modal) handlers.onCloseModal();
    });

    render();
  });

initAgents();
