(() => {
  const namespace = window.ResearchWorkbench;
  class OverlayController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { bindDropZone, init, applyUiPrefs, setTheme, clearCharts, renderWorkspaces, bindWorkspaceEvents, switchWorkspace, closeMenu, showWorkspaceSwitcher, bindBoardEvents, switchBoard, renderBoard, refreshItems, renderList, hideHoverCard, renderDetail, batchGenerateNotes, createIdea, createExperiment, bindRefClicks, importPdfs, showSettings, showDiscovery, showTimeline } = context.actions;
  function openModal(title, bodyHtml, onReady, cls = '') {
    const root = $('#modalRoot');
    S.modalTrigger = document.activeElement;
    root.innerHTML = `<div class="modal-mask"></div><div class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-title"><span>${esc(title)}</span><button class="icon-btn modal-close" type="button" aria-label="关闭">${ico('close', 15)}</button></div><div class="modal-body">${bodyHtml}</div></div>`;
    root.classList.add('show');
    root.querySelector('.modal-mask').addEventListener('click', closeModal);
    root.querySelector('.modal-close').addEventListener('click', closeModal);
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    const modal = root.querySelector('.modal');
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    if (onReady) onReady(modal);
    requestAnimationFrame(() => {
      const autofocus = modal.querySelector('[autofocus]');
      const focusable = modal.querySelector('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])');
      (autofocus || focusable || root.querySelector('.modal-close'))?.focus();
    });
  }
  function closeModal() {
    const root = $('#modalRoot');
    root.classList.remove('show');
    root.innerHTML = '';
    clearCharts();
    if (window.Timeline) Timeline.destroy();
    const ratingPop = $('#ratingPopover');
    if (ratingPop) ratingPop.remove();
    const timelinePop = $('#timelinePopover');
    if (timelinePop) timelinePop.remove();
    if (S.modalTrigger && typeof S.modalTrigger.focus === 'function') {
      const trigger = S.modalTrigger;
      S.modalTrigger = null;
      requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus(); });
    }
  }

  // ---------- 命令面板 / 快捷键帮助（D54 可发现性） ----------
  function newCurrentItem() {
    if (S.board === 'ideas') createIdea(S.statusFilter === 'todo' ? 'todo' : 'idea');
    else if (S.board === 'experiments') createExperiment();
    else if (S.board === 'papers') importPdfs();
    else if (S.board === 'timeline') $('#tlFocus')?.focus();
    else $('#discoveryQuery')?.focus();
  }

  function buildCommands() {
    const cmds = [];
    S.wsList.forEach((w) => cmds.push({
      icon: 'layers', label: w, hint: '切换工作区', group: '工作区',
      run: () => switchWorkspace(w)
    }));
    [
      ['papers', '论文', 'fileText'],
      ['discovery', '论文检索', 'search'],
      ['timeline', '论文脉络', 'timeline'],
      ['ideas', 'Idea 灵感', 'lightbulb'],
      ['experiments', '实验', 'flask']
    ].forEach(([b, label, name]) => cmds.push({
      icon: name, label: '前往 ' + label, hint: '切换板块', group: '导航',
      run: () => switchBoard(b)
    }));
    cmds.push(
      { icon: 'network', label: '论断中心', hint: '论断 ↔ 证据网络', group: '导航', run: () => showClaimCenter() },
      { icon: 'stats', label: '工作区统计', hint: '阅读状态 / 增长', group: '导航', run: () => showStatsPanel() },
      { icon: 'search', label: '论文检索', hint: '独立界面 · OpenAlex', group: '导航', run: () => showDiscovery() }
    );
    S.items.forEach((it) => {
      const name = S.board === 'papers' ? 'fileText' : S.board === 'ideas' ? 'lightbulb' : 'flask';
      cmds.push({
        icon: name, label: it.shortName || it.title || it.id, hint: '打开条目', group: '当前板块',
        run: () => { S.selectedId = it.id; hideHoverCard(); renderList(); renderDetail(); }
      });
    });
    cmds.push(
      { icon: 'plus', label: '新建条目', hint: 'Ctrl+N', group: '操作', run: () => newCurrentItem() },
      { icon: 'upload', label: '导入 PDF', hint: '论文板块', group: '操作', run: () => importPdfs() },
      { icon: 'sparkle', label: 'AI 批量生成笔记', hint: '论文板块', group: '操作', run: () => batchGenerateNotes() },
      { icon: (S.cfg.ui && S.cfg.ui.theme) === 'neo' ? 'sun' : 'moon', label: '切换主题', hint: '经典 / 霓虹', group: '操作', run: () => $('#themeToggleBtn').click() },
      { icon: 'focus', label: '专注模式', hint: 'Esc 退出', group: '操作', run: () => toggleFocus(true) },
      { icon: 'keyboard', label: '快捷键帮助', hint: 'Ctrl+/', group: '帮助', run: () => showShortcutHelp() }
    );
    return cmds;
  }

  let cmdkFiltered = [], cmdkIndex = 0;
  function showCommandPalette() {
    closeMenu(); closeModal(); hideHoverCard();
    const root = $('#cmdkRoot');
    const cmds = buildCommands();
    cmdkIndex = 0;
    root.innerHTML = `
      <div class="cmdk-mask"></div>
      <div class="cmdk">
        <div class="cmdk-search">${ico('search', 17)}<input id="cmdkInput" placeholder="搜索工作区、条目或命令…" autocomplete="off" spellcheck="false"></div>
        <div class="cmdk-list" id="cmdkList"></div>
        <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
      </div>`;
    root.classList.add('show');
    const input = root.querySelector('#cmdkInput');
    const listEl = root.querySelector('#cmdkList');
    const render = () => {
      const q = input.value.trim().toLowerCase();
      cmdkFiltered = cmds.filter((c) => !q || (c.label + ' ' + c.hint + ' ' + c.group).toLowerCase().includes(q));
      if (cmdkIndex >= cmdkFiltered.length) cmdkIndex = 0;
      listEl.innerHTML = cmdkFiltered.length
        ? cmdkFiltered.map((c, i) => `
            <div class="cmdk-item ${i === cmdkIndex ? 'active' : ''}" data-i="${i}">
              <span class="ci-ico">${ico(c.icon, 16)}</span>
              <span class="ci-label">${esc(c.label)}</span>
              <span class="ci-group">${esc(c.group)}</span>
            </div>`).join('')
        : `<div class="cmdk-empty">没有匹配的命令</div>`;
      const active = listEl.querySelector('.cmdk-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    };
    const exec = (i) => {
      const c = cmdkFiltered[i];
      closeCmdk();
      if (c) setTimeout(() => { try { c.run(); } catch (e) { toast(e.message, true); } }, 30);
    };
    input.addEventListener('input', () => { cmdkIndex = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdkFiltered.length) cmdkIndex = (cmdkIndex + 1) % cmdkFiltered.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdkFiltered.length) cmdkIndex = (cmdkIndex - 1 + cmdkFiltered.length) % cmdkFiltered.length; render(); }
      else if (e.key === 'Enter') { e.preventDefault(); exec(cmdkIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
    });
    listEl.addEventListener('click', (e) => {
      const it = e.target.closest('[data-i]');
      if (it) exec(Number(it.dataset.i));
    });
    root.querySelector('.cmdk-mask').addEventListener('click', closeCmdk);
    render();
    setTimeout(() => input.focus(), 0);
  }
  function closeCmdk() {
    const root = $('#cmdkRoot');
    root.classList.remove('show');
    root.innerHTML = '';
  }

  /** 论断中心（D50 + M3 极性升级）：以 Idea 为论断节点，聚合支撑/反驳/待检验实验极性与引用网络。 */
  function showClaimCenter() {
    if (window.Charts) Charts.destroyAll();
    openModal('论断中心（假设 ↔ 证据极性网络）', '<div class="hint">正在汇总引用图与实验证据极性…</div>', async (root) => {
      let graph, expItems = [];
      try {
        [graph, expItems] = await Promise.all([
          call('getRefGraph', S.ws),
          call('listItems', S.ws, 'experiments').catch(() => [])
        ]);
      } catch (e) {
        root.innerHTML = `<div class="chart-empty">${ico('network', 18)}<span>载入失败：${esc(e.message)}</span></div>`;
        return;
      }
      const expMap = new Map((expItems || []).map((ex) => [ex.id, ex]));
      const classifyExp = (ex) => {
        if (!ex) return 'untested';
        const v = String(ex.keepDecision || ex.verdict || '').toLowerCase();
        const st = String(ex.status || '');
        const c = String(ex.conclusion || '');
        if (v.includes('discard') || st === '失败' || /推翻|不支持|退化|无效/i.test(c)) return 'contradicts';
        if (v.includes('keep') || (st === '完成' && !/失败|退化/i.test(c))) return 'supports';
        return 'untested';
      };
      const polLabel = { supports: '支持', contradicts: '反驳', untested: '待检验' };

      const claims = (graph.claims || []).map((c) => {
        const linkedExps = [].concat(c.in || [], c.out || []).filter((l) => l.board === 'experiments');
        const polCounts = { supports: 0, contradicts: 0, untested: 0 };
        linkedExps.forEach((l) => { polCounts[classifyExp(expMap.get(l.id))]++; });
        const overall = polCounts.contradicts > 0 && polCounts.supports === 0 ? 'contradicts'
          : polCounts.supports > 0 ? 'supports' : 'untested';
        return { ...c, overall, polCounts };
      });
      const supportedCnt = claims.filter((c) => c.overall === 'supports').length;
      const contradictedCnt = claims.filter((c) => c.overall === 'contradicts').length;

      const ovCard = (num, label) => `<div class="ov-card"><div class="ov-num">${num}</div><div class="ov-label">${label}</div></div>`;
      const linkList = (list, emptyText) => (list && list.length)
        ? `<div class="claim-links">${list.map((l) => {
            const pol = l.board === 'experiments' ? classifyExp(expMap.get(l.id)) : '';
            const badge = pol ? `<span class="polarity-badge pol-${pol}">${polLabel[pol]}</span>` : '';
            return `<div class="claim-link" data-ref="${esc(l.id)}" data-board="${esc(l.board)}" tabindex="0"><span class="cl-ico">${ico(boardIcon(l.board), 13)}</span><span>${esc(l.label)}</span>${badge}<span class="cl-via">${esc(l.via)}</span></div>`;
          }).join('')}</div>`
        : `<div class="hint">${emptyText}</div>`;
      const cards = claims.map((c) => `<div class="claim-card">
          <div class="claim-card-head">
            <span class="cl-ico">${ico('lightbulb', 15)}</span>
            <span class="cc-title">${esc(c.label)}</span>
            <span class="polarity-badge pol-${c.overall}">${polLabel[c.overall]}</span>
            <span class="status-chip">${esc(c.status || '未标注')}</span>
          </div>
          <div class="claim-sec-title">支撑证据（${c.out.length}）</div>
          ${linkList(c.out, '暂无支撑证据，正文用 [[论文]] / [[exp-001]] 引用或在 Idea 中关联支撑文献即可建立')}
          <div class="claim-sec-title">引用它的实验与条目（${c.in.length}）</div>
          ${linkList(c.in, '暂无关联实验或来源引用')}
        </div>`).join('');
      root.innerHTML = `
        <div class="claim-overview">
          ${ovCard(claims.length, '论断（Idea）')}
          ${ovCard(supportedCnt, '已有支持证据')}
          ${ovCard(contradictedCnt, '已被反驳/需修正')}
          ${ovCard(graph.linkCount || 0, '证据链接')}
          ${ovCard(graph.orphanCount || 0, '孤立论断')}
        </div>
        ${cards || `<div class="chart-empty">${ico('network', 18)}<span>当前工作区还没有 Idea。新建一条灵感并在正文用 [[...]] 引用论文或实验，即可形成论断网络。</span></div>`}`;
      await bindRefClicks(root, { closeModalOnJump: true });
    }, 'wide');
  }

  /** 工作区统计：本地 md 聚合 → 概览卡 + 4 图，双主题配色来自 Charts.palette()。 */
  function showStatsPanel() {
    if (window.Charts) Charts.destroyAll();
    openModal('工作区统计', '<div class="hint">正在统计本地数据…</div>', async (root) => {
      let papers = [], ideas = [], experiments = [];
      try {
        [papers, ideas, experiments] = await Promise.all(['papers', 'ideas', 'experiments'].map((b) => call('listItems', S.ws, b)));
      } catch (e) {
        root.innerHTML = `<div class="chart-empty">${ico('stats', 18)}<span>统计失败：${esc(e.message)}</span></div>`;
        return;
      }
      // 图表颜色一律由 charts.js 按色板索引取色，不在此处硬编码，切主题自动换值
      const ovCard = (num, label) => `<div class="ov-card"><div class="ov-num">${num}</div><div class="ov-label">${label}</div></div>`;
      const statusOrder = ['待读', '在读', '已读', '精读', '归档'];
      const statusCounts = statusOrder.map((s) => papers.filter((i) => (i.status || '待读') === s).length);

      const monthSet = new Set();
      [papers, ideas, experiments].forEach((list) => list.forEach((i) => {
        const m = String(i.createdAt || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(m)) monthSet.add(m);
      }));
      const months = Array.from(monthSet).sort().slice(-12);
      const countByMonth = (list) => months.map((m) => list.filter((i) => String(i.createdAt || '').slice(0, 7) === m).length);
      const growthSeries = [
        { label: '论文', data: countByMonth(papers) },
        { label: 'Idea', data: countByMonth(ideas) },
        { label: '实验', data: countByMonth(experiments) }
      ];

      const expMonthSet = new Set();
      experiments.forEach((i) => {
        const m = String(i.date || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(m)) expMonthSet.add(m);
      });
      const expMonths = Array.from(expMonthSet).sort().slice(-12);
      const expCounts = expMonths.map((m) => experiments.filter((i) => String(i.date || '').slice(0, 7) === m).length);
      const expStatuses = ['计划中', '进行中', '完成', '失败'];
      const expStatusCounts = expStatuses.map((s) => experiments.filter((i) => (i.status || '') === s).length);
      const starred = papers.filter((i) => !!i.starred).length;

      const mini = (title, canvasId, hasData) => `<div class="chart-mini"><div class="cm-title">${title}</div>${hasData
        ? `<div class="chart-canvas-wrap"><canvas id="${canvasId}" data-chart-key="${canvasId}"></canvas></div>`
        : `<div class="chart-empty">${ico('chart', 16)}<span>暂无数据</span></div>`}</div>`;
      root.innerHTML = `
        <div class="stat-overview">
          ${ovCard(papers.length, '论文')}${ovCard(ideas.length, 'Idea')}${ovCard(experiments.length, '实验')}${ovCard(starred, '必引论文')}
        </div>
        <div class="modal-pane-title">分布与增长</div>
        <div class="stat-grid">
          ${mini('论文五态分布', 'statCanvasStatus', papers.length > 0)}
          ${mini('三板块月度增长', 'statCanvasGrowth', months.length > 0)}
          ${mini('实验时间线', 'statCanvasExp', expMonths.length > 0)}
          ${mini('实验状态占比', 'statCanvasExpStatus', experiments.length > 0)}
        </div>`;
      if (!window.Charts) return;
      const renderMini = (canvasId, key, labels, series, kind) => {
        const canvas = root.querySelector('#' + canvasId);
        if (!canvas) return;
        canvas._statState = { key: key, labels: labels, series: series, kind: kind };
        Charts.renderSimple(key, canvas, labels, series, kind);
      };
      renderMini('statCanvasStatus', 'stats:status', statusOrder, [{ label: '论文数', data: statusCounts }], 'bar');
      renderMini('statCanvasGrowth', 'stats:growth', months, growthSeries, 'line');
      // colorIndex:3 保留原「实验时间线」琥珀色，同时让切主题时按色板索引重取色
      renderMini('statCanvasExp', 'stats:exp', expMonths, [{ label: '实验数', data: expCounts, colorIndex: 3 }], 'bar');
      renderMini('statCanvasExpStatus', 'stats:expStatus', expStatuses,
        expStatuses.map((s, i) => ({ label: s, data: [expStatusCounts[i]] })), 'doughnut');
    }, 'wide');
  }

  function showShortcutHelp() {
    const rows = [
      ['Ctrl + K', '命令面板 · 快速跳转工作区 / 条目 / 命令'],
      ['Ctrl + F', '聚焦当前板块搜索框'],
      ['Ctrl + N', '在当前板块新建条目'],
      ['Ctrl + /', '打开快捷键帮助'],
      ['Alt + 1 / 2 / 3 / 4 / 5', '切换检索 / 论文 / 论文脉络 / Idea / 实验板块'],
      ['↑ / ↓', '在列表中键盘导航'],
      ['Enter', '打开当前选中的条目'],
      ['Esc', '关闭弹窗 / 退出专注模式']
    ];
    openModal('快捷键', `
      <div class="shortcut-grid">
        ${rows.map(([k, d]) => `<div class="sc-row"><span class="sc-key">${k.split(' + ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' + ')}</span><span class="sc-desc">${esc(d)}</span></div>`).join('')}
      </div>
      <div class="hint" style="margin-top:12px">Ctrl + K → 搜索「论断中心」：打开论断 ↔ 证据网络视图</div>
      <div class="hint" style="margin-top:4px">Ctrl + K → 搜索「工作区统计」：打开阅读状态与增长概览（也可点顶栏图表按钮）</div>
      <div class="hint" style="margin-top:4px">论文检索现为独立板块；Idea 支持快速捕获、阶段整理和关联实验</div>
      <div class="hint" style="margin-top:16px">提示：各栏之间的分隔条都可以拖拽调整宽度；论文详情右侧属性栏也可拖拽。</div>
      <div class="modal-actions"><button class="btn" data-close>知道了</button></div>
    `);
  }

  // ---------- 全局绑定 ----------
  function bindGlobal() {
    bindWorkspaceEvents();
    bindBoardEvents();
    bindDropZone($('#paneList'), {
      onFiles: async (paths) => {
        if (S.board === 'papers') {
          const created = await call('importPdfs', S.ws, paths);
          toast(`已拖拽上传 ${created.length} 篇论文`);
          await refreshItems();
        } else if (S.board === 'experiments') {
          if (!S.selectedId) throw new Error('请先选择或创建一个实验');
          const names = await call('importDataFiles', S.ws, S.selectedId, paths);
          toast(`已上传 ${names.length} 个实验文件`);
          await renderDetail();
        } else {
          throw new Error('灵感板块暂无文件上传区域');
        }
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (!e.target.closest('.drop-zone')) e.preventDefault();
    });
    $('#settingsBtn').addEventListener('click', showSettings);
    const statsBtn = $('#statsBtn');
    if (statsBtn) statsBtn.addEventListener('click', showStatsPanel);
    $('#cmdBtn').addEventListener('click', showCommandPalette);
    $('#wsSwitchBtn').addEventListener('click', showWorkspaceSwitcher);
    $('#helpBtn').addEventListener('click', showShortcutHelp);
    $('#themeToggleBtn').addEventListener('click', async () => {
      const next = (S.cfg.ui && S.cfg.ui.theme) === 'neo' ? 'classic' : 'neo';
      await setTheme(next);
      toast(next === 'neo' ? '已切换：炫酷主题' : '已切换：简约主题');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ws-menu') && !e.target.closest('#menuPop')) closeMenu();
      // 点击列表外区域时隐藏悬浮窗
      if (!e.target.closest('#hoverCard') && !e.target.closest('.list-item')) hideHoverCard();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.getElementById('app').classList.contains('focus-mode')) { toggleFocus(false); return; }
        closeModal(); closeMenu(); closeCmdk(); hideHoverCard();
      }
      // Ctrl+K 命令面板
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); showCommandPalette(); return;
      }
      // Ctrl+/ 快捷键帮助
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault(); showShortcutHelp(); return;
      }
      // Alt+1..5 切换板块
      if (e.altKey && ['1', '2', '3', '4', '5'].includes(e.key)) {
        e.preventDefault(); switchBoard(['discovery', 'papers', 'timeline', 'ideas', 'experiments'][Number(e.key) - 1]); return;
      }
      // Ctrl+F 聚焦搜索
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const s = S.board === 'discovery' ? $('#discoveryQuery') : S.board === 'timeline' ? $('#tlFocus') : $('#searchInput');
        if (s) { s.focus(); s.select(); }
      }
      // Ctrl+N 新建当前板块条目
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newCurrentItem();
      }
    });

    // 列表键盘导航：↑↓ 移动、Enter 打开（焦点在列表项上）
    $('#listScroll').addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      const items = $$('#listScroll .list-item');
      if (!items.length) return;
      let idx = items.findIndex((el) => el.classList.contains('active'));
      if (e.key === 'Enter') { if (idx >= 0) items[idx].click(); return; }
      e.preventDefault();
      idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      const target = items[Math.max(0, idx)];
      target.scrollIntoView({ block: 'nearest' });
      target.click();
    });

    // 列表栏收起（单一按钮）
    $('#listToggleBtn').addEventListener('click', () => setListCollapsed(!document.getElementById('app').classList.contains('list-collapsed')));
    $('#listRail').addEventListener('click', () => setListCollapsed(false));

    // 专注模式（详情通到顶部）
    $('#focusToggleBtn').addEventListener('click', () => toggleFocus(!document.getElementById('app').classList.contains('focus-mode')));

    // 窗口控制
    $('#winMinBtn').addEventListener('click', () => window.bridge.win.minimize());
    $('#winMaxBtn').addEventListener('click', () => window.bridge.win.maximize());
    $('#winCloseBtn').addEventListener('click', () => window.bridge.win.close());

    // 拖拽调整列表栏宽度（范围宽松，避免论文详情被挤窄）
    dragResize($('#paneResizer'), (px) => {
      document.getElementById('app').style.setProperty('--list-w', px + 'px');
    }, () => curVar('--list-w', 340), 240, 900, 'listWidth',
    () => columnResizeBounds('list', 240, 900));
    // 拖拽调整工作区栏宽度
    dragResize($('#wsWidthHandle'), (px) => {
      document.getElementById('app').style.setProperty('--ws-w', px + 'px');
    }, () => curVar('--ws-w', 224), 150, 420, 'wsWidth',
    () => columnResizeBounds('workspace', 150, 420));
    window.addEventListener('resize', () => {
      applyColumnWidths(curVar('--ws-w', 224), curVar('--list-w', 340));
    });

    window.bridge.app.dataRoot().then((r) => (S._dataRoot = r));
  }

  async function setListCollapsed(next) {
    document.getElementById('app').classList.toggle('list-collapsed', next);
    applyColumnWidths(curVar('--ws-w', 224), curVar('--list-w', 340));
    S.cfg = await call('updateConfig', { ui: { listCollapsed: next } });
  }
  function toggleFocus(on) {
    document.getElementById('app').classList.toggle('focus-mode', on);
    const btn = $('#focusToggleBtn');
    if (btn) btn.title = on ? '退出最大化' : '最大化详情（通到顶部）';
    if (on) hideHoverCard();
  }
  function curVar(name, fallback) {
    const v = parseInt(document.getElementById('app').style.getPropertyValue(name));
    return isNaN(v) ? fallback : v;
  }
  function columnBudget() {
    const app = $('#app');
    const wsCollapsed = app.classList.contains('ws-collapsed');
    const listCollapsed = app.classList.contains('list-collapsed');
    const rails = (wsCollapsed ? 34 : 0) + (listCollapsed ? 32 : 0);
    const listHandle = listCollapsed ? 0 : 12;
    return app.clientWidth - rails - listHandle - 520;
  }
  function applyColumnWidths(requestedWs, requestedList) {
    const app = $('#app');
    const wsCollapsed = app.classList.contains('ws-collapsed');
    const listCollapsed = app.classList.contains('list-collapsed');
    const budget = columnBudget();
    let wsWidth = curVar('--ws-w', Number(requestedWs) || 224);
    let listWidth = curVar('--list-w', Number(requestedList) || 340);
    if (!wsCollapsed) {
      const maxWs = Math.max(150, Math.min(420, budget - (listCollapsed ? 0 : 240)));
      wsWidth = Math.max(150, Math.min(maxWs, Number(requestedWs) || wsWidth));
    }
    if (!listCollapsed) {
      const maxList = Math.max(240, Math.min(900, budget - (wsCollapsed ? 0 : wsWidth)));
      listWidth = Math.max(240, Math.min(maxList, Number(requestedList) || listWidth));
    }
    app.style.setProperty('--ws-w', wsWidth + 'px');
    app.style.setProperty('--list-w', listWidth + 'px');
  }
  function columnResizeBounds(kind, min, max) {
    const app = $('#app');
    const wsCollapsed = app.classList.contains('ws-collapsed');
    const listCollapsed = app.classList.contains('list-collapsed');
    const budget = columnBudget();
    const otherWidth = kind === 'workspace'
      ? (listCollapsed ? 0 : curVar('--list-w', 340))
      : (wsCollapsed ? 0 : curVar('--ws-w', 224));
    return { min, max: Math.max(min, Math.min(max, budget - otherWidth)) };
  }
  function dragResize(handle, apply, getStart, min, max, persistKey, getBounds) {
    if (!handle) return;
    const bounds = () => getBounds ? getBounds() : { min, max };
    const updateAria = (value) => {
      const range = bounds();
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
      handle.setAttribute('aria-valuenow', String(Math.round(value)));
    };
    handle.setAttribute('role', 'separator');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', persistKey === 'listWidth' ? '调整列表栏宽度' : '调整工作区栏宽度');
    updateAria(getStart());
    handle.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const pointerId = e.pointerId;
      document.body.classList.add(persistKey === 'listWidth' ? 'is-resizing-list' : 'is-resizing-workspace');
      const startX = e.clientX, startW = getStart();
      const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        const range = bounds();
        const next = Math.max(range.min, Math.min(range.max, startW + ev.clientX - startX));
        apply(next);
        updateAria(next);
      };
      const up = async (ev) => {
        if (ev.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-resizing-list', 'is-resizing-workspace');
        if (persistKey) {
          const cur = parseInt(document.getElementById('app').style.getPropertyValue('--' + (persistKey === 'listWidth' ? 'list' : 'ws') + '-w')) || startW;
          try {
            S.cfg = await call('updateConfig', { ui: { [persistKey]: cur } });
          } catch (error) {
            toast('保存栏宽度失败：' + error.message, true);
          }
        }
      };
      handle.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', async (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const range = bounds();
      let next = getStart();
      if (e.key === 'ArrowLeft') next -= 24;
      if (e.key === 'ArrowRight') next += 24;
      if (e.key === 'Home') next = range.min;
      if (e.key === 'End') next = range.max;
      next = Math.max(range.min, Math.min(range.max, next));
      apply(next);
      updateAria(next);
      if (persistKey) {
        try {
          S.cfg = await call('updateConfig', { ui: { [persistKey]: next } });
        } catch (error) {
          toast('保存栏宽度失败：' + error.message, true);
        }
      }
    });
  }

  async function refreshAll() {
    const d = await call('init');
    S.cfg = d.config;
    S.wsList = d.workspaces;
    S.ws = S.cfg.currentWorkspace || S.wsList[0];
    S.skills = await call('listSkills');
    S.selectedId = null;
    S.search = '';
    S.statusFilter = '';
    applyUiPrefs();
    await renderWorkspaces();
    await renderBoard();
  }

      Object.assign(this, {
        openModal, closeModal, newCurrentItem, buildCommands,
        showCommandPalette, closeCmdk, showClaimCenter, showStatsPanel,
        showShortcutHelp, bindGlobal, setListCollapsed, toggleFocus,
        curVar, columnBudget, applyColumnWidths, columnResizeBounds,
        dragResize, refreshAll
      });
    }
  }
  namespace.OverlayController = OverlayController;
})();
