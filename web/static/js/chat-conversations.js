/**
 * chat-conversations.js —— 会话侧边栏：筛选、排序、分页与批量管理
 *
 * 从 chat.js 拆出（原文件末尾区块）：
 * 项目筛选器与自定义下拉、会话排序菜单、列表分页、上下文菜单与批量操作。
 *
 * 与 chat.js 同处全局作用域，共享其工具函数；加载顺序置于 chat.js 之前。
 */
// ============================================
// 对话批量管理功能
// ============================================

let contextMenuConversationId = null;
let contextMenuConversationTitle = '';
let conversationsListLoadSeq = 0; // 对话列表加载序号，避免并发请求导致重复渲染
let conversationsListNavigateGen = 0; // 用户主动翻页代数，防止后台刷新覆盖翻页结果
const CONVERSATIONS_PAGE_SIZE_KEY = 'cyberstrike.conversations_page_size';
const CONVERSATIONS_SORT_KEY = 'cyberstrike.conversations_sort_by';
const CONVERSATIONS_PROJECT_FILTER_KEY = 'cyberstrike.conversations_project_filter';
const CONVERSATION_PROJECT_FILTER_NONE = '__none__';
const CONVERSATION_PROJECT_FILTER_SELECT_ID = 'conversation-project-filter';
const CONVERSATION_PROJECT_FILTER_CARET = '<svg class="conversation-project-filter-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BATCH_PROJECT_FILTER_SELECT_ID = 'batch-project-filter';
const projectFilterCustomSelectRegistry = {};
let projectFilterCustomSelectDocBound = false;

function projectFilterT(key, fallback) {
    if (typeof window.t === 'function') {
        const value = window.t(key);
        if (value && value !== key) return value;
    }
    return fallback;
}

function closeProjectFilterCustomSelect(selectId) {
    const reg = projectFilterCustomSelectRegistry[selectId];
    if (!reg || !reg.wrapper) return;
    reg.wrapper.classList.remove('open');
    if (reg.trigger) reg.trigger.setAttribute('aria-expanded', 'false');
    if (reg.filterSearchTimer) {
        clearTimeout(reg.filterSearchTimer);
        reg.filterSearchTimer = null;
    }
    reg.filterSearchSeq = (reg.filterSearchSeq || 0) + 1;
    if (reg.searchInput) reg.searchInput.value = '';
}

function closeAllProjectFilterCustomSelects() {
    Object.keys(projectFilterCustomSelectRegistry).forEach(closeProjectFilterCustomSelect);
}

function ensureProjectFilterSearchUi(reg) {
    if (reg.searchInput && reg.optionsList) return;
    const { dropdown } = reg;
    dropdown.innerHTML = '';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'conversation-project-filter-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'conversation-project-filter-search-input';
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.setAttribute('data-i18n', 'chat.filterProjectSearch');
    searchInput.setAttribute('data-i18n-attr', 'placeholder');
    searchInput.placeholder = projectFilterT('chat.filterProjectSearch', '搜索项目…');
    searchWrap.appendChild(searchInput);
    dropdown.appendChild(searchWrap);
    reg.searchInput = searchInput;

    const optionsList = document.createElement('div');
    optionsList.className = 'conversation-project-filter-options';
    dropdown.appendChild(optionsList);
    reg.optionsList = optionsList;
    reg.filterSearchSeq = 0;
    reg.filterSearchTimer = null;

    searchInput.addEventListener('input', () => loadProjectFilterLocalOptions(reg.select.id));
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeProjectFilterCustomSelect(reg.select.id);
    });
}

function createProjectFilterOptionButton(value, label, selectedValue) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-project-filter-option';
    item.setAttribute('role', 'option');
    item.setAttribute('data-value', value);
    item.title = label;
    if (value === selectedValue) {
        item.classList.add('is-selected');
        item.setAttribute('aria-selected', 'true');
    } else {
        item.setAttribute('aria-selected', 'false');
    }
    const check = document.createElement('span');
    check.className = 'conversation-project-filter-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    const labelEl = document.createElement('span');
    labelEl.className = 'conversation-project-filter-option-label';
    labelEl.textContent = label;
    labelEl.title = label;
    item.appendChild(check);
    item.appendChild(labelEl);
    return item;
}

function appendProjectFilterStatusMessage(optionsList, className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    optionsList.appendChild(el);
    return el;
}

function renderProjectFilterPinnedOptions(reg) {
    const { select, optionsList } = reg;
    optionsList.innerHTML = '';
    Array.prototype.forEach.call(select.options, (opt) => {
        if (opt.value === '' || opt.value === CONVERSATION_PROJECT_FILTER_NONE) {
            optionsList.appendChild(createProjectFilterOptionButton(opt.value, opt.textContent || '', select.value));
        }
    });
}

function ensureNativeProjectFilterOption(select, projectId, label) {
    if (!projectId || projectId === CONVERSATION_PROJECT_FILTER_NONE) return;
    if (Array.prototype.some.call(select.options, (opt) => opt.value === projectId)) return;
    const opt = document.createElement('option');
    opt.value = projectId;
    opt.textContent = label || projectId;
    select.appendChild(opt);
}

async function loadProjectFilterLocalOptions(selectId) {
    const reg = projectFilterCustomSelectRegistry[selectId];
    if (!reg || !reg.optionsList) return;
    const query = (reg.searchInput?.value || '').trim();
    const seq = ++reg.filterSearchSeq;

    const needsFetch = typeof window.isProjectsCacheReady === 'function' && !window.isProjectsCacheReady();
    let loadingEl = null;
    if (needsFetch) {
        renderProjectFilterPinnedOptions(reg);
        loadingEl = appendProjectFilterStatusMessage(
            reg.optionsList,
            'conversation-project-filter-status',
            projectFilterT('common.loading', '加载中…')
        );
    }

    try {
        const ensureLoaded = typeof window.ensureProjectsLoaded === 'function'
            ? window.ensureProjectsLoaded
            : null;
        const filterLocal = typeof window.filterActiveProjectsLocal === 'function'
            ? window.filterActiveProjectsLocal
            : null;
        if (!ensureLoaded || !filterLocal) throw new Error('projects cache unavailable');

        const all = await ensureLoaded();
        if (seq !== reg.filterSearchSeq) return;

        renderProjectFilterPinnedOptions(reg);
        const selected = reg.select.value;
        const pinnedValues = new Set(['', CONVERSATION_PROJECT_FILTER_NONE]);
        const projects = filterLocal(all, query);
        projects.forEach((p) => {
            if (pinnedValues.has(p.id)) return;
            reg.optionsList.appendChild(
                createProjectFilterOptionButton(p.id, p.name || p.id, selected)
            );
        });

        if (query && projects.length === 0) {
            appendProjectFilterStatusMessage(
                reg.optionsList,
                'conversation-project-filter-empty',
                projectFilterT('chat.filterProjectSearchEmpty', '没有匹配的项目')
            );
        }
    } catch (e) {
        if (seq !== reg.filterSearchSeq) return;
        renderProjectFilterPinnedOptions(reg);
        appendProjectFilterStatusMessage(
            reg.optionsList,
            'conversation-project-filter-empty',
            projectFilterT('chat.filterProjectSearchFailed', '加载项目失败，请重试')
        );
    } finally {
        if (loadingEl && loadingEl.parentNode) loadingEl.remove();
    }
}

function syncProjectFilterCustomSelect(selectId) {
    const reg = projectFilterCustomSelectRegistry[selectId];
    if (!reg) return;
    ensureProjectFilterSearchUi(reg);
    const { select, trigger } = reg;
    const valueSpan = trigger.querySelector('.conversation-project-filter-value');
    const selectedOpt = select.options[select.selectedIndex];
    const selectedText = selectedOpt ? (selectedOpt.textContent || '') : '';
    if (valueSpan) {
        valueSpan.textContent = selectedText;
        valueSpan.title = selectedText;
    }
}

function ensureSimpleCustomSelectOptionsUi(reg) {
    if (reg.optionsList) return;
    reg.dropdown.innerHTML = '';
    const optionsList = document.createElement('div');
    optionsList.className = 'conversation-project-filter-options';
    reg.dropdown.appendChild(optionsList);
    reg.optionsList = optionsList;
}

function renderSimpleCustomSelectOptions(reg) {
    ensureSimpleCustomSelectOptionsUi(reg);
    const { select, optionsList } = reg;
    optionsList.innerHTML = '';
    Array.prototype.forEach.call(select.options, (opt) => {
        optionsList.appendChild(createProjectFilterOptionButton(opt.value, opt.textContent || '', select.value));
    });
}

function syncSimpleCustomSelect(selectId) {
    const reg = projectFilterCustomSelectRegistry[selectId];
    if (!reg) return;
    const { select, trigger } = reg;
    const valueSpan = trigger.querySelector('.conversation-project-filter-value');
    const selectedOpt = select.options[select.selectedIndex];
    const selectedText = selectedOpt ? (selectedOpt.textContent || '') : '';
    if (valueSpan) {
        valueSpan.textContent = selectedText;
        valueSpan.title = selectedText;
    }
}

function initSimpleCustomSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    if (select.dataset.projectCustomSelect === '1') {
        syncSimpleCustomSelect(selectId);
        return;
    }
    select.dataset.projectCustomSelect = '1';
    select.classList.add('conversation-project-filter-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const wrapper = document.createElement('div');
    wrapper.className = 'conversation-project-filter-ui';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'conversation-project-filter-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const valueSpan = document.createElement('span');
    valueSpan.className = 'conversation-project-filter-value';
    trigger.appendChild(valueSpan);
    trigger.insertAdjacentHTML('beforeend', CONVERSATION_PROJECT_FILTER_CARET);

    const dropdown = document.createElement('div');
    dropdown.className = 'conversation-project-filter-dropdown';
    dropdown.setAttribute('role', 'listbox');

    const parent = select.parentNode;
    parent.insertBefore(wrapper, select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    wrapper.appendChild(select);

    projectFilterCustomSelectRegistry[selectId] = { wrapper, trigger, dropdown, select };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = wrapper.classList.contains('open');
        closeAllProjectFilterCustomSelects();
        if (!open) {
            wrapper.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            renderSimpleCustomSelectOptions(projectFilterCustomSelectRegistry[selectId]);
        }
    });

    dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.conversation-project-filter-option');
        if (!opt) return;
        e.stopPropagation();
        const val = opt.getAttribute('data-value');
        if (val === null) return;
        if (select.value !== val) {
            select.value = val;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeProjectFilterCustomSelect(selectId);
        syncSimpleCustomSelect(selectId);
    });

    if (!projectFilterCustomSelectDocBound) {
        projectFilterCustomSelectDocBound = true;
        document.addEventListener('click', closeAllProjectFilterCustomSelects);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllProjectFilterCustomSelects();
        });
    }
    syncSimpleCustomSelect(selectId);
}

function initProjectFilterCustomSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    if (select.dataset.projectCustomSelect === '1') {
        syncProjectFilterCustomSelect(selectId);
        return;
    }
    select.dataset.projectCustomSelect = '1';
    select.classList.add('conversation-project-filter-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const wrapper = document.createElement('div');
    wrapper.className = 'conversation-project-filter-ui';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'conversation-project-filter-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const valueSpan = document.createElement('span');
    valueSpan.className = 'conversation-project-filter-value';
    trigger.appendChild(valueSpan);
    trigger.insertAdjacentHTML('beforeend', CONVERSATION_PROJECT_FILTER_CARET);

    const dropdown = document.createElement('div');
    dropdown.className = 'conversation-project-filter-dropdown';
    dropdown.setAttribute('role', 'listbox');

    const parent = select.parentNode;
    parent.insertBefore(wrapper, select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    wrapper.appendChild(select);

    projectFilterCustomSelectRegistry[selectId] = { wrapper, trigger, dropdown, select };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = wrapper.classList.contains('open');
        closeAllProjectFilterCustomSelects();
        if (!open) {
            wrapper.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            ensureProjectFilterSearchUi(projectFilterCustomSelectRegistry[selectId]);
            const reg = projectFilterCustomSelectRegistry[selectId];
            if (reg?.searchInput) {
                reg.searchInput.value = '';
                loadProjectFilterLocalOptions(selectId);
                requestAnimationFrame(() => reg.searchInput.focus());
            }
        }
    });

    dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.conversation-project-filter-option');
        if (!opt) return;
        e.stopPropagation();
        const val = opt.getAttribute('data-value');
        if (val === null) return;
        const label = opt.querySelector('.conversation-project-filter-option-label')?.textContent || val;
        ensureNativeProjectFilterOption(select, val, label);
        if (select.value !== val) {
            select.value = val;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeProjectFilterCustomSelect(selectId);
        syncProjectFilterCustomSelect(selectId);
    });

    if (!projectFilterCustomSelectDocBound) {
        projectFilterCustomSelectDocBound = true;
        document.addEventListener('click', closeAllProjectFilterCustomSelects);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllProjectFilterCustomSelects();
        });
    }
    syncProjectFilterCustomSelect(selectId);
}

function syncConversationProjectCustomSelect() {
    syncProjectFilterCustomSelect(CONVERSATION_PROJECT_FILTER_SELECT_ID);
}

function initConversationProjectCustomSelect() {
    initProjectFilterCustomSelect(CONVERSATION_PROJECT_FILTER_SELECT_ID);
}

function getConversationProjectFilter() {
    try {
        return localStorage.getItem(CONVERSATIONS_PROJECT_FILTER_KEY) || '';
    } catch (e) {
        return '';
    }
}

function setConversationProjectFilter(projectId) {
    const value = (projectId || '').trim();
    try {
        if (value) localStorage.setItem(CONVERSATIONS_PROJECT_FILTER_KEY, value);
        else localStorage.removeItem(CONVERSATIONS_PROJECT_FILTER_KEY);
    } catch (e) { /* ignore */ }
    const sel = document.getElementById('conversation-project-filter');
    if (sel && sel.value !== value) sel.value = value;
    syncConversationProjectCustomSelect();
    updateConversationSidebarFilterUI();
}

function appendProjectFilterPinnedNativeOptions(sel) {
    const tFn = typeof window.t === 'function' ? window.t.bind(window) : null;
    const allLabel = tFn ? tFn('chat.filterAllProjects') : '全部项目';
    const unboundLabel = tFn ? tFn('chat.filterUnboundProjects') : '未绑定项目';
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = allLabel;
    allOpt.setAttribute('data-i18n', 'chat.filterAllProjects');
    sel.appendChild(allOpt);
    const unboundOpt = document.createElement('option');
    unboundOpt.value = CONVERSATION_PROJECT_FILTER_NONE;
    unboundOpt.textContent = unboundLabel;
    unboundOpt.setAttribute('data-i18n', 'chat.filterUnboundProjects');
    sel.appendChild(unboundOpt);
}

async function resolveProjectFilterSelection(projectId) {
    const saved = (projectId || '').trim();
    if (!saved || saved === CONVERSATION_PROJECT_FILTER_NONE) return saved;
    const fetchSummary = typeof window.fetchProjectSummary === 'function'
        ? window.fetchProjectSummary
        : null;
    if (!fetchSummary) return saved;
    const project = await fetchSummary(saved);
    if (!project || !project.id || project.status === 'archived') return '';
    return project.id;
}

async function appendSelectedProjectFilterOption(sel, projectId) {
    const id = (projectId || '').trim();
    if (!id || id === CONVERSATION_PROJECT_FILTER_NONE) return;
    if (Array.prototype.some.call(sel.options, (opt) => opt.value === id)) return;
    const fetchSummary = typeof window.fetchProjectSummary === 'function'
        ? window.fetchProjectSummary
        : null;
    const project = fetchSummary ? await fetchSummary(id) : null;
    const label = (project && (project.name || project.id)) || (window.projectNameById && window.projectNameById[id]) || id;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    sel.appendChild(opt);
}

async function refreshConversationProjectFilter() {
    const sel = document.getElementById('conversation-project-filter');
    if (!sel) return;
    const saved = getConversationProjectFilter();
    appendProjectFilterPinnedNativeOptions(sel);
    const normalized = await resolveProjectFilterSelection(saved);
    if (normalized && normalized !== CONVERSATION_PROJECT_FILTER_NONE) {
        await appendSelectedProjectFilterOption(sel, normalized);
    }
    if (normalized !== saved) setConversationProjectFilter(normalized);
    sel.value = normalized;
    syncConversationProjectCustomSelect();
    updateConversationSidebarFilterUI();
}

function onConversationProjectFilterChange(projectId) {
    setConversationProjectFilter(projectId || '');
    commitConversationsPage(1, { bumpNavigateGen: true });
    loadConversations(conversationsSearchQuery);
}

function updateConversationSidebarFilterUI() {
    const titleEl = document.querySelector('.recent-conversations-section .section-title');
    const filter = getConversationProjectFilter();
    const hasSearch = !!(conversationsSearchQuery && conversationsSearchQuery.trim());
    if (!titleEl) return;
    const tFn = typeof window.t === 'function' ? window.t.bind(window) : null;
    if (filter && filter !== CONVERSATION_PROJECT_FILTER_NONE) {
        const name = (window.projectNameById && window.projectNameById[filter]) || filter;
        const fullTitle = tFn ? tFn('chat.projectConversationsTitle', { name }) : `${name} · 对话`;
        titleEl.textContent = fullTitle;
        titleEl.title = fullTitle;
        titleEl.classList.add('section-title--filtered');
        titleEl.removeAttribute('data-i18n');
    } else if (filter === CONVERSATION_PROJECT_FILTER_NONE) {
        const fullTitle = tFn ? tFn('chat.unboundConversationsTitle') : '未绑定项目';
        titleEl.textContent = fullTitle;
        titleEl.title = fullTitle;
        titleEl.classList.add('section-title--filtered');
        titleEl.setAttribute('data-i18n', 'chat.unboundConversationsTitle');
    } else {
        titleEl.classList.remove('section-title--filtered');
        titleEl.removeAttribute('title');
        titleEl.setAttribute('data-i18n', 'chat.recentConversations');
        if (tFn) titleEl.textContent = tFn('chat.recentConversations');
    }
}

window.onConversationProjectBindingChanged = function onConversationProjectBindingChanged() {
    loadConversations(conversationsSearchQuery);
};

function getConversationSortBy() {
    try {
        const saved = localStorage.getItem(CONVERSATIONS_SORT_KEY);
        if (saved === 'created_at' || saved === 'updated_at') return saved;
    } catch (e) { /* ignore */ }
    return 'updated_at';
}

let conversationSortBy = getConversationSortBy();

function getConversationSortTime(conv) {
    const field = conversationSortBy === 'created_at' ? 'createdAt' : 'updatedAt';
    const raw = conv && conv[field];
    if (!raw) return new Date(0);
    const date = new Date(raw);
    return isNaN(date.getTime()) ? new Date(0) : date;
}

