import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../../shared/http.js';
import { apiError, appRoutes, created, mockApi, noContent, settle } from '../../test/mock-api.js';

const $ = (id) => document.getElementById(id);
const LIMIT = 10 * 1024;
const SPLIT = 'You need to split your content into smaller documents. Or if you want to customize this tool you could build a vector DB for semantic search. This tool does not currently support semantic search.';
const tooLarge = () => apiError(422, 'kb_document_too_large', `This content is larger than 10 KB. ${SPLIT}`);
const doc = (n, title, status, content = `content of ${title}`) => ({
  document_id: `d${n}`, title, content, status, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  size_bytes: new TextEncoder().encode(content).length, version_number: 1,
}); // fmt: skip

const defaults = () => ({
  research: [
    { category_id: 'c1', name: 'Networks', subcategories: [{ subcategory_id: 's1', name: 'Segmentation', documents: [doc(1, 'network-segmentation.txt', 'current'), doc(2, 'legacy-tls.txt', 'archived')] }] },
    { category_id: 'c2', name: 'Penetration Testing', subcategories: [{ subcategory_id: 's2', name: 'Planning', documents: [doc(3, 'rules-of-engagement.txt', 'pending-review')] }] },
    { category_id: 'c3', name: 'HIPAA', subcategories: [{ subcategory_id: 's3', name: 'Rules', documents: [doc(4, 'hipaa-safeguards.txt', 'current')] }] },
  ],
  code: [{ category_id: 'c10', name: 'Python', subcategories: [] }, { category_id: 'c11', name: 'C++', subcategories: [] }],
  assistant: [],
}); // fmt: skip

const apiError409 = (details) => ({ __status: 409, body: { error: { code: 'kb_version_in_use', message: 'In use. Delete those records too?', details } } });
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const readText = (file) => new Promise((resolve) => Object.assign(new FileReader(), { onload() { resolve(this.result); } }).readAsText(file)); // fmt: skip

