(() => {
  const namespace = window.ResearchWorkbench;
  class DiscoveryController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { switchBoard, renderBoard, refreshItems, bindRefClicks, openModal, closeModal } = context.actions;
  // ---------- v3/v4：多源前沿论文检索 / 内嵌 GitHub Skills / 评级 / 入库 / 时间脉络 ----------
  const fmtCites = (n) => (Number(n) || 0).toLocaleString('en-US');
  const fmtCompact = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    return String(v);
  };
  const ALL_SOURCE_OPTIONS = [
    { id: 'openalex', label: 'OpenAlex', tip: '全学科主库 · 引用量与引文关系' },
    { id: 'arxiv', label: 'arXiv', tip: '最新预印本 · 直连 PDF 与学科分类' },
    { id: 'openreview', label: 'OpenReview', tip: 'ICLR / NeurIPS / ICML / CoRL 录用核验' },
    { id: 'huggingface', label: 'HF Papers', tip: '社区前沿热度 · GitHub 代码与 Stars' },
    { id: 'crossref', label: 'Crossref', tip: '正式出版物 DOI 与期刊载体' },
    { id: 'semanticscholar', label: 'Semantic Scholar', tip: '高影响力引用与 TLDR（可选填 Key）' }
  ];
  const SOURCE_LABEL_MAP = Object.fromEntries(ALL_SOURCE_OPTIONS.map((o) => [o.id, o.label]));

  function showDiscovery() { return switchBoard('discovery'); }

  async function loadSearchSkillsIfNeeded(force = false) {
    if (!force && Array.isArray(S.discoverySkills) && S.discoverySkills.length) return S.discoverySkills;
    try {
      const list = await svc('openalex', 'listSearchSkills');
      S.discoverySkills = Array.isArray(list) ? list : [];
      if (S.discoverySkills.length && !S.discoverySkills.some((sk) => sk.id === S.discoverySkillId)) {
        S.discoverySkillId = S.discoverySkills[0].id;
      }
    } catch (_) {
      S.discoverySkills = [];
    }
    return S.discoverySkills;
  }

  function currentSearchSkill() {
    return (S.discoverySkills || []).find((sk) => sk.id === S.discoverySkillId) || null;
  }

  function applySearchSkillPreset(skill) {
    if (!skill) return;
    if (Array.isArray(skill.defaultSources) && skill.defaultSources.length) {
      S.discoverySources = skill.defaultSources.slice();
    }
    if (skill.defaultSort) S.discoverySort = skill.defaultSort;
    S.discoveryAiScreening = Boolean(skill.enableRcsScreening);
    if (Number(skill.recentYears) > 0) {
      const curYear = new Date().getUTCFullYear();
      S.discoveryFilters.yearFrom = String(curYear - Number(skill.recentYears) + 1);
      S.discoveryFilters.yearTo = '';
    } else if (S.discoveryFilters && S.discoveryFilters._fromSkill) {
      S.discoveryFilters.yearFrom = '';
    }
    S.discoveryFilters._fromSkill = Number(skill.recentYears) > 0;
  }

  function activeFilterCount() {
    const f = S.discoveryFilters || {};
    let n = 0;
    if (f.yearFrom || f.yearTo) n++;
    if (Number(f.minCitations) > 0) n++;
    if (f.peerReviewedOnly) n++;
    if (f.hasCodeOnly) n++;
    if (f.hasPdfOnly) n++;
    if (f.hideDuplicates) n++;
    if (S.discoveryAiScreening) n++;
    return n;
  }

  function renderDiscoveryBoard() {
    const root = $('#discoveryPage');
    const oaCfg = S.cfg.openalex || {};
    const uiCfg = S.cfg.ui || {};
    if (!S.discoveryCount) S.discoveryCount = Number(oaCfg.perPage) || 20;
    if (!S.discoveryFilters) {
      S.discoveryFilters = { yearFrom: '', yearTo: '', minCitations: '', peerReviewedOnly: false, hasCodeOnly: false, hasPdfOnly: false, hideDuplicates: false };
    }
    if (S.discoveryMeta && S.discoveryMeta._ws && S.discoveryMeta._ws !== S.ws) {
      S.discoveryMeta = null;
      S.discoveryExpandedAbstracts = new Set();
    }
    const searchRatio = Math.max(25, Math.min(65, Number(uiCfg.discoverySearchRatio) || 40));
    const curYear = new Date().getUTCFullYear();
    const f = S.discoveryFilters;
    const filterBadge = activeFilterCount();
    const skill = currentSearchSkill();

    root.innerHTML = `<div class="discovery-shell" style="--discovery-search-ratio:${searchRatio}%">
      <header class="discovery-hero">
        <div class="discovery-eyebrow-row">
          <div class="discovery-eyebrow">${ico('search', 14)} 前沿论文检索 · 多源联邦 &amp; GITHUB SKILLS</div>
          <div class="discovery-hero-actions">
            <button type="button" class="btn ghost sm" id="discoveryDailyBtn" title="直接拉取 Hugging Face 今日热门前沿论文">${ico('zap', 13)}今日前沿</button>
            <button type="button" class="btn ghost sm" id="discoveryManageSkillsBtn" title="查看内置 GitHub 检索 Skills 或导入新 Skill">${ico('book', 13)}检索 Skills</button>
          </div>
        </div>
        <div class="discovery-skill-bar" id="discoverySkillBar">
          ${renderSkillPillsHtml()}
        </div>
        <div class="discovery-query-row">
          <div class="discovery-query-box">
            <span class="discovery-query-icon">${ico('search', 18)}</span>
            <textarea id="discoveryQuery" rows="1" placeholder="描述你要找的前沿研究问题、方法架构或具体方向（支持中英文）…" autocomplete="off">${esc(S.discoveryQuery)}</textarea>
          </div>
          <button class="btn discovery-go" id="discoveryGo">${ico('search', 15)}检索</button>
        </div>
        <div class="discovery-composer-row">
          <span class="discovery-composer-hint">Enter 检索 · Shift+Enter 换行</span>
          <span class="discovery-skill-desc" id="discoverySkillDesc">${esc(skill ? skill.summary : '加载内置 GitHub 检索 Skills 中…')}</span>
        </div>
        <div class="discovery-options">
          <label>返回
            <select id="discoveryCount">${[10, 20, 50].map((n) => `<option value="${n}" ${n === Number(S.discoveryCount) ? 'selected' : ''}>${n} 篇</option>`).join('')}</select>
          </label>
          <label>排序
            <select id="discoverySort">
              <option value="frontier" ${S.discoverySort === 'frontier' ? 'selected' : ''}>前沿综合</option>
              <option value="relevance" ${S.discoverySort === 'relevance' ? 'selected' : ''}>相关度</option>
              <option value="velocity" ${S.discoverySort === 'velocity' ? 'selected' : ''}>引用增速</option>
              <option value="cited_by_count:desc" ${S.discoverySort === 'cited_by_count:desc' ? 'selected' : ''}>引用量优先</option>
              <option value="publication_date:desc" ${S.discoverySort === 'publication_date:desc' ? 'selected' : ''}>最新发表</option>
            </select>
          </label>
          <label class="discovery-ai-option"><input id="discoveryStrategy" type="checkbox" ${S.discoveryStrategy ? 'checked' : ''}>AI 扩展检索式（需配置模型）</label>
          <button type="button" class="btn ghost sm discovery-filter-toggle ${S.discoveryFiltersOpen ? 'is-open' : ''}" id="discoveryFilterToggle" aria-expanded="${S.discoveryFiltersOpen ? 'true' : 'false'}">
            ${ico('filter', 13)}数据源与筛选${filterBadge ? ` <span class="discovery-badge-count">${filterBadge}</span>` : ''}
          </button>
          <span class="discovery-source-note">模型配置可用时并行检索扩展词 · ${(S.discoverySources || []).map((id) => SOURCE_LABEL_MAP[id] || id).join(' / ')} · 入库前不改动论文库</span>
        </div>
        <div class="discovery-filter-drawer ${S.discoveryFiltersOpen ? 'is-open' : ''}" id="discoveryFilterDrawer">
          <div class="discovery-filter-group">
            <span class="discovery-filter-label">学术数据源</span>
            <div class="discovery-source-pills" id="discoverySourcePills">
              ${ALL_SOURCE_OPTIONS.map((opt) => `<label class="discovery-source-pill ${(S.discoverySources || []).includes(opt.id) ? 'active' : ''}" title="${esc(opt.tip)}">
                <input type="checkbox" data-src="${opt.id}" ${(S.discoverySources || []).includes(opt.id) ? 'checked' : ''}>
                <span>${esc(opt.label)}</span>
              </label>`).join('')}
            </div>
          </div>
          <div class="discovery-filter-row">
            <label class="discovery-filter-field"><span>发表年份</span>
              <input type="number" id="dfYearFrom" min="1950" max="${curYear + 1}" placeholder="起始" value="${esc(f.yearFrom || '')}">
              <span class="hint">—</span>
              <input type="number" id="dfYearTo" min="1950" max="${curYear + 1}" placeholder="截止" value="${esc(f.yearTo || '')}">
            </label>
            <div class="discovery-year-presets">
              <button type="button" data-year-span="1">近1年</button>
              <button type="button" data-year-span="2">近2年</button>
              <button type="button" data-year-span="3">近3年</button>
              <button type="button" data-year-span="0">不限</button>
            </div>
            <label class="discovery-filter-field"><span>最低引用</span>
              <input type="number" id="dfMinCites" min="0" placeholder="0" value="${esc(f.minCitations || '')}">
            </label>
          </div>
          <div class="discovery-filter-toggles">
            <label><input type="checkbox" id="dfPeerReviewed" ${f.peerReviewedOnly ? 'checked' : ''}>仅正式发表/同行评审</label>
            <label><input type="checkbox" id="dfHasCode" ${f.hasCodeOnly ? 'checked' : ''}>仅含开源代码</label>
            <label><input type="checkbox" id="dfHasPdf" ${f.hasPdfOnly ? 'checked' : ''}>仅含开放 PDF</label>
            <label><input type="checkbox" id="dfHideDup" ${f.hideDuplicates ? 'checked' : ''}>隐藏已在库</label>
            <label title="将当前工作区论文作为 AI 术语锚点及引文滚雪球种子"><input type="checkbox" id="dfWorkspaceSeeds" ${S.discoveryUseWorkspaceSeeds ? 'checked' : ''}>结合工作区论文上下文</label>
            <label title="调用 1 次批量模型对前 15 篇做 RCS 0-10 相关性打分与匹配理由"><input type="checkbox" id="dfAiScreen" ${S.discoveryAiScreening ? 'checked' : ''}>AI 相关性初筛 (RCS)</label>
          </div>
        </div>
        <div class="discovery-examples"><span>试试：</span>
          <button type="button" data-query="vision-language-action latent world model robot manipulation">VLA 隐式世界模型</button>
          <button type="button" data-query="robot learning from human video">机器人从人类视频学习</button>
          <button type="button" data-query="diffusion flow matching visuomotor policy">扩散/流匹配机器人策略</button>
          <button type="button" data-query="multimodal scientific discovery">多模态科学发现</button>
        </div>
        <div class="discovery-recent" id="discoveryRecent"></div>
      </header>
      <div class="discovery-splitter" id="discoverySplitter" title="拖动调整检索框与论文结果区比例"><span></span></div>
      <section class="discovery-results-panel">
        <div class="discovery-results-toolbar">
          <div>
            <div class="discovery-results-title">检索结果</div>
            <div class="discovery-results-summary" id="discoverySummary">选择检索 Skill 并描述研究问题，或点击「今日前沿」直接浏览最新热点。</div>
          </div>
          <div class="discovery-bulk-actions">
            <button class="btn ghost sm" id="discoveryExport" ${S.searchResults.length ? '' : 'disabled'} title="导出 BibTeX 或 Markdown 文献综述表">${ico('copy', 13)}导出引用</button>
            <label class="discovery-select-all"><input id="discoveryAll" type="checkbox" disabled> 全选本页</label>
            <button class="btn" id="discoveryImport" disabled>${ico('download', 14)}入库选中 <span id="discoveryPicked">0</span></button>
          </div>
        </div>
        <div id="discoveryPlanBar"></div>
        <div id="discoveryPostFilters"></div>
        <div id="discoveryResults"><div class="discovery-empty">
          <div class="discovery-empty-icon">${ico('search', 26)}</div>
          <h2>从前沿问题或 GitHub 检索 Skill 开始</h2>
          <p>支持多源联邦检索（OpenAlex · arXiv · OpenReview · Hugging Face Papers · Crossref · Semantic Scholar），自动跨源去重、校对顶会录用状态并标出开源代码与引用增速。</p>
        </div></div>
      </section>
    </div>`;

    renderDiscoveryRecent(root);
    bindDiscoveryEvents(root);
    if (S.searchResults.length) {
      renderDiscoveryPlan(root);
      renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
    }
    bindDiscoverySplitter(root);
    syncDiscoveryHeroFit(root);
    requestAnimationFrame(() => syncDiscoveryHeroFit(root));

    if (!Array.isArray(S.discoverySkills) || !S.discoverySkills.length) {
      loadSearchSkillsIfNeeded().then(() => {
        if (S.board !== 'discovery') return;
        const bar = root.querySelector('#discoverySkillBar');
        if (bar) {
          bar.innerHTML = renderSkillPillsHtml();
          bindSkillPillClicks(root);
        }
        const activeSkill = currentSearchSkill();
        const desc = root.querySelector('#discoverySkillDesc');
        if (desc && activeSkill) desc.textContent = activeSkill.summary;
        syncDiscoveryHeroFit(root);
        requestAnimationFrame(() => syncDiscoveryHeroFit(root));
      });
    }

    setTimeout(() => {
      if (!$('#modalRoot')?.classList.contains('show')) {
        root.querySelector('#discoveryQuery')?.focus();
      }
    }, 0);
  }

  function syncDiscoveryHeroFit(root) {
    const shell = root && root.querySelector('.discovery-shell');
    const hero = root && root.querySelector('.discovery-hero');
    const handle = root && root.querySelector('#discoverySplitter');
    if (!shell || !hero || !handle) return;
    const style = getComputedStyle(shell);
    const available = Math.max(1, shell.clientHeight - handle.offsetHeight -
      (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
    const uiCfg = S.cfg.ui || {};
    const savedRatio = Math.max(25, Math.min(65, Number(uiCfg.discoverySearchRatio) || 40));
    const maxRatio = Math.min(65, Math.floor(100 - 180 / available * 100));
    // 根据内容自然高度自动避免首屏或筛选抽屉展开时裁切，且不覆盖用户持久化偏好
    const neededPx = hero.scrollHeight + 4;
    const neededRatio = Math.ceil((neededPx / available) * 100);
    const effective = S.discoveryFiltersOpen
      ? Math.min(maxRatio, Math.max(savedRatio, neededRatio))
      : Math.min(maxRatio, Math.max(savedRatio, Math.min(neededRatio, 46)));
    shell.style.setProperty('--discovery-search-ratio', effective + '%');
    handle.setAttribute('aria-valuenow', String(Math.round(effective)));
  }

  function sortDiscoveryResultsInPlace(sortMode) {
    if (!Array.isArray(S.searchResults) || S.searchResults.length < 2) return;
    const selectedPapers = new Set(Array.from(S.selection).map((i) => S.searchResults[i]).filter(Boolean));
    const expandedPapers = new Set(Array.from(S.discoveryExpandedAbstracts || []).map((i) => S.searchResults[i]).filter(Boolean));
    const mode = String(sortMode || 'frontier');
    S.searchResults.sort((a, b) => {
      if (mode === 'cited_by_count:desc') {
        return (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0) || ((Number(b.frontierScore) || 0) - (Number(a.frontierScore) || 0));
      }
      if (mode === 'publication_date:desc') {
        return String(b.publicationDate || b.published || '').localeCompare(String(a.publicationDate || a.published || '')) || ((Number(b.frontierScore) || 0) - (Number(a.frontierScore) || 0));
      }
      if (mode === 'velocity') {
        return (Number(b.citationVelocity) || 0) - (Number(a.citationVelocity) || 0) || ((Number(b.frontierScore) || 0) - (Number(a.frontierScore) || 0));
      }
      if (mode === 'relevance') {
        if (typeof a.rcsScore === 'number' && typeof b.rcsScore === 'number' && b.rcsScore !== a.rcsScore) {
          return b.rcsScore - a.rcsScore;
        }
        return (Number(b.rrfScore) || 0) - (Number(a.rrfScore) || 0) || ((Number(b.frontierScore) || 0) - (Number(a.frontierScore) || 0));
      }
      return ((Number(b.frontierScore) || 0) - (Number(a.frontierScore) || 0)) || ((Number(b.rrfScore) || 0) - (Number(a.rrfScore) || 0));
    });
    S.selection = new Set();
    S.discoveryExpandedAbstracts = new Set();
    S.searchResults.forEach((paper, idx) => {
      if (selectedPapers.has(paper)) S.selection.add(idx);
      if (expandedPapers.has(paper)) S.discoveryExpandedAbstracts.add(idx);
    });
  }

  function renderSkillPillsHtml() {
    const list = S.discoverySkills || [];
    if (!list.length) {
      return `<span class="discovery-skill-loading">正在加载内嵌 GitHub 检索 Skills…</span>`;
    }
    return `<span class="discovery-skill-label">${ico('sparkle', 12)}检索 Skill</span>` + list.map((sk) => {
      const active = sk.id === S.discoverySkillId;
      return `<button type="button" class="discovery-skill-pill ${active ? 'active' : ''}" data-skill-id="${esc(sk.id)}" title="${esc(sk.summary)}${sk.githubRepo ? '\n来源：' + sk.githubRepo : ''}">
        <span class="dsp-name">${esc(sk.name.split('·')[0].trim())}</span>
        <span class="dsp-badge">${esc(sk.badge || 'Skill')}</span>
      </button>`;
    }).join('');
  }

  function bindSkillPillClicks(root) {
    root.querySelectorAll('[data-skill-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.skillId;
        const skill = (S.discoverySkills || []).find((sk) => sk.id === id);
        if (!skill) return;
        S.discoverySkillId = id;
        applySearchSkillPreset(skill);
        renderDiscoveryBoard();
        toast(`已切换检索 Skill：${skill.name}`);
      });
    });
  }

  function bindDiscoveryEvents(root) {
    bindSkillPillClicks(root);
    const queryInput = root.querySelector('#discoveryQuery');
    resizeDiscoveryComposer(queryInput);
    queryInput.addEventListener('input', (e) => {
      S.discoveryQuery = e.target.value;
      resizeDiscoveryComposer(e.target);
    });
    queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        root.querySelector('#discoveryGo').click();
      }
    });

    root.querySelector('#discoveryGo').addEventListener('click', () => runDiscovery(root, queryInput.value.trim()));
    root.querySelector('#discoveryDailyBtn').addEventListener('click', () => runDailyFrontier(root));
    root.querySelector('#discoveryManageSkillsBtn').addEventListener('click', showSearchSkillsModal);
    root.querySelector('#discoveryExport').addEventListener('click', showExportModal);
    root.querySelector('#discoveryCount').addEventListener('change', (e) => { S.discoveryCount = Number(e.target.value) || 20; });
    root.querySelector('#discoverySort').addEventListener('change', (e) => {
      S.discoverySort = e.target.value;
      if (S.searchResults.length > 1) {
        sortDiscoveryResultsInPlace(S.discoverySort);
        renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
        const label = e.target.options && e.target.selectedIndex >= 0 ? e.target.options[e.target.selectedIndex].text : S.discoverySort;
        toast(`已按「${label}」重排当前结果；重新点击检索可全库重抓`);
      }
    });
    root.querySelector('#discoveryStrategy').addEventListener('change', (e) => { S.discoveryStrategy = e.target.checked; });
    root.querySelector('#discoveryFilterToggle').addEventListener('click', () => {
      S.discoveryFiltersOpen = !S.discoveryFiltersOpen;
      root.querySelector('#discoveryFilterDrawer')?.classList.toggle('is-open', S.discoveryFiltersOpen);
      const tgl = root.querySelector('#discoveryFilterToggle');
      if (tgl) {
        tgl.classList.toggle('is-open', S.discoveryFiltersOpen);
        tgl.setAttribute('aria-expanded', S.discoveryFiltersOpen ? 'true' : 'false');
      }
      syncDiscoveryHeroFit(root);
      requestAnimationFrame(() => syncDiscoveryHeroFit(root));
    });

    root.querySelectorAll('#discoverySourcePills input[data-src]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const picked = Array.from(root.querySelectorAll('#discoverySourcePills input[data-src]:checked')).map((el) => el.dataset.src);
        if (!picked.length) {
          cb.checked = true;
          return toast('至少保留一个学术数据源', true);
        }
        S.discoverySources = picked;
        cb.closest('.discovery-source-pill')?.classList.toggle('active', cb.checked);
        const note = root.querySelector('.discovery-source-note');
        if (note) {
          note.textContent = `模型配置可用时并行检索扩展词 · ${picked.map((id) => SOURCE_LABEL_MAP[id] || id).join(' / ')} · 入库前不改动论文库`;
        }
      });
    });

    const syncFilter = () => {
      const f = S.discoveryFilters;
      f.yearFrom = root.querySelector('#dfYearFrom').value.trim();
      f.yearTo = root.querySelector('#dfYearTo').value.trim();
      f.minCitations = root.querySelector('#dfMinCites').value.trim();
      f.peerReviewedOnly = root.querySelector('#dfPeerReviewed').checked;
      f.hasCodeOnly = root.querySelector('#dfHasCode').checked;
      f.hasPdfOnly = root.querySelector('#dfHasPdf').checked;
      f.hideDuplicates = root.querySelector('#dfHideDup').checked;
      f._fromSkill = false;
      S.discoveryUseWorkspaceSeeds = root.querySelector('#dfWorkspaceSeeds').checked;
      S.discoveryAiScreening = root.querySelector('#dfAiScreen').checked;
      const tgl = root.querySelector('#discoveryFilterToggle');
      const count = activeFilterCount();
      if (tgl) tgl.innerHTML = `${ico('filter', 13)}数据源与筛选${count ? ` <span class="discovery-badge-count">${count}</span>` : ''}`;
    };
    ['#dfYearFrom', '#dfYearTo', '#dfMinCites', '#dfPeerReviewed', '#dfHasCode', '#dfHasPdf', '#dfHideDup', '#dfWorkspaceSeeds', '#dfAiScreen']
      .forEach((sel) => root.querySelector(sel)?.addEventListener('change', syncFilter));

    root.querySelectorAll('[data-year-span]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const span = Number(btn.dataset.yearSpan) || 0;
        const curYear = new Date().getUTCFullYear();
        root.querySelector('#dfYearFrom').value = span > 0 ? String(curYear - span + 1) : '';
        root.querySelector('#dfYearTo').value = '';
        syncFilter();
      });
    });

    root.querySelector('#discoveryImport').addEventListener('click', importSelected);
    root.querySelector('#discoveryAll').addEventListener('change', (e) => {
      S.selection = new Set();
      const visible = visibleDiscoveryEntries();
      if (e.target.checked) visible.forEach(({ paper, index }) => { if (!paper.duplicateOf) S.selection.add(index); });
      renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
    });

    root.querySelectorAll('[data-query]').forEach((button) => button.addEventListener('click', () => {
      queryInput.value = button.dataset.query;
      S.discoveryQuery = button.dataset.query;
      resizeDiscoveryComposer(queryInput);
      queryInput.focus();
    }));
  }

  function visibleDiscoveryEntries() {
    const rows = S.searchResults || [];
    const srcFilter = S.discoveryResultSourceFilter || '';
    const gradeFilter = S.discoveryResultGradeFilter || '';
    return rows
      .map((paper, index) => ({ paper, index }))
      .filter(({ paper }) => {
        if (srcFilter) {
          const srcs = Array.isArray(paper.sources) && paper.sources.length ? paper.sources : ['openalex'];
          if (!srcs.includes(srcFilter)) return false;
        }
        if (gradeFilter) {
          const ratingResult = paper.ratingResult || S.ratingCache[paper.openalexId || paper.arxivId || paper.title];
          const g = String((ratingResult && ratingResult.grade) || paper.rating || '').toUpperCase();
          if (g !== gradeFilter) return false;
        }
        return true;
      });
  }

  function resizeDiscoveryComposer(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function bindDiscoverySplitter(root) {
    const shell = root.querySelector('.discovery-shell');
    const handle = root.querySelector('#discoverySplitter');
    if (!shell || !handle) return;
    let ratio = Number.parseFloat(shell.style.getPropertyValue('--discovery-search-ratio')) || 40;
    const bounds = () => {
      const style = getComputedStyle(shell);
      const available = Math.max(1, shell.clientHeight - handle.offsetHeight -
        (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
      const min = Math.min(60, Math.max(25, Math.ceil(190 / available * 100)));
      const max = Math.max(min + 1, Math.min(65, Math.floor(100 - 180 / available * 100)));
      return { min, max };
    };
    const apply = (next) => {
      const range = bounds();
      ratio = Math.max(range.min, Math.min(range.max, next));
      shell.style.setProperty('--discovery-search-ratio', ratio + '%');
      handle.setAttribute('aria-valuemin', String(range.min));
      handle.setAttribute('aria-valuemax', String(range.max));
      handle.setAttribute('aria-valuenow', String(Math.round(ratio)));
    };
    const persist = async () => {
      try {
        S.cfg = await call('updateConfig', { ui: { discoverySearchRatio: Math.round(ratio) } });
      } catch (error) {
        toast('保存检索区比例失败：' + error.message, true);
      }
    };
    handle.setAttribute('role', 'separator');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', '调整检索输入区与论文结果区比例');
    apply(ratio);
    handle.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startRatio = ratio;
      document.body.classList.add('is-resizing-discovery');
      const move = (e) => {
        if (e.pointerId !== pointerId) return;
        const style = getComputedStyle(shell);
        const rect = shell.getBoundingClientRect();
        const top = rect.top + (parseFloat(style.paddingTop) || 0);
        const available = Math.max(1, shell.clientHeight - handle.offsetHeight -
          (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
        apply((e.clientY - top) / available * 100);
      };
      const finish = async (e) => {
        if (e.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        document.body.classList.remove('is-resizing-discovery');
        if (ratio !== startRatio) await persist();
      };
      handle.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
    handle.addEventListener('keydown', async (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const range = bounds();
      const step = event.shiftKey ? 10 : 2;
      const next = event.key === 'Home' ? range.min
        : event.key === 'End' ? range.max
          : ratio + (event.key === 'ArrowDown' ? step : -step);
      apply(next);
      await persist();
    });
  }

  function renderDiscoveryRecent(root) {
    const box = root.querySelector('#discoveryRecent');
    if (!box) return;
    box.innerHTML = S.recentSearches.length
      ? `<span class="discovery-recent-label">最近搜索</span>` + S.recentSearches.map((query) => `<button type="button" class="recent-q" data-q="${esc(query)}">${esc(query)}</button>`).join('')
      : '<span class="discovery-recent-label">搜索历史仅保存在当前会话</span>';
    box.querySelectorAll('[data-q]').forEach((button) => button.addEventListener('click', () => {
      const input = root.querySelector('#discoveryQuery');
      input.value = button.dataset.q;
      S.discoveryQuery = input.value;
      resizeDiscoveryComposer(input);
      input.focus();
    }));
  }

  function prepareSearchResults(list) {
    const arr = Array.isArray(list) ? list : [];
    arr.forEach((paper) => {
      const cacheKey = paper.openalexId || paper.arxivId || paper.title;
      const cached = S.ratingCache[cacheKey];
      const existing = paper.ratingResult || cached;
      if (existing) {
        paper.ratingResult = existing;
        paper.rating = existing.grade || '';
        paper.ratingPending = false;
      } else {
        paper.ratingPending = true;
        paper.ratingError = '';
      }
    });
    return arr;
  }

  /** Multi-source skill-driven search → deduplicated cards; never writes local records. */
  async function runDiscovery(root, query) {
    if (!query) return toast('请输入检索提示词', true);
    const requestId = ++S.discoveryRequestId;
    S.discoveryQuery = query;
    S.recentSearches = [query, ...S.recentSearches.filter((q) => q !== query)].slice(0, 8);
    renderDiscoveryRecent(root);
    S.searchResults = [];
    S.discoveryMeta = null;
    S.discoveryResultSourceFilter = '';
    S.discoveryResultGradeFilter = '';
    S.discoveryExpandedAbstracts = new Set();
    S.selection = new Set();
    updateDiscoveryControls(root);
    const planBar = root.querySelector('#discoveryPlanBar');
    if (planBar) planBar.innerHTML = '';
    const postFilters = root.querySelector('#discoveryPostFilters');
    if (postFilters) postFilters.innerHTML = '';

    const box = root.querySelector('#discoveryResults');
    const btn = root.querySelector('#discoveryGo');
    const activeSkill = currentSearchSkill();
    const sources = (S.discoverySources && S.discoverySources.length) ? S.discoverySources : ['openalex', 'arxiv', 'openreview', 'huggingface'];
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 检索中…'; }
    box.innerHTML = `<div class="discovery-empty is-loading"><span class="spinner"></span><h2>正在执行「${esc(activeSkill ? activeSkill.name : '多源联邦检索')}」</h2><p>并行检索 ${esc(sources.map((s) => SOURCE_LABEL_MAP[s] || s).join(' · '))}，跨源去重并比对本地论文库…</p></div>`;
    const summary = root.querySelector('#discoverySummary');
    if (summary) summary.textContent = `正在检索“${query}”…`;

    const f = S.discoveryFilters || {};
    const filters = {
      yearFrom: Number(f.yearFrom) || undefined,
      yearTo: Number(f.yearTo) || undefined,
      minCitations: Number(f.minCitations) || undefined,
      peerReviewedOnly: Boolean(f.peerReviewedOnly),
      hasCodeOnly: Boolean(f.hasCodeOnly),
      hasPdfOnly: Boolean(f.hasPdfOnly),
      hideDuplicates: Boolean(f.hideDuplicates)
    };

    try {
      const resp = await svc('openalex', 'search', {
        query,
        ws: S.ws,
        perPage: Number(root.querySelector('#discoveryCount').value) || S.discoveryCount || 20,
        sort: root.querySelector('#discoverySort').value || S.discoverySort || 'frontier',
        useAiStrategy: !!root.querySelector('#discoveryStrategy').checked,
        apiKey: (S.cfg.openalex || {}).apiKey || '',
        s2ApiKey: (S.cfg.search || {}).semanticScholarApiKey || '',
        skillId: S.discoverySkillId || 'paper-search-pro',
        sources,
        filters,
        useWorkspaceSeeds: S.discoveryUseWorkspaceSeeds !== false,
        enableAiScreening: Boolean(S.discoveryAiScreening),
        returnMeta: true
      });
      if (requestId !== S.discoveryRequestId) return;
      const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.papers) ? resp.papers : []);
      S.discoveryMeta = resp && resp.meta ? { ...resp.meta, _ws: S.ws } : null;
      S.searchResults = prepareSearchResults(list);
      S.selection = new Set();
      renderDiscoveryPlan(root);
      renderDiscoveryResults(S.searchResults, box);
      autoRateDiscoveryResults(S.searchResults, root, requestId);
      const warnings = (S.discoveryMeta && S.discoveryMeta.warnings) || [];
      if (warnings.length) {
        toast(`部分数据源降级，已聚合其余结果（${S.searchResults.length} 篇）：${warnings[0]}`, true);
      } else {
        toast(`聚合到 ${S.searchResults.length} 篇前沿论文${S.discoveryMeta ? `（去重自 ${S.discoveryMeta.totalRaw} 条）` : ''}`);
      }
    } catch (e) {
      if (requestId !== S.discoveryRequestId) return;
      S.searchResults = [];
      S.discoveryMeta = null;
      box.innerHTML = `<div class="discovery-empty discovery-error"><h2>检索失败</h2><p>${esc(e.message || '请检查网络或检索条件后重试。')}</p></div>`;
      updateDiscoveryControls(root);
      toast(e.message || '检索失败', true);
    } finally {
      if (requestId === S.discoveryRequestId && btn) { btn.disabled = false; btn.innerHTML = ico('search', 15) + '检索'; }
    }
  }

  /** 今日前沿雷达（Hugging Face Daily Papers） */
  async function runDailyFrontier(root) {
    const requestId = ++S.discoveryRequestId;
    const filterQuery = (root.querySelector('#discoveryQuery')?.value || '').trim();
    S.searchResults = [];
    S.discoveryMeta = null;
    S.discoveryResultSourceFilter = '';
    S.discoveryResultGradeFilter = '';
    S.discoveryExpandedAbstracts = new Set();
    S.selection = new Set();
    updateDiscoveryControls(root);
    const box = root.querySelector('#discoveryResults');
    const dailyBtn = root.querySelector('#discoveryDailyBtn');
    if (dailyBtn) { dailyBtn.disabled = true; dailyBtn.innerHTML = '<span class="spinner"></span> 拉取中…'; }
    box.innerHTML = `<div class="discovery-empty is-loading"><span class="spinner"></span><h2>正在拉取今日前沿论文</h2><p>实时获取 Hugging Face Daily Papers 社区热度与开源代码仓…</p></div>`;
    try {
      const resp = await svc('openalex', 'dailyFrontier', { ws: S.ws, query: filterQuery, limit: Number(S.discoveryCount) || 25 });
      if (requestId !== S.discoveryRequestId) return;
      S.discoveryMeta = resp && resp.meta ? { ...resp.meta, _ws: S.ws } : null;
      S.searchResults = prepareSearchResults(resp && resp.papers);
      renderDiscoveryPlan(root);
      renderDiscoveryResults(S.searchResults, box);
      autoRateDiscoveryResults(S.searchResults, root, requestId);
      if (S.discoveryMeta && S.discoveryMeta.filterFallback) {
        toast(`今日精选未命中该关键词，已展示今日全部热门 ${S.searchResults.length} 篇`);
      } else {
        toast(`已加载今日前沿论文 ${S.searchResults.length} 篇`);
      }
    } catch (e) {
      if (requestId !== S.discoveryRequestId) return;
      box.innerHTML = `<div class="discovery-empty discovery-error"><h2>拉取今日前沿失败</h2><p>${esc(e.message || '请检查网络后重试。')}</p></div>`;
      toast('拉取失败：' + (e.message || ''), true);
    } finally {
      if (requestId === S.discoveryRequestId && dailyBtn) {
        dailyBtn.disabled = false;
        dailyBtn.innerHTML = `${ico('zap', 13)}今日前沿`;
      }
    }
  }

  /** 单篇论文 1-Click 双向引文追踪（Citation Snowball） */
  async function runSnowballOnPaper(paper, root) {
    if (!paper) return;
    const requestId = ++S.discoveryRequestId;
    const box = root.querySelector('#discoveryResults');
    S.searchResults = [];
    S.discoveryMeta = null;
    S.discoveryResultSourceFilter = '';
    S.discoveryResultGradeFilter = '';
    S.discoveryExpandedAbstracts = new Set();
    S.selection = new Set();
    updateDiscoveryControls(root);
    box.innerHTML = `<div class="discovery-empty is-loading"><span class="spinner"></span><h2>正在执行引文滚雪球追踪</h2><p>追踪「${esc(String(paper.title || '').slice(0, 60))}」的最新引用者（前向）与奠基文献（后向）…</p></div>`;
    try {
      const resp = await svc('openalex', 'snowball', paper, { ws: S.ws, perPage: Math.max(20, Number(S.discoveryCount) || 20), direction: 'both' });
      if (requestId !== S.discoveryRequestId) return;
      S.discoveryMeta = resp && resp.meta ? { ...resp.meta, _ws: S.ws } : null;
      S.searchResults = prepareSearchResults(resp && resp.papers);
      renderDiscoveryPlan(root);
      renderDiscoveryResults(S.searchResults, box);
      autoRateDiscoveryResults(S.searchResults, root, requestId);
      toast(`引文追踪找到 ${S.searchResults.length} 篇关联前沿论文`);
    } catch (e) {
      if (requestId !== S.discoveryRequestId) return;
      box.innerHTML = `<div class="discovery-empty discovery-error"><h2>引文追踪失败</h2><p>${esc(e.message || '')}</p></div>`;
      toast('引文追踪失败：' + (e.message || ''), true);
    }
  }

  function renderDiscoveryPlan(root) {
    const bar = root.querySelector('#discoveryPlanBar');
    if (!bar) return;
    const meta = S.discoveryMeta;
    if (!meta) { bar.innerHTML = ''; return; }
    const queries = (meta.plan && Array.isArray(meta.plan.queries)) ? meta.plan.queries : [];
    const diags = Array.isArray(meta.sourceDiagnostics) ? meta.sourceDiagnostics : [];
    const boolQ = (meta.plan && meta.plan.booleanQuery) || '';
    const seeds = Array.isArray(meta.snowballSeeds) ? meta.snowballSeeds : [];
    bar.innerHTML = `<details class="discovery-plan-card" open>
      <summary class="discovery-plan-head">
        <span class="discovery-plan-skill">${ico('book', 12)}${esc((meta.skill && meta.skill.name) || '检索方案')}</span>
        <span class="discovery-plan-stat">原始 ${meta.totalRaw || 0} → 去重融合 ${meta.totalFused || 0}${meta.elapsedMs ? ` · ${(meta.elapsedMs / 1000).toFixed(1)}s` : ''}${meta.rcsApplied ? ' · 已执行 AI RCS 初筛' : ''}</span>
      </summary>
      <div class="discovery-plan-body">
        ${queries.length ? `<div class="discovery-plan-row"><span class="dp-k">执行检索式</span><div class="dp-chips">${queries.map((q) => `<span class="dp-query-chip" title="${esc(q.angle || '')}"><b>${esc(q.angle || '策略')}</b> ${esc(q.term)}</span>`).join('')}</div></div>` : ''}
        ${diags.length ? `<div class="discovery-plan-row"><span class="dp-k">多源诊断</span><div class="dp-chips">${diags.map((d) => `<span class="dp-src-chip ${d.ok ? 'is-ok' : 'is-warn'}" title="${esc(d.error || `命中 ${d.count} 条 · ${d.latencyMs}ms`)}">${esc(d.label)} ${d.ok ? d.count : '降级'}</span>`).join('')}</div></div>` : ''}
        ${seeds.length ? `<div class="discovery-plan-row"><span class="dp-k">引文种子</span><div class="dp-chips">${seeds.map((s) => `<span class="dp-query-chip">${esc(String(s.title || s.openalexId).slice(0, 48))}</span>`).join('')}</div></div>` : ''}
        ${boolQ ? `<div class="discovery-plan-row"><span class="dp-k">标准布尔式</span><code class="dp-bool">${esc(boolQ)}</code><button type="button" class="btn ghost sm dp-copy-bool">${ico('copy', 12)}复制</button></div>` : ''}
      </div>
    </details>`;
    bar.querySelector('.dp-copy-bool')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(boolQ); toast('已复制标准布尔检索式'); }
      catch (_) { toast('复制失败，请手动选中复制', true); }
    });
  }

  function renderDiscoveryPostFilters(root) {
    const holder = root.querySelector('#discoveryPostFilters');
    if (!holder) return;
    const rows = S.searchResults || [];
    if (!rows.length) { holder.innerHTML = ''; return; }
    const srcCounts = {};
    const gradeCounts = { S: 0, A: 0, B: 0, C: 0 };
    rows.forEach((p) => {
      const srcs = Array.isArray(p.sources) && p.sources.length ? p.sources : ['openalex'];
      srcs.forEach((s) => { srcCounts[s] = (srcCounts[s] || 0) + 1; });
      const ratingResult = p.ratingResult || S.ratingCache[p.openalexId || p.arxivId || p.title];
      const g = String((ratingResult && ratingResult.grade) || p.rating || '').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(gradeCounts, g)) gradeCounts[g]++;
    });
    const grades = ['S', 'A', 'B', 'C'];
    holder.innerHTML = `<div class="discovery-post-filters">
      <div class="dpf-group">
        <span class="dpf-label">按来源</span>
        <button type="button" class="dpf-chip ${!S.discoveryResultSourceFilter ? 'active' : ''}" data-post-src="">全部 ${rows.length}</button>
        ${Object.keys(srcCounts).map((src) => `<button type="button" class="dpf-chip ${S.discoveryResultSourceFilter === src ? 'active' : ''}" data-post-src="${esc(src)}">${esc(SOURCE_LABEL_MAP[src] || src)} ${srcCounts[src]}</button>`).join('')}
      </div>
      <div class="dpf-group">
        <span class="dpf-label">按评级</span>
        <button type="button" class="dpf-chip ${!S.discoveryResultGradeFilter ? 'active' : ''}" data-post-grade="">全部</button>
        ${grades.map((g) => `<button type="button" class="dpf-chip ${S.discoveryResultGradeFilter === g ? 'active' : ''}" data-post-grade="${g}">${g}${gradeCounts[g] ? ` ${gradeCounts[g]}` : ''}</button>`).join('')}
      </div>
    </div>`;
    holder.querySelectorAll('[data-post-src]').forEach((btn) => btn.addEventListener('click', () => {
      S.discoveryResultSourceFilter = btn.dataset.postSrc || '';
      renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
    }));
    holder.querySelectorAll('[data-post-grade]').forEach((btn) => btn.addEventListener('click', () => {
      S.discoveryResultGradeFilter = btn.dataset.postGrade || '';
      renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
    }));
  }

  function updateDiscoveryControls(root) {
    const page = root || $('#discoveryPage');
    if (!page) return;
    const count = page.querySelector('#discoveryPicked');
    const importButton = page.querySelector('#discoveryImport');
    const exportButton = page.querySelector('#discoveryExport');
    const selectAll = page.querySelector('#discoveryAll');
    const summary = page.querySelector('#discoverySummary');
    if (count) count.textContent = String(S.selection.size);
    if (importButton) {
      importButton.disabled = S.selection.size === 0;
      importButton.innerHTML = `${ico('download', 14)}入库选中 <span id="discoveryPicked">${S.selection.size}</span>`;
    }
    if (exportButton) exportButton.disabled = !S.searchResults.length;
    const visible = visibleDiscoveryEntries();
    if (selectAll) {
      const eligible = visible.filter(({ paper }) => !paper.duplicateOf).length;
      const pickedVisible = visible.filter(({ index, paper }) => !paper.duplicateOf && S.selection.has(index)).length;
      selectAll.disabled = eligible === 0;
      selectAll.checked = eligible > 0 && pickedVisible === eligible;
    }
    if (summary) {
      const duplicateCount = S.searchResults.filter((paper) => paper.duplicateOf).length;
      const multiSourceCount = S.searchResults.filter((paper) => Array.isArray(paper.sources) && paper.sources.length > 1).length;
      const multiStrategyCount = S.searchResults.filter((paper) => Number(paper.searchQueryMatchCount) > 1).length;
      const codeCount = S.searchResults.filter((paper) => Boolean(paper.codeUrl)).length;
      summary.textContent = S.searchResults.length
        ? `展示 ${visible.length} / ${S.searchResults.length} 篇` +
          `${multiSourceCount ? ` · ${multiSourceCount} 篇多源共识` : ''}` +
          `${multiStrategyCount ? ` · ${multiStrategyCount} 篇多策略命中` : ''}` +
          `${codeCount ? ` · ${codeCount} 篇含代码` : ''}` +
          ` · ${duplicateCount ? `${duplicateCount} 篇已在库` : '尚未入库'} · 已选 ${S.selection.size} 篇`
        : '选择检索 Skill 并描述研究问题，或点击「今日前沿」直接浏览最新热点。';
    }
  }

  /** Result cards keep the 5 core fields + multi-source provenance + frontier signals together. */
  function renderDiscoveryResults(list, container) {
    const box = container || $('#discoveryResults');
    if (!box) return;
    const page = box.closest('.discovery-shell') || $('#discoveryPage');
    const rows = list || [];
    renderDiscoveryPostFilters(page);
    if (!rows.length) {
      box.innerHTML = `<div class="discovery-empty">
        <div class="discovery-empty-icon">${ico('search', 26)}</div>
        <h2>${S.discoveryQuery ? '没有找到匹配论文' : '从前沿问题或 GitHub 检索 Skill 开始'}</h2>
        <p>${S.discoveryQuery ? '试试切换检索 Skill、放宽年份/同行评审筛选，或勾选更多学术数据源后重新检索。' : '支持多源联邦检索与内嵌 GitHub 论文检索 Skills。'}</p>
      </div>`;
      updateDiscoveryControls(page);
      return;
    }
    const visible = visibleDiscoveryEntries();
    if (!visible.length) {
      box.innerHTML = `<div class="discovery-empty">
        <div class="discovery-empty-icon">${ico('filter', 26)}</div>
        <h2>当前快速筛选下无匹配条目</h2>
        <p>可点击上方「全部」按钮恢复显示全部 ${rows.length} 篇检索结果。</p>
      </div>`;
      updateDiscoveryControls(page);
      return;
    }

    const sixMonthsAgo = Date.now() - 6 * 30 * 24 * 3600 * 1000;
    const expandedSet = S.discoveryExpandedAbstracts || new Set();
    box.innerHTML = `<div class="discovery-card-list">${visible.map(({ paper: p, index: i }, pos) => {
        const dup = !!p.duplicateOf;
        const searchQueryMatchCount = Number(p.searchQueryMatchCount) || 1;
        const cacheKey = p.openalexId || p.arxivId || p.title;
        const ratingResult = p.ratingResult || S.ratingCache[cacheKey];
        const grade = String((ratingResult && ratingResult.grade) || p.rating || '').toUpperCase();
        const t = Date.parse(p.publicationDate || '');
        const isNew = !isNaN(t) && t >= sixMonthsAgo;
        const abstract = String(p.abstract || '').trim();
        const isExpanded = expandedSet.has(i);
        const excerptText = p.abstractExcerpt || (abstract ? abstract.slice(0, 300) + (abstract.length > 300 ? '…' : '') : '暂无可用摘要');
        const canExpand = Boolean(abstract && abstract.length > excerptText.length + 24);
        const abstractShown = isExpanded ? abstract : excerptText;
        const abstractState = !abstract && !p.abstractExcerpt
          ? '摘要不全'
          : (!isExpanded && canExpand ? '摘要节选' : '');
        const sources = Array.isArray(p.sources) && p.sources.length ? p.sources : ['openalex'];
        const venueStatus = String(p.venueStatus || '');
        const venueHighlight = ['Oral', 'Spotlight'].includes(venueStatus)
          ? `<span class="discovery-venue-badge is-elite">${esc(venueStatus)}</span>`
          : (['Accepted', 'Journal', 'Published'].includes(venueStatus) && !p.isPreprint
            ? `<span class="discovery-venue-badge is-peer">正式发表</span>`
            : '');
        const frontierBadge = Number(p.frontierScore) > 0
          ? `<span class="discovery-frontier-score" title="前沿综合分（综合多源共识、引用增速、载体权威、时效与开源代码）">前沿 ${p.frontierScore}</span>`
          : '';
        const rcsBadge = typeof p.rcsScore === 'number'
          ? `<span class="discovery-rcs-badge ${p.rcsScore >= 8 ? 'is-high' : p.rcsScore >= 6 ? 'is-mid' : 'is-low'}" title="paper-search-pro RCS 相关性评分（0-10）">RCS ${p.rcsScore}/10</span>`
          : '';
        const snowballTag = Array.isArray(p.snowballReasons) && p.snowballReasons.length
          ? `<div class="discovery-snowball-note">${ico('gitBranch', 11)}<span>${esc(p.snowballReasons.join(' · '))}</span></div>`
          : '';
        const rcsNote = p.rcsReason
          ? `<div class="discovery-rcs-note">${ico('sparkle', 11)}<span>AI 初筛：${esc(p.rcsReason)}</span></div>`
          : '';
        const velocityText = Number(p.citationVelocity) >= 1
          ? `<span class="discovery-velocity" title="按发表时长归一化的年均引用速度">~${fmtCompact(Math.round(p.citationVelocity))}/年</span>`
          : '';
        const citeSourceLabel = p.citationSource ? `（${p.citationSource}）` : '';

        return `<article class="discovery-card ${dup ? 'is-duplicate' : ''} ${S.selection.has(i) ? 'is-selected' : ''}" data-i="${i}">
          <label class="discovery-card-select" title="${dup ? '这篇论文已在本地库中' : '选择入库'}"><input type="checkbox" class="row-pick" data-i="${i}" ${dup ? 'disabled' : ''} ${S.selection.has(i) ? 'checked' : ''} aria-label="选择 ${esc(p.title || '论文')} 入库"></label>
          <div class="discovery-card-content">
            <div class="discovery-card-topline">
              <div class="discovery-topline-left">
                <span class="discovery-result-index">${String(pos + 1).padStart(2, '0')} / ${visible.length}</span>
                <div class="discovery-src-tags">${sources.map((s) => `<span class="discovery-src-tag src-${esc(s)}">${esc(SOURCE_LABEL_MAP[s] || s)}</span>`).join('')}</div>
              </div>
              <div class="discovery-card-badges">
                ${dup ? `<span class="discovery-duplicate" title="匹配到本地条目：${esc(p.duplicateOf)}">已在库</span>` : ''}
                ${venueHighlight}
                ${rcsBadge}
                ${frontierBadge}
                ${searchQueryMatchCount > 1 ? `<span class="discovery-multimatch" title="同时命中多条检索策略">多策略命中</span>` : ''}
                ${isNew ? '<span class="lag-chip" title="新论文·引用尚在积累">近期发表</span>' : ''}
              </div>
            </div>
            <h2 class="discovery-card-title">${esc(p.title || '（无标题）')}</h2>
            <div class="discovery-card-meta">
              <span>${esc((p.authors || []).slice(0, 4).join(', ') || '作者未知')}</span>
              ${p.venue ? `<span class="${!p.isPreprint ? 'is-formal-venue' : ''}">${esc(p.venue)}</span>` : ''}
              <span>${esc(p.publicationDate || p.published || '发表时间未知')}</span>
              ${p.arxivId ? `<span>arXiv:${esc(p.arxivId)}</span>` : ''}
            </div>
            ${snowballTag}
            ${rcsNote}
            ${abstractState ? `<span class="discovery-abstract-label">${abstractState}</span>` : ''}
            <p class="discovery-card-abstract">${esc(abstractShown)}${canExpand ? ` <button type="button" class="discovery-expand-btn" data-expand-i="${i}">${isExpanded ? '收起' : '展开全文摘要'}</button>` : ''}</p>
            <div class="discovery-card-footer">
              <div class="discovery-card-metrics">
                <span title="引用量口径${citeSourceLabel || '（OpenAlex）'}，与 Google Scholar 等数据库口径不同"><strong>${fmtCites(p.citedByCount)}</strong> 次引用${velocityText}</span>
                ${Number(p.influentialCitationCount) > 0 ? `<span class="discovery-inf-cite" title="Semantic Scholar 高影响力引用">高影响 ${fmtCites(p.influentialCitationCount)}</span>` : ''}
                ${Number(p.hfUpvotes) > 0 ? `<span class="discovery-hf-chip" title="Hugging Face Papers 社区点赞">HF +${fmtCites(p.hfUpvotes)}</span>` : ''}
                ${p.codeUrl ? `<a class="discovery-code-chip" data-open="${esc(p.codeUrl)}" title="打开开源代码仓库">${ico('code', 11)}开源代码${Number(p.githubStars) > 0 ? ' ' + fmtCompact(p.githubStars) : ''}</a>` : ''}
                <button class="rating-badge ${grade || 'is-empty'}" data-rate-i="${i}" ${p.ratingPending ? 'disabled' : ''} title="${ratingResult ? '点击查看辅助评级详情' : (p.ratingPending ? '正在自动评级' : '点击重试评级')}">${grade || (p.ratingPending ? '评级中…' : (p.ratingError ? '重试评级' : '评级待生成'))}</button>
              </div>
              <div class="discovery-card-links">
                <button type="button" class="discovery-action-link" data-snowball-i="${i}" title="围绕该论文执行前向/后向引文滚雪球追踪">${ico('gitBranch', 12)}引文追踪</button>
                ${p.pdfUrl ? `<a class="dt-link" data-open="${esc(p.pdfUrl)}" title="打开开放获取 PDF">${ico('fileText', 12)}PDF</a>` : ''}
                ${p.oaUrl ? `<a class="dt-link" data-open="${esc(p.oaUrl)}" title="打开原文页面">${ico('external', 12)}原文</a>` : ''}
                ${p.doi ? `<span class="discovery-doi">DOI ${esc(p.doi)}</span>` : ''}
                ${dup ? `<span class="discovery-duplicate-note">已匹配：${esc(p.duplicateOf)}</span>` : ''}
              </div>
            </div>
          </div>
        </article>`;
      }).join('')}</div>
      <p class="discovery-disclaimer">引用量主要来自 OpenAlex（补充源另行标注），与 Google Scholar 等数据库口径不同；前沿分与评级仅作辅助判断，不代表学术定论。</p>`;

    box.querySelectorAll('.row-pick').forEach((cb) => cb.addEventListener('change', () => {
      const i = Number(cb.dataset.i);
      if (cb.checked) S.selection.add(i); else S.selection.delete(i);
      cb.closest('.discovery-card')?.classList.toggle('is-selected', cb.checked);
      updateDiscoveryControls(page);
    }));
    box.querySelectorAll('.discovery-card').forEach((card) => card.addEventListener('click', (event) => {
      if (event.target.closest('button,a,input,label,select,textarea,[data-open]')) return;
      const checkbox = card.querySelector('.row-pick');
      if (!checkbox || checkbox.disabled) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    box.querySelectorAll('[data-rate-i]').forEach((b) => b.addEventListener('click', (e) => {
      const p = rows[Number(b.dataset.rateI)];
      if (!p) return;
      if (p.ratingResult) showRatingDetail(p.ratingResult, e);
      else rateDiscoveryResult(p, b);
    }));
    box.querySelectorAll('[data-expand-i]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(b.dataset.expandI);
      if (!S.discoveryExpandedAbstracts) S.discoveryExpandedAbstracts = new Set();
      if (S.discoveryExpandedAbstracts.has(idx)) S.discoveryExpandedAbstracts.delete(idx);
      else S.discoveryExpandedAbstracts.add(idx);
      renderDiscoveryResults(S.searchResults, box);
    }));
    box.querySelectorAll('[data-snowball-i]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = rows[Number(b.dataset.snowballI)];
      if (p) runSnowballOnPaper(p, page);
    }));
    bindRefClicks(box); // data-open 走系统浏览器，复用既有跳转绑定
    updateDiscoveryControls(page);
  }

  /** 管理 & 导入 GitHub 论文检索 Skills 模态窗 */
  async function showSearchSkillsModal({ preserveTrigger = false } = {}) {
    const savedTrigger = preserveTrigger ? S.modalTrigger : null;
    const skillsList = await loadSearchSkillsIfNeeded(true);
    const listHtml = skillsList.map((sk) => `
      <div class="skill-card ${sk.id === S.discoverySkillId ? 'is-active' : ''}" data-sk-card="${esc(sk.id)}">
        <div class="skill-card-head">
          <div>
            <strong>${esc(sk.name)}</strong>
            <span class="skill-card-badge">${esc(sk.badge || 'Skill')}</span>
            ${sk.license ? `<span class="skill-card-license">${esc(sk.license)}</span>` : ''}
          </div>
          <div class="skill-card-actions">
            <button type="button" class="btn sm ${sk.id === S.discoverySkillId ? 'ghost' : ''}" data-use-skill="${esc(sk.id)}">${sk.id === S.discoverySkillId ? '当前使用中' : '选用'}</button>
            <button type="button" class="btn ghost sm" data-view-skill="${esc(sk.id)}" aria-expanded="false">查看规范</button>
            ${sk.builtin ? '' : `<button type="button" class="btn ghost sm danger-text" data-del-skill="${esc(sk.id)}">删除</button>`}
          </div>
        </div>
        <p class="skill-card-summary">${esc(sk.summary || '')}</p>
        <div class="skill-card-meta">
          <span>默认数据源：${esc((sk.defaultSources || []).map((id) => SOURCE_LABEL_MAP[id] || id).join(' / '))}</span>
          ${sk.githubRepo ? `<a class="dt-link" data-open="${esc(sk.githubRepo)}">${ico('external', 11)}GitHub 来源</a>` : ''}
        </div>
        <div class="skill-card-preview" data-preview-for="${esc(sk.id)}"></div>
      </div>`).join('');

    openModal('管理与导入 GitHub 论文检索 Skills', `
      <div class="hint" style="margin-bottom:10px">系统已内嵌 4 个源自 GitHub 开源项目的可执行检索 Skill，并支持直接粘贴任意 GitHub 仓库或 SKILL.md 链接内嵌到工作台，在检索时驱动多源路由与查询规划。</div>
      <div class="skill-import-box">
        <div class="section-title" style="margin-top:0">从 GitHub 仓库或 SKILL.md 链接导入</div>
        <div class="skill-import-row">
          <input id="ghSkillUrl" placeholder="例如：O0000-code/paper-search-pro 或 marciob/skill-research-papers">
          <input id="ghSkillName" class="skill-name-input" placeholder="自定义名称（可选）">
          <button type="button" class="btn sm" id="ghSkillImportBtn">${ico('download', 13)}拉取并内嵌</button>
        </div>
        <div class="skill-import-sub">
          <button type="button" class="btn ghost sm" id="localSkillImportBtn">${ico('upload', 13)}从本地选择 SKILL.md 文件</button>
          <span class="hint">仅允许从 github.com / raw.githubusercontent.com 拉取；自动探测子目录 SKILL.md，保存在 data/skills/search/</span>
        </div>
        <div id="ghDiscoveredSkills"></div>
      </div>
      <div class="section-title">已内嵌的论文检索 Skills（${skillsList.length}）</div>
      <div class="skill-card-list" id="searchSkillCardList">${listHtml}</div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, (modal) => {
      if (preserveTrigger && savedTrigger) S.modalTrigger = savedTrigger;
      bindRefClicks(modal);
      modal.querySelectorAll('[data-use-skill]').forEach((btn) => btn.addEventListener('click', () => {
        const sk = skillsList.find((s) => s.id === btn.dataset.useSkill);
        if (!sk) return;
        S.discoverySkillId = sk.id;
        applySearchSkillPreset(sk);
        closeModal();
        renderDiscoveryBoard();
        toast(`已启用检索 Skill：${sk.name}`);
      }));
      modal.querySelectorAll('[data-view-skill]').forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.viewSkill;
        const card = btn.closest('.skill-card');
        const holder = card && card.querySelector('.skill-card-preview');
        if (!holder) return;
        if (holder.classList.contains('is-open')) {
          holder.classList.remove('is-open');
          holder.innerHTML = '';
          btn.textContent = '查看规范';
          btn.setAttribute('aria-expanded', 'false');
          return;
        }
        try {
          const detail = await svc('openalex', 'getSearchSkill', id);
          if (!detail) return;
          holder.innerHTML = `<div class="skill-preview-box">
            <div class="skill-preview-head"><strong>${esc(detail.name)}</strong><span>v${esc(detail.version || '1.0')}</span></div>
            <pre class="skill-preview-code">${esc(detail.content || detail.raw || '')}</pre>
          </div>`;
          holder.classList.add('is-open');
          btn.textContent = '收起规范';
          btn.setAttribute('aria-expanded', 'true');
          holder.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) { toast('读取规范失败：' + err.message, true); }
      }));
      modal.querySelectorAll('[data-del-skill]').forEach((btn) => btn.addEventListener('click', async () => {
        const delId = btn.dataset.delSkill;
        const wasActive = S.discoverySkillId === delId;
        try {
          await svc('openalex', 'deleteSearchSkill', delId);
          toast('已删除自定义检索 Skill');
          await loadSearchSkillsIfNeeded(true);
          if (wasActive && currentSearchSkill()) applySearchSkillPreset(currentSearchSkill());
          if (S.board === 'discovery') renderDiscoveryBoard();
          await showSearchSkillsModal({ preserveTrigger: true });
        } catch (err) { toast(err.message, true); }
      }));
      const doGithubImport = async (rawUrl, customName = '') => {
        const btn = modal.querySelector('#ghSkillImportBtn');
        const discoveredBox = modal.querySelector('#ghDiscoveredSkills');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 拉取中…';
        if (discoveredBox) discoveredBox.innerHTML = '';
        try {
          const saved = await svc('openalex', 'importSearchSkillFromUrl', rawUrl, customName);
          await loadSearchSkillsIfNeeded(true);
          S.discoverySkillId = saved.id;
          applySearchSkillPreset(saved);
          toast(`已从 GitHub 内嵌检索 Skill：${saved.name}`);
          if (S.board === 'discovery') renderDiscoveryBoard();
          await showSearchSkillsModal({ preserveTrigger: true });
        } catch (err) {
          const msg = String((err && err.message) || err || '导入失败');
          toast('导入失败：' + msg, true);
          // 若是多 Skill 仓库（如 huggingface/skills），拉取候选路径供一键点选
          const repoMatch = rawUrl.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
          if (repoMatch && /包含\s*\d+\s*个\s*SKILL\.md/i.test(msg) && discoveredBox) {
            try {
              const paths = await svc('openalex', 'discoverGithubSkillFiles', repoMatch[1], repoMatch[2]);
              if (Array.isArray(paths) && paths.length) {
                discoveredBox.innerHTML = `<div class="skill-discovered-list">
                  <div class="hint" style="margin-bottom:6px">该仓库检测到多个 SKILL.md，点击任意一项即可直接导入：</div>
                  <div class="skill-discovered-chips">${paths.slice(0, 12).map((p) => {
                    const shorthand = `${repoMatch[1]}/${repoMatch[2]}/${p}`;
                    return `<button type="button" class="dpf-chip" data-pick-gh="${esc(shorthand)}" title="${esc(shorthand)}">${esc(p)}</button>`;
                  }).join('')}</div>
                </div>`;
                discoveredBox.querySelectorAll('[data-pick-gh]').forEach((pickBtn) => {
                  pickBtn.addEventListener('click', () => {
                    modal.querySelector('#ghSkillUrl').value = pickBtn.dataset.pickGh;
                    doGithubImport(pickBtn.dataset.pickGh, modal.querySelector('#ghSkillName').value.trim());
                  });
                });
              }
            } catch (_) { /* 忽略二次发现失败 */ }
          }
          if (btn.isConnected) {
            btn.disabled = false; btn.innerHTML = `${ico('download', 13)}拉取并内嵌`;
          }
        }
      };
      modal.querySelector('#ghSkillImportBtn').addEventListener('click', () => {
        const url = modal.querySelector('#ghSkillUrl').value.trim();
        const name = modal.querySelector('#ghSkillName').value.trim();
        if (!url) return toast('请输入 GitHub 仓库或 SKILL.md 链接', true);
        doGithubImport(url, name);
      });
      modal.querySelector('#localSkillImportBtn').addEventListener('click', async () => {
        const paths = await window.bridge.dialog.openFiles({ title: '选择论文检索 SKILL.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
        if (!paths.length) return;
        try {
          const saved = await svc('openalex', 'importSearchSkillFromFile', paths[0]);
          await loadSearchSkillsIfNeeded(true);
          S.discoverySkillId = saved.id;
          applySearchSkillPreset(saved);
          toast(`已导入本地检索 Skill：${saved.name}`);
          if (S.board === 'discovery') renderDiscoveryBoard();
          await showSearchSkillsModal({ preserveTrigger: true });
        } catch (err) { toast('导入失败：' + err.message, true); }
      });
    }, 'wide');
  }

  /** 导出选中或当前检索结果为 BibTeX / Markdown 文献综述矩阵 */
  async function showExportModal() {
    const pickedIndices = Array.from(S.selection).filter((i) => S.searchResults[i]);
    const targets = pickedIndices.length
      ? pickedIndices.map((i) => S.searchResults[i])
      : visibleDiscoveryEntries().map((x) => x.paper);
    if (!targets.length) return toast('当前没有可导出的论文', true);
    let currentFormat = 'bibtex';
    const buildText = async (fmt) => svc('openalex', 'exportResults', targets, fmt);
    let initialText = '';
    try { initialText = await buildText(currentFormat); } catch (e) { return toast('导出失败：' + e.message, true); }

    openModal(`导出文献（${targets.length} 篇${pickedIndices.length ? '已选' : '本页'}）`, `
      <div class="export-tabs">
        <button type="button" class="btn sm" data-exp-fmt="bibtex">BibTeX 引用</button>
        <button type="button" class="btn ghost sm" data-exp-fmt="markdown">Markdown 综述矩阵</button>
        <button type="button" class="btn ghost sm" id="copyExportBtn" style="margin-left:auto">${ico('copy', 13)}复制全部</button>
      </div>
      <textarea id="exportPreviewArea" class="editor-area export-textarea" rows="15" readonly>${esc(initialText)}</textarea>
      <div class="modal-actions"><button class="btn" data-close>完成</button></div>
    `, (modal) => {
      const area = modal.querySelector('#exportPreviewArea');
      modal.querySelectorAll('[data-exp-fmt]').forEach((btn) => btn.addEventListener('click', async () => {
        currentFormat = btn.dataset.expFmt;
        modal.querySelectorAll('[data-exp-fmt]').forEach((b) => b.classList.toggle('ghost', b !== btn));
        try { area.value = await buildText(currentFormat); } catch (err) { toast(err.message, true); }
      }));
      modal.querySelector('#copyExportBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(area.value); toast(`已复制 ${targets.length} 篇 ${currentFormat === 'bibtex' ? 'BibTeX' : 'Markdown 矩阵'}`); }
        catch (_) { area.select(); toast('请按 Ctrl+C 复制选中文本'); }
      });
    }, 'wide');
  }

  async function rateDiscoveryResult(paper, button) {
    const key = paper.openalexId || paper.arxivId || paper.title;
    const rect = button.getBoundingClientRect();
    const cached = S.ratingCache[key];
    if (cached) {
      paper.ratingResult = cached;
      paper.rating = cached.grade || '';
      button.textContent = paper.rating || '—';
      button.classList.toggle('is-empty', !paper.rating);
      button.title = '点击查看辅助评级详情';
      return showRatingDetail(cached, { rect });
    }
    button.disabled = true;
    button.textContent = '评级中…';
    paper.ratingPending = true;
    try {
      const result = await svc('rating', 'rate', paper);
      S.ratingCache[key] = result;
      paper.ratingResult = result;
      paper.rating = result.grade || '';
      paper.ratingPending = false;
      paper.ratingError = '';
      button.textContent = paper.rating || '—';
      button.disabled = false;
      button.classList.toggle('is-empty', !paper.rating);
      button.title = '点击查看辅助评级详情';
      showRatingDetail(result, { rect });
    } catch (error) {
      button.disabled = false;
      button.textContent = '重试评级';
      paper.ratingPending = false;
      paper.ratingError = error.message || '评级失败';
      toast('评级失败：' + error.message, true);
    }
  }

  async function autoRateDiscoveryResults(papers, root, requestId) {
    const pending = (papers || []).map((paper, index) => ({ paper, index }))
      .filter(({ paper }) => !paper.ratingResult && !S.ratingCache[paper.openalexId || paper.arxivId || paper.title]);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (cursor < pending.length && requestId === S.discoveryRequestId) {
        const { paper, index } = pending[cursor++];
        const key = paper.openalexId || paper.arxivId || paper.title;
        try {
          const result = S.ratingCache[key] || await svc('rating', 'rate', paper);
          if (requestId !== S.discoveryRequestId) return;
          S.ratingCache[key] = result;
          paper.ratingResult = result;
          paper.rating = result.grade || '';
          paper.ratingError = '';
        } catch (error) {
          if (requestId !== S.discoveryRequestId) return;
          paper.ratingError = error.message || '评级失败';
        } finally {
          if (requestId === S.discoveryRequestId) {
            paper.ratingPending = false;
            const currentIdx = (S.searchResults || []).indexOf(paper);
            updateDiscoveryRatingBadge(root, paper, currentIdx >= 0 ? currentIdx : index);
            if (S.discoveryResultGradeFilter) {
              renderDiscoveryResults(S.searchResults, root.querySelector('#discoveryResults'));
            } else {
              renderDiscoveryPostFilters(root);
            }
          }
        }
      }
    });
    await Promise.all(workers);
  }

  function updateDiscoveryRatingBadge(root, paper, index) {
    const button = root.querySelector(`[data-rate-i="${index}"]`);
    if (!button) return;
    const grade = String(paper.ratingResult?.grade || paper.rating || '').toUpperCase();
    button.textContent = grade || '重试评级';
    button.disabled = false;
    button.className = `rating-badge ${grade || 'is-empty'}`;
    button.title = grade ? '点击查看辅助评级详情' : '评级失败，点击重试';
  }

  /** P1-3：评级徽标浮层展示五维明细与 skill 版本来源。 */
  function showRatingDetail(result, ev) {
    const old = $('#ratingPopover');
    if (old) old.remove();
    const r = result || {};
    const dims = r.dimensions || {};
    const grade = String(r.grade || '—').toUpperCase();
    const pop = document.createElement('div');
    pop.id = 'ratingPopover';
    pop.className = 'rating-popover';
    pop.innerHTML = `<div class="rp-head"><span class="rating-badge ${grade || 'is-empty'}">${esc(grade)}</span>
        <span>${esc(r.reason || '暂无理由')}</span></div>
      ${['venue', 'citation', 'peerReview', 'institution', 'recency'].map((k) => {
        const label = { venue: '发表载体', citation: '引用位置', peerReview: '同行评审', institution: '作者机构', recency: '时效' }[k];
        return `<div class="rp-row"><span class="rp-k">${label}</span><span>${esc(dims[k] || '—')}</span></div>`;
      }).join('')}
      <div class="rp-row"><span class="rp-k">评级来源</span><span>${esc(r.source || '—')}</span></div>
      <div class="rp-foot">辅助判断、非学术定论 · 引用数据口径 OpenAlex</div>`;
    document.body.appendChild(pop);
    const rect = ev && ev.rect
      ? ev.rect
      : ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect
        ? ev.currentTarget.getBoundingClientRect()
        : { left: 200, top: 200, bottom: 220 };
    pop.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 280) + 'px';
    const off = (e) => {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); }
    };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
  }

  /** P1-1：批量入库确认 + 逐条提炼 + 可选拉取开放 PDF + 逐条写 md，单条失败不中断。 */
  async function importSelected() {
    const picks = Array.from(S.selection).filter((i) => {
      const p = S.searchResults[i];
      return p && !p.duplicateOf;
    });
    if (!picks.length) return toast('请先勾选要入库的论文（已在库项不可选）', true);
    const workspace = S.ws;
    const papers = picks.map((i) => ({
      ...S.searchResults[i],
      authors: [...(S.searchResults[i].authors || [])],
      ratingResult: S.searchResults[i].ratingResult ? { ...S.searchResults[i].ratingResult } : undefined
    }));
    const withPdf = papers.filter((p) => p.pdfUrl || p.arxivId).length;
    openModal('确认入库', `
      <div>将入库 <span class="bulk-confirm-count">${papers.length}</span> 篇论文到「${esc(workspace)}」。</div>
      <div class="hint" style="margin-top:8px">仅对入库论文调用一句话提炼（约 ${papers.length} 次模型调用，会消耗额度）；提炼失败自动降级为摘要节选，不阻断入库。入库后完全离线可用。</div>
      ${withPdf ? `<label class="discovery-ai-option" style="margin-top:12px"><input type="checkbox" id="importDownloadPdf">同时尝试自动下载开放获取 PDF 到本地（${withPdf} 篇可用，失败不阻断入库）</label>` : ''}
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="importGo">确认入库</button></div>
    `, (root) => {
      root.querySelector('#importGo').addEventListener('click', async () => {
        const downloadPdf = Boolean(root.querySelector('#importDownloadPdf')?.checked);
        closeModal();
        await doImportPicks(papers, workspace, { downloadPdf });
      });
    });
  }

  /** 单篇入库路径：脉络图「入库后查看详情」也复用它。 */
  function importOne(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || !S.searchResults[i]) return;
    const paper = S.searchResults[i];
    return doImportPicks([{
      ...paper,
      authors: [...(paper.authors || [])],
      ratingResult: paper.ratingResult ? { ...paper.ratingResult } : undefined
    }], S.ws);
  }

  async function doImportPicks(papers, workspace, opts = {}) {
    let ok = 0, failed = 0, pdfOk = 0;
    const imported = [];
    for (let n = 0; n < papers.length; n++) {
      const p = papers[n];
      toast(`入库中 ${n + 1}/${papers.length}：${String(p.title || '').slice(0, 24)}…`);
      let summary = String(p.abstractExcerpt || '').trim();
      let summarySource = 'excerpt';
      let summaryMethod = '';
      try {
        const line = await ai('oneLineSummary', { title: p.title, abstract: p.abstract || p.abstractExcerpt || '' });
        if (line && String(line).trim()) {
          summary = String(line).trim();
          summarySource = 'ai';
          summaryMethod = 'paper-reading-method@1.0';
        }
      } catch (e) {
        toast('提炼失败，已改用摘要节选：' + (e.message || '').slice(0, 40));
      }
      let pdfPath = '';
      if (opts.downloadPdf && (p.pdfUrl || p.arxivId)) {
        try {
          pdfPath = await svc('openalex', 'downloadPaperPdf', workspace, p);
          if (pdfPath) pdfOk++;
        } catch (_) {
          // 下载开放 PDF 失败不阻断入库
        }
      }
      try {
        const createdId = await call('importFromOpenAlex', workspace, p, {
          summary,
          summarySource,
          summaryMethod,
          pdfPath,
          searchSkill: S.discoverySkillId || '',
          skill: S.cfg.activeSkill || 'default',
          rating: p.ratingResult || { grade: p.rating || '', source: '' }
        });
        ok++;
        imported.push({ paper: p, id: createdId || p.title });
      } catch (e) {
        failed++;
        toast('入库失败：' + (e.message || '').slice(0, 80), true);
      }
    }
    if (S.ws === workspace) {
      if (S.board === 'discovery') {
        const importedMap = new Map(imported.map(({ paper, id }) => [paper.openalexId || paper.arxivId || paper.title, id]));
        S.searchResults.forEach((paper) => {
          const k = paper.openalexId || paper.arxivId || paper.title;
          if (importedMap.has(k)) paper.duplicateOf = importedMap.get(k);
        });
        S.selection.clear();
        renderDiscoveryResults(S.searchResults, $('#discoveryResults'));
      } else if (S.board === 'timeline') {
        await renderTimelineBoard();
      } else {
        await refreshItems();
        await renderBoard();
      }
    }
    toast(`入库到「${workspace}」完成：成功 ${ok} 篇${pdfOk ? `（含 ${pdfOk} 篇 PDF）` : ''}${failed ? '，失败 ' + failed + ' 篇' : ''}`);
  }

  /** P1-4：仅用户点击时联网重抓引用量；失败保留旧值、不写 md。 */
  async function refreshCitationsBtn() {
    const ids = S.items.filter((it) => it.externalIds && it.externalIds.openalex).map((it) => it.id);
    if (!ids.length) return toast('当前板块没有带 OpenAlex ID 的论文');
    toast(`正在刷新 ${ids.length} 篇论文的引用量…`);
    try {
      const results = await svc('openalex', 'refreshCitations', S.ws, ids);
      let updated = 0, failed = 0;
      for (const r of (results || [])) {
        if (r.error) { failed++; continue; }
        const item = await call('getItem', S.ws, 'papers', r.id);
        if (!item) continue;
        await call('saveItem', S.ws, 'papers', r.id, {
          frontmatter: { ...(item.frontmatter || {}), citedByCount: r.citedByCount, citationFetchedAt: r.citationFetchedAt },
          body: item.body
        });
        updated++;
      }
      await refreshItems();
      toast(`引用量已更新 ${updated} 篇${failed ? '，失败 ' + failed + ' 篇（保留旧值）' : ''}`);
    } catch (e) {
      toast('刷新失败：' + (e.message || ''), true);
    }
  }

  function showTimeline() { return switchBoard('timeline'); }

  /** 通用领域 Skill 管理弹窗（支持 lineage / idea / experiment 浏览与 GitHub SKILL.md 导入） */
  async function showDomainSkillsModal(domain, titleLabel, onAfterChange) {
    const dom = String(domain || 'lineage');
    let list = [];
    try { list = await svc('skills', 'listSkills', dom, { includeContent: true }); } catch (e) { return toast('读取 Skills 失败：' + e.message, true); }
    const cards = list.map((sk) => `
      <div class="domain-skill-card">
        <div class="dsc-head">
          <strong>${esc(sk.name)}</strong>
          <span class="dsc-badge">${esc(sk.badge || (sk.builtin ? '内置技能' : 'GitHub 导入'))}</span>
          ${sk.githubRepo ? `<button type="button" class="btn ghost sm" data-open-repo="${esc(sk.githubRepo)}">${ico('external', 12)}GitHub</button>` : ''}
          ${!sk.builtin ? `<button type="button" class="btn ghost sm btn-danger-ghost" data-del-dskill="${esc(sk.id)}">${ico('trash', 12)}删除</button>` : ''}
        </div>
        <div class="dsc-summary">${esc(sk.summary || '')}</div>
        ${Array.isArray(sk.workflowSteps) && sk.workflowSteps.length ? `<ul class="dsc-steps">${sk.workflowSteps.map((st) => `<li>${esc(st)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');

    openModal(`${titleLabel}（${list.length} 个已内嵌）`, `
      <div class="domain-skill-list">${cards || '<div class="hint">暂无可用 Skill</div>'}</div>
      <div class="domain-skill-import">
        <div class="dsi-title">${ico('download', 14)}从 GitHub 导入 ${esc(dom)} 领域 SKILL.md</div>
        <div class="dsi-row">
          <input id="dSkillGithubInput" class="search-input" placeholder="owner/repo 或 https://github.com/.../SKILL.md">
          <input id="dSkillNameInput" class="search-input" style="max-width:170px" placeholder="自定义名称（可选）">
          <button type="button" class="btn sm" id="dSkillImportBtn">${ico('download', 13)}拉取并内嵌</button>
          <button type="button" class="btn ghost sm" id="dSkillLocalBtn">${ico('upload', 13)}本地文件</button>
        </div>
        <div id="dSkillDiscovered"></div>
      </div>
      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>
    `, (modal) => {
      modal.querySelectorAll('[data-open-repo]').forEach((b) => b.addEventListener('click', () => window.bridge.shell.open(b.dataset.openRepo)));
      modal.querySelectorAll('[data-del-dskill]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await svc('skills', 'deleteSkill', b.dataset.delDskill, dom);
          toast('已删除自定义 Skill');
          if (onAfterChange) await onAfterChange();
          await showDomainSkillsModal(dom, titleLabel, onAfterChange);
        } catch (err) { toast('删除失败：' + err.message, true); }
      }));
      const runGhImport = async (rawUrl, customName = '') => {
        const btn = modal.querySelector('#dSkillImportBtn');
        const box = modal.querySelector('#dSkillDiscovered');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 导入中…';
        if (box) box.innerHTML = '';
        try {
          const saved = await svc('skills', 'importSkillFromGithub', rawUrl, { domain: dom, customName });
          toast(`已内嵌 Skill：${saved.name}`);
          if (onAfterChange) await onAfterChange();
          await showDomainSkillsModal(dom, titleLabel, onAfterChange);
        } catch (err) {
          const msg = String((err && err.message) || err || '导入失败');
          toast('导入失败：' + msg, true);
          const repoMatch = rawUrl.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
          if (repoMatch && /包含\s*\d+\s*个\s*SKILL\.md/i.test(msg) && box) {
            try {
              const paths = await svc('skills', 'discoverGithubSkillFiles', repoMatch[1], repoMatch[2]);
              if (Array.isArray(paths) && paths.length) {
                box.innerHTML = `<div class="skill-discovered-list"><div class="hint" style="margin:6px 0">检测到多个 SKILL.md，点选导入：</div><div class="skill-discovered-chips">${paths.slice(0, 12).map((p) => `<button type="button" class="dpf-chip" data-pick-dgh="${esc(`${repoMatch[1]}/${repoMatch[2]}/${p}`)}">${esc(p)}</button>`).join('')}</div></div>`;
                box.querySelectorAll('[data-pick-dgh]').forEach((pb) => pb.addEventListener('click', () => {
                  modal.querySelector('#dSkillGithubInput').value = pb.dataset.pickDgh;
                  runGhImport(pb.dataset.pickDgh, modal.querySelector('#dSkillNameInput').value.trim());
                }));
              }
            } catch (_) { /* ignore */ }
          }
          if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('download', 13)}拉取并内嵌`; }
        }
      };
      modal.querySelector('#dSkillImportBtn').addEventListener('click', () => {
        const u = modal.querySelector('#dSkillGithubInput').value.trim();
        if (!u) return toast('请输入 GitHub 仓库或 SKILL.md 链接', true);
        runGhImport(u, modal.querySelector('#dSkillNameInput').value.trim());
      });
      modal.querySelector('#dSkillLocalBtn').addEventListener('click', async () => {
        const paths = await window.bridge.dialog.openFiles({ title: '选择 SKILL.md 文件', filters: [{ name: 'Markdown', extensions: ['md'] }] });
        if (!paths.length) return;
        try {
          const saved = await svc('skills', 'importSkillFromFile', paths[0], { domain: dom });
          toast(`已导入本地 Skill：${saved.name}`);
          if (onAfterChange) await onAfterChange();
          await showDomainSkillsModal(dom, titleLabel, onAfterChange);
        } catch (err) { toast('导入失败：' + err.message, true); }
      });
    }, 'wide');
  }

  async function renderTimelineBoard() {
    const root = $('#timelinePage');
    if (window.Timeline) window.Timeline.destroy();
    const requestId = (S.timelineRequestId || 0) + 1;
    S.timelineRequestId = requestId;
    const workspace = S.ws;
    root.innerHTML = '<div class="timeline-loading">正在汇总论文引用与脉络结构…</div>';
    let graph;
    let lineageSkills = [];
    try {
      [graph, lineageSkills] = await Promise.all([
        call('getCitationGraph', workspace, S.searchResults || []),
        svc('skills', 'listSkills', 'lineage').catch(() => [])
      ]);
    } catch (error) {
      if (requestId === S.timelineRequestId && S.board === 'timeline') {
        root.innerHTML = `<div class="timeline-loading is-error">${ico('timeline', 18)}载入失败：${esc(error.message)}</div>`;
      }
      return;
    }
    if (requestId !== S.timelineRequestId || S.board !== 'timeline' || S.ws !== workspace) return;

    const years = (graph.nodes || []).map((node) => node.year).filter(Boolean);
    const minYear = years.length ? Math.min.apply(null, years) : '';
    const maxYear = years.length ? Math.max.apply(null, years) : '';
    const categoryOf = (edge) => ['references', 'referenced_works', 'cites'].includes(edge.via) ? 'citation' : edge.via;
    const labels = {
      citation: '直接引用',
      notes: '笔记中的显式引用',
      coupling: '共同参考文献',
      cocitation: '共同被引',
      coauthor: '共同作者'
    };
    const categories = ['citation', 'coupling', 'cocitation', 'coauthor', 'notes'];
    const categoryCounts = (graph.edges || []).reduce((counts, edge) => {
      const category = categoryOf(edge);
      counts[category] = (counts[category] || 0) + 1;
      return counts;
    }, {});
    const unhydratedCount = (graph.nodes || []).filter((n) => n.source === 'local' && !n.openalexId).length;
    const missingTopCount = (graph.missingSeeds && Array.isArray(graph.missingSeeds.topCited)) ? graph.missingSeeds.topCited.length : 0;
    const cachedSynthesis = S._lineageSynthesis && S._lineageSynthesis.ws === workspace ? S._lineageSynthesis.data : null;
    const cachedMissing = S._lineageMissing && S._lineageMissing.ws === workspace ? S._lineageMissing.data : null;
    let activeSubTab = S._lineageTab || 'graph';

    const nodeOptionsHtml = () => (graph.nodes || []).map((node) =>
      `<option value="${esc(node.key)}">${esc(String(node.label).slice(0, 64))}${node.year ? ` · ${node.year}` : ''}</option>`
    ).join('');

    root.innerHTML = `<div class="paper-network-shell lineage-v5-shell">
      <header class="paper-network-header">
        <div>
          <div class="paper-network-eyebrow">${ico('timeline', 15)} 学术谱系与文献脉络引擎（PaperWeave / LocalCitationNetwork / Inciteful）</div>
          <h1>论文脉络</h1>
          <p>支持元数据与引文一键补全、核心骨干 DAG 分层、两篇论文最短演化路径、缺失奠基文献发现，以及 AI 五维文献综述与研究缺口直连 Idea 孵化。</p>
        </div>
        <div class="paper-network-actions lineage-top-actions">
          <button class="btn sm" id="tlHydrateBtn" title="联网为缺失 OpenAlex/引文列表的本地论文补全元数据与引用边">${ico('refresh', 13)}补全引文元数据${unhydratedCount ? ` (${unhydratedCount})` : ''}</button>
          <button class="btn ghost sm" id="tlMissingBtn" title="基于 LocalCitationNetwork 算法发现本地库缺失的奠基与跟进文献">${ico('search', 13)}缺失关键文献${missingTopCount ? ` (${missingTopCount})` : ''}</button>
          <select id="tlSkillSelect" class="lineage-skill-select" title="选择脉络分析 Skill">
            ${(lineageSkills.length ? lineageSkills : [{ id: 'research-genealogy', name: 'Research Genealogy' }]).map((sk) =>
              `<option value="${esc(sk.id)}">${esc(sk.name)}</option>`
            ).join('')}
          </select>
          <button class="btn sm" id="tlSynthesizeBtn" title="调用选定脉络 Skill 生成学术谱系、对比矩阵、阅读队列与研究缺口">${ico('sparkle', 13)}AI 脉络综述</button>
          <button class="btn ghost sm" id="tlSkillsBtn" title="查看内置脉络 Skills 或从 GitHub 导入">${ico('book', 13)}Skills</button>
        </div>
      </header>

      <nav class="lineage-subtabs" role="tablist">
        <button type="button" class="lineage-subtab ${activeSubTab === 'graph' ? 'active' : ''}" data-ltab="graph">${ico('network', 13)}脉络图谱 & 最短路径</button>
        <button type="button" class="lineage-subtab ${activeSubTab === 'synthesis' ? 'active' : ''}" data-ltab="synthesis">${ico('sparkle', 13)}AI 谱系综述 & 研究缺口${cachedSynthesis ? ` (${(cachedSynthesis.lineage.researchGaps || []).length})` : ''}</button>
        <button type="button" class="lineage-subtab ${activeSubTab === 'matrix' ? 'active' : ''}" data-ltab="matrix">${ico('list', 13)}六列文献对比矩阵</button>
        <button type="button" class="lineage-subtab ${activeSubTab === 'missing' ? 'active' : ''}" data-ltab="missing">${ico('gitBranch', 13)}缺失核心文献${cachedMissing ? ` (${(cachedMissing.topCited || []).length + (cachedMissing.topCiting || []).length})` : ''}</button>
      </nav>

      <div id="lineageTabGraph" class="lineage-tab-pane ${activeSubTab === 'graph' ? 'active' : ''}">
        <section class="paper-network-filterbar">
          <div class="paper-network-relations">
            <span class="filter-caption">关系类型</span>
            ${categories.map((category) => `<label class="relation-toggle relation-${category}">
              <input type="checkbox" data-reltype="${category}" checked>
              <span class="relation-swatch"></span>${labels[category]}
              <small>${categoryCounts[category] || 0}</small>
            </label>`).join('')}
          </div>
          <div class="timeline-controls">
            <select id="tlLayout" title="切换脉络图布局">
              <option value="backbone">核心骨干 DAG</option>
              <option value="network">关系网络</option>
              <option value="timeline">发表时间轴</option>
            </select>
            <select id="tlSource" title="按来源筛选"><option value="all">全部来源</option><option value="local">仅已入库</option><option value="search">仅检索暂存</option></select>
            <input type="number" id="tlFrom" placeholder="起始年" value="${minYear}" min="1900" max="2100" title="起始年份">
            <span class="hint">—</span>
            <input type="number" id="tlTo" placeholder="结束年" value="${maxYear}" min="1900" max="2100" title="结束年份">
            <select id="tlDir" title="按关系方向筛选">
              <option value="all">全部方向</option><option value="out">有向关系发出</option>
              <option value="in">有向关系指向</option><option value="connected">至少有一条关系</option>
            </select>
            <select id="tlMinStrength" title="推导关系最小证据数量">
              <option value="1">至少 1 项证据</option><option value="2">至少 2 项证据</option>
              <option value="3">至少 3 项证据</option>
            </select>
            <select id="tlFocus" title="选择论文并高亮一跳关系">
              <option value="">聚焦某论文…</option>
              ${nodeOptionsHtml()}
            </select>
            <button class="btn ghost sm" id="tlCitedBy" title="按需联网查询谁引用了聚焦论文">${ico('network', 12)}谁引用它</button>
            <button class="btn ghost sm" id="tlZoomIn" title="放大">${ico('plus', 12)}</button>
            <button class="btn ghost sm" id="tlZoomOut" title="缩小">${ico('minus', 12)}</button>
            <button class="btn ghost sm" id="tlReset" title="重置视图">${ico('refresh', 12)}</button>
          </div>
          <div class="lineage-pathbar">
            <span class="filter-caption">${ico('arrowRight', 13)}最短演化路径</span>
            <select id="tlPathFrom"><option value="">起点论文（如早期奠基）…</option>${nodeOptionsHtml()}</select>
            <span class="hint">→</span>
            <select id="tlPathTo"><option value="">终点论文（如前沿新作）…</option>${nodeOptionsHtml()}</select>
            <button type="button" class="btn ghost sm" id="tlFindPathBtn">查找演进链</button>
            <button type="button" class="btn ghost sm" id="tlClearPathBtn">清除高亮</button>
            <span id="tlPathResult" class="lineage-path-result"></span>
          </div>
        </section>
        <div class="paper-network-summary" id="tlCounts"></div>
        ${graph.edges.length === 0 && unhydratedCount > 0 ? `<div class="lineage-hydrate-banner">${ico('zap', 14)}当前工作区有 <b>${unhydratedCount}</b> 篇本地论文尚未关联 OpenAlex 引文数据，导致图谱关系边为 0。点击右上角「补全引文元数据」即可自动建立引文脉络并发现缺失奠基文献。</div>` : ''}
        <div class="timeline-legend">
          <span class="lg-item"><span class="lg-line"></span>有向引用</span>
          <span class="lg-item"><span class="lg-line dashed"></span>推导关系</span>
          <span class="lg-item"><span class="lg-line dashed"></span>虚线节点：仅检索暂存</span>
          <span class="lg-item">骨干 DAG 模式自动剪枝毛线球噪音并按奠基→前沿分层</span>
        </div>
        <section class="paper-network-main">
          <div id="timelineRoot" class="paper-network-canvas"></div>
          <aside id="timelineDetail" class="paper-network-detail">
            <div class="timeline-detail-empty">${ico('network', 22)}<strong>选择一个节点查看</strong><span>点击论文节点可查看它与其他论文的关系证据、设为路径起点或发起前向引文追踪</span></div>
          </aside>
        </section>
      </div>

      <div id="lineageTabSynthesis" class="lineage-tab-pane ${activeSubTab === 'synthesis' ? 'active' : ''}"></div>
      <div id="lineageTabMatrix" class="lineage-tab-pane ${activeSubTab === 'matrix' ? 'active' : ''}"></div>
      <div id="lineageTabMissing" class="lineage-tab-pane ${activeSubTab === 'missing' ? 'active' : ''}"></div>
    </div>`;

    const switchSubTab = (tab) => {
      activeSubTab = tab;
      S._lineageTab = tab;
      root.querySelectorAll('[data-ltab]').forEach((b) => b.classList.toggle('active', b.dataset.ltab === tab));
      root.querySelector('#lineageTabGraph').classList.toggle('active', tab === 'graph');
      root.querySelector('#lineageTabSynthesis').classList.toggle('active', tab === 'synthesis');
      root.querySelector('#lineageTabMatrix').classList.toggle('active', tab === 'matrix');
      root.querySelector('#lineageTabMissing').classList.toggle('active', tab === 'missing');
    };
    root.querySelectorAll('[data-ltab]').forEach((b) => b.addEventListener('click', () => switchSubTab(b.dataset.ltab)));

    const renderSynthesisViews = (res) => {
      const synPane = root.querySelector('#lineageTabSynthesis');
      const matPane = root.querySelector('#lineageTabMatrix');
      if (!res || !res.lineage) {
        synPane.innerHTML = `<div class="lineage-empty-panel">${ico('sparkle', 24)}<h3>尚未生成 AI 脉络综述</h3><p>点击顶部「AI 脉络综述」将基于选定的 GitHub 脉络 Skill（PaperWeave / Five-Lens）梳理演进叙事、推荐阅读队列与严格引用校验的研究缺口。</p><button type="button" class="btn" id="tlRunSynInline">${ico('sparkle', 14)}立即生成脉络综述</button></div>`;
        synPane.querySelector('#tlRunSynInline')?.addEventListener('click', () => root.querySelector('#tlSynthesizeBtn').click());
        matPane.innerHTML = `<div class="lineage-empty-panel">${ico('list', 24)}<h3>尚未生成六列文献对比矩阵</h3><p>运行「AI 脉络综述」后将自动抽取每篇论文的任务、方法、核心假设、数据集、指标与局限性。</p></div>`;
        return;
      }
      const lin = res.lineage;
      const gaps = Array.isArray(lin.researchGaps) ? lin.researchGaps : [];
      const queue = Array.isArray(lin.readingQueue) ? lin.readingQueue : [];
      const edges = Array.isArray(lin.edges) ? lin.edges : [];
      const matrix = Array.isArray(lin.matrix) ? lin.matrix : [];
      synPane.innerHTML = `<div class="lineage-syn-grid">
        <div class="lineage-syn-card lineage-syn-full">
          <div class="lsc-head">
            <h3>${ico('book', 15)}学术演进叙事</h3>
            <span class="lsc-badge ${res.citationsVerified ? 'is-ok' : 'is-warn'}">${res.citationsVerified ? 'OpenScholar 引用核验通过' : '已过滤未验证引用'}</span>
            ${res.fallbackUsed ? '<span class="lsc-badge">离线结构化模式</span>' : `<span class="lsc-badge is-ai">Skill: ${esc(res.skillId || '')}</span>`}
            <button type="button" class="btn ghost sm" id="tlCopyLineageMd" style="margin-left:auto">${ico('copy', 12)}复制综述 Markdown</button>
          </div>
          <p class="lsc-narrative">${esc(lin.narrative || '')}</p>
          ${Array.isArray(lin.eras) && lin.eras.length ? `<div class="lsc-eras">演进时间跨度：${lin.eras.map((e) => `<span class="lsc-era-chip">${esc(e)}</span>`).join(' → ')}</div>` : ''}
        </div>
        <div class="lineage-syn-card">
          <div class="lsc-head"><h3>${ico('lightbulb', 15)}识别到的研究缺口（${gaps.length}）</h3></div>
          <div class="lsc-gap-list">${gaps.length ? gaps.map((g, gi) => `
            <div class="lsc-gap-item">
              <div class="lsc-gap-top">
                <strong>${esc(g.title || `研究缺口 ${gi + 1}`)}</strong>
                <button type="button" class="btn sm" data-gap-to-idea="${gi}">${ico('lightbulb', 12)}送入 Idea 孵化</button>
              </div>
              <p>${esc(g.gap || '')}</p>
              ${g.whyUnresolved ? `<div class="hint">尚未解决原因：${esc(g.whyUnresolved)}</div>` : ''}
              ${g.suggestedDirection ? `<div class="lsc-gap-dir">建议切入点：${esc(g.suggestedDirection)}</div>` : ''}
              ${Array.isArray(g.evidencePaperIds) && g.evidencePaperIds.length ? `<div class="lsc-gap-refs">${g.evidencePaperIds.map((pid) => `<span class="md-ref" data-ref="${esc(pid)}">${esc(pid)}</span>`).join(' ')}</div>` : ''}
            </div>`).join('') : '<div class="hint">暂无明确研究缺口</div>'}
          </div>
        </div>
        <div class="lineage-syn-card">
          <div class="lsc-head"><h3>${ico('list', 15)}渐进精读队列（${queue.length}）</h3></div>
          <ol class="lsc-queue">${queue.length ? queue.map((q) => `
            <li>
              <div class="lsc-q-head">
                <span class="md-ref" data-ref="${esc(q.id)}">${esc(q.id)}</span>
                ${q.stage ? `<span class="lsc-stage">${esc(q.stage)}</span>` : ''}
              </div>
              <div class="lsc-q-reason">${esc(q.reason || '')}</div>
            </li>`).join('') : '<li class="hint">暂无排序论文</li>'}</ol>
          <div class="lsc-head" style="margin-top:14px"><h3>${ico('gitBranch', 15)}关键演进边（${edges.length}）</h3></div>
          <div class="lsc-edge-list">${edges.slice(0, 12).map((e) => `<div class="lsc-edge-row"><code>${esc(e.source)}</code> <span class="lsc-edge-type">${esc(e.type)}</span> <code>${esc(e.target)}</code><span>${esc(e.rationale || '')}</span></div>`).join('') || '<div class="hint">暂无演进边</div>'}</div>
        </div>
      </div>`;
      bindRefClicks(synPane);
      synPane.querySelector('#tlCopyLineageMd')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(res.markdown || ''); toast('已复制论文脉络综述 Markdown'); } catch (_) { toast('复制失败', true); }
      });
      synPane.querySelectorAll('[data-gap-to-idea]').forEach((btn) => btn.addEventListener('click', async () => {
        const g = gaps[Number(btn.dataset.gapToIdea)];
        if (!g) return;
        try {
          await context.actions.openWithSeed({
            title: g.title || '来自论文脉络的研究构想',
            problem: g.gap || '',
            gap: g.whyUnresolved || g.gap || '',
            hypothesis: g.suggestedDirection || '',
            groundedPapers: Array.isArray(g.evidencePaperIds) ? g.evidencePaperIds : [],
            source: '论文脉络缺口分析'
          });
        } catch (err) { toast('送入 Idea 失败：' + err.message, true); }
      }));

      matPane.innerHTML = `<div class="lineage-matrix-wrap">
        <div class="lsc-head" style="margin-bottom:10px">
          <h3>${ico('list', 15)}六列文献横向对比矩阵（${matrix.length} 篇）</h3>
          <button type="button" class="btn ghost sm" id="tlCopyMatrixMd" style="margin-left:auto">${ico('copy', 12)}复制表格 Markdown</button>
        </div>
        <div class="data-table-wrap">
          <table class="data-table lineage-matrix-table">
            <thead><tr><th>论文</th><th>年份</th><th>任务</th><th>核心方法</th><th>核心假设</th><th>基准数据集</th><th>指标</th><th>局限性</th></tr></thead>
            <tbody>${matrix.map((m) => `<tr>
              <td><span class="md-ref" data-ref="${esc(m.id)}">${esc(m.title || m.id)}</span></td>
              <td>${esc(m.year || '-')}</td>
              <td>${esc(m.task || '-')}</td>
              <td>${esc(m.method || '-')}</td>
              <td>${esc(m.assumption || '-')}</td>
              <td>${esc(m.dataset || '-')}</td>
              <td>${esc(m.metric || '-')}</td>
              <td>${esc(m.limitation || '-')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
      bindRefClicks(matPane);
      matPane.querySelector('#tlCopyMatrixMd')?.addEventListener('click', async () => {
        const header = '| 论文 | 年份 | 任务 | 核心方法 | 核心假设 | 数据集 | 指标 | 局限性 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
        const rows = matrix.map((m) => '| ' + [m.title || m.id, m.year, m.task, m.method, m.assumption, m.dataset, m.metric, m.limitation].map((v) => String(v || '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ') + ' |');
        try { await navigator.clipboard.writeText([header, ...rows].join('\n')); toast('已复制六列文献对比矩阵'); } catch (_) { toast('复制失败', true); }
      });
    };

    const renderMissingView = (res) => {
      const pane = root.querySelector('#lineageTabMissing');
      if (!res) {
        pane.innerHTML = `<div class="lineage-empty-panel">${ico('gitBranch', 24)}<h3>尚未扫描缺失核心文献</h3><p>基于 LocalCitationNetwork 算法，统计本地库论文未展开引文的共引频次（Top Cited 奠基文献）及共同引用本地论文的最新跟进工作（Top Citing）。</p><button type="button" class="btn" id="tlScanMissingInline">${ico('search', 14)}立即发现缺失核心文献</button></div>`;
        pane.querySelector('#tlScanMissingInline')?.addEventListener('click', () => root.querySelector('#tlMissingBtn').click());
        return;
      }
      const renderSeedList = (items, roleLabel, bucket) => {
        if (!items || !items.length) return `<div class="hint">暂未发现${roleLabel}（如刚导入 PDF 请先点击「补全引文元数据」）</div>`;
        return items.map((p, idx) => `<div class="lineage-seed-card">
          <div class="seed-card-main">
            <div class="seed-card-title">${esc(p.title || p.openalexId)}</div>
            <div class="seed-card-meta">${esc(p.publicationDate || p.published || '未知日期')} · 引用 ${fmtCites(p.citedByCount)}${p.venue ? ` · ${esc(p.venue)}` : ''}</div>
            <div class="seed-card-reason">${esc(p.reason || '')}</div>
          </div>
          <div class="seed-card-actions">
            ${p.oaUrl ? `<button type="button" class="btn ghost sm" data-open-url="${esc(p.oaUrl)}">${ico('external', 12)}查看</button>` : ''}
            <button type="button" class="btn sm" data-import-seed="${bucket}:${idx}">${ico('plus', 12)}一键入库</button>
          </div>
        </div>`).join('');
      };
      pane.innerHTML = `<div class="lineage-missing-grid">
        <div class="lineage-syn-card">
          <div class="lsc-head"><h3>${ico('book', 15)}缺失奠基文献 · Top Cited（${(res.topCited || []).length}）</h3><span class="hint">被本地库多篇论文共同引用</span></div>
          <div class="lineage-seed-list">${renderSeedList(res.topCited, '缺失奠基文献', 'cited')}</div>
        </div>
        <div class="lineage-syn-card">
          <div class="lsc-head"><h3>${ico('zap', 15)}前沿后续文献 · Top Citing（${(res.topCiting || []).length}）</h3><span class="hint">同时引用本地多篇论文的新作</span></div>
          <div class="lineage-seed-list">${renderSeedList(res.topCiting, '前沿后续文献', 'citing')}</div>
        </div>
      </div>`;
      pane.querySelectorAll('[data-open-url]').forEach((b) => b.addEventListener('click', () => window.bridge.shell.open(b.dataset.openUrl)));
      pane.querySelectorAll('[data-import-seed]').forEach((b) => b.addEventListener('click', async () => {
        const [bucket, idxStr] = b.dataset.importSeed.split(':');
        const arr = bucket === 'cited' ? (res.topCited || []) : (res.topCiting || []);
        const cand = arr[Number(idxStr)];
        if (!cand) return;
        b.disabled = true; b.textContent = '入库中…';
        try {
          await doImportPicks([cand], S.ws);
        } finally {
          if (b.isConnected) { b.disabled = false; b.textContent = '已处理'; }
        }
      }));
    };

    renderSynthesisViews(cachedSynthesis);
    renderMissingView(cachedMissing);

    const mount = root.querySelector('#timelineRoot');
    if (!window.Timeline) {
      mount.innerHTML = `<div class="chart-empty">${ico('timeline', 18)}<span>脉络图模块未加载</span></div>`;
      return;
    }
    const focusSelect = root.querySelector('#tlFocus');
    const selectedCategories = () => new Set(Array.from(root.querySelectorAll('[data-reltype]:checked')).map((input) => input.dataset.reltype));
    const relationEvidenceCount = (edge) => Number(edge.sharedReferenceCount || edge.coCitedByCount || edge.sharedAuthorCount || 1);
    const eligibleEdges = () => {
      const categoriesOn = selectedCategories();
      const minStrength = Number(root.querySelector('#tlMinStrength').value) || 1;
      return (graph.edges || []).filter((edge) => categoriesOn.has(categoryOf(edge)) &&
        (categoryOf(edge) === 'citation' || categoryOf(edge) === 'notes' || relationEvidenceCount(edge) >= minStrength));
    };
    const updateCounts = () => {
      const selectedNodes = root.querySelector('#timelineRoot').querySelectorAll('[data-nodekey]').length;
      const selectedEdges = root.querySelector('#timelineRoot').querySelectorAll('[data-edgeindex]').length;
      root.querySelector('#tlCounts').textContent =
        `显示 ${selectedNodes} / ${graph.nodes.length} 篇论文 · ${selectedEdges} / ${graph.edges.length} 条关系 · 库外引用 ${graph.stats.unresolvedEdgeCount || 0} 条未展开` +
        (missingTopCount ? ` · 可发现 ${missingTopCount} 篇缺失奠基文献` : '') +
        (graph.stats.inferredRelationCapped ? ' · 高密度推导关系按证据强度限量显示' : '');
      root.querySelectorAll('[data-reltype]').forEach((input) => {
        const category = input.dataset.reltype;
        const count = (graph.edges || []).filter((edge) => categoryOf(edge) === category).length;
        const badge = input.parentElement.querySelector('small');
        if (badge) badge.textContent = String(count);
      });
    };
    const applyFilters = () => {
      const src = root.querySelector('#tlSource').value;
      const from = Number(root.querySelector('#tlFrom').value) || -Infinity;
      const to = Number(root.querySelector('#tlTo').value) || Infinity;
      const dir = root.querySelector('#tlDir').value;
      const edges = eligibleEdges();
      const outs = new Set(), ins = new Set(), connected = new Set();
      edges.forEach((edge) => {
        connected.add(edge.from); connected.add(edge.to);
        if (edge.directed === false) {
          outs.add(edge.from); outs.add(edge.to); ins.add(edge.from); ins.add(edge.to);
        } else {
          outs.add(edge.from); ins.add(edge.to);
        }
      });
      Timeline.setEdgeFilter((edge) => edges.includes(edge));
      Timeline.setFilter((node) => {
        if (src !== 'all' && node.source !== src) return false;
        if (node.year && (node.year < from || node.year > to)) return false;
        if (dir === 'out' && !outs.has(node.key)) return false;
        if (dir === 'in' && !ins.has(node.key)) return false;
        if (dir === 'connected' && !connected.has(node.key)) return false;
        return true;
      });
      updateCounts();
    };
    const renderGraph = () => {
      Timeline.render(mount, graph, {
        layout: root.querySelector('#tlLayout').value,
        nodeClick: bindNodeClick
      });
      applyFilters();
      const focus = graph.nodes.find((node) => node.key === focusSelect.value);
      if (focus) Timeline.focus(focus.key);
    };
    const renderDetail = (node) => {
      const detail = root.querySelector('#timelineDetail');
      if (!node) {
        detail.innerHTML = `<div class="timeline-detail-empty">${ico('network', 22)}<strong>选择一个节点查看</strong><span>点击论文节点可查看它与其他论文的关系证据、设为路径起点或发起前向引文追踪</span></div>`;
        return;
      }
      const neighbors = (graph.edges || []).filter((edge) => edge.from === node.key || edge.to === node.key)
        .map((edge) => {
          const otherKey = edge.from === node.key ? edge.to : edge.from;
          const other = graph.nodes.find((candidate) => candidate.key === otherKey);
          if (!other) return '';
          let evidence = '';
          if (edge.via === 'coupling') evidence = `共享 ${edge.sharedReferenceCount} 篇参考文献`;
          else if (edge.via === 'cocitation') {
            const examples = (edge.coCitedBy || []).map((key) => graph.nodes.find((candidate) => candidate.key === key))
              .filter(Boolean).map((candidate) => candidate.label).slice(0, 3);
            evidence = `共同被 ${edge.coCitedByCount} 篇论文引用${examples.length ? ` · 例如 ${examples.join('、')}` : ''}`;
          }
          else if (edge.via === 'coauthor') evidence = `共同作者：${(edge.sharedAuthors || []).join('、')}`;
          else if (edge.via === 'notes') evidence = '笔记中显式链接';
          else evidence = edge.from === node.key ? '引用了该论文' : '被该论文引用';
          return `<button class="timeline-relation-row" data-neighbor="${esc(other.key)}">
            <span class="relation-badge relation-${esc(categoryOf(edge))}">${esc(labels[categoryOf(edge)] || '其他关系')}</span>
            <strong>${esc(other.label)}</strong><small>${esc(evidence)}</small>
          </button>`;
        }).join('');
      const authors = Array.isArray(node.authors) && node.authors.length ? node.authors.join('、') : '未提供';
      const idx = (S.searchResults || []).findIndex((paper) =>
        (node.openalexId && paper.openalexId === node.openalexId) || paper.title === node.label);
      const candidate = node.candidate || (idx >= 0 ? S.searchResults[idx] : null);
      detail.innerHTML = `<div class="timeline-detail-head">
          <span class="timeline-detail-source ${node.source === 'local' ? 'is-local' : 'is-search'}">${node.source === 'local' ? '已入库' : '检索暂存'}</span>
          <h2>${esc(node.label)}</h2>
          <p>${esc(authors)}</p>
        </div>
        <div class="timeline-detail-metrics"><span><small>发表</small><strong>${esc(node.pubDate || '未知')}</strong></span>
          <span><small>引用量</small><strong>${fmtCites(node.citedByCount)}</strong></span>
          <span><small>评级</small><strong>${esc(node.rating || '—')}</strong></span></div>
        <div class="timeline-detail-actions">
          ${node.source === 'local' ? '<button class="btn sm" id="tlOpenPaper">打开论文</button>' :
            `<button class="btn sm" id="tlImportPaper" ${candidate ? '' : 'disabled'}>入库论文</button>`}
          <button type="button" class="btn ghost sm" id="tlSetPathStart">设为路径起点</button>
          <button type="button" class="btn ghost sm" id="tlSetPathEnd">设为路径终点</button>
          ${node.openalexId ? `<button type="button" class="btn ghost sm" id="tlOpenExternal" data-open="https://openalex.org/${encodeURIComponent(node.openalexId)}">${ico('external', 12)}OpenAlex</button>` : ''}
        </div>
        <div class="timeline-relations-title">关系证据 <span>${neighbors ? (graph.edges || []).filter((edge) => edge.from === node.key || edge.to === node.key).length : 0}</span></div>
        <div class="timeline-relation-list">${neighbors || '<div class="timeline-no-relations">当前图中没有已确认的相邻关系</div>'}</div>`;
      detail.querySelectorAll('[data-neighbor]').forEach((button) => button.addEventListener('click', () => {
        const next = graph.nodes.find((candidate) => candidate.key === button.dataset.neighbor);
        if (next) {
          focusSelect.value = next.key;
          Timeline.focus(next.key);
          renderDetail(next);
        }
      }));
      detail.querySelector('#tlOpenPaper')?.addEventListener('click', async () => {
        S.lastSelected.papers = node.id;
        await switchBoard('papers');
      });
      detail.querySelector('#tlImportPaper')?.addEventListener('click', async () => {
        if (idx >= 0) await importOne(idx);
        else if (candidate) await doImportPicks([candidate], S.ws);
      });
      detail.querySelector('#tlSetPathStart')?.addEventListener('click', () => {
        root.querySelector('#tlPathFrom').value = node.key;
        toast('已设为演化路径起点');
      });
      detail.querySelector('#tlSetPathEnd')?.addEventListener('click', () => {
        root.querySelector('#tlPathTo').value = node.key;
        toast('已设为演化路径终点');
      });
      detail.querySelector('#tlOpenExternal')?.addEventListener('click', (e) => {
        const url = e.currentTarget.dataset.open;
        if (url) window.bridge.shell.open(url);
      });
    };
    const bindNodeClick = (node) => {
      if (!node) return;
      focusSelect.value = node.key;
      Timeline.focus(node.key);
      renderDetail(node);
    };

    root.querySelector('#tlLayout').addEventListener('change', (event) => {
      Timeline.setLayout(event.target.value);
      updateCounts();
    });
    ['tlSource', 'tlFrom', 'tlTo', 'tlDir', 'tlMinStrength'].forEach((id) =>
      root.querySelector('#' + id).addEventListener('change', applyFilters));
    root.querySelectorAll('[data-reltype]').forEach((input) => input.addEventListener('change', applyFilters));
    focusSelect.addEventListener('change', () => {
      const node = graph.nodes.find((candidate) => candidate.key === focusSelect.value);
      Timeline.focus(focusSelect.value);
      if (node) renderDetail(node);
    });
    root.querySelector('#tlZoomIn').addEventListener('click', () => Timeline.zoom(0.15));
    root.querySelector('#tlZoomOut').addEventListener('click', () => Timeline.zoom(-0.15));
    root.querySelector('#tlReset').addEventListener('click', () => {
      root.querySelector('#tlSource').value = 'all';
      root.querySelector('#tlFrom').value = minYear;
      root.querySelector('#tlTo').value = maxYear;
      root.querySelector('#tlDir').value = 'all';
      root.querySelector('#tlMinStrength').value = '1';
      root.querySelectorAll('[data-reltype]').forEach((input) => { input.checked = true; });
      focusSelect.value = '';
      root.querySelector('#tlPathResult').textContent = '';
      Timeline.reset();
      renderDetail(null);
      applyFilters();
    });

    // 最短演化路径查找
    root.querySelector('#tlFindPathBtn').addEventListener('click', async () => {
      const fromKey = root.querySelector('#tlPathFrom').value;
      const toKey = root.querySelector('#tlPathTo').value;
      if (!fromKey || !toKey) return toast('请先选择起点和终点论文', true);
      try {
        const res = await svc('lineage', 'findShortestEvolutionPath', graph, fromKey, toKey);
        const outEl = root.querySelector('#tlPathResult');
        if (res && res.found) {
          Timeline.highlightPath(res.nodeKeys, res.edges);
          outEl.textContent = res.explanation;
          outEl.classList.remove('is-error');
        } else {
          Timeline.highlightPath(null);
          outEl.textContent = (res && res.explanation) || '未找到演化路径';
          outEl.classList.add('is-error');
        }
      } catch (err) { toast('路径查找失败：' + err.message, true); }
    });
    root.querySelector('#tlClearPathBtn').addEventListener('click', () => {
      Timeline.highlightPath(null);
      root.querySelector('#tlPathResult').textContent = '';
    });

    // 批量补全本地论文元数据与引文关系
    root.querySelector('#tlHydrateBtn').addEventListener('click', async () => {
      const btn = root.querySelector('#tlHydrateBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 补全中…';
      toast('正在联网匹配 OpenAlex 元数据与参考文献列表…');
      try {
        const res = await svc('lineage', 'hydrateWorkspacePapers', workspace);
        toast(`元数据补全完成：更新 ${res.updatedCount || 0} 篇，跳过 ${res.skippedCount || 0} 篇${res.errors && res.errors.length ? `，失败 ${res.errors.length} 篇` : ''}`);
        await renderTimelineBoard();
      } catch (err) {
        toast('补全失败：' + err.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('refresh', 13)}补全引文元数据`; }
      }
    });

    // 发现缺失关键文献
    root.querySelector('#tlMissingBtn').addEventListener('click', async () => {
      const btn = root.querySelector('#tlMissingBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 扫描中…';
      try {
        const res = await svc('lineage', 'discoverMissingKeyPapers', workspace, { staged: S.searchResults || [], limit: 12 });
        S._lineageMissing = { ws: workspace, data: res };
        renderMissingView(res);
        switchSubTab('missing');
        toast(`已发现 ${(res.topCited || []).length} 篇缺失奠基文献与 ${(res.topCiting || []).length} 篇跟进新作`);
      } catch (err) {
        toast('发现缺失文献失败：' + err.message, true);
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('search', 13)}缺失关键文献`; }
      }
    });

    // AI 脉络综述与缺口分析
    root.querySelector('#tlSynthesizeBtn').addEventListener('click', async () => {
      const btn = root.querySelector('#tlSynthesizeBtn');
      const skillId = root.querySelector('#tlSkillSelect').value || 'research-genealogy';
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 分析中…';
      try {
        const res = await ai('synthesizeLineage', {
          ws: workspace,
          graph,
          focusIds: focusSelect.value ? [focusSelect.value.replace(/^local:/, '')] : [],
          skillId,
          topic: workspace
        });
        S._lineageSynthesis = { ws: workspace, data: res };
        renderSynthesisViews(res);
        switchSubTab('synthesis');
        toast(res.fallbackUsed ? '已生成离线结构化脉络综述与对比矩阵' : 'AI 脉络综述与研究缺口分析已完成');
      } catch (err) {
        toast('脉络分析失败：' + err.message, true);
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('sparkle', 13)}AI 脉络综述`; }
      }
    });

    root.querySelector('#tlSkillsBtn').addEventListener('click', () => {
      showDomainSkillsModal('lineage', '论文脉络 Skills', () => renderTimelineBoard());
    });

    root.querySelector('#tlCitedBy').addEventListener('click', async () => {
      const node = graph.nodes.find((candidate) => candidate.key === focusSelect.value);
      if (!node) return toast('请先选择或点击一篇论文', true);
      if (!node.openalexId) return toast('该论文没有 OpenAlex ID，请先点击「补全引文元数据」', true);
      toast('正在查询谁引用了它…');
      try {
        const citers = await svc('openalex', 'citedBy', node.openalexId, { perPage: 50 });
        let added = 0;
        (citers || []).forEach((citer) => {
          if (!citer || !citer.openalexId) return;
          let citingNode = graph.nodes.find((candidate) => candidate.openalexId === citer.openalexId);
          if (!citingNode) {
            citingNode = {
              key: 'search:' + citer.openalexId, source: 'search', board: 'papers', id: citer.openalexId,
              label: String(citer.title || citer.openalexId).slice(0, 80), openalexId: citer.openalexId,
              pubDate: citer.publicationDate || '', year: Number(String(citer.publicationDate || '').slice(0, 4)) || 0,
              rating: citer.rating || '', citedByCount: Number(citer.citedByCount) || 0, authors: citer.authors || []
            };
            graph.nodes.push(citingNode);
            added++;
          }
          if (citingNode.source !== 'local') citingNode.candidate = citer;
          const from = citingNode.key;
          if (!(graph.edges || []).some((edge) => edge.from === from && edge.to === node.key && edge.via === 'cites')) {
            graph.edges.push({ from, to: node.key, via: 'cites', directed: true, weight: 1 });
          }
        });
        const optsHtml = nodeOptionsHtml();
        focusSelect.innerHTML = '<option value="">聚焦某论文…</option>' + optsHtml;
        root.querySelector('#tlPathFrom').innerHTML = '<option value="">起点论文…</option>' + optsHtml;
        root.querySelector('#tlPathTo').innerHTML = '<option value="">终点论文…</option>' + optsHtml;
        focusSelect.value = node.key;
        renderGraph();
        bindNodeClick(node);
        toast(`已加入 ${citers.length} 位引用者（新增 ${added} 篇论文）`);
      } catch (error) {
        toast('查询失败：' + (error.message || ''), true);
      }
    });
    renderGraph();
    if (graph.nodes.length > 120) toast('文献较多；建议切换「核心骨干 DAG」并按年份或关系类型筛选');
  }

  function bindingTimelineNodeClick(node) {
    if (!node) return;
    const root = $('#timelinePage');
    const focus = root && root.querySelector('#tlFocus');
    if (!focus) return;
    focus.value = node.key;
    focus.dispatchEvent(new Event('change', { bubbles: true }));
  }

      Object.assign(this, {
        showDiscovery, renderDiscoveryBoard, resizeDiscoveryComposer, bindDiscoverySplitter,
        renderDiscoveryRecent, runDiscovery, runDailyFrontier, runSnowballOnPaper,
        showSearchSkillsModal, showDomainSkillsModal, showExportModal, updateDiscoveryControls, renderDiscoveryResults,
        rateDiscoveryResult, autoRateDiscoveryResults, updateDiscoveryRatingBadge, showRatingDetail,
        importSelected, importOne, doImportPicks, refreshCitationsBtn,
        showTimeline, renderTimelineBoard, bindingTimelineNodeClick
      });
    }
  }
  namespace.DiscoveryController = DiscoveryController;
})();