function updateConversationSortMenuUI() {
    const menu = document.getElementById('conversation-sort-menu');
    const btn = document.getElementById('conversation-sort-btn');
    if (!menu) return;
    menu.querySelectorAll('.conversation-sort-option').forEach((option) => {
        const selected = option.dataset.sort === conversationSortBy;
        option.classList.toggle('is-selected', selected);
        option.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    if (btn) {
        btn.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    }
}

function closeConversationSortMenu() {
    const menu = document.getElementById('conversation-sort-menu');
    const btn = document.getElementById('conversation-sort-btn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleConversationSortMenu(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const menu = document.getElementById('conversation-sort-menu');
    const btn = document.getElementById('conversation-sort-btn');
    if (!menu || !btn) return;
    const willOpen = menu.hidden;
    closeConversationSortMenu();
    if (willOpen) {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        updateConversationSortMenuUI();
    }
}

function setConversationSortBy(sortBy) {
    const next = sortBy === 'created_at' ? 'created_at' : 'updated_at';
    if (next === conversationSortBy) {
        closeConversationSortMenu();
        return;
    }
    conversationSortBy = next;
    try {
        localStorage.setItem(CONVERSATIONS_SORT_KEY, next);
    } catch (e) { /* ignore */ }
    updateConversationSortMenuUI();
    closeConversationSortMenu();
    commitConversationsPage(1, { bumpNavigateGen: true });
    loadConversations(conversationsSearchQuery);
}

if (!window.__conversationSortMenuBound) {
    window.__conversationSortMenuBound = true;
    document.addEventListener('click', (event) => {
        const dropdown = document.getElementById('conversation-sort-dropdown');
        if (!dropdown || dropdown.contains(event.target)) return;
        closeConversationSortMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeConversationSortMenu();
    });
}

window.toggleConversationSortMenu = toggleConversationSortMenu;
window.setConversationSortBy = setConversationSortBy;
window.closeConversationSortMenu = closeConversationSortMenu;

function getConversationsPageSize() {
    try {
        const saved = parseInt(localStorage.getItem(CONVERSATIONS_PAGE_SIZE_KEY), 10);
        if ([20, 50, 100].includes(saved)) return saved;
    } catch (e) { /* ignore */ }
    return 50;
}

let conversationsPagination = {
    page: 1,
    pageSize: getConversationsPageSize(),
    total: 0,
    visibleCount: 0,
};
let conversationsSearchQuery = '';
let conversationsPaginationEventsBound = false;

function getConversationsTotalPages() {
    const { total, pageSize } = conversationsPagination;
    return Math.max(1, Math.ceil((total || 0) / pageSize) || 1);
}

/**
 * 分页状态约定：
 * - conversationsPagination.page 仅在此处（用户操作 / reconcile 钳制 / clamp）写入
 * - loadConversations 只读页码，用 intentPage 或当前 page 计算 offset
 * - isStaleConversationListLoad 丢弃页码或 navigateGen 已变的在途请求
 */
function commitConversationsPage(page, { bumpNavigateGen = false } = {}) {
    const next = Math.max(1, parseInt(page, 10) || 1);
    if (bumpNavigateGen) {
        conversationsListNavigateGen += 1;
    }
    conversationsPagination.page = next;
    return next;
}

function isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage) {
    if (loadSeq !== conversationsListLoadSeq) return true;
    // 后台刷新期间用户已翻页（含 2→1、1→2），丢弃过期结果
    if (intentPage == null && navigateGenAtStart !== conversationsListNavigateGen) return true;
    // 用户主动翻页后，丢弃目标页已变化的请求
    if (intentPage != null && intentPage !== conversationsPagination.page) return true;
    // 后台刷新完成时页码已变（如 reconcile 钳制），丢弃过期结果
    if (intentPage == null && activePage != null && activePage !== conversationsPagination.page) return true;
    return false;
}

function reconcileConversationsPageAfterTotal(activePage, intentPage, parsed, pageSize, offset, resolvedTotal) {
    let total = resolvedTotal;
    const totalPages = () => Math.max(1, Math.ceil((total || 0) / pageSize) || 1);

    if (activePage <= totalPages()) {
        return { ok: true, total };
    }

    const serverTotal = parseListTotalValue(parsed.total, parsed.items.length);
    const hasPageData = parsed.items.length > 0;
    const knownTotal = conversationsPagination.total || 0;
    // 用户主动翻页且服务端确有该页数据时，不信过期/偏低的 total（避免 2>1 被钳回第 1 页）
    if (intentPage != null && (hasPageData || serverTotal > offset || total > offset || knownTotal > offset)) {
        total = Math.max(total, serverTotal, knownTotal, offset + parsed.items.length);
        if (activePage <= totalPages()) {
            return { ok: true, total };
        }
    }

    const clampedPage = totalPages();
    commitConversationsPage(clampedPage);
    return { ok: false, total, clampedPage };
}

function clampConversationsPageToTotal() {
    const totalPages = getConversationsTotalPages();
    if (conversationsPagination.page > totalPages) {
        commitConversationsPage(totalPages);
        return true;
    }
    if (conversationsPagination.page < 1) {
        commitConversationsPage(1);
        return true;
    }
    return false;
}

let conversationsPaginationRenderLock = false;

function initConversationsPaginationEvents() {
    if (conversationsPaginationEventsBound) return;
    const el = document.getElementById('conversations-pagination');
    if (!el) return;
    conversationsPaginationEventsBound = true;
    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-conv-page]');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        const page = parseInt(btn.getAttribute('data-conv-page'), 10);
        if (Number.isFinite(page)) {
            goConversationsPage(page);
        }
    });
    el.addEventListener('change', (e) => {
        if (conversationsPaginationRenderLock) return;
        if (e.target && e.target.id === 'conversations-page-size-pagination') {
            changeConversationsPageSize();
        }
    });
}

