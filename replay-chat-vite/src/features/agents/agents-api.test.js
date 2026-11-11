import { describe, expect, it } from 'vitest';
import { mockApi } from '../../test/mock-api.js';
import {
  MAX_DOCUMENT_BYTES, addCategory, addDocument, byteLength, countDocuments, deleteCategory, deleteDocument,
  deleteSubcategory, findDocument, findSubcategory, formatSize, loadKnowledgeBase, resetKnowledgeBase, statusCounts,
  statusLabel, toDoc, toKb, updateDocument, uploadDocuments,
} from './agents-api.js';

const serverTree = {
  agent_id: 'research',
  categories: [
    {
      category_id: 'c1',
      name: 'Networks',
      subcategories: [
        {
          subcategory_id: 's1',
          name: 'Segmentation',
          documents: [
            { document_id: 'd1', title: 'a.txt', content: 'A', status: 'current', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
            { document_id: 'd2', title: 'b.txt', content: 'B', status: 'archived', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    },
    { category_id: 'c2', name: 'Books', subcategories: [] },
  ],
};

describe('agents api', () => {
  it('maps the server tree to the shape the UI reads', () => {
    const kb = toKb(serverTree);
    expect(kb.categories.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(kb.categories[0].subcategories[0].documents[0]).toEqual({
      id: 'd1', title: 'a.txt', content: 'A', status: 'current', sizeBytes: 1, versionNumber: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    }); // fmt: skip
    expect(toDoc({ ...serverTree.categories[0].subcategories[0].documents[0], size_bytes: 9, version_number: 3 })).toMatchObject({ sizeBytes: 9, versionNumber: 3 });
    expect(kb.categories[1].subcategories).toEqual([]);
  });

  it('answers pure questions about a loaded tree', () => {
    const kb = toKb(serverTree);
    expect(countDocuments(kb)).toBe(2);
    expect(statusCounts(kb)).toMatchObject({ current: 1, archived: 1, quarantined: 0 });
    expect(findDocument(kb, 'd2')).toMatchObject({ category: { id: 'c1' }, subcategory: { id: 's1' }, document: { title: 'b.txt' } });
    expect(findDocument(kb, 'nope')).toBeNull();
    expect(findSubcategory(kb, 's1').category.name).toBe('Networks');
    expect(statusLabel('pending-review')).toBe('Pending review');
  });

  it('calls the right routes with the right bodies', async () => {
    const mock = mockApi({
      'GET /api/agents/:agent/knowledge-base': () => serverTree,
      'POST /api/agents/:agent/knowledge-base/reset': () => serverTree,
      'POST /api/agents/:agent/categories': () => ({ category_id: 'c9', name: 'Cloud', subcategories: [] }),
      'POST /api/subcategories/:id/documents': () => serverTree.categories[0].subcategories[0].documents[0],
      'PATCH /api/documents/:id': () => serverTree.categories[0].subcategories[0].documents[1],
      'DELETE /api/categories/:id': () => ({ __status: 204, body: null }),
    });
    expect((await loadKnowledgeBase('research')).categories).toHaveLength(2);
    expect((await resetKnowledgeBase('research')).categories).toHaveLength(2);
    expect(await addCategory('research', 'Cloud')).toEqual({ id: 'c9', name: 'Cloud', subcategories: [] });
    await addDocument('s1', { title: 'x', content: 'y', status: 'current' });
    expect(mock.lastBody('POST /api/subcategories/:id/documents')).toEqual({ title: 'x', content: 'y', status: 'current' });
    await addDocument('s1', { title: 'defaults' });
    expect(mock.lastBody('POST /api/subcategories/:id/documents')).toEqual({ title: 'defaults', content: '', status: 'pending-review' });
    await updateDocument('d2', { title: 'b.txt', content: 'new', status: 'quarantined' });
    expect(mock.lastBody('PATCH /api/documents/:id')).toEqual({ title: 'b.txt', content: 'new', status: 'quarantined' });
    expect(await deleteCategory('c1')).toBeNull();
    expect(mock.calls.find((c) => c.method === 'GET').path).toBe('/api/agents/research/knowledge-base');
  });

  it('asks the server to delete the records that used a file only when told to', async () => {
    const mock = mockApi({
      'DELETE /api/documents/:id': () => ({ __status: 204, body: null }),
      'DELETE /api/categories/:id': () => ({ __status: 204, body: null }),
      'DELETE /api/subcategories/:id': () => ({ __status: 204, body: null }),
      'POST /api/agents/:agent/knowledge-base/reset': () => serverTree,
    });
    await deleteDocument('d1');
    await deleteDocument('d1', { deleteConversations: false });
    await deleteDocument('d1', { deleteConversations: true });
    await deleteCategory('c1', { deleteConversations: true });
    await deleteSubcategory('s1', { deleteConversations: false });
    await resetKnowledgeBase('research', { deleteConversations: true });
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/documents/d1', '/api/documents/d1?delete_conversations=false', '/api/documents/d1?delete_conversations=true',
      '/api/categories/c1?delete_conversations=true', '/api/subcategories/s1?delete_conversations=false',
      '/api/agents/research/knowledge-base/reset?delete_conversations=true',
    ]); // fmt: skip
    expect(mock.calls).toHaveLength(6);
  });

  it('formats sizes against the 10 KB limit', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(10240);
    expect(byteLength('é')).toBe(2);
    expect(formatSize(512)).toBe('0.5 KB');
    expect(formatSize(10240)).toBe('10 KB');
  });

  it('uploads files as multipart with the chosen status and maps the per-file results', async () => {
    const mock = mockApi({
      'POST /api/subcategories/:id/documents:upload': () => ({
        results: [
          { filename: 'a.txt', ok: true, document: serverTree.categories[0].subcategories[0].documents[0] },
          { filename: 'bad.png', ok: false, error: '"bad.png" is not a text file.' },
        ],
      }),
    });
    const files = [new File(['A'], 'a.txt', { type: 'text/plain' }), new File(['x'], 'bad.png')];
    const results = await uploadDocuments('s1', files, 'current');
    const form = mock.calls[0].formData;
    expect(form.getAll('files').map((f) => f.name)).toEqual(['a.txt', 'bad.png']);
    expect(form.get('status')).toBe('current');
    expect(results[0].document.id).toBe('d1');
    expect(results[1]).toMatchObject({ ok: false, error: '"bad.png" is not a text file.' });
  });
});
