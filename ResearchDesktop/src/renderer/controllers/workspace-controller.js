(() => {
  const namespace = window.ResearchWorkbench;
  class WorkspaceController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { renderPaperDetail, batchGenerateNotes, editPaper, renderIdeaDetail, createIdea, editIdea, showCoIIdeationModal, showIdeaTournamentModal, showIdeaSkillsModal, renderExpDetail, createExperiment, editExperiment, showQuickIngestModal, showSweepModal, showCompareModal, showNegativeLedgerModal, showExperimentSkillsModal, importPdfs, batchImport, confirmDeleteItem, renderDiscoveryBoard, renderTimelineBoard, refreshCitationsBtn, showTimeline, openModal, closeModal, curVar, applyColumnWidths, refreshAll } = context.actions;
  // ---------- 工作区栏 ----------
  async function renderWorkspaces() {
    const el = $('#workspaceList');
    el.innerHTML = S.wsList.map((w) => `
      <div class="ws-item ${w === S.ws ? 'active' : ''}" data-ws="${esc(w)}" tabindex="0" aria-current="${w === S.ws ? 'page' : 'false'}">
        <span class="ws-item-ico">${ico('layers', 15)}</span>
        <span class="ws-name" title="${esc(w)}">${esc(w)}</span>
        <button class="ws-menu" data-wsmenu="${esc(w)}" title="工作区操作" aria-label="${esc(w)} 工作区操作" aria-haspopup="menu">${ico('more', 15)}</button>
      </div>`).join('');
    const count = $('#wsCount');
    if (count) count.textContent = S.wsList.length;
  }

  function bindWorkspaceEvents() {
    $('#workspaceList').addEventListener('click', async (e) => {
      const menu = e.target.closest('[data-wsmenu]');
      if (menu) { e.stopPropagation(); showWorkspaceMenu(menu.dataset.wsmenu, menu); return; }
      const item = e.target.closest('[data-ws]');
      if (item) await switchWorkspace(item.dataset.ws);
    });
    $('#workspaceList').addEventListener('keydown', async (e) => {
      const item = e.target.closest('[data-ws]');
      if (!item) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        await switchWorkspace(item.dataset.ws);
      }
      if (e.key === 'F10' && e.shiftKey) {
        e.preventDefault();
        showWorkspaceMenu(item.dataset.ws, item);
      }
    });
    $('#wsAddBtn').addEventListener('click', showNewWorkspace);
    $('#wsToggleBtn').addEventListener('click', () => toggleWorkspaceBar(!document.getElementById('app').classList.contains('ws-collapsed')));
    $('#wsRail').addEventListener('click', () => toggleWorkspaceBar(false));
  }

  async function switchWorkspace(ws) {
    if (ws === S.ws) return;
    S.discoveryRequestId++;
    S.ws = ws;
    S.selectedId = null;
    S.search = '';
    S.statusFilter = '';
    S.ideaStageFilter = '';
    S.discoveryQuery = '';
    S.searchResults = [];
    S.discoveryMeta = null;
    S.discoveryResultSourceFilter = '';
    S.discoveryResultGradeFilter = '';
    S.discoveryExpandedAbstracts = new Set();
    S._lineageSynthesis = null;
    S._lineageMissing = null;
    S.selection.clear();
    await call('updateConfig', { currentWorkspace: ws });
    const crumb = $('#wsBreadcrumb');
    if (crumb) crumb.textContent = ws;
    hideHoverCard();
    hydrateIcons();
    await renderWorkspaces();
    await renderBoard();
  }

  async function toggleWorkspaceBar(collapse) {
    document.getElementById('app').classList.toggle('ws-collapsed', collapse);
    $('#workspaceBar').classList.toggle('collapsed', collapse);
    applyColumnWidths(curVar('--ws-w', 224), curVar('--list-w', 340));
    S.cfg = await call('updateConfig', { ui: { workspaceCollapsed: collapse } });
  }

  function showWorkspaceMenu(ws, anchor) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu-pop';
    m.id = 'menuPop';
    m.setAttribute('role', 'menu');
    const items = [
      { label: '重命名', act: 'rename' },
      { label: '复制工作区', act: 'copy' },
      { label: '删除工作区', act: 'delete', danger: true }
    ];
    m.innerHTML = items.map((i) => `<button class="menu-item ${i.danger ? 'danger' : ''}" role="menuitem" data-act="${i.act}">${i.label}</button>`).join('');
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - 170) + 'px';
    m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
    m.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-act]');
      if (!item) return;
      const act = item.dataset.act;
      closeMenu();
      if (act === 'rename') showRenameWorkspace(ws);
      else if (act === 'copy') showCopyWorkspace(ws);
      else if (act === 'delete') confirmDeleteWorkspace(ws);
    });
    m.addEventListener('keydown', (e) => {
      const itemsEl = Array.from(m.querySelectorAll('[role="menuitem"]'));
      const idx = itemsEl.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); itemsEl[(idx + 1) % itemsEl.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); itemsEl[(idx - 1 + itemsEl.length) % itemsEl.length]?.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); }
    });
    m.querySelector('[role="menuitem"]')?.focus();
  }
  function closeMenu() {
    const m = $('#menuPop');
    if (m) m.remove();
    const trigger = $('#wsSwitchBtn');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function showWorkspaceSwitcher() {
    closeMenu();
    const trigger = $('#wsSwitchBtn');
    const m = document.createElement('div');
    m.className = 'menu-pop workspace-switcher';
    m.id = 'menuPop';
    m.setAttribute('role', 'menu');
    m.innerHTML =
      `<div class="menu-title">切换工作区</div>` +
      S.wsList.map((w) => `<button class="menu-item workspace-switch-item ${w === S.ws ? 'active' : ''}" role="menuitem" data-ws-switch="${esc(w)}">${ico(w === S.ws ? 'check' : 'layers', 14)}<span>${esc(w)}</span></button>`).join('') +
      `<div class="menu-separator"></div><button class="menu-item" role="menuitem" data-ws-new>${ico('plus', 14)}新建工作区</button>`;
    document.body.appendChild(m);
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    const r = trigger ? trigger.getBoundingClientRect() : { left: 10, bottom: 80 };
    m.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8) + 'px';
    m.querySelectorAll('[data-ws-switch]').forEach((b) => b.addEventListener('click', async () => {
      const ws = b.dataset.wsSwitch;
      closeMenu();
      if (ws !== S.ws) await switchWorkspace(ws);
    }));
    m.querySelector('[data-ws-new]').addEventListener('click', () => {
      closeMenu();
      showNewWorkspace();
    });
    m.addEventListener('keydown', (e) => {
      const itemsEl = Array.from(m.querySelectorAll('[role="menuitem"]'));
      const idx = itemsEl.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); itemsEl[(idx + 1) % itemsEl.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); itemsEl[(idx - 1 + itemsEl.length) % itemsEl.length]?.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); trigger?.focus(); }
    });
    m.querySelector('.workspace-switch-item.active')?.focus();
  }

  function showNewWorkspace() {
    openModal('新建工作区', `
      <div class="form-field"><label>工作区名称</label><input id="mWsName" placeholder="例如：课程项目-机器人" autofocus></div>
      <div class="hint" style="margin-top:8px">每个工作区拥有独立的论文、灵感和实验数据。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="mWsOk">创建</button></div>
    `, (root) => {
      root.querySelector('#mWsOk').addEventListener('click', async () => {
        const name = root.querySelector('#mWsName').value.trim();
        if (!name) return toast('请输入名称', true);
        try {
          const created = await call('createWorkspace', name);
          await call('updateConfig', { currentWorkspace: created });
          closeModal();
          await refreshAll();
          toast('工作区已创建');
        } catch (e) { toast(e.message, true); }
      });
      root.querySelector('#mWsName').addEventListener('keydown', (e) => { if (e.key === 'Enter') root.querySelector('#mWsOk').click(); });
    });
  }
  function showRenameWorkspace(ws) {
    openModal('重命名工作区', `
      <div class="form-field"><label>新名称</label><input id="mWsName" value="${esc(ws)}"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="mWsOk">保存</button></div>
    `, (root) => {
      root.querySelector('#mWsOk').addEventListener('click', async () => {
        const name = root.querySelector('#mWsName').value.trim();
        if (!name || name === ws) return closeModal();
        try { await call('renameWorkspace', ws, name); closeModal(); await refreshAll(); toast('已重命名'); }
        catch (e) { toast(e.message, true); }
      });
    });
  }
  function showCopyWorkspace(ws) {
    openModal('复制工作区', `
      <div class="form-field"><label>新工作区名称</label><input id="mWsName" value="${esc(ws)}-副本"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="mWsOk">复制</button></div>
    `, (root) => {
      root.querySelector('#mWsOk').addEventListener('click', async () => {
        const name = root.querySelector('#mWsName').value.trim();
        if (!name) return toast('请输入名称', true);
        try { await call('copyWorkspace', ws, name); closeModal(); await refreshAll(); toast('已复制'); }
        catch (e) { toast(e.message, true); }
      });
    });
  }
  function confirmDeleteWorkspace(ws) {
    if (S.wsList.length <= 1) {
      toast('至少保留一个工作区，无法删除最后一个', true);
      return;
    }
    openModal('删除工作区', `
      <div style="color:var(--red);margin-bottom:8px">确定删除工作区「${esc(ws)}」吗？</div>
      <div class="hint">其中的论文笔记、灵感、实验记录与数据文件都会被永久删除，无法恢复。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn danger" id="mWsOk">确认删除</button></div>
    `, (root) => {
      root.querySelector('#mWsOk').addEventListener('click', async () => {
        try { await call('deleteWorkspace', ws); closeModal(); await refreshAll(); toast('已删除'); }
        catch (e) { toast(e.message, true); }
      });
    });
  }

  // ---------- 板块切换 ----------
  function bindBoardEvents() {
    $$('.board-tab').forEach((t) => {
      t.addEventListener('click', () => switchBoard(t.dataset.board));
      t.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const tabs = $$('.board-tab').filter((x) => getComputedStyle(x).display !== 'none');
        if (!tabs.length) return;
        let index = tabs.findIndex((x) => x.dataset.board === S.board);
        if (e.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
        if (e.key === 'ArrowRight') index = (index + 1) % tabs.length;
        if (e.key === 'Home') index = 0;
        if (e.key === 'End') index = tabs.length - 1;
        tabs[index].focus();
        switchBoard(tabs[index].dataset.board);
      });
    });
  }
  async function switchBoard(board) {
    if (board === S.board) return;
    if (S.board === 'discovery') S.discoveryRequestId++;
    if (S.board === 'timeline' && window.Timeline) window.Timeline.destroy();
    if (S.board !== 'discovery' && S.selectedId) S.lastSelected[S.board] = S.selectedId;
    S.board = board;
    S.selectedId = board === 'discovery' || board === 'timeline' ? null : (S.lastSelected[board] || null);
    S.statusFilter = '';
    S.ideaStageFilter = '';
    S.search = '';
    hideHoverCard();
    await renderBoard();
  }

  // ---------- 列表与详情 ----------
  async function renderBoard() {
    $$('.board-tab').forEach((t) => {
      const active = t.dataset.board === S.board;
      t.classList.toggle('active', active);
      if (t.classList.contains('board-tab')) t.setAttribute('aria-selected', String(active));
      if (t.classList.contains('board-tab')) t.setAttribute('tabindex', active ? '0' : '-1');
    });
    const discoveryMode = S.board === 'discovery';
    const app = document.getElementById('app');
    app.classList.toggle('discovery-mode', discoveryMode);
    app.classList.toggle('timeline-mode', S.board === 'timeline');
    if (discoveryMode) {
      S.items = [];
      renderDiscoveryBoard();
      return;
    }
    if (S.board === 'timeline') {
      S.items = [];
      await renderTimelineBoard();
      return;
    }
    S.items = await call('listItems', S.ws, S.board);
    buildToolbar();
    renderList();
    // 默认选中第一条，让详情区始终有内容，不是空白
    if (!S.selectedId && S.items.length > 0) S.selectedId = S.items[0].id;
    await renderDetail();
  }
  async function refreshItems() {
    S.items = await call('listItems', S.ws, S.board);
    renderList();
  }

  function buildToolbar() {
    const tb = $('#listToolbar');
    if (S.board === 'papers') {
      tb.innerHTML = `
        <div class="search-row">
          <input class="search-input" id="searchInput" placeholder="搜索标题 / 简称 / arXiv / 笔记全文" value="${esc(S.search)}">
          <button class="icon-btn search-clear ${S.search ? '' : 'is-hidden'}" id="searchClearBtn" title="清除搜索">${ico('close', 14)}</button>
          <button class="btn" id="importPdfsBtn" title="导入 PDF · 支持多选">${ico('upload', 14)}导入 PDF</button>
        </div>
        <div class="filter-row" id="filterRow">
          <button class="chip ${S.statusFilter === '' ? 'active' : ''}" data-status="">全部</button>
          <button class="chip chip-star ${S.statusFilter === '__starred' ? 'active' : ''}" data-status="__starred" title="只看星标（必引）论文">${ico('star', 12)}必引</button>
          ${['待读', '在读', '已读', '精读', '归档'].map((s) => `<button class="chip ${S.statusFilter === s ? 'active' : ''}" data-status="${s}">${s}</button>`).join('')}
        </div>
        <div class="btn-row">
          <button class="btn ghost sm" id="timelineBtn">${ico('timeline', 13)}脉络图</button>
          <button class="btn ghost sm" id="refreshCitBtn" title="按需联网重抓 OpenAlex 引用量">${ico('refresh', 13)}引用量</button>
          <button class="btn ghost sm" id="batchImportBtn">${ico('folderOpen', 13)}批量扫描</button>
          <button class="btn ghost sm" id="batchAiBtn" title="给所有缺笔记的论文批量生成 AI 笔记+摘要">${ico('sparkle', 13)}AI 批量笔记</button>
        </div>`;
      $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value.trim().toLowerCase(); $('#searchClearBtn').classList.toggle('is-hidden', !S.search); renderList(); });
      $('#searchClearBtn').addEventListener('click', () => { S.search = ''; const input = $('#searchInput'); input.value = ''; $('#searchClearBtn').classList.add('is-hidden'); input.focus(); renderList(); });
      $('#importPdfsBtn').addEventListener('click', importPdfs);
      $('#timelineBtn').addEventListener('click', showTimeline);
      $('#refreshCitBtn').addEventListener('click', refreshCitationsBtn);
      $('#batchImportBtn').addEventListener('click', batchImport);
      $('#batchAiBtn').addEventListener('click', batchGenerateNotes);
      bindFilterRow();
    } else if (S.board === 'ideas') {
      tb.innerHTML = `
        <div class="search-row">
          <input class="search-input" id="searchInput" placeholder="搜索灵感 / 待办" value="${esc(S.search)}">
          <button class="icon-btn search-clear ${S.search ? '' : 'is-hidden'}" id="searchClearBtn" title="清除搜索">${ico('close', 14)}</button>
        </div>
        <div class="idea-capture-row">
          <input id="ideaCaptureInput" type="text" placeholder="快速记录一个想法，按 Enter 保存…" aria-label="快速记录 Idea">
          <button class="btn" id="addIdeaBtn">${ico('plus', 14)}记下</button>
          <button class="btn ghost" id="addTodoBtn" title="快速新增待办">${ico('checkSquare', 14)}待办</button>
        </div>
        <div class="filter-row" id="filterRow">
          ${['', 'idea', 'todo'].map((s) => `<button class="chip ${S.statusFilter === s ? 'active' : ''}" data-status="${s}">${s === '' ? '全部' : s === 'idea' ? '灵感池' : '待办区'}</button>`).join('')}
        </div>
        <div class="btn-row">
          <button class="btn ghost sm" id="ideaCoIBtn" title="借鉴 CoI-Agent 从本地论文链孵化结构化 Idea">${ico('sparkle', 13)}CoI 文献孵化</button>
          <button class="btn ghost sm" id="ideaTourBtn" title="借鉴 Open-Co-Scientist 进行成对 Elo 锦标赛与进化">${ico('zap', 13)}Elo 锦标赛</button>
          <button class="btn ghost sm" id="ideaSkillsBtn" title="管理内置 Idea Skills 或从 GitHub 导入">${ico('book', 13)}Skills</button>
        </div>`;
      tb.insertAdjacentHTML('beforeend', `
        <label class="idea-stage-row"><span>阶段</span><select id="ideaStageSelect">
          <option value="">全部阶段</option>
          ${[...IDEA_STAGES, ...TODO_STAGES.filter((stage) => stage !== '已归档')].map((stage) =>
            `<option value="${esc(stage)}" ${S.ideaStageFilter === stage ? 'selected' : ''}>${esc(stage)}</option>`
          ).join('')}
        </select></label>`);
      $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value.trim().toLowerCase(); $('#searchClearBtn').classList.toggle('is-hidden', !S.search); renderList(); });
      $('#searchClearBtn').addEventListener('click', () => { S.search = ''; const input = $('#searchInput'); input.value = ''; $('#searchClearBtn').classList.add('is-hidden'); input.focus(); renderList(); });
      const capture = (type) => {
        const input = $('#ideaCaptureInput');
        const title = input.value.trim();
        if (!title) return toast('先写下一句话再记录', true);
        input.value = '';
        createIdea(type, title);
      };
      $('#addIdeaBtn').addEventListener('click', () => capture('idea'));
      $('#addTodoBtn').addEventListener('click', () => capture('todo'));
      $('#ideaCaptureInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); capture(S.statusFilter === 'todo' ? 'todo' : 'idea'); }
      });
      $('#ideaStageSelect').addEventListener('change', (e) => { S.ideaStageFilter = e.target.value; renderList(); });
      $('#ideaCoIBtn').addEventListener('click', () => showCoIIdeationModal());
      $('#ideaTourBtn').addEventListener('click', () => showIdeaTournamentModal());
      $('#ideaSkillsBtn').addEventListener('click', () => showIdeaSkillsModal());
      bindFilterRow();
    } else {
      tb.innerHTML = `
        <div class="search-row">
          <input class="search-input" id="searchInput" placeholder="搜索实验" value="${esc(S.search)}">
          <button class="icon-btn search-clear ${S.search ? '' : 'is-hidden'}" id="searchClearBtn" title="清除搜索">${ico('close', 14)}</button>
          <button class="btn" id="addExpBtn">${ico('plus', 14)}新建实验</button>
        </div>
        <div class="filter-row" id="filterRow">
          ${['', '草稿', '计划中', '进行中', '阻塞', '完成', '失败', '已归档'].map((s) =>
            `<button class="chip ${S.statusFilter === s ? 'active' : ''}" data-status="${esc(s)}">${s || '全部'}</button>`
          ).join('')}
        </div>
        <div class="btn-row">
          <button class="btn sm exp-hero-ingest" id="expIngestBtn" title="扫描 Hydra/W&B/HF/Lightning/TensorBoard 目录或粘贴命令行与日志直接导入">${ico('download', 13)}导入运行/日志（目录 · 命令 · 终端输出）</button>
          <button class="btn ghost sm" id="expCompareBtn" title="实验总榜、多种子 booktabs 论文表、EMA 曲线叠加与 Git 代码 Diff">${ico('stats', 13)}总榜与论文表</button>
          <button class="btn ghost sm" id="expSweepBtn" title="生成超参 Sweep 笛卡尔网格与多卡/tmux/Slurm 脚本">${ico('zap', 13)}超参 Sweep</button>
          <button class="btn ghost sm" id="expLedgerBtn" title="查看所有失败/退化实验的负结果教训台账">${ico('shield', 13)}负结果台账</button>
          <button class="btn ghost sm" id="expSkillsBtn" title="管理内置实验 Skills 或从 GitHub 导入">${ico('book', 13)}Skills</button>
        </div>`;
      $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value.trim().toLowerCase(); $('#searchClearBtn').classList.toggle('is-hidden', !S.search); renderList(); });
      $('#searchClearBtn').addEventListener('click', () => { S.search = ''; const input = $('#searchInput'); input.value = ''; $('#searchClearBtn').classList.add('is-hidden'); input.focus(); renderList(); });
      $('#addExpBtn').addEventListener('click', () => createExperiment());
      $('#expIngestBtn').addEventListener('click', () => showQuickIngestModal());
      $('#expCompareBtn').addEventListener('click', () => showCompareModal());
      $('#expSweepBtn').addEventListener('click', () => showSweepModal());
      $('#expLedgerBtn').addEventListener('click', () => showNegativeLedgerModal());
      $('#expSkillsBtn').addEventListener('click', () => showExperimentSkillsModal());
      bindFilterRow();
    }
  }
  function bindFilterRow() {
    const row = $('#filterRow');
    if (!row) return;
    row.addEventListener('click', (e) => {
      const c = e.target.closest('[data-status]');
      if (!c) return;
      S.statusFilter = c.dataset.status;
      $$('#filterRow .chip').forEach((x) => x.classList.toggle('active', x === c));
      renderList();
    });
  }

  function filteredItems() {
    let list = S.items.slice();
    if (S.search) {
      list = list.filter((it) => [it.title, it.shortName, it.arxivId, it.id, it.status, it.source,
        ...(S.board === 'ideas' && Array.isArray(it.tags) ? it.tags : [])]
        .some((v) => String(v || '').toLowerCase().includes(S.search))
        || String(it._fulltext || it._excerpt || '').includes(S.search));
    }
    if (S.statusFilter) {
      if (S.statusFilter === '__starred') {
        // D49 必引筛选：跨状态的星标论文
        list = list.filter((it) => !!it.starred);
      } else if (S.board === 'papers') list = list.filter((it) => (it.status || '待读') === S.statusFilter);
      else if (S.board === 'ideas' && ['idea', 'todo'].includes(S.statusFilter)) {
        list = list.filter((it) => (it.type || 'idea') === S.statusFilter);
      } else if (S.board === 'experiments') list = list.filter((it) => (it.status || '草稿') === S.statusFilter);
    }
    if (S.board === 'ideas' && S.ideaStageFilter) list = list.filter((it) => ideaStage(it) === S.ideaStageFilter);
    return list;
  }

  function renderList() {
    const list = filteredItems();
    const el = $('#listScroll');
    const foot = $('#listFoot');
    if (foot) foot.textContent = `共 ${list.length} 项${S.search || S.statusFilter ? ' · 已筛选' : ''}`;
    if (list.length === 0) {
      el.innerHTML = `<div class="list-empty">
        <div class="le-ico">${ico('search', 26)}</div>
        <div class="le-title">${S.search ? '没有匹配的内容' : '这里还空着'}</div>
        <div class="le-sub">${S.search ? '换个关键词，或清空筛选条件试试' : '按 Ctrl+N 新建一条记录'}</div>
      </div>`;
      return;
    }
    if (S.board === 'papers') {
      const groups = ['待读', '在读', '已读', '精读', '归档'];
      el.innerHTML = groups.map((g) => {
        const items = list.filter((it) => (it.status || '待读') === g);
        if (!items.length) return '';
        return `<div class="group-label">${g} · ${items.length}</div>` + items.map(paperItemHtml).join('');
      }).join('') || list.map(paperItemHtml).join('');
    } else if (S.board === 'ideas') {
      const stages = S.statusFilter === 'todo' ? TODO_STAGES : S.statusFilter === 'idea' ? IDEA_STAGES : [...IDEA_STAGES, ...TODO_STAGES.filter((stage) => stage !== '已归档')];
      el.innerHTML = stages.map((stage) => {
        const items = list.filter((it) => ideaStage(it) === stage);
        return items.length ? `<div class="group-label">${esc(stage)} · ${items.length}</div>${items.map(ideaItemHtml).join('')}` : '';
      }).join('');
    } else {
      el.innerHTML = list.map(expItemHtml).join('');
    }
    bindListEvents();
  }

  function paperItemHtml(it) {
    const status = it.status || '待读';
    const starred = !!it.starred;
    // D48 溯源标记：AI 生成的内容显示一个小的"AI"角标（色+文双通道，D45）
    const aiMark = it.aiGenerated ? `<span class="li-ai" title="摘要/笔记由 AI 生成，请核对原文">${ico('sparkle', 10)}AI</span>` : '';
    return `<div class="list-item ${it.id === S.selectedId ? 'active' : ''}" data-id="${esc(it.id)}" tabindex="0" aria-selected="${it.id === S.selectedId ? 'true' : 'false'}">
      <div class="li-icon" data-hover="${esc(it.id)}">${ico('fileText', 15)}</div>
      <div class="li-main">
        <div class="li-title">${starred ? `<span class="li-star-on" title="已标记必引">${ico('star', 11)}</span>` : ''}${esc(it.shortName || it.title || it.id)}</div>
        <div class="li-sub">${esc(it.published || '')} ${it.arxivId ? '· arXiv:' + esc(it.arxivId) : ''} ${aiMark}</div>
      </div>
      <button class="li-star-btn ${starred ? 'on' : ''}" data-star="${esc(it.id)}" title="${starred ? '取消必引' : '标记必引'}">${ico(starred ? 'star' : 'starOff', 15)}</button>
      <span class="li-flag flag-${esc(status)}">${esc(status)}</span>
    </div>`;
  }
  function ideaItemHtml(it) {
    const type = it.type || 'idea';
    return `<div class="list-item ${it.id === S.selectedId ? 'active' : ''}" data-id="${esc(it.id)}" tabindex="0" aria-selected="${it.id === S.selectedId ? 'true' : 'false'}">
      <div class="li-icon">${ico(type === 'todo' ? 'checkSquare' : 'lightbulb', 15)}</div>
      <div class="li-main">
        <div class="li-title">${esc(it.title || it.id)}</div>
        <div class="li-sub">${esc(it.source || '未分类')}${Array.isArray(it.tags) && it.tags.length ? ' · ' + esc(it.tags.slice(0, 2).join(' / ')) : ''}</div>
      </div>
      <span class="li-flag idea-stage-chip">${esc(ideaStage(it))}</span>
    </div>`;
  }
  function expItemHtml(it) {
    const child = it.basedOn ? ' child' : '';
    // P1-2：沿 basedOn 链计算层级（限深 3、防环）；列表仍按日期倒序，不改变排序逻辑
    let depth = 0;
    let cur = it;
    const visited = new Set([it.id]);
    while (cur && cur.basedOn && depth < 3) {
      const parentId = String(cur.basedOn).trim();
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      const parent = S.items.find((x) => x.id === parentId || x.shortName === parentId || x.title === parentId);
      if (!parent) { depth++; break; }
      cur = parent;
      depth++;
    }
    const depthCls = depth > 0 ? ' depth-' + Math.min(depth, 3) : '';
    const depthMark = depth >= 2 ? `<span class="li-depth">L${depth}</span>` : '';
    const results = it.results && typeof it.results === 'object' ? it.results : {};
    const metrics = results.metrics && typeof results.metrics === 'object' ? results.metrics : {};
    const metricText = Object.keys(metrics).slice(0, 2).map((k) => `${k}=${String(metrics[k])}`).join(' · ');
    const tags = Array.isArray(it.tags) ? it.tags.slice(0, 2).map((t) => `<span class="li-tag">${esc(t)}</span>`).join('') : '';
    return `<div class="list-item timeline-item${child}${depthCls} ${it.id === S.selectedId ? 'active' : ''}" data-id="${esc(it.id)}" tabindex="0" aria-selected="${it.id === S.selectedId ? 'true' : 'false'}">
      <div class="li-icon">${ico('flask', 15)}</div>
      <div class="li-main">
        <div class="li-title">${depthMark}${esc(it.title || it.id)}</div>
        <div class="li-sub">${esc(it.date || '')}${it.priority ? ' · ' + esc(it.priority) : ''}${it.basedOn ? ' · 基于 ' + esc(it.basedOn) : ''}</div>
        ${metricText ? `<div class="li-sub li-metric">${esc(metricText)}</div>` : ''}
        ${tags ? `<div class="li-tags">${tags}</div>` : ''}
      </div>
      <span class="li-flag flag-${esc(it.status || '')}">${esc(it.status || '')}</span>
    </div>`;
  }

  function bindListEvents() {
    $('#listScroll').querySelectorAll('.list-item').forEach((el) => {
      el.addEventListener('click', async () => {
        S.selectedId = el.dataset.id;
        renderList();
        const again = $(`#listScroll .list-item[data-id="${CSS.escape(el.dataset.id)}"]`);
        if (again) again.focus({ preventScroll: true });
        await renderDetail();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
        if (e.key === 'F10' && e.shiftKey) {
          e.preventDefault();
          showItemMenu(el.dataset.id, e);
        }
      });
      el.addEventListener('dblclick', async (e) => {
        if (e.target.closest('[data-star]')) return;
        S.selectedId = el.dataset.id;
        await renderDetail();
        const detail = $('#paneDetail');
        if (detail) detail.scrollIntoView({ block: 'nearest' });
      });
      // D49 星标/必引：点击星标切换，不触发打开详情
      const starBtn = el.querySelector('[data-star]');
      if (starBtn) starBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleStar(el.dataset.id);
      });
      // 右键菜单
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); showItemMenu(el.dataset.id, e); });
      // 论文：整条悬停出摘要（不只是图标）
      if (S.board === 'papers') {
        el.addEventListener('mouseenter', (e) => { clearTimeout(hoverTimer); showHoverCard(e, el.dataset.id); });
        el.addEventListener('mouseleave', (e) => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { if (!cardHovered) hideHoverCard(); }, 220); });
        el.addEventListener('mousemove', positionHoverCard);
      }
    });
  }

  // ---------- 悬浮摘要（可停留、可交互） ----------
  let hoverTimer = null, cardHovered = false, hoverHideTimer = null;
  async function showHoverCard(e, id) {
    const item = await call('getItem', S.ws, 'papers', id);
    if (!item) return;
    const fm = item.frontmatter || {};
    const card = $('#hoverCard');
    // D45 状态双通道 + D48 溯源：悬浮窗顶部标注来源与必引状态
    const badge = `${fm.starred ? `<span class="hc-badge star">${ico('star', 11)}必引</span>` : ''}${fm.aiGenerated ? `<span class="hc-badge ai">${ico('sparkle', 11)}AI 生成·请核对原文</span>` : ''}`;
    card.innerHTML = `
      <div class="hc-title">${esc(fm.shortName || fm.title || id)}</div>
      ${badge ? `<div class="hc-badges">${badge}</div>` : ''}
      <div class="hc-body">${fm.summary ? esc(fm.summary) : '<span class="hc-empty">还没有摘要 — 生成 AI 笔记后会自动填充</span>'}</div>
      <div class="hc-foot">点击进入详情 · 摘要可复制</div>`;
    card.style.display = 'block';
    card.style.pointerEvents = 'auto';
    card.onmouseenter = () => { cardHovered = true; clearTimeout(hoverHideTimer); };
    card.onmouseleave = () => { cardHovered = false; hideHoverCard(); };
    card.onclick = async () => { hideHoverCard(); S.selectedId = id; renderList(); await renderDetail(); };
    positionHoverCard(e);
  }
  function positionHoverCard(e) {
    const card = $('#hoverCard');
    const list = $('#paneList');
    const listRect = list.getBoundingClientRect();
    card.style.width = Math.max(200, Math.min(300, listRect.width - 16)) + 'px';
    const rect = card.getBoundingClientRect();
    const minX = listRect.left + 8;
    const maxX = Math.max(minX, listRect.right - rect.width - 8);
    const preferredX = e.clientX > listRect.left + listRect.width / 2
      ? e.clientX - rect.width - 16
      : e.clientX + 16;
    const belowY = e.clientY + 10;
    const preferredY = belowY + rect.height <= window.innerHeight - 8
      ? belowY
      : e.clientY - rect.height - 10;
    card.style.left = Math.max(minX, Math.min(maxX, preferredX)) + 'px';
    card.style.top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, preferredY)) + 'px';
  }
  function hideHoverCard() { $('#hoverCard').style.display = 'none'; $('#hoverCard').style.pointerEvents = 'none'; }

  // D49 星标/必引切换
  async function toggleStar(id) {
    const item = await call('getItem', S.ws, 'papers', id);
    if (!item) return;
    const fm = item.frontmatter || {};
    fm.starred = !fm.starred;
    await call('saveItem', S.ws, 'papers', id, { frontmatter: fm, body: item.body });
    await refreshItems();
    // 若正处于"必引"筛选且取消了星标，列表会自动更新
    toast(fm.starred ? '已标记必引 ★' : '已取消必引');
  }

  // ---------- 列表项右键菜单 ----------
  function showItemMenu(id, e) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu-pop'; m.id = 'menuPop';
    const label = S.board === 'papers' ? '论文' : S.board === 'ideas' ? '灵感' : '实验';
    const items = [
      { label: '打开 / 选中', act: 'open' },
      { label: '编辑', act: 'edit' },
      { label: '复制 ID', act: 'copyid' },
      { label: '删除', act: 'delete', danger: true }
    ];
    m.setAttribute('role', 'menu');
    m.innerHTML = `<div class="menu-title">${label} · ${esc(id)}</div>` + items.map((i) => `<button class="menu-item ${i.danger ? 'danger' : ''}" role="menuitem" data-act="${i.act}">${i.label}</button>`).join('');
    document.body.appendChild(m);
    const anchorEl = e && e.target && e.target.closest ? e.target.closest('[data-id]') : null;
    const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const cx = Number.isFinite(e && e.clientX) ? e.clientX : (rect ? rect.right : window.innerWidth - 180);
    const cy = Number.isFinite(e && e.clientY) ? e.clientY : (rect ? rect.top : 80);
    m.style.left = Math.min(cx, window.innerWidth - 170) + 'px';
    m.style.top = Math.min(cy, window.innerHeight - m.offsetHeight - 8) + 'px';
    m.addEventListener('click', async (ev) => {
      const item = ev.target.closest('[data-act]');
      if (!item) return;
      const act = item.dataset.act; closeMenu();
      const selectedItem = await call('getItem', S.ws, S.board, id);
      if (!selectedItem) return;
      if (act === 'open') { S.selectedId = id; renderList(); await renderDetail(); }
      else if (act === 'edit') { S.selectedId = id; await renderDetail(); if (S.board === 'papers') editPaper(selectedItem); else if (S.board === 'ideas') editIdea(selectedItem); else editExperiment(selectedItem); }
      else if (act === 'copyid') { try { await navigator.clipboard.writeText(id); toast('已复制 ID'); } catch (_) { toast(id); } }
      else if (act === 'delete') confirmDeleteItem(S.board, id);
    });
    m.addEventListener('keydown', (ev) => {
      const menuItems = Array.from(m.querySelectorAll('[role="menuitem"]'));
      const idx = menuItems.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); menuItems[(idx + 1) % menuItems.length]?.focus(); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); menuItems[(idx - 1 + menuItems.length) % menuItems.length]?.focus(); }
      if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
    });
    m.querySelector('[role="menuitem"]')?.focus();
  }

  // ---------- 详情路由 ----------
  async function renderDetail() {
    // DOM 即将重建：先释放所有 Chart.js 实例，杜绝 canvas 实例泄漏
    if (window.Charts) Charts.destroyAll();
    const root = $('#detailRoot');
    const empty = $('#detailEmpty');
    if (!S.selectedId) { root.innerHTML = ''; empty.style.display = 'flex'; return; }
    empty.style.display = 'none';
    const item = await call('getItem', S.ws, S.board, S.selectedId);
    if (!item) { root.innerHTML = '<div class="detail">条目不存在</div>'; return; }
    if (S.board === 'papers') await renderPaperDetail(root, item);
    else if (S.board === 'ideas') renderIdeaDetail(root, item);
    else renderExpDetail(root, item);
  }

      Object.assign(this, {
        renderWorkspaces, bindWorkspaceEvents, switchWorkspace, toggleWorkspaceBar,
        showWorkspaceMenu, closeMenu, showWorkspaceSwitcher, showNewWorkspace,
        showRenameWorkspace, showCopyWorkspace, confirmDeleteWorkspace, bindBoardEvents,
        switchBoard, renderBoard, refreshItems, buildToolbar,
        bindFilterRow, filteredItems, renderList, paperItemHtml,
        ideaItemHtml, expItemHtml, bindListEvents, showHoverCard,
        positionHoverCard, hideHoverCard, toggleStar, showItemMenu,
        renderDetail
      });
    }
  }
  namespace.WorkspaceController = WorkspaceController;
})();