function parseListTotalValue(raw, itemsLength) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    if (raw != null && raw !== '') {
        const n = parseInt(String(raw), 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return itemsLength;
}

function parseListOffsetValue(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    if (raw != null && raw !== '') {
        const n = parseInt(String(raw), 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
}

function parseConversationsListResponse(data) {
    if (Array.isArray(data)) {
        return { items: data, total: data.length, limit: data.length, offset: 0, isLegacyArray: true };
    }
    const items = data.conversations || data.items || [];
    const arr = Array.isArray(items) ? items : [];
    return {
        items: arr,
        total: parseListTotalValue(data.total, arr.length),
        limit: parseListTotalValue(data.limit, arr.length) || arr.length,
        offset: parseListOffsetValue(data.offset),
        isLegacyArray: false,
    };
}

async function resolveConversationsListTotal(params, parsed, pageSize, offset) {
    const serverTotal = parsed.total;
    if (!parsed.isLegacyArray && typeof serverTotal === 'number' && Number.isFinite(serverTotal) && serverTotal >= 0) {
        return serverTotal;
    }
    if (!parsed.isLegacyArray && serverTotal > offset + parsed.items.length) {
        return serverTotal;
    }
    if (parsed.items.length < pageSize) {
        return Math.max(serverTotal, offset + parsed.items.length);
    }
    const probe = new URLSearchParams(params);
    probe.set('offset', String(offset + pageSize));
    probe.set('limit', '1');
    try {
        const res = await apiFetch(`/api/conversations?${probe}`);
        if (!res.ok) return Math.max(serverTotal, offset + parsed.items.length);
        const probeParsed = parseConversationsListResponse(await res.json());
        if (probeParsed.total > serverTotal) return probeParsed.total;
        if (probeParsed.items.length > 0) {
            return Math.max(serverTotal, offset + pageSize + 1);
        }
    } catch (e) { /* ignore */ }
    return Math.max(serverTotal, offset + parsed.items.length);
}

async function fetchAllConversations(searchQuery) {
    let all = [];
    const pageSize = 200;
    let offset = 0;
    let total = Infinity;
    const search = (searchQuery || '').trim();
    while (all.length < total) {
        const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
        if (search) params.set('search', search);
        const res = await apiFetch(`/api/conversations?${params}`);
        if (!res.ok) throw new Error('load conversations failed');
        const parsed = parseConversationsListResponse(await res.json());
        all = all.concat(parsed.items);
        total = parsed.total;
        if (!parsed.items.length) break;
        offset += parsed.items.length;
    }
    return all;
}

function getConversationListEmptyHtml() {
    const filter = getConversationProjectFilter();
    if (filter && filter !== CONVERSATION_PROJECT_FILTER_NONE) {
        return '<div class="conversations-list-empty" data-i18n="chat.noProjectConversations"></div>';
    }
    if (filter === CONVERSATION_PROJECT_FILTER_NONE) {
        return '<div class="conversations-list-empty" data-i18n="chat.noUnboundConversations"></div>';
    }
    return '<div class="conversations-list-empty" data-i18n="chat.noHistoryConversations"></div>';
}

function renderConversationsPagination(visibleCount) {
    const el = document.getElementById('conversations-pagination');
    if (!el) return;
    const { page, pageSize, total } = conversationsPagination;
    if (typeof visibleCount === 'number') {
        conversationsPagination.visibleCount = visibleCount;
    }

    if (!total) {
        el.innerHTML = '';
        el.hidden = true;
        if (typeof initPaginationSelects === 'function') initPaginationSelects(el);
        return;
    }

    const totalPages = getConversationsTotalPages();
    const navDisabled = totalPages <= 1;
    const recentToggle = document.getElementById('recent-conversations-toggle');
    el.hidden = !recentToggle || recentToggle.getAttribute('aria-expanded') !== 'true';
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    const tFn = typeof window.t === 'function' ? window.t.bind(window) : null;
    const infoText = tFn
        ? tFn('chat.paginationRange', { start, end, total })
        : `${start}-${end}/${total}`;
    const pageText = tFn
        ? tFn('chat.paginationPage', { page, total: totalPages })
        : `${page}/${totalPages}`;
    const perPageLabel = tFn ? tFn('chat.paginationPerPage') : 'Per page';
    const prevLabel = tFn ? tFn('chat.paginationPrev') : 'Prev';
    const nextLabel = tFn ? tFn('chat.paginationNext') : 'Next';
    const prevPage = page - 1;
    const nextPage = page + 1;
    conversationsPaginationRenderLock = true;
    try {
        el.innerHTML = `
        <div class="sidebar-list-pagination-inner sidebar-list-pagination-inner--compact">
            <span class="pagination-info">${escapeHtml(infoText)}</span>
            <div class="pagination-controls">
                <button type="button" class="btn-icon-pagination" data-conv-page="${prevPage}" ${page <= 1 || navDisabled ? 'disabled' : ''} title="${escapeAttr(prevLabel)}" aria-label="${escapeAttr(prevLabel)}">‹</button>
                <span class="pagination-page">${escapeHtml(pageText)}</span>
                <button type="button" class="btn-icon-pagination" data-conv-page="${nextPage}" ${page >= totalPages || navDisabled ? 'disabled' : ''} title="${escapeAttr(nextLabel)}" aria-label="${escapeAttr(nextLabel)}">›</button>
            </div>
            <label class="pagination-page-size">
                ${escapeHtml(perPageLabel)}
                <select id="conversations-page-size-pagination">
                    <option value="20" ${pageSize === 20 ? 'selected' : ''}>20</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                </select>
            </label>
        </div>`;
        if (typeof initPaginationSelects === 'function') initPaginationSelects(el);
    } finally {
        conversationsPaginationRenderLock = false;
    }
}

function goConversationsPage(page) {
    const requestedPage = Math.max(1, parseInt(page, 10) || 1);
    const scrollToTop = requestedPage !== conversationsPagination.page;
    commitConversationsPage(requestedPage, { bumpNavigateGen: true });
    loadConversations(conversationsSearchQuery, {
        refreshMeta: false,
        scrollToTop,
        intentPage: requestedPage,
    });
}

function changeConversationsPageSize() {
    const sel = document.getElementById('conversations-page-size-pagination');
    const newSize = sel ? parseInt(sel.value, 10) : 50;
    if (![20, 50, 100].includes(newSize)) return;
    // 重建 DOM 后浏览器可能异步触发 change，值未变时不应重置页码
    if (newSize === conversationsPagination.pageSize) return;
    try {
        localStorage.setItem(CONVERSATIONS_PAGE_SIZE_KEY, String(newSize));
    } catch (e) { /* ignore */ }
    conversationsPagination.pageSize = newSize;
    commitConversationsPage(1, { bumpNavigateGen: true });
    loadConversations(conversationsSearchQuery);
}

window.goConversationsPage = goConversationsPage;
window.changeConversationsPageSize = changeConversationsPageSize;

// 加载对话列表（支持置顶）
async function loadConversations(searchQuery = '', options = {}) {
    const refreshMeta = options.refreshMeta !== false;
    const scrollToTop = options.scrollToTop === true;
    const intentPage = Number.isFinite(options.intentPage) ? options.intentPage : null;
    const navigateGenAtStart = conversationsListNavigateGen;
    const loadSeq = ++conversationsListLoadSeq;
    try {
        conversationsSearchQuery = searchQuery || '';
        const pageSize = getConversationsPageSize();
        conversationsPagination.pageSize = pageSize;
        const activePage = intentPage != null ? intentPage : conversationsPagination.page;
        const offset = (activePage - 1) * pageSize;
        const convParams = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
        if (conversationSortBy === 'created_at') {
            convParams.set('sort_by', 'created_at');
        }
        const projectFilter = getConversationProjectFilter();
        if (projectFilter) {
            convParams.set('project_id', projectFilter);
        }
        if (searchQuery && searchQuery.trim()) {
            convParams.set('search', searchQuery.trim());
        }
        updateConversationSidebarFilterUI();
        const url = `/api/conversations?${convParams}`;
        const response = await apiFetch(url);
        if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;

        const listContainer = document.getElementById('conversations-list');
        if (!listContainer) {
            return;
        }

        // 保存滚动位置
        const sidebarContent = listContainer.closest('.sidebar-content');
        const savedScrollTop = sidebarContent ? sidebarContent.scrollTop : 0;

        const emptyStateHtml = getConversationListEmptyHtml();
        listContainer.innerHTML = '';

        // 如果响应不是200，显示空状态（友好处理，不显示错误）
        if (!response.ok) {
            listContainer.innerHTML = emptyStateHtml;
            if (typeof window.applyTranslations === 'function') window.applyTranslations(listContainer);
            updateRecentConversationsCount(0);
            renderConversationsPagination(0);
            return;
        }

        const data = await response.json();
        if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
        const parsed = parseConversationsListResponse(data);
        const resolvedTotal = await resolveConversationsListTotal(convParams, parsed, pageSize, offset);
        if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
        conversationsPagination.total = resolvedTotal;
        updateRecentConversationsCount(resolvedTotal);

        const pageCheck = reconcileConversationsPageAfterTotal(
            activePage, intentPage, parsed, pageSize, offset, resolvedTotal
        );
        conversationsPagination.total = pageCheck.total;
        if (!pageCheck.ok) {
            if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
            // 用户主动翻页被钳制时仍保留 intent，并 bump navigateGen 使在途后台刷新失效
            if (intentPage != null) {
                commitConversationsPage(pageCheck.clampedPage, { bumpNavigateGen: true });
            }
            loadConversations(searchQuery, {
                ...options,
                intentPage: pageCheck.clampedPage,
                scrollToTop: options.scrollToTop === true || activePage !== pageCheck.clampedPage,
            });
            return;
        }
        if (intentPage == null && clampConversationsPageToTotal()) {
            if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
            loadConversations(searchQuery, options);
            return;
        }

        // 双重保险：后端或并发情况下若出现重复ID，前端按ID去重
        const uniqueConversations = [];
        const seenConversationIds = new Set();
        parsed.items.forEach(conv => {
            if (!conv || !conv.id || seenConversationIds.has(conv.id)) {
                return;
            }
            seenConversationIds.add(conv.id);
            uniqueConversations.push(conv);
        });

        if (uniqueConversations.length === 0) {
            listContainer.innerHTML = emptyStateHtml;
            if (typeof window.applyTranslations === 'function') window.applyTranslations(listContainer);
            renderConversationsPagination(0);
            return;
        }

        // 分离置顶和普通对话
        const pinnedConvs = [];
        const normalConvs = [];

        uniqueConversations.forEach(conv => {
            if (conv.pinned) {
                pinnedConvs.push(conv);
            } else {
                normalConvs.push(conv);
            }
        });

        // 按时间排序
        const sortByTime = (a, b) => getConversationSortTime(b) - getConversationSortTime(a);

        pinnedConvs.sort(sortByTime);
        normalConvs.sort(sortByTime);

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(todayStart.getDate() - 1);
        const sevenDaysCutoff = new Date(todayStart);
        sevenDaysCutoff.setDate(todayStart.getDate() - 7);

        const tFn = typeof window.t === 'function' ? window.t.bind(window) : null;
        const groupOrder = [
            { key: 'today', label: tFn ? tFn('chat.historyGroupToday') : '今天' },
            { key: 'yesterday', label: tFn ? tFn('chat.yesterday') : '昨天' },
            { key: 'last7Days', label: tFn ? tFn('chat.historyGroupLast7Days') : '过去七天' },
            { key: 'earlier', label: tFn ? tFn('chat.historyGroupEarlier') : '更早' },
        ];

        const groups = {
            today: [],
            yesterday: [],
            last7Days: [],
            earlier: [],
        };

        normalConvs.forEach(conv => {
            const dateObj = getConversationSortTime(conv);
            const validDate = dateObj.getTime() === 0 ? new Date() : dateObj;
            const groupKey = getConversationGroup(validDate, todayStart, sevenDaysCutoff, yesterdayStart);
            groups[groupKey].push({
                ...conv,
                _timeText: formatConversationTimestamp(validDate, todayStart, yesterdayStart),
            });
        });

        const fragment = document.createDocumentFragment();

        if (pinnedConvs.length > 0) {
            pinnedConvs.forEach(conv => {
                const dateObj = getConversationSortTime(conv);
                const validDate = dateObj.getTime() === 0 ? new Date() : dateObj;
                fragment.appendChild(createConversationListItemWithMenu({
                    ...conv,
                    _timeText: formatConversationTimestamp(validDate, todayStart, yesterdayStart),
                }, true));
            });
        }

        groupOrder.forEach(({ key, label }) => {
            const items = groups[key];
            if (!items || items.length === 0) {
                return;
            }
            const section = document.createElement('div');
            section.className = 'conversation-group';

            const title = document.createElement('div');
            title.className = 'conversation-group-title';
            title.textContent = label;
            section.appendChild(title);

            items.forEach(itemData => {
                section.appendChild(createConversationListItemWithMenu(itemData, false));
            });

            fragment.appendChild(section);
        });

        const visibleCount = pinnedConvs.length + Object.values(groups).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
        conversationsPagination.visibleCount = visibleCount;

        if (fragment.children.length === 0) {
            listContainer.innerHTML = emptyStateHtml;
            if (typeof window.applyTranslations === 'function') window.applyTranslations(listContainer);
            renderConversationsPagination(0);
            return;
        }

        if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
        listContainer.appendChild(fragment);
        updateActiveConversation();
        renderConversationsPagination(visibleCount);

        // 翻页时回到列表顶部；后台刷新保留滚动位置
        if (sidebarContent) {
            requestAnimationFrame(() => {
                if (!isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) {
                    sidebarContent.scrollTop = scrollToTop ? 0 : savedScrollTop;
                }
            });
        }
    } catch (error) {
        if (isStaleConversationListLoad(loadSeq, intentPage, navigateGenAtStart, activePage)) return;
        console.error('加载对话列表失败:', error);
        // 错误时显示空状态，而不是错误提示（更友好的用户体验）
        const listContainer = document.getElementById('conversations-list');
        if (listContainer) {
            listContainer.innerHTML = getConversationListEmptyHtml();
            if (typeof window.applyTranslations === 'function') window.applyTranslations(listContainer);
            updateRecentConversationsCount(0);
            renderConversationsPagination(0);
        }
    }
}

// 创建带菜单的对话项
function createConversationListItemWithMenu(conversation, isPinned) {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.conversationId = conversation.id;
    if (conversation.id === currentConversationId) {
        item.classList.add('active');
    }

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'conversation-content';

    const titleWrapper = document.createElement('div');
    titleWrapper.style.display = 'flex';
    titleWrapper.style.alignItems = 'center';
    titleWrapper.style.gap = '4px';

    const title = document.createElement('div');
    title.className = 'conversation-title';
    const titleText = conversation.title || '未命名对话';
    title.textContent = safeTruncateText(titleText, 60);
    title.title = titleText; // 设置完整标题以便悬停查看
    titleWrapper.appendChild(title);

    if (isPinned) {
        const pinIcon = document.createElement('span');
        pinIcon.className = 'conversation-item-pinned';
        pinIcon.innerHTML = '📌';
        pinIcon.title = '已置顶';
        titleWrapper.appendChild(pinIcon);
    }

    contentWrapper.appendChild(titleWrapper);

    const time = document.createElement('div');
    time.className = 'conversation-time';
    const dateObj = conversation.updatedAt ? new Date(conversation.updatedAt) : new Date();
    time.textContent = conversation._timeText || formatConversationTimestamp(dateObj);
    contentWrapper.appendChild(time);

    item.appendChild(contentWrapper);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'conversation-item-menu';
    menuBtn.innerHTML = '⋯';
    menuBtn.onclick = (e) => openConversationContextMenuForId(e, conversation.id, conversation.title || '');
    item.appendChild(menuBtn);

    item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetConversationId = String(item.dataset.conversationId || '').trim();
        if (targetConversationId) loadConversation(targetConversationId);
    };

    return item;
}

function openConversationContextMenuForId(event, conversationId, conversationTitle = '') {
    event.stopPropagation();
    event.preventDefault();
    contextMenuConversationId = conversationId;
    contextMenuConversationTitle = conversationTitle;
    return showConversationContextMenu(event);
}

let downloadMarkdownSubmenuHideTimer = null;

function clearDownloadMarkdownSubmenuHideTimeout() {
    if (!downloadMarkdownSubmenuHideTimer) return;
    clearTimeout(downloadMarkdownSubmenuHideTimer);
    downloadMarkdownSubmenuHideTimer = null;
}

function hideDownloadMarkdownSubmenu() {
    clearDownloadMarkdownSubmenuHideTimeout();
    downloadMarkdownSubmenuHideTimer = setTimeout(() => {
        const submenu = document.getElementById('download-markdown-submenu');
        if (submenu) submenu.style.display = 'none';
        downloadMarkdownSubmenuHideTimer = null;
    }, 120);
}

function handleDownloadMarkdownSubmenuEnter() {
    clearDownloadMarkdownSubmenuHideTimeout();
    const submenu = document.getElementById('download-markdown-submenu');
    if (submenu) submenu.style.display = 'block';
}

function handleDownloadMarkdownSubmenuLeave(event) {
    const submenu = document.getElementById('download-markdown-submenu');
    if (submenu && event?.relatedTarget && submenu.contains(event.relatedTarget)) return;
    hideDownloadMarkdownSubmenu();
}

function updateConversationContextPinText(isPinned) {
    const pinMenuText = document.getElementById('pin-conversation-menu-text');
    if (!pinMenuText) return;
    if (typeof window.t === 'function') {
        pinMenuText.textContent = isPinned ? window.t('contextMenu.unpinConversation') : window.t('contextMenu.pinConversation');
    } else {
        pinMenuText.textContent = isPinned ? '取消置顶' : '置顶此对话';
    }
}

async function refreshConversationContextPinText(convId) {
    if (!convId) {
        updateConversationContextPinText(false);
        return;
    }
    try {
        const response = await apiFetch(`/api/conversations/${convId}`);
        if (!response.ok) return;
        const conv = await response.json();
        updateConversationContextPinText(!!conv.pinned);
    } catch (error) {
        console.error('获取对话置顶状态失败:', error);
    }
}

// 显示对话上下文菜单
async function showConversationContextMenu(event) {
    const menu = document.getElementById('conversation-context-menu');
    if (!menu) return;

    const downloadSubmenu = document.getElementById('download-markdown-submenu');
    if (downloadSubmenu) {
        downloadSubmenu.style.display = 'none';
    }
    // 清除所有定时器
    clearDownloadMarkdownSubmenuHideTimeout();

    const convId = contextMenuConversationId;
    updateConversationContextPinText(false);

    // 更新攻击链菜单项的启用状态
    const attackChainMenuItem = document.getElementById('attack-chain-menu-item');
    if (attackChainMenuItem) {
        if (convId) {
            const isRunning = typeof isConversationTaskRunning === 'function'
                ? isConversationTaskRunning(convId)
                : false;
            if (isRunning) {
                attackChainMenuItem.style.opacity = '0.5';
                attackChainMenuItem.style.cursor = 'not-allowed';
                attackChainMenuItem.onclick = null;
                attackChainMenuItem.title = '当前对话正在执行，请稍后再生成攻击链';
            } else {
                attackChainMenuItem.style.opacity = '1';
                attackChainMenuItem.style.cursor = 'pointer';
                attackChainMenuItem.onclick = showAttackChainFromContext;
                attackChainMenuItem.title = (typeof window.t === 'function' ? window.t('chat.viewAttackChainCurrentConv') : '查看当前对话的攻击链');
            }
        } else {
            attackChainMenuItem.style.opacity = '0.5';
            attackChainMenuItem.style.cursor = 'not-allowed';
            attackChainMenuItem.onclick = null;
            attackChainMenuItem.title = (typeof window.t === 'function' ? window.t('chat.viewAttackChainSelectConv') : '请选择一个对话以查看攻击链');
        }
    }

    // 先显示菜单，置顶状态随后异步刷新，避免接口慢时点击没有任何反馈。
    menu.style.display = 'block';
    menu.style.visibility = 'visible';
    menu.style.opacity = '1';

    // 强制重排以获取正确尺寸
    void menu.offsetHeight;

    // 计算菜单位置，确保不超出屏幕
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const submenuWidth = 0;

    let left = event.clientX;
    let top = event.clientY;

    // 如果菜单会超出右边界，调整到左侧
    if (left + menuRect.width + submenuWidth > viewportWidth) {
        left = event.clientX - menuRect.width;
        // 如果调整后仍然超出，则放在按钮左侧
        if (left < 0) {
            left = Math.max(8, event.clientX - menuRect.width - submenuWidth);
        }
    }

    // 如果菜单会超出下边界，调整到上方
    if (top + menuRect.height > viewportHeight) {
        top = Math.max(8, event.clientY - menuRect.height);
    }

    // 确保不超出左边界
    if (left < 0) {
        left = 8;
    }

    // 确保不超出上边界
    if (top < 0) {
        top = 8;
    }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // 如果菜单在右侧，子菜单应该在左侧显示
    if (left < event.clientX) {
        if (downloadSubmenu) {
            downloadSubmenu.style.left = 'auto';
            downloadSubmenu.style.right = '100%';
            downloadSubmenu.style.marginLeft = '0';
            downloadSubmenu.style.marginRight = '4px';
        }
    } else {
        if (downloadSubmenu) {
            downloadSubmenu.style.left = '100%';
            downloadSubmenu.style.right = 'auto';
            downloadSubmenu.style.marginLeft = '4px';
            downloadSubmenu.style.marginRight = '0';
        }
    }

    // 点击外部关闭菜单
    const closeMenu = (e) => {
        // 检查点击是否在主菜单或子菜单内
        const downloadMarkdownSubmenuEl = document.getElementById('download-markdown-submenu');
        const clickedInMenu = menu.contains(e.target);
        const clickedInDownloadSubmenu = downloadMarkdownSubmenuEl && downloadMarkdownSubmenuEl.contains(e.target);

        if (!clickedInMenu && !clickedInDownloadSubmenu) {
            closeContextMenu();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 0);

    refreshConversationContextPinText(convId);
}

let renameConversationTargetId = null;

function ensureConversationRenameModal() {
    let modal = document.getElementById('conversation-rename-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'conversation-rename-modal';
    modal.className = 'modal-overlay projects-modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'conversation-rename-title');
    modal.innerHTML = `
        <div class="projects-modal-dialog">
            <div class="projects-modal-header">
                <div class="projects-modal-header-text">
                    <div>
                        <h3 id="conversation-rename-title" data-i18n="chat.renameConversationTitle">重命名对话</h3>
                        <p class="projects-modal-subtitle" data-i18n="chat.renameConversationSubtitle">修改后会同步更新项目文件夹和最近对话中的名称</p>
                    </div>
                </div>
                <button type="button" class="projects-modal-close" data-conversation-rename-close aria-label="关闭" data-i18n="common.close" data-i18n-attr="aria-label" data-i18n-skip-text="true">&times;</button>
            </div>
            <div class="projects-modal-body">
                <div class="projects-form-field">
                    <label for="conversation-rename-input" data-i18n="chat.conversationTitleLabel">对话名称</label>
                    <input type="text" id="conversation-rename-input" class="form-input" maxlength="200" autocomplete="off" data-i18n="chat.conversationTitlePlaceholder" data-i18n-attr="placeholder" placeholder="请输入对话名称">
                </div>
            </div>
            <div class="projects-modal-footer">
                <button class="btn-secondary" type="button" data-conversation-rename-close data-i18n="common.cancel">取消</button>
                <button class="btn-primary" type="button" id="conversation-rename-submit" data-i18n="contextMenu.rename">重命名</button>
            </div>
        </div>`;
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeConversationRenameModal();
    });
    modal.querySelectorAll('[data-conversation-rename-close]').forEach((button) => {
        button.addEventListener('click', closeConversationRenameModal);
    });
    modal.querySelector('#conversation-rename-submit')?.addEventListener('click', saveConversationRename);
    modal.querySelector('#conversation-rename-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveConversationRename();
        } else if (event.key === 'Escape') {
            closeConversationRenameModal();
        }
    });
    document.body.appendChild(modal);
    if (typeof window.applyTranslations === 'function') window.applyTranslations(modal);
    return modal;
}

