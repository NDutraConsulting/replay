import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';
import { footerHTML } from '../../shared/shell-ui.js';
import { DEFAULT_STATUS, MAX_DOCUMENT_BYTES, STATUSES, byteLength, countDocuments, findDocument, formatSize, statusLabel } from './agents-api.js';

// View-model (built by agents-controller.js): { agents, agentId, kb, selectedDocId, filter, open: Set<string>, modal: ''|'agent'|'category'|'sub'|'file', modalParent }

const statusBadge = (id) => `<span class="status status-${esc(id)}">${esc(statusLabel(id))}</span>`;
const statusOptions = (selected) =>
  STATUSES.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function docMatches(d, filter) {
  return !filter || d.status === filter;
}

function treeHTML(v) {
  const { kb, filter, selectedDocId, open } = v;
  const cats = kb.categories
    .map((c) => {
      const subs = c.subcategories
        .map((s) => {
          const docs = s.documents.filter((d) => docMatches(d, filter));
          if (filter && !docs.length) return '';
          const list = docs.length
            ? `<ul class="kb-docs">${docs
                .map(
                  (d) =>
                    `<li><button type="button" class="kb-doc ${d.id === selectedDocId ? 'selected' : ''}" data-doc="${esc(d.id)}" aria-current="${d.id === selectedDocId}">${icon('doc')}<span class="kb-doc-name">${esc(d.title)}</span>${statusBadge(d.status)}</button></li>`,
                )
                .join('')}</ul>`
            : '<p class="small kb-none">No documents yet.</p>';
          return `<details class="kb-sub" data-node="${esc(s.id)}" ${filter || open.has(s.id) ? 'open' : ''}><summary><span class="kb-name">${esc(s.name)}</span><span class="badge">${plural(docs.length, 'file')}</span><button type="button" class="kb-icon-btn" data-delete-sub="${esc(s.id)}" aria-label="Delete sub category ${esc(s.name)}">${icon('trash')}</button></summary>${list}</details>`;
        })
        .join('');
      if (filter && !subs) return '';
      const total = c.subcategories.reduce((n, s) => n + s.documents.filter((d) => docMatches(d, filter)).length, 0);
      return `<details class="kb-cat" data-node="${esc(c.id)}" ${filter || open.has(c.id) ? 'open' : ''}><summary>${icon('folder')}<span class="kb-name">${esc(c.name)}</span><span class="badge">${plural(total, 'file')}</span><button type="button" class="kb-icon-btn" data-delete-category="${esc(c.id)}" aria-label="Delete category ${esc(c.name)}">${icon('trash')}</button></summary>${subs || '<p class="small kb-none">No sub categories yet.</p>'}</details>`;
    })
    .join('');
  if (cats) return cats;
  return filter
    ? `<div class="empty"><p>No documents are marked “${esc(statusLabel(filter))}”.</p></div>`
    : `<div class="empty"><div class="circle-icon">${icon('folder')}</div><h2>No knowledge yet.</h2><p>Create a category, add a sub category, then add text files.</p></div>`;
}

/** The File menu: every way to open an agent or add to its knowledge base starts here and opens its own popup. */
function fileMenuHTML(v) {
  const { kb } = v;
  const noCats = !kb.categories.length;
  const noSubs = !kb.categories.some((c) => c.subcategories.length);
  const item = (id, label, disabled = false) =>
    `<button type="button" role="menuitem" class="kb-menu-item" id="${id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  return `<div class="kb-file-menu"><button type="button" class="btn" id="file-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="file-menu">File<span class="kb-caret" aria-hidden="true">▾</span></button><div class="kb-menu" id="file-menu" role="menu" aria-label="File" hidden>${item('open-agent', 'Open agent')}${item('open-add-category', 'Add category')}${item('open-add-sub', 'Add subcategory', noCats)}${item('open-add-file', 'Add file', noSubs)}</div></div>`;
}

/** The size of a file against the limit, its version, and why there is a limit. */
export const sizeHintHTML = (bytes, version) =>
  `<p class="kb-size small ${bytes > MAX_DOCUMENT_BYTES ? 'over' : ''}" id="doc-size"><span id="doc-size-text">${formatSize(bytes)} of ${formatSize(MAX_DOCUMENT_BYTES)}</span>${version ? ` · version ${esc(version)}` : ''} · The whole file is sent to the model, so a file is limited to ${formatSize(MAX_DOCUMENT_BYTES)}. Split longer text into smaller files. This tool does not support semantic search.</p>`;

