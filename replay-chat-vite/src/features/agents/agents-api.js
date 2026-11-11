import { api } from '../../shared/http.js';

/** Document review/trust states (must match the backend's DocumentStatus). */
export const STATUSES = [
  { id: 'current', label: 'Current' },
  { id: 'pending-review', label: 'Pending review' },
  { id: 'malicious-active', label: 'Malicious (active)' },
  { id: 'quarantined', label: 'Quarantined' },
  { id: 'archived', label: 'Archived' },
];
export const DEFAULT_STATUS = 'pending-review';

/**
 * A file holds at most this many UTF-8 bytes (the backend's KB_MAX_DOCUMENT_BYTES). The whole file is sent to a model, so
 * longer text must be split into smaller files. This tool has no semantic search over a vector database.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024;
export const byteLength = (text) => new TextEncoder().encode(text).length;
/** "3.2 KB" */
export const formatSize = (bytes) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
export const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;

// ---- server shapes -> the shapes the UI reads
export const toDoc = (d) => ({
  id: d.document_id,
  title: d.title,
  content: d.content,
  status: d.status,
  sizeBytes: d.size_bytes ?? byteLength(d.content ?? ''),
  versionNumber: d.version_number ?? null, // each real change to the text is a new version; records point at one
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

const toSub = (s) => ({ id: s.subcategory_id, name: s.name, documents: (s.documents || []).map(toDoc) });
const toCategory = (c) => ({ id: c.category_id, name: c.name, subcategories: (c.subcategories || []).map(toSub) });

/** { categories: [{ id, name, subcategories: [{ id, name, documents: [{ id, title, content, status, ... }] }] }] } */
export const toKb = (tree) => ({ categories: tree.categories.map(toCategory) });

// ---- requests (the server enforces the rules and answers with user-facing messages)
const base = (agentId) => `/api/agents/${encodeURIComponent(agentId)}`;

export const loadKnowledgeBase = async (agentId) => toKb(await api.get(`${base(agentId)}/knowledge-base`));

/**
 * Deleting files that conversations or replays were answered with: the first call fails with `kb_version_in_use` and the
 * counts in `error.details` ({conversations, replays}); ask the user, then repeat the call with
 * `{ deleteConversations: true }` (the records go too) or `false` (they stay, flagged "version deleted").
 */
const records = (opts) => (opts?.deleteConversations === undefined ? '' : `?delete_conversations=${opts.deleteConversations}`);

/** "Restore defaults" for one agent (it deletes every file the agent had, so it can fail with `kb_version_in_use` too). */
export const resetKnowledgeBase = async (agentId, opts) =>
  toKb(await api.post(`${base(agentId)}/knowledge-base/reset${records(opts)}`));

export const addCategory = async (agentId, name) => toCategory(await api.post(`${base(agentId)}/categories`, { name }));
export const addSubcategory = async (categoryId, name) =>
  toSub(await api.post(`/api/categories/${categoryId}/subcategories`, { name }));
export const addDocument = async (subcategoryId, { title, content = '', status = DEFAULT_STATUS }) =>
  toDoc(await api.post(`/api/subcategories/${subcategoryId}/documents`, { title, content, status }));
export const updateDocument = async (documentId, { title, content, status }) =>
  toDoc(await api.patch(`/api/documents/${documentId}`, { title, content, status }));

export const deleteCategory = (categoryId, opts) => api.delete(`/api/categories/${categoryId}${records(opts)}`);
export const deleteSubcategory = (subcategoryId, opts) => api.delete(`/api/subcategories/${subcategoryId}${records(opts)}`);
export const deleteDocument = (documentId, opts) => api.delete(`/api/documents/${documentId}${records(opts)}`);

/**
 * Upload text files in one request. Partial success is normal.
 * @returns {Promise<{filename: string, ok: boolean, document?: object, error?: string, error_code?: string}[]>}
 *   `error_code` is `kb_document_too_large` for a file over the size limit.
 */
export async function uploadDocuments(subcategoryId, files, status) {
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  formData.append('status', status);
  const { results } = await api.post(`/api/subcategories/${subcategoryId}/documents:upload`, undefined, { formData });
  return results.map((r) => ({ ...r, document: r.document ? toDoc(r.document) : undefined }));
}

// ---- lookups over a loaded tree (pure)
export const findCategory = (kb, id) => kb.categories.find((c) => c.id === id);

export function findSubcategory(kb, id) {
  for (const category of kb.categories) {
    const subcategory = category.subcategories.find((s) => s.id === id);
    if (subcategory) return { category, subcategory };
  }
  return null;
}

export function findDocument(kb, id) {
  for (const category of kb.categories) {
    for (const subcategory of category.subcategories) {
      const document = subcategory.documents.find((d) => d.id === id);
      if (document) return { category, subcategory, document };
    }
  }
  return null;
}

export function statusCounts(kb) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
  for (const c of kb.categories) for (const s of c.subcategories) for (const d of s.documents) counts[d.status] = (counts[d.status] || 0) + 1;
  return counts;
}

export const countDocuments = (kb) => Object.values(statusCounts(kb)).reduce((a, b) => a + b, 0);