// 打开应用内重命名弹窗，避免内置浏览器拦截 window.prompt。
function renameConversation() {
    const convId = contextMenuConversationId;
    if (!convId) return;

    renameConversationTargetId = convId;
    const currentTitle = contextMenuConversationTitle || '';
    ensureConversationRenameModal();
    const input = document.getElementById('conversation-rename-input');
    if (input) input.value = currentTitle;
    closeContextMenu();
    openAppModal('conversation-rename-modal', { focusEl: input });
    if (input) input.select();
}

function closeConversationRenameModal() {
    renameConversationTargetId = null;
    closeAppModal('conversation-rename-modal');
}

async function saveConversationRename() {
    const convId = renameConversationTargetId;
    const input = document.getElementById('conversation-rename-input');
    const newTitle = (input?.value || '').trim();
    if (!convId || !newTitle) {
        input?.focus();
        return;
    }

    const submitButton = document.getElementById('conversation-rename-submit');
    if (submitButton) submitButton.disabled = true;

    try {
        const response = await apiFetch(`/api/conversations/${convId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ title: newTitle.trim() }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || '更新失败');
        }

        // 更新前端显示
        document.querySelectorAll('[data-conversation-id]').forEach((item) => {
            if (item.dataset.conversationId !== convId) return;
            item.querySelectorAll('.conversation-title, .project-conversation-title')
                .forEach((titleEl) => {
                    titleEl.textContent = newTitle.trim();
                    titleEl.title = newTitle.trim();
                });
        });

        // 同步更新顶栏正在运行的任务名称
        if (typeof updateActiveTaskConversationTitle === 'function') {
            updateActiveTaskConversationTitle(convId, newTitle.trim());
        }

        // 重新加载对话列表
        await loadConversations();
        if (typeof window.refreshChatProjectFolders === 'function') {
            await window.refreshChatProjectFolders();
        }
        closeConversationRenameModal();
    } catch (error) {
        console.error('重命名对话失败:', error);
        const failedLabel = typeof window.t === 'function' ? window.t('chat.renameFailed') : '重命名失败';
        const unknownErr = '未知错误';
        alert(failedLabel + ': ' + (error.message || unknownErr));
    } finally {
        if (submitButton) submitButton.disabled = false;
    }
}

async function assertConversationActionResponse(response, fallbackMessage) {
    if (response && response.ok) return response;
    let payload = {};
    try {
        payload = response ? await response.json() : {};
    } catch (e) { /* ignore */ }
    throw new Error(payload.error || payload.message || fallbackMessage);
}

function notifyConversationPinnedChanged(conversationId, pinned) {
    try {
        document.dispatchEvent(new CustomEvent('conversation-pinned-changed', {
            detail: { conversationId, pinned: !!pinned }
        }));
    } catch (e) { /* ignore */ }
}

// 置顶对话
async function pinConversation() {
    const convId = contextMenuConversationId;
    if (!convId) return;

    // 点击后立即收起菜单，避免网络请求期间看起来“没有反应”。
    closeContextMenu();

    try {
        const response = await apiFetch(`/api/conversations/${convId}`);
        await assertConversationActionResponse(response, '获取对话失败');
        const conv = await response.json();
        const newPinned = !conv.pinned;

        const updateResponse = await apiFetch(`/api/conversations/${convId}/pinned`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ pinned: newPinned }),
        });
        await assertConversationActionResponse(updateResponse, '更新置顶状态失败');

        notifyConversationPinnedChanged(convId, newPinned);
        loadConversations();
    } catch (error) {
        console.error('置顶对话失败:', error);
        alert('置顶失败: ' + (error.message || '未知错误'));
    }

}

// 从上下文菜单查看攻击链
function showAttackChainFromContext() {
    const convId = contextMenuConversationId;
    if (!convId) return;

    closeContextMenu();
    showAttackChain(convId);
}

function formatConversationDateForMarkdown(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    return d.toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function getConversationRoleLabel(role) {
    switch (role) {
        case 'assistant':
            return 'Assistant';
        case 'user':
            return 'User';
        case 'system':
            return 'System';
        default:
            return role || 'Unknown';
    }
}

function formatConversationAsMarkdown(conversation, options = {}) {
    const includeToolDetails = !!options.includeToolDetails;
    const title = (conversation && conversation.title ? String(conversation.title) : '').trim() || 'Untitled Conversation';
    const createdAt = formatConversationDateForMarkdown(conversation && conversation.createdAt);
    const updatedAt = formatConversationDateForMarkdown(conversation && conversation.updatedAt);
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];

    let markdown = `# ${title}\n\n`;
    markdown += `- Conversation ID: \`${conversation && conversation.id ? conversation.id : ''}\`\n`;
    if (createdAt) markdown += `- Created At: ${createdAt}\n`;
    if (updatedAt) markdown += `- Updated At: ${updatedAt}\n`;
    markdown += `- Message Count: ${messages.length}\n\n`;
    markdown += '---\n\n';

    if (messages.length === 0) {
        markdown += '_No messages in this conversation._\n';
        return markdown;
    }

    messages.forEach((msg, index) => {
        if (msg && msg.role === 'user' && isInterruptContinueInjectChatMessage(msg.content)) {
            return;
        }
        const role = getConversationRoleLabel(msg && msg.role);
        const timestamp = formatConversationDateForMarkdown(msg && msg.createdAt);
        const content = msg && typeof msg.content === 'string' ? msg.content : '';

        markdown += `## ${index + 1}. ${role}`;
        if (timestamp) markdown += ` (${timestamp})`;
        markdown += '\n\n';
        markdown += content ? `${content}\n\n` : '_[Empty message]_\n\n';

        if (Array.isArray(msg && msg.processDetails) && msg.processDetails.length > 0) {
            markdown += '### Process Details\n\n';
            msg.processDetails.forEach((detail) => {
                const detailTime = formatConversationDateForMarkdown(detail && detail.timestamp);
                const eventType = detail && detail.eventType ? detail.eventType : 'event';
                const detailMsg = detail && detail.message ? detail.message : '';
                // Avoid "[label]:" pattern because some Markdown parsers treat it as link reference definition.
                markdown += `- \`${eventType}\``;
                if (detailTime) markdown += ` ${detailTime}`;
                if (detailMsg) markdown += `: ${detailMsg}`;
                markdown += '\n';

                if (includeToolDetails && detail && detail.data && (eventType === 'tool_call' || eventType === 'tool_result')) {
                    const pretty = JSON.stringify(detail.data, null, 2);
                    markdown += '\n```json\n';
                    markdown += pretty || '{}';
                    markdown += '\n```\n';
                }
            });
            markdown += '\n';
        }

        if (Array.isArray(msg && msg.mcpExecutionIds) && msg.mcpExecutionIds.length > 0) {
            markdown += `- MCP Execution IDs: ${msg.mcpExecutionIds.join(', ')}\n\n`;
        }

        markdown += '---\n\n';
    });

    return markdown;
}

function buildConversationMarkdownFileName(conversation, options = {}) {
    const includeToolDetails = !!options.includeToolDetails;
    const title = (conversation && conversation.title ? String(conversation.title) : '').trim() || 'conversation';
    const safeTitle = title
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'conversation';
    const idPart = (conversation && conversation.id ? String(conversation.id) : '').slice(0, 8) || 'export';
    const modePart = includeToolDetails ? 'full' : 'summary';
    return `${safeTitle}_${idPart}_${modePart}.md`;
}

// 从上下文菜单下载对话 Markdown
async function downloadConversationMarkdownFromContext(includeToolDetails = false) {
    const convId = contextMenuConversationId;
    if (!convId) return;

    try {
        // 下载不影响页面性能：直接从后端一次性拉取全量过程详情
        const response = await apiFetch(`/api/conversations/${convId}?include_process_details=1`);
        let conversation = null;
        try {
            conversation = await response.json();
        } catch (e) {
            conversation = null;
        }
        if (!response.ok) {
            const errorMsg = conversation && conversation.error ? conversation.error : 'unknown error';
            throw new Error(errorMsg);
        }

        const markdown = formatConversationAsMarkdown(conversation || {}, { includeToolDetails });
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = buildConversationMarkdownFileName(conversation || {}, { includeToolDetails });
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('下载对话 Markdown 失败:', error);
        const failedLabel = typeof window.t === 'function' ? window.t('chat.downloadConversationFailed') : '下载失败';
        const errMsg = error && error.message ? error.message : 'unknown error';
        alert(failedLabel + ': ' + errMsg);
    }

    closeContextMenu();
}

// 从上下文菜单跳转到漏洞管理，并按当前对话 ID 筛选
function navigateToVulnerabilitiesForContextConversation() {
    const convId = contextMenuConversationId;
    if (!convId) {
        closeContextMenu();
        return;
    }
    closeContextMenu();
    window.location.hash = 'vulnerabilities?conversation_id=' + encodeURIComponent(convId);
}

// 从上下文菜单删除对话
function deleteConversationFromContext() {
    if (typeof requirePermission === 'function' && !requirePermission('chat:delete')) return;
    const convId = contextMenuConversationId;
    if (!convId) return;

    const confirmMsg = typeof window.t === 'function' ? window.t('chat.deleteConversationConfirm') : '确定要删除此对话吗？';
    if (confirm(confirmMsg)) {
        deleteConversation(convId, true); // 跳过内部确认，因为这里已经确认过了
    }
    closeContextMenu();
}

// 关闭上下文菜单
function closeContextMenu() {
    const menu = document.getElementById('conversation-context-menu');
    if (menu) {
        menu.style.display = 'none';
    }
    const downloadSubmenu = document.getElementById('download-markdown-submenu');
    if (downloadSubmenu) {
        downloadSubmenu.style.display = 'none';
    }
    // 清除所有定时器
    clearDownloadMarkdownSubmenuHideTimeout();
    contextMenuConversationId = null;
    contextMenuConversationTitle = '';
}

// 显示批量管理模态框
let allConversationsForBatch = [];

function getConversationProjectId(conv) {
    return (conv?.projectId || conv?.project_id || '').trim();
}

function getConversationProjectLabel(conv) {
    const pid = getConversationProjectId(conv);
    if (!pid) {
        return typeof window.t === 'function' ? window.t('batchManageModal.noProject') : '无项目';
    }
    const name = window.projectNameById && window.projectNameById[pid];
    if (name) return name;
    return typeof window.t === 'function' ? window.t('batchManageModal.unknownProject') : '未知项目';
}

async function prefetchProjectNamesForConversations(conversations) {
    const missing = new Set();
    for (const conv of conversations || []) {
        const pid = getConversationProjectId(conv);
        if (pid && !(window.projectNameById && window.projectNameById[pid])) {
            missing.add(pid);
        }
    }
    if (!missing.size) return;
    const fetchSummary = typeof window.fetchProjectSummary === 'function'
        ? window.fetchProjectSummary
        : null;
    if (!fetchSummary) return;
    await Promise.all([...missing].map((id) => fetchSummary(id).catch(() => null)));
}

async function refreshBatchProjectFilter() {
    const sel = document.getElementById('batch-project-filter');
    if (!sel) return;
    const saved = sel.value || '';
    appendProjectFilterPinnedNativeOptions(sel);
    const normalized = await resolveProjectFilterSelection(saved);
    if (normalized && normalized !== CONVERSATION_PROJECT_FILTER_NONE) {
        await appendSelectedProjectFilterOption(sel, normalized);
    }
    sel.value = normalized;
    syncProjectFilterCustomSelect(BATCH_PROJECT_FILTER_SELECT_ID);
}

function getBatchFilteredConversations() {
    const query = (document.getElementById('batch-search-input')?.value || '').trim().toLowerCase();
    const projectFilter = (document.getElementById('batch-project-filter')?.value || '').trim();
    return allConversationsForBatch.filter((conv) => {
        const pid = getConversationProjectId(conv);
        if (projectFilter) {
            if (projectFilter === CONVERSATION_PROJECT_FILTER_NONE) {
                if (pid) return false;
            } else if (pid !== projectFilter) {
                return false;
            }
        }
        if (!query) return true;
        const title = (conv.title || '').toLowerCase();
        const projectName = getConversationProjectLabel(conv).toLowerCase();
        return title.includes(query) || projectName.includes(query);
    });
}

function applyBatchConversationFilters() {
    const filtered = getBatchFilteredConversations();
    updateBatchManageTitle(filtered.length);
    renderBatchConversations(filtered);
}

// 更新批量管理模态框标题（含条数），支持 i18n；count 为当前条数
function updateBatchManageTitle(count) {
    const titleEl = document.getElementById('batch-manage-title');
    if (!titleEl || typeof window.t !== 'function') return;
    const template = window.t('batchManageModal.title', { count: '__C__' });
    const parts = template.split('__C__');
    titleEl.innerHTML = (parts[0] || '') + '<span id="batch-manage-count">' + (count || 0) + '</span>' + (parts[1] || '');
}

async function showBatchManageModal() {
    try {
        initProjectFilterCustomSelect(BATCH_PROJECT_FILTER_SELECT_ID);
        allConversationsForBatch = await fetchAllConversations('');
        await prefetchProjectNamesForConversations(allConversationsForBatch);
        await refreshBatchProjectFilter();
        const sidebarFilter = getConversationProjectFilter();
        const batchSel = document.getElementById('batch-project-filter');
        if (batchSel && sidebarFilter && (
            sidebarFilter === CONVERSATION_PROJECT_FILTER_NONE ||
            (window.projectNameById && window.projectNameById[sidebarFilter])
        )) {
            batchSel.value = sidebarFilter;
        }
        const searchInput = document.getElementById('batch-search-input');
        if (searchInput) searchInput.value = '';
        applyBatchConversationFilters();
        openAppModal('batch-manage-modal', { focus: false });
    } catch (error) {
        console.error('加载对话列表失败:', error);
        initProjectFilterCustomSelect(BATCH_PROJECT_FILTER_SELECT_ID);
        allConversationsForBatch = [];
        await refreshBatchProjectFilter();
        applyBatchConversationFilters();
        openAppModal('batch-manage-modal', { focus: false });
    }
}

// 安全截断中文字符串，避免在汉字中间截断
function safeTruncateText(text, maxLength = 50) {
    if (!text || typeof text !== 'string') {
        return text || '';
    }

    // 使用 Array.from 将字符串转换为字符数组（正确处理 Unicode 代理对）
    const chars = Array.from(text);

    // 如果文本长度未超过限制，直接返回
    if (chars.length <= maxLength) {
        return text;
    }

    // 截断到最大长度（基于字符数，而不是代码单元）
    let truncatedChars = chars.slice(0, maxLength);

    // 尝试在标点符号或空格处截断，使截断更自然
    // 在截断点往前查找合适的断点（不超过20%的长度）
    const searchRange = Math.floor(maxLength * 0.2);
    const breakChars = ['，', '。', '、', ' ', ',', '.', ';', ':', '!', '?', '！', '？', '/', '\\', '-', '_'];
    let bestBreakPos = truncatedChars.length;

    for (let i = truncatedChars.length - 1; i >= truncatedChars.length - searchRange && i >= 0; i--) {
        if (breakChars.includes(truncatedChars[i])) {
            bestBreakPos = i + 1; // 在标点符号后断开
            break;
        }
    }

    // 如果找到合适的断点，使用它；否则使用原截断位置
    if (bestBreakPos < truncatedChars.length) {
        truncatedChars = truncatedChars.slice(0, bestBreakPos);
    }

    // 将字符数组转换回字符串，并添加省略号
    return truncatedChars.join('') + '...';
}

// 渲染批量管理对话列表
function renderBatchConversations(filtered = null) {
    const list = document.getElementById('batch-conversations-list');
    if (!list) return;

    const conversations = filtered || allConversationsForBatch;
    list.innerHTML = '';

    conversations.forEach(conv => {
        const row = document.createElement('div');
        row.className = 'batch-conversation-row';
        row.dataset.conversationId = conv.id;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'batch-conversation-checkbox theme-checkbox';
        checkbox.dataset.conversationId = conv.id;
        checkbox.addEventListener('change', syncSelectAllBatchCheckbox);

        const checkboxCol = document.createElement('div');
        checkboxCol.className = 'batch-table-col-checkbox';
        checkboxCol.appendChild(checkbox);

        const name = document.createElement('div');
        name.className = 'batch-table-col-name';
        const originalTitle = conv.title || (typeof window.t === 'function' ? window.t('batchManageModal.unnamedConversation') : '未命名对话');
        const truncatedTitle = safeTruncateText(originalTitle, 36);
        name.textContent = truncatedTitle;
        name.title = originalTitle;

        const project = document.createElement('div');
        project.className = 'batch-table-col-project';
        const projectLabel = getConversationProjectLabel(conv);
        const truncatedProject = safeTruncateText(projectLabel, 28);
        project.textContent = truncatedProject;
        project.title = projectLabel;
        if (!getConversationProjectId(conv)) {
            project.classList.add('is-unbound');
        }

        const time = document.createElement('div');
        time.className = 'batch-table-col-time';
        const dateObj = conv.updatedAt ? new Date(conv.updatedAt) : new Date();
        const locale = (typeof i18next !== 'undefined' && i18next.language) ? i18next.language : 'zh-CN';
        time.textContent = dateObj.toLocaleString(locale, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        const action = document.createElement('div');
        action.className = 'batch-table-col-action';
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'batch-delete-btn';
        deleteBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        const deleteLabel = typeof window.t === 'function' ? window.t('contextMenu.deleteConversation') : '删除此对话';
        deleteBtn.title = deleteLabel;
        deleteBtn.setAttribute('aria-label', deleteLabel);
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteConversation(conv.id);
        };
        action.appendChild(deleteBtn);

        row.appendChild(checkboxCol);
        row.appendChild(name);
        row.appendChild(project);
        row.appendChild(time);
        row.appendChild(action);

        list.appendChild(row);
    });

    syncSelectAllBatchCheckbox();
}

// 筛选批量管理对话
function filterBatchConversations() {
    applyBatchConversationFilters();
}

// 全选/取消全选
function toggleSelectAllBatch() {
    const selectAll = document.getElementById('batch-select-all');
    const checkboxes = document.querySelectorAll('.batch-conversation-checkbox');

    if (selectAll) {
        selectAll.indeterminate = false;
    }
    checkboxes.forEach(cb => {
        cb.checked = selectAll.checked;
    });
}

function syncSelectAllBatchCheckbox() {
    const selectAll = document.getElementById('batch-select-all');
    if (!selectAll) return;

    const checkboxes = document.querySelectorAll('.batch-conversation-checkbox');
    const total = checkboxes.length;
    const checked = document.querySelectorAll('.batch-conversation-checkbox:checked').length;

    if (total === 0 || checked === 0) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    } else if (checked === total) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
    } else {
        selectAll.checked = false;
        selectAll.indeterminate = true;
    }
}