export function editorHTML(v) {
  const found = v.selectedDocId && findDocument(v.kb, v.selectedDocId);
  if (!found) {
    return `<div class="empty"><div class="circle-icon">${icon('doc')}</div><h2>Select a file.</h2><p>Choose a text file from the knowledge base to read it, edit it, or change its status.</p></div>`;
  }
  const { document: d, category, subcategory } = found;
  const flagged = d.status === 'malicious-active' || d.status === 'quarantined';
  return `<div class="panel-head"><h2>${esc(d.title)}</h2><p>${esc(category.name)} / ${esc(subcategory.name)} · updated ${esc(new Date(d.updatedAt).toLocaleString())}</p></div>
  <form id="doc-form" class="kb-editor-form">
    ${flagged ? `<div class="kb-flag" role="alert">${icon('lock')}<span>This file is flagged <b>${esc(statusLabel(d.status))}</b>. It is shown as plain text only and should not be trusted or executed.</span></div>` : ''}
    <div class="kb-field"><label for="doc-title">File name</label><input class="kb-input" id="doc-title" type="text" value="${esc(d.title)}" autocomplete="off"></div>
    <div class="kb-field"><label for="doc-status">Status</label><select class="kb-input" id="doc-status">${statusOptions(d.status)}</select></div>
    <div class="kb-field"><label for="doc-content">Content</label><textarea class="kb-input kb-content" id="doc-content" spellcheck="false">${esc(d.content)}</textarea>${sizeHintHTML(d.sizeBytes, d.versionNumber)}</div>
    <div class="kb-row kb-actions"><button class="btn yellow" type="submit">${icon('check')}Save file</button><button class="btn" type="button" id="delete-doc">${icon('trash')}Delete file</button></div>
  </form>`;
}

const MODAL_TITLES = { agent: 'Open agent', category: 'Add category', sub: 'Add subcategory', file: 'Add file' };