/** An in-memory fake of the knowledge-base routes (just enough behaviour for the page). */
function kbServer() {
  const { routes } = appRoutes();
  const kbs = defaults();
  let id = 100;
  const find = (fn) => {
    for (const cats of Object.values(kbs)) for (const c of cats) { for (const s of c.subcategories) { for (const d of s.documents) { const hit = fn({ c, s, d }); if (hit) return hit; } const hit = fn({ c, s }); if (hit) return hit; } const hit = fn({ c }); if (hit) return hit; } // fmt: skip
    return null;
  };
  // files, sub categories and categories that conversations or replays were answered with: { id: {conversations, replays} }
  const server = { kbs, loads: 0, used: {} };
  /** The 409 the server answers with until the client says what to do with the records (?delete_conversations=). */
  const settle409 = (id, query) => {
    const used = server.used[id];
    if (!used || query.delete_conversations !== undefined) return null;
    return apiError409(used);
  };
  const mock = mockApi({
    ...routes,
    'GET /api/agents/:agent/knowledge-base': ({ params }) => {
      server.loads++;
      return { agent_id: params.agent, categories: structuredClone(kbs[params.agent]) };
    },
    'POST /api/agents/:agent/knowledge-base/reset': ({ params, query }) => {
      const blocked = settle409(`reset:${params.agent}`, query);
      if (blocked) return blocked;
      server.resetQuery = query;
      kbs[params.agent] = defaults()[params.agent];
      return { agent_id: params.agent, categories: structuredClone(kbs[params.agent]) };
    },
    'POST /api/agents/:agent/categories': ({ params, body }) => {
      const name = body.name.trim();
      if (!name) return apiError(422, 'validation_error', 'Enter a category name.');
      if (kbs[params.agent].some((c) => same(c.name, name))) return apiError(409, 'duplicate_name', `A category named "${name}" already exists.`);
      const category = { category_id: `c${id++}`, name, subcategories: [] };
      kbs[params.agent].push(category);
      return created(category);
    },
    'DELETE /api/categories/:id': ({ params, query }) => {
      const blocked = settle409(params.id, query);
      if (blocked) return blocked;
      server.deleteQuery = query;
      for (const cats of Object.values(kbs)) { const i = cats.findIndex((c) => c.category_id === params.id); if (i >= 0) cats.splice(i, 1); } // fmt: skip
      return noContent();
    },
    'POST /api/categories/:id/subcategories': ({ params, body }) => {
      const category = find(({ c, s }) => c.category_id === params.id && !s && c);
      if (category.subcategories.some((s) => same(s.name, body.name))) return apiError(409, 'duplicate_name', `"${category.name}" already has a sub category named "${body.name}".`);
      const sub = { subcategory_id: `s${id++}`, name: body.name.trim(), documents: [] };
      category.subcategories.push(sub);
      return created(sub);
    },
    'DELETE /api/subcategories/:id': ({ params, query }) => {
      const blocked = settle409(params.id, query);
      if (blocked) return blocked;
      server.deleteQuery = query;
      for (const cats of Object.values(kbs)) for (const c of cats) c.subcategories = c.subcategories.filter((s) => s.subcategory_id !== params.id); // fmt: skip
      return noContent();
    },
    'POST /api/subcategories/:id/documents': ({ params, body }) => {
      if (new TextEncoder().encode(body.content ?? '').length > LIMIT) return tooLarge();
      const sub = find(({ s, d }) => s?.subcategory_id === params.id && !d && s);
      const title = /\.[A-Za-z0-9]{1,5}$/.test(body.title.trim()) ? body.title.trim() : `${body.title.trim()}.txt`;
      if (sub.documents.some((x) => same(x.title, title))) return apiError(409, 'duplicate_name', `"${title}" already exists in this sub category.`);
      const created_doc = doc(id++, title, body.status, body.content);
      sub.documents.push(created_doc);
      return created(created_doc);
    },
    'PATCH /api/documents/:id': ({ params, body }) => {
      if (new TextEncoder().encode(body.content ?? '').length > LIMIT) return tooLarge();
      const found = find(({ d }) => d?.document_id === params.id && d);
      const next = Object.assign(found, body);
      if (body.content !== undefined) Object.assign(next, { size_bytes: new TextEncoder().encode(body.content).length, version_number: next.version_number + 1 });
      return next;
    },
    'DELETE /api/documents/:id': ({ params, query }) => {
      const blocked = settle409(params.id, query);
      if (blocked) return blocked;
      server.deleteQuery = query;
      for (const cats of Object.values(kbs)) for (const c of cats) for (const s of c.subcategories) s.documents = s.documents.filter((d) => d.document_id !== params.id); // fmt: skip
      return noContent();
    },
    'POST /api/subcategories/:id/documents:upload': async ({ params, formData }) => {
      const sub = find(({ s, d }) => s?.subcategory_id === params.id && !d && s);
      const results = [];
      for (const file of formData.getAll('files')) {
        if (!file.name.endsWith('.txt')) { results.push({ filename: file.name, ok: false, error: `"${file.name}" is not a text file.` }); continue; } // fmt: skip
        if (file.size > LIMIT) { results.push({ filename: file.name, ok: false, error: `"${file.name}" is larger than 10 KB. ${SPLIT}`, error_code: 'kb_document_too_large' }); continue; } // fmt: skip
        const d = doc(id++, file.name, formData.get('status'), await readText(file));
        sub.documents.push(d);
        results.push({ filename: file.name, ok: true, document: d });
      }
      return { results };
    },
  });
  return { server, mock };
}