// 删除选中的对话
async function deleteSelectedConversations() {
    if (typeof requirePermission === 'function' && !requirePermission('chat:delete')) return;
    const checkboxes = document.querySelectorAll('.batch-conversation-checkbox:checked');
    if (checkboxes.length === 0) {
        alert(typeof window.t === 'function' ? window.t('batchManageModal.confirmDeleteNone') : '请先选择要删除的对话');
        return;
    }

    const confirmMsg = typeof window.t === 'function' ? window.t('batchManageModal.confirmDeleteN', { count: checkboxes.length }) : '确定要删除选中的 ' + checkboxes.length + ' 条对话吗？';
    if (!confirm(confirmMsg)) {
        return;
    }

    const ids = Array.from(checkboxes).map(cb => cb.dataset.conversationId);

    try {
        for (const id of ids) {
            await deleteConversation(id, true); // 跳过内部确认，因为批量删除时已经确认过了
        }
        // 删除后保持弹窗打开，便于继续管理剩余对话
        const selectAll = document.getElementById('batch-select-all');
        if (selectAll) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        }
    } catch (error) {
        console.error('删除失败:', error);
        const failedMsg = typeof window.t === 'function' ? window.t('batchManageModal.deleteFailed') : '删除失败';
        const unknownErr = '未知错误';
        alert(failedMsg + ': ' + (error.message || unknownErr));
    }
}