function modalBodyHTML(v) {
  const { modal, kb } = v;
  const actions = (submit) =>
    `<div class="kb-row kb-actions kb-modal-actions"><button type="button" class="btn" id="cancel-modal">Cancel</button><button class="btn yellow" type="submit">${submit}</button></div>`;
  if (modal === 'agent') {
    const options = v.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === v.agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    return `<form id="modal-form" class="kb-modal-form" novalidate><div class="kb-intro"><h3>Agent knowledge bases</h3><p>Organize the reference material behind each agent and track the review status of every file.</p></div><div class="kb-field"><label for="agent-select">AI agent</label><select class="kb-input" id="agent-select">${options}</select></div><p class="kb-error" id="modal-error" role="alert"></p>${actions('Open agent')}</form>`;
  }
  if (modal === 'category') {
    return `<form id="modal-form" class="kb-modal-form" novalidate><div class="kb-field"><label for="new-category">Category name</label><input class="kb-input" id="new-category" type="text" placeholder="e.g. Cloud security" autocomplete="off"></div><p class="kb-error" id="modal-error" role="alert"></p>${actions('Add category')}</form>`;
  }
  if (modal === 'sub') {
    const options = kb.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === v.modalParent ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<form id="modal-form" class="kb-modal-form" novalidate><div class="kb-field"><label for="sub-parent">Category</label><select class="kb-input" id="sub-parent">${options}</select></div><div class="kb-field"><label for="new-sub">Sub category name</label><input class="kb-input" id="new-sub" type="text" placeholder="e.g. Hardening" autocomplete="off"></div><p class="kb-error" id="modal-error" role="alert"></p>${actions('Add subcategory')}</form>`;
  }
  const groups = kb.categories
    .filter((c) => c.subcategories.length)
    .map((c) => `<optgroup label="${esc(c.name)}">${c.subcategories.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</optgroup>`)
    .join('');
  return `<form class="kb-modal-form" id="add-doc-form" novalidate><div class="kb-field"><label for="doc-parent">Sub category</label><select class="kb-input" id="doc-parent">${groups}</select></div><div class="kb-field"><label for="new-doc">File name</label><input class="kb-input" id="new-doc" type="text" placeholder="file-name.txt" autocomplete="off"></div><div class="kb-field"><label for="new-doc-status">Status</label><select class="kb-input" id="new-doc-status">${statusOptions(DEFAULT_STATUS)}</select></div><div class="kb-row kb-actions kb-modal-actions"><label class="btn kb-upload" for="upload-docs">${icon('download')}Upload .txt files<input id="upload-docs" type="file" multiple accept=".txt,.md,.markdown,.log,.csv,.json,.yml,.yaml,text/*"></label><button type="button" class="btn" id="cancel-modal">Cancel</button><button class="btn yellow" type="submit">${icon('plus')}Add file</button></div></form>`;
}

function modalHTML(v) {
  if (!v.modal) return '';
  const title = MODAL_TITLES[v.modal];
  return `<div class="kb-modal-overlay" id="kb-modal"><div class="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-modal-title"><div class="kb-modal-head"><h2 id="kb-modal-title">${title}</h2><button type="button" class="icon-btn" id="close-modal" aria-label="Close">${icon('close')}</button></div>${modalBodyHTML(v)}</div></div>`;
}

const MIN_TREE = 260;
const MIN_EDITOR = 320;
/** The dragged width of the knowledge base panel; kept here so it survives re-renders (nothing is stored in the browser). */
let treeWidth = 0;

export function agentsPageHTML(v) {
  const { agents, agentId, kb, filter } = v;
  const agent = agents.find((a) => a.id === agentId);
  return `<div class="page-heading kb-page-heading">${fileMenuHTML(v)}</div><hr class="kb-rule">
  <div class="kb-layout" id="kb-layout" ${treeWidth ? `style="--kb-tree-w:${treeWidth}px"` : ''}>
    <section class="panel kb-tree-panel" aria-label="Knowledge base">
      <div class="panel-head kb-head"><div><h2>${esc(agent.name)} knowledge base</h2><p>${kb.categories.length} ${kb.categories.length === 1 ? 'category' : 'categories'} · ${plural(countDocuments(kb), 'file')}</p></div><div class="kb-head-tools"><label class="sr-only" for="status-filter">Filter by status</label><select class="model-select" id="status-filter"><option value="">All statuses</option>${STATUSES.map((s) => `<option value="${s.id}" ${s.id === filter ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select><button type="button" class="btn" id="reset-kb">Restore defaults</button></div></div>
      <div class="kb-tree" id="kb-tree">${treeHTML(v)}</div>
    </section>
    <div class="kb-resizer" id="kb-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the knowledge base panel" aria-valuemin="${MIN_TREE}" tabindex="0" title="Drag to resize"></div>
    <section class="panel kb-editor" id="kb-editor" aria-label="File editor">${editorHTML(v)}</section>
  </div>${modalHTML(v)}${footerHTML()}`;
}

const $ = (id) => document.getElementById(id);
const all = (sel) => [...document.querySelectorAll(sel)];

/** Wire a freshly rendered agents page to controller handlers. */
export function bindFileMenu(h) {
  const btn = $('file-menu-btn');
  const menu = $('file-menu');
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open);
  };
  btn.onclick = () => {
    setOpen(menu.hidden);
    if (!menu.hidden) menu.querySelector('button:not(:disabled)')?.focus();
  };
  const items = [...menu.querySelectorAll('button')];
  [['open-agent', 'agent'], ['open-add-category', 'category'], ['open-add-sub', 'sub'], ['open-add-file', 'file']].forEach(([id, kind]) => {
    $(id).onclick = () => {
      setOpen(false);
      h.onOpenModal(kind);
    };
  });
  menu.onkeydown = (e) => {
    const enabled = items.filter((b) => !b.disabled);
    const at = enabled.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') enabled[(at + 1) % enabled.length]?.focus();
    else if (e.key === 'ArrowUp') enabled[(at - 1 + enabled.length) % enabled.length]?.focus();
    else return;
    e.preventDefault();
  };
  document.onmousedown = (e) => {
    if (!menu.hidden && !e.target.closest?.('.kb-file-menu')) setOpen(false);
  };
  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  };
}

/** Drag (or use the arrow keys on) the handle between the two panels to change the knowledge base panel's width. */
function bindResizer() {
  const bar = $('kb-resizer');
  const layout = $('kb-layout');
  const panel = layout.querySelector('.kb-tree-panel');
  const clamp = (w) => Math.round(Math.max(MIN_TREE, Math.min(w, layout.clientWidth - bar.offsetWidth - MIN_EDITOR - 24)));
  const set = (w) => {
    treeWidth = clamp(w);
    layout.style.setProperty('--kb-tree-w', `${treeWidth}px`);
    bar.setAttribute('aria-valuenow', treeWidth);
  };
  bar.onpointerdown = (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    const left = panel.getBoundingClientRect().left;
    bar.onpointermove = (m) => set(m.clientX - left);
    bar.onpointerup = bar.onpointercancel = () => {
      bar.classList.remove('dragging');
      bar.onpointermove = bar.onpointerup = bar.onpointercancel = null;
    };
  };
  bar.ondblclick = () => {
    treeWidth = 0;
    layout.style.removeProperty('--kb-tree-w');
  };
  bar.onkeydown = (e) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === 'ArrowLeft') set(panel.offsetWidth - step);
    else if (e.key === 'ArrowRight') set(panel.offsetWidth + step);
    else return;
    e.preventDefault();
  };
}