async function boot() {
  vi.resetModules();
  document.body.innerHTML = '';
  setUnauthorizedHandler(vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  const fake = kbServer();
  await import('./agents-controller.js');
  await settle();
  return fake;
}
const type = (id, value) => {
  $(id).value = value;
};
const pickAgent = async (id) => {
  $('open-agent').click();
  type('agent-select', id);
  $('modal-form').requestSubmit();
  await settle();
};
const addCategoryViaModal = async (name) => {
  $('open-add-category').click();
  type('new-category', name);
  $('modal-form').requestSubmit();
  await settle();
};
const dialog = () => document.querySelector('.modal');
const choose = async (choice) => {
  document.querySelector(`[data-choice="${choice}"]`).click();
  await settle();
};
const toastText = () => document.querySelector('.toast')?.textContent;
const categoryNames = () => [...document.querySelectorAll('.kb-cat > summary .kb-name')].map((e) => e.textContent);

describe('agents page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the research knowledge base from the server by default and switches agents', async () => {
    const { mock } = await boot();
    $('open-agent').click();
    expect($('agent-select').value).toBe('research');
    expect([...$('agent-select').options].map((o) => o.textContent)).toEqual(['General assistant', 'Code assistant', 'IT Security Assistant']);
    expect(categoryNames()).toEqual(['Networks', 'Penetration Testing', 'HIPAA']);
    expect(mock.calls.find((c) => c.method === 'GET' && c.path.includes('knowledge-base')).path).toBe('/api/agents/research/knowledge-base');
    await pickAgent('code');
    expect(categoryNames()).toEqual(['Python', 'C++']);
    await pickAgent('assistant');
    expect(document.querySelector('.kb-tree .empty h2').textContent).toBe('No knowledge yet.');
  });

  it('creates a category, a sub category and a file, then edits its status and content', async () => {
    const { mock } = await boot();
    await addCategoryViaModal('Cloud security');
    expect(mock.lastBody('POST /api/agents/:agent/categories')).toEqual({ name: 'Cloud security' });
    expect(categoryNames().at(-1)).toBe('Cloud security');
    expect($('kb-modal')).toBeNull();

    const cloud = [...document.querySelectorAll('.kb-cat')].at(-1);
    $('open-add-sub').click();
    type('sub-parent', cloud.dataset.node);
    type('new-sub', 'IAM');
    $('modal-form').requestSubmit();
    await settle();
    expect(mock.lastBody('POST /api/categories/:id/subcategories')).toEqual({ name: 'IAM' });

    const sub = document.querySelector(`[data-node="${cloud.dataset.node}"] .kb-sub`);
    $('open-add-file').click();
    type('doc-parent', sub.dataset.node);
    type('new-doc', 'least-privilege');
    $('add-doc-form').requestSubmit();
    await settle();
    expect(mock.lastBody('POST /api/subcategories/:id/documents')).toEqual({ title: 'least-privilege', content: '', status: 'pending-review' });
    expect($('doc-title').value).toBe('least-privilege.txt');
    expect($('doc-status').value).toBe('pending-review');

    type('doc-content', 'Grant the minimum.');
    type('doc-status', 'quarantined');
    $('doc-form').requestSubmit();
    await settle();
    expect(mock.lastBody('PATCH /api/documents/:id')).toEqual({ title: 'least-privilege.txt', content: 'Grant the minimum.', status: 'quarantined' });
    expect(document.querySelector('.kb-flag')).not.toBeNull();
    expect(toastText()).toBe('File saved.');
  });

  it("shows the server's message inside the modal and keeps it open when a name is taken", async () => {
    const { mock } = await boot();
    await addCategoryViaModal('networks');
    expect($('modal-error').textContent).toBe('A category named "networks" already exists.');
    expect($('kb-modal')).not.toBeNull();
    expect(mock.count('GET /api/agents/:agent/knowledge-base')).toBe(1); // nothing was reloaded
    expect(categoryNames()).toEqual(['Networks', 'Penetration Testing', 'HIPAA']);
  });

  it('shows duplicate sub category and file errors', async () => {
    await boot();
    $('open-add-sub').click();
    type('sub-parent', 'c1');
    type('new-sub', 'segmentation');
    $('modal-form').requestSubmit();
    await settle();
    expect($('modal-error').textContent).toBe('"Networks" already has a sub category named "segmentation".');
    $('cancel-modal').click();
    $('open-add-file').click();
    type('doc-parent', 's1');
    type('new-doc', 'network-segmentation');
    $('add-doc-form').requestSubmit();
    await settle();
    expect(toastText()).toBe('"network-segmentation.txt" already exists in this sub category.');
  });

  it('filters by status without asking the server again', async () => {
    const { mock } = await boot();
    const before = mock.calls.length;
    type('status-filter', 'archived');
    $('status-filter').dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.kb-doc')).toHaveLength(1);
    expect(document.querySelector('.kb-doc .status').textContent).toBe('Archived');
    type('status-filter', 'malicious-active');
    $('status-filter').dispatchEvent(new Event('change'));
    expect(document.querySelector('.kb-tree .empty').textContent).toMatch(/Malicious/);
    expect(mock.calls.length).toBe(before);
  });

  it('escapes names from the server', async () => {
    await boot();
    await addCategoryViaModal('<img src=x onerror=alert(1)>');
    expect(document.querySelector('.kb-tree img')).toBeNull();
    expect(categoryNames().at(-1)).toBe('<img src=x onerror=alert(1)>');
  });

  it('deletes after confirmation, and not when declined', async () => {
    const { server, mock } = await boot();
    document.querySelector('[data-delete-category="c1"]').click();
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(mock.called('DELETE /api/categories/:id')).toBe(true);
    expect(categoryNames()).toEqual(['Penetration Testing', 'HIPAA']);
    expect(server.kbs.research).toHaveLength(2);
    vi.mocked(confirm).mockReturnValueOnce(false);
    document.querySelector('[data-delete-category="c2"]').click();
    await settle();
    expect(categoryNames()).toEqual(['Penetration Testing', 'HIPAA']);
  });

  it('deletes a sub category and a selected file', async () => {
    const { mock } = await boot();
    document.querySelector('[data-delete-sub="s3"]').click();
    await settle();
    expect(mock.called('DELETE /api/subcategories/:id')).toBe(true);
    document.querySelector('[data-doc="d3"]').click();
    $('delete-doc').click();
    await settle();
    expect(mock.called('DELETE /api/documents/:id')).toBe(true);
    expect($('doc-form')).toBeNull();
    expect(document.querySelector('[data-doc="d3"]')).toBeNull();
  });

  it('uploads text files with the chosen status and reports the ones the server rejected', async () => {
    const { mock } = await boot();
    $('open-add-file').click();
    type('doc-parent', 's1');
    type('new-doc-status', 'current');
    const input = $('upload-docs');
    Object.defineProperty(input, 'files', {
      value: [new File(['hello world'], 'uploaded.txt', { type: 'text/plain' }), new File(['x'], 'bad.png', { type: 'image/png' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settle(20);
    const form = mock.calls.find((c) => c.formData).formData;
    expect(form.get('status')).toBe('current');
    expect(form.getAll('files').map((f) => f.name)).toEqual(['uploaded.txt', 'bad.png']);
    expect(document.querySelector('[data-doc]:last-child, .kb-doc-name')).not.toBeNull();
    expect([...document.querySelectorAll('.kb-doc-name')].map((e) => e.textContent)).toContain('uploaded.txt');
    expect($('doc-content').value).toBe('hello world');
    expect(toastText()).toBe('"bad.png" is not a text file.');
  });

  it('restores the defaults after confirmation', async () => {
    const { mock } = await boot();
    await addCategoryViaModal('Extra');
    expect(categoryNames()).toHaveLength(4);
    $('reset-kb').click();
    await settle();
    expect(mock.called('POST /api/agents/:agent/knowledge-base/reset')).toBe(true);
    expect(categoryNames()).toEqual(['Networks', 'Penetration Testing', 'HIPAA']);
    expect(toastText()).toBe('Defaults restored.');
  });

  it('keeps the page unchanged and says why when a request fails', async () => {
    const { mock } = await boot();
    globalThis.fetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    document.querySelector('[data-delete-category="c1"]').click();
    await settle();
    expect(toastText()).toMatch(/Could not reach the server/);
    expect(categoryNames()).toEqual(['Networks', 'Penetration Testing', 'HIPAA']);
    void mock;
  });

  describe('files: size limit, versions and the records that used them', () => {
    const big = 'x'.repeat(LIMIT + 1);

    it('shows the size, the limit and the version of the selected file, and updates the size as you type', async () => {
      await boot();
      document.querySelector('[data-doc="d1"]').click();
      expect($('doc-size').textContent).toContain('of 10 KB');
      expect($('doc-size').textContent).toContain('version 1');
      expect($('doc-size').textContent).toContain('does not support semantic search');
      type('doc-content', 'é'.repeat(LIMIT / 2 + 1));
      $('doc-content').dispatchEvent(new Event('input'));
      expect($('doc-size').classList.contains('over')).toBe(true);
      expect($('doc-size-text').textContent).toBe('10 KB of 10 KB');
      type('doc-content', 'short');
      $('doc-content').dispatchEvent(new Event('input'));
      expect($('doc-size').classList.contains('over')).toBe(false);
    });

    it('saving a file over 10 KB shows the "split your content" popup and changes nothing', async () => {
      const { mock } = await boot();
      document.querySelector('[data-doc="d1"]').click();
      type('doc-content', big);
      $('doc-form').requestSubmit();
      await settle();
      expect(dialog().querySelector('h2').textContent).toBe('Split your content into smaller documents');
      expect(dialog().textContent).toContain('You need to split your content into smaller documents.');
      expect(dialog().textContent).toContain('This tool does not currently support semantic search.');
      expect(document.querySelector('.toast')).toBeNull(); // the popup, not a toast
      expect(mock.count('GET /api/agents/:agent/knowledge-base')).toBe(1); // nothing reloaded
      document.querySelector('[data-choice="ok"]').click();
      await settle();
      expect(dialog()).toBeNull();
      expect($('doc-content').value).toBe(big); // the text is still there to be split
    });

    it('uploading a file over 10 KB shows the popup; the other files are still added', async () => {
      await boot();
      $('open-add-file').click();
      type('doc-parent', 's1');
      const input = $('upload-docs');
      Object.defineProperty(input, 'files', {
        value: [new File(['fine'], 'ok.txt', { type: 'text/plain' }), new File([big], 'huge.txt', { type: 'text/plain' })],
        configurable: true,
      });
      input.dispatchEvent(new Event('change'));
      await settle(20);
      expect([...document.querySelectorAll('.kb-doc-name')].map((e) => e.textContent)).toContain('ok.txt');
      expect(dialog().textContent).toContain('"huge.txt" is larger than 10 KB.');
      expect(dialog().textContent).toContain('You need to split your content into smaller documents.');
    });

    it('deleting a file that records used asks first; "Keep them" deletes the file and keeps the records', async () => {
      const { server, mock } = await boot();
      server.used.d3 = { conversations: 2, replays: 1 };
      document.querySelector('[data-doc="d3"]').click();
      $('delete-doc').click();
      await settle();
      expect(dialog().textContent).toContain('2 conversations and 1 replay were answered with it');
      expect(document.querySelector('[data-doc="d3"]')).not.toBeNull(); // nothing is deleted by the question
      await choose('keep');
      expect(mock.calls.filter((c) => c.key === 'DELETE /api/documents/:id')).toHaveLength(2); // the question, then the answer
      expect(server.deleteQuery).toEqual({ delete_conversations: 'false' });
      expect(document.querySelector('[data-doc="d3"]')).toBeNull();
      expect(toastText()).toBe('File deleted.');
    });

    it('"Delete them too" deletes the file and asks the server to delete the records', async () => {
      const { server } = await boot();
      server.used.d3 = { conversations: 1, replays: 0 };
      document.querySelector('[data-doc="d3"]').click();
      $('delete-doc').click();
      await settle();
      expect(dialog().textContent).toContain('1 conversation and 0 replays');
      await choose('delete');
      expect(server.deleteQuery).toEqual({ delete_conversations: 'true' });
      expect(document.querySelector('[data-doc="d3"]')).toBeNull();
    });

    it('Cancel (or Escape) keeps the file and everything else, with no error', async () => {
      const { server, mock } = await boot();
      server.used.d3 = { conversations: 1, replays: 1 };
      document.querySelector('[data-doc="d3"]').click();
      $('delete-doc').click();
      await settle();
      await choose('cancel');
      expect(document.querySelector('[data-doc="d3"]')).not.toBeNull();
      expect(document.querySelector('.toast')).toBeNull();
      expect(mock.calls.filter((c) => c.key === 'DELETE /api/documents/:id')).toHaveLength(1);
      $('delete-doc').click();
      await settle();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await settle();
      expect(dialog()).toBeNull();
      expect(document.querySelector('[data-doc="d3"]')).not.toBeNull();
    });

    it('deleting a category or sub category that records used asks the same question', async () => {
      const { server } = await boot();
      server.used.c1 = { conversations: 3, replays: 0 };
      server.used.s3 = { conversations: 1, replays: 1 };
      document.querySelector('[data-delete-category="c1"]').click();
      await settle();
      expect(dialog().textContent).toContain('3 conversations');
      await choose('keep');
      expect(categoryNames()).toEqual(['Penetration Testing', 'HIPAA']);
      document.querySelector('[data-delete-sub="s3"]').click();
      await settle();
      expect(dialog().textContent).toContain('1 conversation and 1 replay');
      await choose('delete');
      expect(server.deleteQuery).toEqual({ delete_conversations: 'true' });
    });

    it('"Restore defaults" asks the same question when the files it replaces were used', async () => {
      const { server } = await boot();
      server.used['reset:research'] = { conversations: 1, replays: 0 };
      $('reset-kb').click();
      await settle();
      expect(dialog()).not.toBeNull();
      await choose('keep');
      expect(server.resetQuery).toEqual({ delete_conversations: 'false' });
      expect(toastText()).toBe('Defaults restored.');
    });
  });

  describe('add category / sub category modals', () => {
    it('opens each modal independently and returns focus to its button on cancel', async () => {
      await boot();
      expect($('kb-modal')).toBeNull();
      $('open-add-category').click();
      expect($('kb-modal-title').textContent).toBe('Add category');
      expect($('new-sub')).toBeNull();
      expect(document.activeElement).toBe($('new-category'));
      $('cancel-modal').click();
      expect($('kb-modal')).toBeNull();
      expect(document.activeElement).toBe($('file-menu-btn'));
      $('open-add-sub').click();
      expect($('kb-modal-title').textContent).toBe('Add subcategory');
      expect($('new-category')).toBeNull();
      expect($('sub-parent').options).toHaveLength(3);
    });

    it('closes with Escape, the close button and an overlay click', async () => {
      await boot();
      $('open-add-category').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect($('kb-modal')).toBeNull();
      $('open-add-sub').click();
      $('close-modal').click();
      expect($('kb-modal')).toBeNull();
      $('open-add-sub').click();
      $('kb-modal').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect($('kb-modal')).toBeNull();
    });

    it('disables Add subcategory and Add file when the agent has nothing to add them to', async () => {
      await boot();
      await pickAgent('assistant');
      expect($('open-add-sub').disabled).toBe(true);
      expect($('open-add-file').disabled).toBe(true);
      expect($('open-add-category').disabled).toBe(false);
      expect($('open-agent').disabled).toBe(false);
    });

    it('opens the File menu and gives the agent picker and add file their own popups', async () => {
      await boot();
      expect($('file-menu').hidden).toBe(true);
      expect($('agent-select')).toBeNull();
      expect($('add-doc-form')).toBeNull();
      $('file-menu-btn').click();
      expect($('file-menu').hidden).toBe(false);
      expect([...$('file-menu').querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(['Open agent', 'Add category', 'Add subcategory', 'Add file']);
      $('open-add-file').click();
      expect($('file-menu').hidden).toBe(true);
      expect($('kb-modal-title').textContent).toBe('Add file');
      $('close-modal').click();
      $('open-agent').click();
      expect($('kb-modal-title').textContent).toBe('Open agent');
    });
  });

  it('shows a retryable error when the knowledge base cannot be loaded', async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    setUnauthorizedHandler(vi.fn());
    const { routes } = appRoutes();
    mockApi({ ...routes, 'GET /api/agents/:agent/knowledge-base': apiError(500, 'oops', 'The server hit a problem.') });
    await import('./agents-controller.js');
    await settle();
    expect(document.querySelector('[role="alert"]').textContent).toContain('The server hit a problem.');
    expect($('retry-load')).not.toBeNull();
  });
});