// 关闭批量管理模态框
function closeBatchManageModal() {
    closeAllProjectFilterCustomSelects();
    closeAppModal('batch-manage-modal');
    const selectAll = document.getElementById('batch-select-all');
    if (selectAll) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    }
    const searchInput = document.getElementById('batch-search-input');
    if (searchInput) searchInput.value = '';
    const batchProj = document.getElementById('batch-project-filter');
    if (batchProj) batchProj.value = '';
    allConversationsForBatch = [];
}

// 语言切换时刷新当前聊天页内的时间与动态文案（消息时间、执行流程时间由 monitor 的 refreshProgressAndTimelineI18n 处理）
function refreshChatPanelI18n() {
    const locale = (typeof window.uiLocale === 'function' ? window.uiLocale() : 'en-US');
    const timeOpts = { hour: '2-digit', minute: '2-digit' };
    if (locale === 'zh-CN' || locale === 'ru-RU') timeOpts.hour12 = false;
    const t = typeof window.t === 'function' ? window.t : function (k) { return k; };

    const messagesEl = document.getElementById('chat-messages');
    if (messagesEl) {
        messagesEl.querySelectorAll('.message-time[data-message-time]').forEach(function (el) {
            try {
                const d = new Date(el.dataset.messageTime);
                if (!isNaN(d.getTime())) {
                    el.textContent = d.toLocaleTimeString(locale, timeOpts);
                }
            } catch (e) { /* ignore */ }
        });
        messagesEl.querySelectorAll('.process-detail-btn').forEach(function (btn) {
            const span = btn.querySelector('span');
            if (!span) return;
            const assistantEl = btn.closest('.message.assistant');
            const messageId = assistantEl && assistantEl.id;
            const detailsId = messageId ? 'process-details-' + messageId : '';
            const timeline = detailsId ? document.getElementById(detailsId) && document.getElementById(detailsId).querySelector('.progress-timeline') : null;
            const expanded = timeline && timeline.classList.contains('expanded');
            span.textContent = expanded ? t('tasks.collapseDetail') : t('chat.expandDetail');
        });
        const copyLabel = t('common.copy');
        const copyTitle = t('chat.copyMessageTitle');
        messagesEl.querySelectorAll('.message-copy-btn').forEach(function (btn) {
            if (btn.dataset.copySuccessActive === '1') return;
            const span = btn.querySelector('span');
            if (span) span.textContent = copyLabel;
            btn.title = copyTitle;
            btn.setAttribute('aria-label', copyTitle);
        });
        messagesEl.querySelectorAll('.message.assistant').forEach(function (msgEl) {
            if (typeof window.syncAssistantTurnSummary === 'function') {
                window.syncAssistantTurnSummary(msgEl);
            }
            if (typeof window.syncMcpToolsToggleButton === 'function') {
                window.syncMcpToolsToggleButton(msgEl);
            }
        });
        if (window.CyberStrikeChatScroll && typeof window.CyberStrikeChatScroll.refreshTurnRail === 'function') {
            window.CyberStrikeChatScroll.refreshTurnRail();
        }
    }

    if (isAppModalOpen('mcp-detail-modal')) {
        const detailTimeEl = document.getElementById('detail-time');
        if (detailTimeEl && detailTimeEl.dataset.detailTimeIso) {
            try {
                const d = new Date(detailTimeEl.dataset.detailTimeIso);
                if (!isNaN(d.getTime())) {
                    detailTimeEl.textContent = d.toLocaleString(locale);
                }
            } catch (e) { /* ignore */ }
        }
        const statusEl = document.getElementById('detail-status');
        if (statusEl && statusEl.dataset.detailStatus !== undefined && typeof getStatusText === 'function') {
            statusEl.textContent = getStatusText(statusEl.dataset.detailStatus);
        }
    }
}