export function bindAgents(h) {
  bindResizer();
  bindFileMenu(h);
  $('status-filter').onchange = (e) => h.onFilter(e.target.value);
  $('reset-kb').onclick = h.onReset;
  all('details[data-node]').forEach((d) => (d.ontoggle = () => h.onToggleNode(d.dataset.node, d.open)));
  all('[data-doc]').forEach((b) => (b.onclick = () => h.onSelectDocument(b.dataset.doc)));
  all('[data-delete-category]').forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    h.onDeleteCategory(b.dataset.deleteCategory);
  }));
  all('[data-delete-sub]').forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    h.onDeleteSubcategory(b.dataset.deleteSub);
  }));
  bindEditor(h);
}

/** The editor can be re-rendered on its own (selecting a file) without rebuilding the tree. */
export function bindEditor(h) {
  const form = $('doc-form');
  if (!form) return;
  form.onsubmit = (e) => {
    e.preventDefault();
    h.onSaveDocument({ title: $('doc-title').value, status: $('doc-status').value, content: $('doc-content').value });
  };
  $('delete-doc').onclick = h.onDeleteDocument;
  $('doc-content').oninput = (e) => {
    const bytes = byteLength(e.target.value);
    $('doc-size-text').textContent = `${formatSize(bytes)} of ${formatSize(MAX_DOCUMENT_BYTES)}`;
    $('doc-size').classList.toggle('over', bytes > MAX_DOCUMENT_BYTES);
  };
}

/** Wire the open modal (if any): submit, cancel, overlay click and focus trap. Escape is handled globally. */
export function bindModal(h) {
  const overlay = $('kb-modal');
  if (!overlay) return;
  const form = $('modal-form');
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      if ($('new-category')) h.onAddCategory($('new-category').value);
      else if ($('new-sub')) h.onAddSubcategory($('sub-parent').value, $('new-sub').value);
      else h.onAgent($('agent-select').value);
    };
  }
  if ($('add-doc-form')) {
    $('add-doc-form').onsubmit = (e) => {
      e.preventDefault();
      h.onAddDocument($('doc-parent').value, $('new-doc').value, $('new-doc-status').value);
    };
    $('upload-docs').onchange = (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) h.onUpload($('doc-parent').value, $('new-doc-status').value, files);
    };
  }
  $('close-modal').onclick = $('cancel-modal').onclick = h.onCloseModal;
  overlay.onmousedown = (e) => {
    if (e.target === overlay) h.onCloseModal();
  };
  overlay.onkeydown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...overlay.querySelectorAll('button,input,select,textarea')].filter((el) => !el.disabled);
    if (e.shiftKey && document.activeElement === items[0]) {
      e.preventDefault();
      items.at(-1).focus();
    } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
      e.preventDefault();
      items[0].focus();
    }
  };
}

export const focusModal = () => ($('new-category') || $('new-sub') || $('agent-select') || $('doc-parent'))?.focus();

/** The popups all open from the File menu, so focus goes back to its button. */
export function focusOpener() {
  $('file-menu-btn')?.focus();
}

export function showModalError(message) {
  const el = $('modal-error');
  if (el) el.textContent = message;
  ($('new-category') || $('new-sub'))?.focus();
}
