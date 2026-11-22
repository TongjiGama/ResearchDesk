/* 科研台 — 渲染进程主逻辑 */
(() => {
  'use strict';

  // ---------- 状态 ----------
  const Workbench = window.ResearchWorkbench;
  const S = new Workbench.AppState();

  const services = new Workbench.RendererServices(window.bridge);
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 板块 → 图标名（反向链接 / 论断中心 / 失效引用快速新建共用）
  const boardIcon = (b) => b === 'papers' ? 'fileText' : b === 'discovery' ? 'search' : b === 'timeline' ? 'timeline' : b === 'ideas' ? 'lightbulb' : 'flask';
  const boardName = (b) => b === 'papers' ? '论文' : b === 'discovery' ? '检索' : b === 'timeline' ? '论文脉络' : b === 'ideas' ? 'Idea' : '实验';
  const IDEA_STAGES = ['收件箱', '整理中', '待验证', '已转实验', '已归档'];
  const TODO_STAGES = ['待办', '进行中', '已完成', '已归档'];
  function ideaStage(item) {
    if ((item.type || 'idea') === 'todo') return TODO_STAGES.includes(item.status) ? item.status : '待办';
    return IDEA_STAGES.includes(item.status) ? item.status : '收件箱';
  }

  // 更新按钮内的 SVG 图标（不破坏 data-ico 占位结构）
  function setBtnIcon(btn, name, size) {
    if (!btn) return;
    let slot = btn.querySelector('[data-ico]');
    if (!slot) { slot = document.createElement('span'); slot.className = 'ico-slot'; btn.appendChild(slot); }
    if (slot.dataset.ico === name && slot.dataset.iDone) return;
    slot.dataset.ico = name;
    slot.innerHTML = ico(name, size || 16);
    slot.dataset.iDone = '1';
  }

  async function call(method, ...args) {
    return services.store(method, ...args);
  }
  async function ai(method, ...args) {
    return services.ai(method, ...args);
  }

  /** v3：服务层（openalex / rating）通道；store → call()，ai → ai()，服务 → svc()。 */
  async function svc(service, method, ...args) {
    return services.service(service, method, ...args);
  }

  function draggedFilePaths(dt) {
    const out = [];
    Array.prototype.forEach.call((dt && dt.files) || [], (f) => {
      const p = f.path || f.name;
      if (p) out.push(p);
    });
    return out;
  }

  function bindDropZone(el, options = {}) {
    if (!el) return;
    el.classList.add('drop-zone');
    const onEnter = (e) => {
      e.preventDefault();
      el.classList.add('drop-active');
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-active');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-active');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drop-active');
      const paths = draggedFilePaths(e.dataTransfer);
      if (!paths.length) return toast('未读取到可上传的文件路径', true);
      try {
        await options.onFiles(paths);
      } catch (err) {
        toast(err.message || '拖拽上传失败', true);
      }
    });
  }

  function nestedValue(obj, path) {
    const parts = String(path || '').split('.');
    let cur = obj || {};
    for (const p of parts) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function setNestedValue(obj, path, value) {
    const parts = String(path || '').split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  let paperSlashPickerId = 0;
  function bindPaperSlashPicker(editor) {
    const menu = document.createElement('div');
    const menuId = 'paper-slash-menu-' + (++paperSlashPickerId);
    menu.id = menuId;
    menu.className = 'paper-slash-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    document.body.appendChild(menu);
    editor.setAttribute('aria-autocomplete', 'list');
    editor.setAttribute('aria-controls', menuId);
    editor.setAttribute('aria-expanded', 'false');

    let papersPromise = null;
    let requestId = 0;
    let tokenStart = -1;
    let options = [];
    let activeIndex = 0;
    let isOpen = false;

    function positionMenu() {
      if (!isOpen) return;
      const rect = editor.getBoundingClientRect();
      const width = Math.min(420, Math.max(240, window.innerWidth - 24));
      const height = menu.offsetHeight || 180;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const top = rect.bottom + height + 8 <= window.innerHeight
        ? rect.bottom + 6
        : Math.max(12, rect.top - height - 6);
      menu.style.width = width + 'px';
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    function closeMenu() {
      requestId++;
      isOpen = false;
      menu.hidden = true;
      editor.setAttribute('aria-expanded', 'false');
      editor.removeAttribute('aria-activedescendant');
    }

    function renderMenu(message) {
      menu.innerHTML = `<div class="paper-slash-menu-head">引用论文 <span>输入标题或作者筛选</span></div>${
        message
          ? `<div class="paper-slash-menu-empty">${esc(message)}</div>`
          : options.map((paper, index) => {
            const title = paper.title || paper.shortName || paper.id;
            const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : String(paper.authors || '');
            const meta = [paper.shortName && paper.shortName !== title ? paper.shortName : '', authors, paper.published].filter(Boolean).join(' · ');
            return `<button type="button" class="paper-slash-option${index === activeIndex ? ' active' : ''}" id="${menuId}-option-${index}" role="option" aria-selected="${index === activeIndex}" data-paper-index="${index}"><span class="paper-slash-title">${esc(title)}</span>${meta ? `<span class="paper-slash-meta">${esc(meta)}</span>` : ''}</button>`;
          }).join('')
      }`;
      menu.querySelectorAll('[data-paper-index]').forEach((button) => {
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => selectPaper(Number(button.dataset.paperIndex)));
      });
      if (options.length) editor.setAttribute('aria-activedescendant', menuId + '-option-' + activeIndex);
      positionMenu();
    }

    function selectPaper(index) {
      const paper = options[index];
      if (!paper || !paper.id || tokenStart < 0) return;
      const target = String(paper.id).replace(/\]\]/g, '');
      const label = String(paper.title || paper.shortName || target).replace(/\]\]/g, '] ]');
      editor.setRangeText(`[[${target}|${label}]] `, tokenStart, editor.selectionEnd, 'end');
      closeMenu();
      editor.focus();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function updateMenu() {
      const caret = editor.selectionStart;
      const before = editor.value.slice(0, caret);
      const match = before.match(/(?:^|[\s([{])\/([^\s/]{0,80})$/);
      if (!match) {
        closeMenu();
        return;
      }

      tokenStart = caret - match[1].length - 1;
      const query = match[1].toLocaleLowerCase();
      const currentRequest = ++requestId;
      isOpen = true;
      options = [];
      activeIndex = 0;
      menu.hidden = false;
      editor.setAttribute('aria-expanded', 'true');
      renderMenu('正在加载论文…');
      try {
        if (!papersPromise) papersPromise = call('listItems', S.ws, 'papers');
        const papers = await papersPromise;
        if (currentRequest !== requestId || !editor.isConnected) return;
        if (!Array.isArray(papers)) throw new Error('论文列表格式无效');
        options = papers
          .filter((paper) => paper && paper.id && !paper._error)
          .filter((paper) => {
            const authors = Array.isArray(paper.authors) ? paper.authors.join(' ') : String(paper.authors || '');
            const searchable = [paper.title, paper.shortName, paper.id, paper.arxivId, authors].join(' ').toLocaleLowerCase();
            return !query || searchable.includes(query);
          })
          .sort((a, b) => String(a.title || a.shortName || a.id).localeCompare(String(b.title || b.shortName || b.id)))
          .slice(0, 8);
        renderMenu(options.length ? '' : '没有找到匹配论文');
      } catch (error) {
        if (currentRequest !== requestId) return;
        papersPromise = null;
        closeMenu();
        toast('加载论文列表失败：' + error.message, true);
      }
    }

    function handleKeydown(event) {
      if (!isOpen) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return true;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + direction + options.length) % options.length;
        renderMenu('');
        return true;
      }
      if (event.key === 'Enter' && !event.ctrlKey && options.length) {
        event.preventDefault();
        selectPaper(activeIndex);
        return true;
      }
      return false;
    }

    const reposition = () => positionMenu();
    editor.addEventListener('input', updateMenu);
    editor.addEventListener('scroll', reposition);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return {
      handleKeydown,
      dispose() {
        closeMenu();
        editor.removeEventListener('input', updateMenu);
        editor.removeEventListener('scroll', reposition);
        window.removeEventListener('resize', reposition);
        document.removeEventListener('scroll', reposition, true);
        menu.remove();
        editor.removeAttribute('aria-controls');
        editor.removeAttribute('aria-autocomplete');
        editor.removeAttribute('aria-expanded');
        editor.removeAttribute('aria-activedescendant');
      }
    };
  }

  function bindInlineFields(root, item, board, activeTabName) {
    if (!root) return;
    root.querySelectorAll('[data-inline]').forEach((el) => {
      el.classList.add('inline-editable');
      el.tabIndex = 0;
      el.addEventListener('click', (e) => {
        if (el.querySelector('input,textarea,select')) return;
        if (e.target.closest('a,button,input,textarea,select')) return;
        e.preventDefault();
        e.stopPropagation();
        const path = el.dataset.inline;
        const fm = item.frontmatter || {};
        const multiline = el.dataset.inlineMultiline === 'true';
        const directKey = el.dataset.inlineKey;
        const isBody = path === 'body';
        const oldValue = isBody ? item.body : (directKey ? (nestedValue(fm, path) || {})[directKey] : nestedValue(fm, path));
        const options = el.dataset.inlineOptions ? el.dataset.inlineOptions.split('|') : [];
        const tagsField = el.dataset.inlineType === 'tags';
        const editorType = options.length ? 'select' : (tagsField || multiline ? 'textarea' : 'input');
        const editor = document.createElement(editorType);
        if (multiline || tagsField) editor.rows = multiline ? 3 : 2;
        if (editorType === 'input') editor.type = 'text';
        if (el.dataset.inlineType === 'date') editor.type = 'date';
        editor.className = 'inline-editor';
        if (editorType === 'select') {
          editor.innerHTML = options.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        }
        editor.value = Array.isArray(oldValue) ? oldValue.join(', ') : (oldValue == null ? '' : String(oldValue));
        el.textContent = '';
        el.appendChild(editor);
        editor.focus();
        if (editorType === 'textarea') editor.setSelectionRange(editor.value.length, editor.value.length);
        else if (typeof editor.select === 'function') editor.select();
        const paperSlashPicker = multiline ? bindPaperSlashPicker(editor) : null;
        let finished = false;
        const finish = async (save) => {
          if (finished) return;
          if (paperSlashPicker) paperSlashPicker.dispose();
          if (!save) {
            finished = true;
            restoreInlineValue(el, path, oldValue, board);
            return;
          }
          const rawValue = editor.value;
          if (path === 'title' && !rawValue.trim()) {
            toast('标题不能为空', true);
            editor.focus();
            return;
          }
          finished = true;
          const value = tagsField
            ? rawValue.split(/[,，\r\n]/).map((tag) => tag.trim()).filter(Boolean)
            : (isBody || multiline ? rawValue : rawValue.trim());
          const nf = { ...fm };
          if (isBody) {
            nf.refs = extractRefs((nf.title || '') + '\n' + value);
          } else if (directKey) {
            const bucket = { ...(nestedValue(nf, path) || {}) };
            bucket[directKey] = value;
            setNestedValue(nf, path, bucket);
          } else {
            setNestedValue(nf, path, value);
          }
          if (board === 'ideas' && ['title', 'problem', 'gap', 'hypothesis', 'methodology', 'validationPlan', 'nextStep'].includes(path)) {
            const combined = [nf.title, nf.problem, nf.gap, nf.hypothesis, nf.methodology, nf.validationPlan, nf.nextStep, item.body || ''].join('\n');
            nf.refs = Array.from(new Set(extractRefs(combined).concat(Array.isArray(nf.groundedPapers) ? nf.groundedPapers : [])));
          }
          nf.updatedAt = new Date().toISOString().slice(0, 10);
          try {
            const body = isBody ? value : (item.body || '');
            await call('saveItem', S.ws, board, item.id, { frontmatter: nf, body });
            item.frontmatter = nf;
            item.body = body;
            restoreInlineValue(el, path, value, board);
            const updatedAt = el.closest('.detail')?.querySelector('[data-updated-at]');
            if (updatedAt) updatedAt.textContent = nf.updatedAt;
            if (path === 'basedOn' || path === 'relatedIdea') updateInlineReference(el, value, path === 'basedOn' ? '打开基线' : '打开关联灵感');
            if (isBody) {
              bindRefClicks(el);
              renderBacklinks($('#ideaBacklinks'), item.id);
            }
            if ((board === 'ideas' && ['nextStep', 'problem', 'gap', 'hypothesis', 'methodology', 'validationPlan'].includes(path)) || (board === 'experiments' && ['goal', 'hypothesis', 'conclusion', 'nextStep', 'failure.cause', 'failure.action', 'results.summary'].includes(path))) {
              bindRefClicks(el);
            }
            if (path === 'status') el.className = el.className.replace(/\bflag-[^\s]+/g, '') + ` flag-${String(value).replace(/\s+/g, '-')}`;
            if (board === 'experiments') {
              const activeTab = el.closest('.detail')?.querySelector('[data-etab].active')?.dataset.etab || activeTabName || 'design';
              await refreshExperimentDetail(activeTab);
            }
            else await refreshItems();
            toast('已保存');
          } catch (err) {
            restoreInlineValue(el, path, oldValue, board);
            toast(err.message, true);
          }
        };
        editor.addEventListener('keydown', (ev) => {
          if (paperSlashPicker && paperSlashPicker.handleKeydown(ev)) return;
          if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
          if (ev.key === 'Enter' && (!multiline && !tagsField || ev.ctrlKey)) { ev.preventDefault(); finish(true); }
        });
        editor.addEventListener('blur', () => finish(true));
      });
      el.addEventListener('keydown', (event) => {
        if (event.target !== el || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        el.click();
      });
    });
  }

  function restoreInlineValue(el, path, value, board) {
    if (path === 'body' || path === 'protocol') {
      el.innerHTML = renderMarkdown(String(value || ''));
      return;
    }
    if ((board === 'ideas' && ['nextStep', 'problem', 'gap', 'hypothesis', 'methodology', 'validationPlan'].includes(path)) || (board === 'experiments' && ['goal', 'hypothesis', 'conclusion', 'nextStep', 'failure.cause', 'failure.action', 'results.summary'].includes(path))) {
      el.innerHTML = renderTextWithRefs(String(value || ''));
      return;
    }
    if (path === 'tags' && Array.isArray(value)) {
      const tagClass = board === 'ideas' ? 'idea-tag' : 'li-tag';
      el.innerHTML = value.length
        ? value.map((tag) => `<span class="${tagClass}">${esc(tag)}</span>`).join('')
        : '<span class="hint">点击添加标签</span>';
      return;
    }
    el.textContent = value == null || value === '' ? '—' : String(value);
  }

  function updateInlineReference(el, value, title) {
    let link = el.nextElementSibling;
    if (!link || !link.matches('a[data-ref]')) {
      if (!value) return;
      link = document.createElement('a');
      link.title = title;
      link.textContent = '↗';
      el.after(document.createTextNode(' '), link);
    }
    if (!value) {
      link.remove();
      return;
    }
    link.dataset.ref = value;
    bindRefClicks(link);
  }

  function bindInlineEntryAdds(root, item, activeTabName) {
    if (!root) return;
    root.querySelectorAll('[data-inline-add]').forEach((button) => {
      button.addEventListener('click', () => {
        const kind = button.dataset.inlineAdd;
        const path = kind === 'config' ? 'config' : 'results.metrics';
        const label = kind === 'config' ? '参数名' : '指标名';
        const editor = document.createElement('div');
        editor.className = 'inline-entry-editor';
        editor.innerHTML = `<input class="inline-editor-key" aria-label="${label}" placeholder="${label}"><input class="inline-editor-value" aria-label="数值" placeholder="值"><button class="btn sm" type="button" data-entry-save>添加</button><button class="btn ghost sm" type="button" data-entry-cancel>取消</button>`;
        button.replaceWith(editor);
        const keyInput = editor.querySelector('.inline-editor-key');
        const valueInput = editor.querySelector('.inline-editor-value');
        keyInput.focus();
        const cancel = () => editor.replaceWith(button);
        const save = async () => {
          const key = keyInput.value.trim();
          if (!key) { toast(`${label}不能为空`, true); keyInput.focus(); return; }
          const fm = { ...(item.frontmatter || {}) };
          const bucket = { ...(nestedValue(fm, path) || {}) };
          if (Object.prototype.hasOwnProperty.call(bucket, key)) {
            toast(`已存在「${key}」`, true);
            keyInput.focus();
            return;
          }
          bucket[key] = valueInput.value.trim();
          setNestedValue(fm, path, bucket);
          fm.updatedAt = new Date().toISOString().slice(0, 10);
          const activeTab = activeTabName || root.querySelector('[data-etab].active')?.dataset.etab;
          try {
            await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: fm, body: item.body || '' });
            item.frontmatter = fm;
            await refreshExperimentDetail(activeTab);
            toast('已添加');
          } catch (error) {
            toast(error.message, true);
          }
        };
        editor.querySelector('[data-entry-save]').addEventListener('click', save);
        editor.querySelector('[data-entry-cancel]').addEventListener('click', cancel);
        editor.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          if (event.key === 'Enter') { event.preventDefault(); save(); }
        });
      });
    });
  }
  let toastTimer = null;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  async function refreshExperimentDetail(activeTab) {
    await refreshItems();
    await renderDetail();
    if (activeTab && activeTab !== 'design') {
      $('#detailRoot')?.querySelector(`[data-etab="${activeTab}"]`)?.click();
    }
  }

  // ---------- 初始化 ----------
  async function init() {
    try {
      const initData = await call('init');
      S.cfg = initData.config;
      S.wsList = initData.workspaces;
      S.ws = S.cfg.currentWorkspace || S.wsList[0];
      S.skills = await call('listSkills');
      applyUiPrefs();
      hydrateIcons();
      bindGlobal();
      await renderWorkspaces();
      await renderBoard();
      hydrateIcons();
      console.log(`INIT_OK items=${S.items.length} theme=${(S.cfg.ui || {}).theme || 'classic'}`);
    } catch (e) {
      toast('初始化失败：' + e.message, true);
      console.error('INIT_FAIL', e && e.message, e && e.stack);
    }
  }

  function applyUiPrefs() {
    const ui = S.cfg.ui || {};
    const app = document.getElementById('app');
    app.classList.toggle('ws-collapsed', !!ui.workspaceCollapsed);
    app.classList.toggle('list-collapsed', !!ui.listCollapsed);
    app.classList.remove('focus-mode'); // 专注模式默认不恢复，避免用户困惑
    $('#workspaceBar').classList.toggle('collapsed', !!ui.workspaceCollapsed);
    $('#wsToggleBtn')?.setAttribute('aria-pressed', String(!ui.workspaceCollapsed));
    $('#listToggleBtn')?.setAttribute('aria-pressed', String(!ui.listCollapsed));
    $('#themeToggleBtn')?.setAttribute('aria-label', (ui.theme || 'classic') === 'neo' ? '切换到简约主题' : '切换到炫酷主题');
    document.body.classList.toggle('theme-neo', (ui.theme || 'classic') === 'neo');
    applyColumnWidths(curVar('--ws-w', ui.wsWidth || 224), curVar('--list-w', ui.listWidth || 340));
    const themeBtn = $('#themeToggleBtn');
    setBtnIcon(themeBtn, (ui.theme || 'classic') === 'neo' ? 'sun' : 'moon');
    setBtnIcon($('#focusToggleBtn'), 'focus');
    const crumb = $('#wsBreadcrumb');
    if (crumb) crumb.textContent = S.ws || '工作区';
  }

  async function setTheme(theme) {
    S.cfg = await call('updateConfig', { ui: { theme } });
    applyUiPrefs();
    // Canvas 不继承 CSS 变量：主题切换后立即重取色并重绘所有图表
    if (window.Charts) Charts.refreshTheme();
    window.bridge.app.setBackground(theme);
  }

  /** 重建 DOM 前的统一销毁入口；销毁后把仍可见的详情图表重绘，避免空白。 */
  function clearCharts() {
    if (!window.Charts) return;
    Charts.destroyAll();
    redrawVisibleCharts();
  }

  /** 依据 canvas 上保存的状态，重绘当前仍挂载在 DOM 中的图表。 */
  function redrawVisibleCharts() {
    if (!window.Charts) return;
    $$('.chart-card canvas[data-chart-key]').forEach((canvas) => {
      const st = canvas._chartState;
      if (st) Charts.render(st.key, canvas, st.parsed, st.cfg);
    });
    $$('.chart-mini canvas[data-chart-key]').forEach((canvas) => {
      const st = canvas._statState;
      if (st) Charts.renderSimple(st.key, canvas, st.labels, st.series, st.kind);
    });
  }

  // marked 配置
  if (window.marked) window.marked.setOptions({ gfm: true, breaks: true });

  const registry = new Workbench.ControllerRegistry();
  const coreActions = { ideaStage, setBtnIcon, draggedFilePaths, bindDropZone, nestedValue, setNestedValue, bindInlineFields, restoreInlineValue, updateInlineReference, bindInlineEntryAdds, refreshExperimentDetail, init, applyUiPrefs, setTheme, clearCharts, redrawVisibleCharts };
  const context = new Workbench.AppContext({
    state: S,
    dom: { $, $$, esc },
    services: { call, ai, svc },
    constants: { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage },
    ui: { toast },
    registry,
    coreActions
  });
  [
    ['workspace', Workbench.WorkspaceController],
    ['paper', Workbench.PaperController],
    ['idea', Workbench.IdeaController],
    ['experiment', Workbench.ExperimentController],
    ['reference', Workbench.ReferenceController],
    ['discovery', Workbench.DiscoveryController],
    ['overlay', Workbench.OverlayController]
  ].forEach(([name, Controller]) => registry.register(name, new Controller(context)));
  const {
    renderWorkspaces, bindWorkspaceEvents, switchWorkspace, toggleWorkspaceBar, showWorkspaceMenu,
    closeMenu, showWorkspaceSwitcher, showNewWorkspace, showRenameWorkspace, showCopyWorkspace,
    confirmDeleteWorkspace, bindBoardEvents, switchBoard, renderBoard, refreshItems,
    buildToolbar, bindFilterRow, filteredItems, renderList, paperItemHtml,
    ideaItemHtml, expItemHtml, bindListEvents, showHoverCard, positionHoverCard,
    hideHoverCard, toggleStar, showItemMenu, renderDetail, renderPaperDetail,
    runAiGenerate, batchGenerateNotes, editPaper, renderIdeaDetail, createIdea,
    editIdea, createExperimentFromIdea, renderExpDetail, normalizeChartCfg, dataTableHtml,
    saveChartConfig, chartCardHtml, bindChartCard, renderResultFiles, cloneExperiment, createExperiment,
    editExperiment, renderMarkdown, renderTextWithRefs, extractRefs, bindRefClicks, offerCreateRefTarget,
    renderBacklinks, importPdfs, batchImport, scanPdfRecursive, confirmDeleteItem,
    showSettings, showLearnSkill, showDiscovery, renderDiscoveryBoard, renderTimelineBoard, resizeDiscoveryComposer,
    bindDiscoverySplitter, renderDiscoveryRecent, runDiscovery, updateDiscoveryControls, renderDiscoveryResults,
    rateDiscoveryResult, autoRateDiscoveryResults, updateDiscoveryRatingBadge, showRatingDetail, importSelected,
    importOne, doImportPicks, refreshCitationsBtn, showTimeline, bindingTimelineNodeClick,
    openModal, closeModal, newCurrentItem, buildCommands, showCommandPalette,
    closeCmdk, showClaimCenter, showStatsPanel, showShortcutHelp, bindGlobal,
    setListCollapsed, toggleFocus, curVar, columnBudget, applyColumnWidths,
    columnResizeBounds, dragResize, refreshAll
  } = context.actions;

  init();
})();