// 语言切换时刷新批量管理模态框标题（若当前正在显示）；并刷新对话列表时间格式与系统就绪提示；刷新当前页消息时间与动态文案
document.addEventListener('languagechange', function () {
    refreshSystemReadyMessageBubbles();
    refreshChatPanelI18n();
    if (typeof refreshConversationProjectFilter === 'function') {
        refreshConversationProjectFilter();
    }
    if (typeof refreshBatchProjectFilter === 'function') {
        refreshBatchProjectFilter().then(() => {
            const modal = document.getElementById('batch-manage-modal');
            if (modal && isAppModalOpen('batch-manage-modal') && typeof applyBatchConversationFilters === 'function') {
                applyBatchConversationFilters();
            }
        });
    }
    // 侧边栏最近对话等列表的时间戳会随语言变化（24h/12h 等），重新拉列表以统一格式
    if (typeof loadConversations === 'function') {
        loadConversations();
    }
});

// 初始化时加载对话列表
document.addEventListener('DOMContentLoaded', async () => {
    ensureProjectSidebarStructure();
    if (window.i18nReady) await window.i18nReady;
    if (typeof window.applyTranslations === 'function') {
        window.applyTranslations(document.getElementById('conversation-sidebar'));
    }
    // 任务栏不再暴露项目筛选，清除旧选择以免隐藏部分任务。
    setConversationProjectFilter('');
    restoreRecentConversationsState();
    updateConversationSortMenuUI();
    initConversationProjectCustomSelect();
    initConversationsPaginationEvents();
    await refreshConversationProjectFilter();
    await loadConversations();

    // 添加页面焦点时自动刷新对话列表的功能
    // 这样当通过OpenAPI创建对话后，切换回页面时能自动看到新对话
    let lastFocusTime = Date.now();
    const CONVERSATION_REFRESH_INTERVAL = 30000; // 30秒内最多刷新一次，避免过于频繁

    window.addEventListener('focus', () => {
        const now = Date.now();
        // 如果距离上次刷新超过30秒，才刷新对话列表
        if (now - lastFocusTime > CONVERSATION_REFRESH_INTERVAL) {
            lastFocusTime = now;
            if (typeof loadConversations === 'function') {
                loadConversations();
            }
        }
    });

    // 监听页面可见性变化（当用户切换标签页回来时）
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // 页面变为可见时，检查是否需要刷新
            const now = Date.now();
            if (now - lastFocusTime > CONVERSATION_REFRESH_INTERVAL) {
                lastFocusTime = now;
                if (typeof loadConversations === 'function') {
                    loadConversations();
                }
            }
        }
    });

    // 任意入口删除对话后同步：若删除的是当前对话则清空主区，并刷新侧边栏列表（如从 WebShell AI 助手删除）
    document.addEventListener('conversation-deleted', (e) => {
        const id = e.detail && e.detail.conversationId;
        if (!id) return;
        // API 已确认删除后立即移除可见列表项，网络刷新只负责校准分页和计数。
        document.querySelectorAll('.conversation-item[data-conversation-id]')
            .forEach((item) => {
                if (item.dataset.conversationId === id) item.remove();
            });
        if (id === currentConversationId) {
            currentConversationId = null;
            try {
                window.currentConversationId = '';
            } catch (e) { /* ignore */ }
            const messagesDiv = document.getElementById('chat-messages');
            if (messagesDiv) messagesDiv.innerHTML = '';
            renderChatWelcomeEmptyState();
            addAttackChainButton(null);
        }
        if (typeof loadConversations === 'function') {
            loadConversations();
        }
    });
});

async function refreshAllProjectFilterSelects() {
    await refreshConversationProjectFilter();
    await refreshBatchProjectFilter();
}

// 顶层 async function 不会自动挂到 window，hitl 等脚本依赖 window.loadConversation
if (typeof window !== 'undefined') {
    window.loadConversation = loadConversation;
    window.startNewConversation = startNewConversation;
    window.refreshChatWelcomeEmptyState = refreshSystemReadyMessageBubbles;
    window.openConversationContextMenuForId = openConversationContextMenuForId;
    window.renameConversation = renameConversation;
    window.closeConversationRenameModal = closeConversationRenameModal;
    window.saveConversationRename = saveConversationRename;
    window.refreshConversationProjectFilter = refreshConversationProjectFilter;
    window.refreshAllProjectFilterSelects = refreshAllProjectFilterSelects;
    window.onConversationProjectFilterChange = onConversationProjectFilterChange;
}

