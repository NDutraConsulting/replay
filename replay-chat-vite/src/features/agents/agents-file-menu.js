import { mountFileMenu } from '../../shared/file-menu-ui.js';

/**
 * The AI agents page's File menu: every way to open an agent or add to its knowledge base, each opening its own popup.
 * Add subcategory needs a category and Add file needs a subcategory, so call this again whenever the tree changes.
 * @param {{categories: {subcategories: unknown[]}[]}} kb
 * @param {{onOpenModal: (kind: 'agent'|'category'|'sub'|'file') => void}} h
 */
export function mountAgentsFileMenu(kb, h) {
  const noCategories = !kb.categories.length;
  const noSubcategories = !kb.categories.some((c) => c.subcategories.length);
  mountFileMenu([
    { id: 'open-agent', label: 'Open agent', onSelect: () => h.onOpenModal('agent') },
    { id: 'open-add-category', label: 'Add category', onSelect: () => h.onOpenModal('category') },
    { id: 'open-add-sub', label: 'Add subcategory', disabled: noCategories, onSelect: () => h.onOpenModal('sub') },
    { id: 'open-add-file', label: 'Add file', disabled: noSubcategories, onSelect: () => h.onOpenModal('file') },
  ]);
}
