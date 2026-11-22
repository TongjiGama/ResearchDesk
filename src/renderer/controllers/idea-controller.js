(() => {
  const namespace = window.ResearchWorkbench;
  class IdeaController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { bindInlineFields, renderBoard, refreshItems, renderDetail, renderMarkdown, renderTextWithRefs, extractRefs, bindRefClicks, renderBacklinks, confirmDeleteItem, openModal, closeModal, showDomainSkillsModal } = context.actions;

  const listAsText = (arr) => Array.isArray(arr) ? arr.join('\n') : String(arr || '');
  const textToList = (txt) => String(txt || '').split(/\r?\n|；|;/).map((s) => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);

  function renderReviewSection(fm) {
    const rev = fm.review;
    if (!rev || !rev.scores) return '';
    const axes = [
      ['novelty', '新颖性'],
      ['feasibility', '可行性'],
      ['clarity', '清晰度'],
      ['significance', '重要性'],
      ['groundedness', '文献扎根']
    ];
    return `<section class="idea-analysis-card" id="ideaReviewCard">
      <div class="iac-head">
        <h3>${ico('shield', 14)}五维对抗评审（ResearchAgent / K-Dense）</h3>
        <span class="iac-score-pill">综合 ${esc(rev.overallScore || '—')} / 10</span>
        ${rev.fallbackUsed ? '<span class="iac-tag">离线规范评估</span>' : `<span class="iac-tag is-ai">Skill: ${esc(rev.skillId || 'hypothesis-critique')}</span>`}
        ${rev.revisedIdea ? `<button type="button" class="btn sm" id="applyRevisedIdeaBtn" style="margin-left:auto">${ico('check', 12)}采纳修订方案</button>` : ''}
      </div>
      <div class="idea-score-bars">
        ${axes.map(([k, label]) => {
          const val = Number(rev.scores[k]) || 0;
          return `<div class="isb-row"><span class="isb-label">${label}</span><div class="isb-track"><div class="isb-fill" style="width:${Math.min(100, val * 10)}%"></div></div><strong class="isb-num">${val}</strong></div>`;
        }).join('')}
      </div>
      <div class="iac-cols">
        <div>
          <div class="iac-sub">核心优势</div>
          <ul>${(rev.strengths || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="hint">暂无</li>'}</ul>
        </div>
        <div>
          <div class="iac-sub is-warn">审稿人质疑与弱点</div>
          <ul>${(rev.weaknesses || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="hint">暂无</li>'}</ul>
        </div>
      </div>
      ${Array.isArray(rev.rivalExplanations) && rev.rivalExplanations.length ? `<div class="iac-sub" style="margin-top:8px">竞争性解释（Rival Explanations）</div><ul>${rev.rivalExplanations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </section>`;
  }

  function renderNoveltySection(fm) {
    const nc = fm.noveltyCheck;
    if (!nc || !nc.verdict) return '';
    const lvl = nc.overlapLevel || 'low';
    const lvlCls = lvl === 'high' ? 'is-high' : lvl === 'medium' ? 'is-med' : 'is-low';
    return `<section class="idea-analysis-card" id="ideaNoveltyCard">
      <div class="iac-head">
        <h3>${ico('search', 14)}跨库新颖性查重与转向（AI-Scientist / SciMON）</h3>
        <span class="iac-overlap ${lvlCls}">${esc(nc.verdict)}</span>
        ${nc.checkedCount ? `<span class="hint">已核对 ${nc.checkedCount} 篇本地/外部文献</span>` : ''}
      </div>
      <p class="iac-diff">${esc(nc.differentiation || '')}</p>
      ${Array.isArray(nc.closestPapers) && nc.closestPapers.length ? `
        <div class="iac-sub">最相近文献</div>
        <div class="iac-closest-list">${nc.closestPapers.slice(0, 5).map((p) => `
          <div class="iac-closest-row">
            <div>
              <strong>${esc(p.title)}</strong> <span class="hint">${esc(p.year || '')} · ${esc(p.source || '')}</span>
              <div class="hint">${esc(p.overlapReason || '')}</div>
            </div>
            ${p.url ? `<button type="button" class="btn ghost sm" data-open-novelty-url="${esc(p.url)}">${ico('external', 12)}打开</button>` : ''}
          </div>`).join('')}</div>` : ''}
      ${Array.isArray(nc.pivotSuggestions) && nc.pivotSuggestions.length ? `
        <div class="iac-sub" style="margin-top:8px">SciMON 差异化转向建议</div>
        <div class="iac-pivot-list">${nc.pivotSuggestions.map((s, idx) => `
          <div class="iac-pivot-row">
            <span>${esc(s)}</span>
            <button type="button" class="btn ghost sm" data-apply-pivot="${idx}">写入假设/下一步</button>
          </div>`).join('')}</div>` : ''}
    </section>`;
  }

  function renderFeedbackSection(fm) {
    const list = Array.isArray(fm.experimentFeedback) ? fm.experimentFeedback : [];
    if (!list.length) return '';
    const polLabel = (p) => p === 'supports' ? '支持假设' : p === 'contradicts' ? '反驳 / 需修正' : '待检验';
    return `<section class="idea-analysis-card">
      <div class="iac-head"><h3>${ico('flask', 14)}实验结论回流记录（HypoRefine）</h3></div>
      <div class="iac-fb-list">${list.slice().reverse().map((fb) => `
        <div class="iac-fb-row">
          <div class="iac-fb-top">
            <span class="polarity-badge pol-${esc(fb.polarity || 'untested')}">${polLabel(fb.polarity)}</span>
            <span class="md-ref" data-ref="${esc(fb.expId)}">${esc(fb.expTitle || fb.expId)}</span>
            <span class="hint" style="margin-left:auto">${esc(fb.date || '')}</span>
          </div>
          ${fb.metrics ? `<div class="hint">指标：${esc(fb.metrics)}</div>` : ''}
          <div>${esc(fb.conclusion || '')}</div>
          ${fb.lesson ? `<div class="iac-lesson">假设修订建议：${esc(fb.lesson)}</div>` : ''}
        </div>`).join('')}</div>
    </section>`;
  }

  // ===== Idea 详情 =====
  function renderIdeaDetail(root, item) {
    const fm = item.frontmatter || {};
    const type = fm.type || 'idea';
    const stage = ideaStage({ ...fm, type });
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    const groundedPapers = Array.isArray(fm.groundedPapers) ? fm.groundedPapers : [];
    const assumptions = Array.isArray(fm.assumptions) ? fm.assumptions : [];
    const rivals = Array.isArray(fm.rivalExplanations) ? fm.rivalExplanations : [];
    const stageOptions = type === 'todo' ? TODO_STAGES : IDEA_STAGES;

    root.innerHTML = `<div class="detail idea-detail">
      <header class="idea-detail-head">
        <div class="idea-kicker">${type === 'todo' ? 'TASK' : 'IDEA'} · ${esc(item.id)}${Number(fm.elo) ? ` · <span class="idea-elo-pill">Elo ${esc(fm.elo)}</span>` : ''}</div>
        <div class="detail-title" data-inline="title" title="点击编辑标题">${esc(fm.title || item.id)}</div>
        <div class="idea-detail-meta">
          <span>创建于 ${esc(fm.createdAt || '—')}</span>
          <span>更新于 <span data-updated-at>${esc(fm.updatedAt || fm.createdAt || '—')}</span></span>
          ${fm.review && fm.review.overallScore ? `<span>评审分 <b>${esc(fm.review.overallScore)}/10</b></span>` : ''}
        </div>
        <div class="idea-actions">
          ${type === 'idea' ? `<button class="btn sm" id="ideaToExperimentBtn">${ico('flask', 14)}基于此 Idea 新建实验</button>` : ''}
          ${type === 'idea' ? `<button class="btn ghost sm" id="ideaReviewBtn">${ico('shield', 14)}五维对抗评审</button>` : ''}
          ${type === 'idea' ? `<button class="btn ghost sm" id="ideaNoveltyBtn">${ico('search', 14)}新颖性查重 (SciMON)</button>` : ''}
          <button class="btn ghost sm" id="ideaToggleType">${ico('refresh', 14)}${type === 'todo' ? '转为 Idea' : '转为待办'}</button>
          <button class="btn ghost sm btn-danger-ghost" id="delIdeaBtn">${ico('trash', 14)}删除</button>
        </div>
      </header>
      <div class="idea-workspace">
        <div class="idea-main-col">
          ${type === 'idea' ? `<section class="idea-main-card idea-hypothesis-card">
            <div class="idea-section-head">
              <div><div class="idea-section-kicker">STRUCTURED HYPOTHESIS</div><h2>科研假设工作区（CoI / ResearchAgent / K-Dense）</h2></div>
            </div>
            <div class="idea-struct-grid">
              <div class="idea-struct-field">
                <span class="isf-label">研究问题（Problem）</span>
                <div class="field-box" data-inline="problem" data-inline-multiline="true" title="点击编辑研究问题">${renderTextWithRefs(fm.problem || '点击界定具体科研痛点与失效场景')}</div>
              </div>
              <div class="idea-struct-field">
                <span class="isf-label">文献缺口（Literature Gap）</span>
                <div class="field-box" data-inline="gap" data-inline-multiline="true" title="点击编辑文献缺口">${renderTextWithRefs(fm.gap || '点击说明现有论文为何尚未解决该问题')}</div>
              </div>
              <div class="idea-struct-field isf-full">
                <span class="isf-label">可证伪因果假设（Falsifiable Hypothesis）</span>
                <div class="field-box isf-highlight" data-inline="hypothesis" data-inline-multiline="true" title="点击编辑可证伪假设">${renderTextWithRefs(fm.hypothesis || '若引入机制 X，则在条件 Y 下指标 Z 优于基线，且消融 X 后增益回落')}</div>
              </div>
              <div class="idea-struct-field isf-full">
                <span class="isf-label">核心方法设计（Methodology）</span>
                <div class="field-box" data-inline="methodology" data-inline-multiline="true" title="点击编辑方法设计">${renderTextWithRefs(fm.methodology || '点击描述单一变量改动点、模块结构与基线对比锚点')}</div>
              </div>
              <div class="idea-struct-field">
                <span class="isf-label">前提假设（Assumptions，换行分隔）</span>
                <div class="field-box" id="ideaAssumptionsBox" tabindex="0" title="点击编辑前提假设">${assumptions.length ? `<ul>${assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<span class="hint">点击填写方案成立所依赖的前提条件</span>'}</div>
              </div>
              <div class="idea-struct-field">
                <span class="isf-label">竞争性解释（Rival Explanations，换行分隔）</span>
                <div class="field-box" id="ideaRivalsBox" tabindex="0" title="点击编辑竞争性解释">${rivals.length ? `<ul>${rivals.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<span class="hint">点击预设可能的替代解释（如参数量/超参混杂）</span>'}</div>
              </div>
              <div class="idea-struct-field isf-full">
                <span class="isf-label">验证计划与成功标准（Validation Plan）</span>
                <div class="field-box" data-inline="validationPlan" data-inline-multiline="true" title="点击编辑验证计划">${renderTextWithRefs(fm.validationPlan || '点击填写基准数据集、核心指标、消融组与多种子统计协议')}</div>
              </div>
              <div class="idea-struct-field isf-full">
                <span class="isf-label">支撑文献锚点（Grounded Papers）</span>
                <div class="idea-grounded-row" id="ideaGroundedRow">
                  ${groundedPapers.map((pid) => `<span class="idea-paper-chip"><span class="md-ref" data-ref="${esc(pid)}">${esc(pid)}</span><button type="button" class="chip-rm" data-rm-gp="${esc(pid)}" title="移除">×</button></span>`).join('') || '<span class="hint">暂无支撑文献</span>'}
                  <button type="button" class="btn ghost sm" id="ideaAddPaperBtn">${ico('plus', 12)}关联论文</button>
                </div>
              </div>
            </div>
          </section>` : ''}

          ${renderReviewSection(fm)}
          ${renderNoveltySection(fm)}
          ${renderFeedbackSection(fm)}

          <section class="idea-main-card">
            <div class="idea-section-head"><div><div class="idea-section-kicker">NOTES</div><h2>${type === 'todo' ? '任务说明' : '自由构想与推导笔记'}</h2></div></div>
            <div class="markdown-body idea-notes inline-editable" data-inline="body" data-inline-multiline="true" title="输入 / 搜索论文并插入可点击引用">${item.body ? renderMarkdown(item.body) : '<div class="idea-empty-notes">点击此处直接记录背景、假设、证据或下一步（输入 / 可插入论文引用）。</div>'}</div>
          </section>
        </div>

        <aside class="idea-side-card">
          <label class="idea-field"><span>阶段</span><select id="ideaStageField">${stageOptions.map((option) => `<option ${option === stage ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></label>
          <label class="idea-field"><span>优先级</span><select id="ideaPriorityField">${['高', '中', '低'].map((option) => `<option ${option === (fm.priority || '中') ? 'selected' : ''}>${option}</option>`).join('')}</select></label>
          <div class="idea-field"><span>来源</span><strong data-inline="source" title="点击填写来源">${esc(fm.source || '点击填写来源')}</strong></div>
          <div class="idea-field"><span>标签</span><div class="idea-tags" data-inline="tags" data-inline-type="tags" title="点击添加标签">${tags.length ? tags.map((tag) => `<span class="idea-tag">${esc(tag)}</span>`).join('') : '<span class="hint">点击添加主题标签</span>'}</div></div>
          <div class="idea-next-step"><span>下一步</span><div data-inline="nextStep" data-inline-multiline="true" title="点击填写下一步">${renderTextWithRefs(fm.nextStep || '点击填写下一步')}</div></div>
          <div class="inline-edit-hint">点击字段即可就地编辑；输入 / 可引用论文；失焦自动保存，多行内容按 Ctrl+Enter 保存。</div>
        </aside>
      </div>
      <div id="ideaBacklinks"></div>
    </div>`;

    bindRefClicks(root);
    bindInlineFields(root, item, 'ideas');
    renderBacklinks(root.querySelector('#ideaBacklinks'), item.id);

    const saveIdeaFields = async (patch, msg = 'Idea 已更新') => {
      const next = { ...(item.frontmatter || {}), ...patch, updatedAt: new Date().toISOString().slice(0, 10) };
      const allText = [next.title, next.problem, next.gap, next.hypothesis, next.methodology, next.validationPlan, next.nextStep, item.body || ''].join('\n');
      const extracted = extractRefs(allText);
      const gp = Array.isArray(next.groundedPapers) ? next.groundedPapers : [];
      next.refs = Array.from(new Set(extracted.concat(gp)));
      try {
        await call('saveItem', S.ws, 'ideas', item.id, { frontmatter: next, body: item.body || '' });
        item.frontmatter = next;
        await refreshItems();
        await renderDetail();
        if (msg) toast(msg);
      } catch (error) { toast(error.message, true); }
    };

    // 列表型字段就地编辑（assumptions / rivalExplanations）
    const bindListBox = (sel, fieldKey, placeholder) => {
      const box = root.querySelector(sel);
      if (!box) return;
      box.addEventListener('click', () => {
        if (box.querySelector('textarea')) return;
        const ta = document.createElement('textarea');
        ta.className = 'inline-editor';
        ta.rows = 3;
        ta.placeholder = placeholder;
        ta.value = listAsText(fm[fieldKey]);
        box.textContent = '';
        box.appendChild(ta);
        ta.focus();
        let done = false;
        const commit = async (save) => {
          if (done) return;
          done = true;
          if (!save) { await renderDetail(); return; }
          await saveIdeaFields({ [fieldKey]: textToList(ta.value) });
        };
        ta.addEventListener('blur', () => commit(true));
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); commit(false); }
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); commit(true); }
        });
      });
    };
    bindListBox('#ideaAssumptionsBox', 'assumptions', '每行一条前提假设');
    bindListBox('#ideaRivalsBox', 'rivalExplanations', '每行一条竞争性解释');

    // 支撑文献增删
    root.querySelectorAll('[data-rm-gp]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = b.dataset.rmGp;
      saveIdeaFields({ groundedPapers: groundedPapers.filter((x) => x !== target) }, '已移除关联论文');
    }));
    root.querySelector('#ideaAddPaperBtn')?.addEventListener('click', async () => {
      try {
        const papers = await call('listItems', S.ws, 'papers');
        const avail = (papers || []).filter((p) => !groundedPapers.includes(p.id));
        if (!avail.length) return toast('工作区没有更多可关联的论文', true);
        const sel = document.createElement('select');
        sel.className = 'inline-editor';
        sel.style.width = 'auto';
        sel.innerHTML = `<option value="">选择论文…</option>` + avail.map((p) => `<option value="${esc(p.id)}">${esc(p.shortName || p.title || p.id)}</option>`).join('');
        root.querySelector('#ideaAddPaperBtn').replaceWith(sel);
        sel.focus();
        sel.addEventListener('change', () => {
          if (sel.value) saveIdeaFields({ groundedPapers: groundedPapers.concat([sel.value]) }, '已关联支撑论文');
        });
        sel.addEventListener('blur', () => { if (!sel.value) renderDetail(); });
      } catch (err) { toast('读取论文失败：' + err.message, true); }
    });

    root.querySelector('#ideaStageField').addEventListener('change', (e) => saveIdeaFields({ status: e.target.value }));
    root.querySelector('#ideaPriorityField').addEventListener('change', (e) => saveIdeaFields({ priority: e.target.value }));
    root.querySelector('#ideaToggleType').addEventListener('click', () => {
      const nextType = type === 'todo' ? 'idea' : 'todo';
      saveIdeaFields({ type: nextType, status: nextType === 'todo' ? '待办' : '收件箱' });
    });
    root.querySelector('#delIdeaBtn').addEventListener('click', () => confirmDeleteItem('ideas', item.id));
    root.querySelector('#ideaToExperimentBtn')?.addEventListener('click', () => createExperimentFromIdea(item));

    // 五维对抗评审
    root.querySelector('#ideaReviewBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 评审中…';
      try {
        const papers = await call('listItems', S.ws, 'papers').catch(() => []);
        const rev = await ai('reviewIdea', { idea: { ...fm, body: item.body || '' }, papers, skillId: 'hypothesis-critique' });
        await saveIdeaFields({
          review: { ...rev, reviewedAt: new Date().toISOString().slice(0, 10) }
        }, rev.fallbackUsed ? '已完成离线五维结构化评审' : 'AI 五维对抗评审已完成');
      } catch (err) {
        toast('评审失败：' + err.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('shield', 14)}五维对抗评审`; }
      }
    });

    // 采纳修订建议
    root.querySelector('#applyRevisedIdeaBtn')?.addEventListener('click', async () => {
      const rev = fm.review && fm.review.revisedIdea;
      if (!rev) return;
      await saveIdeaFields({
        problem: rev.problem || fm.problem,
        gap: rev.gap || fm.gap,
        hypothesis: rev.hypothesis || fm.hypothesis,
        methodology: rev.methodology || fm.methodology,
        assumptions: Array.isArray(rev.assumptions) && rev.assumptions.length ? rev.assumptions : fm.assumptions,
        rivalExplanations: Array.isArray(rev.rivalExplanations) && rev.rivalExplanations.length ? rev.rivalExplanations : fm.rivalExplanations,
        validationPlan: rev.validationPlan || fm.validationPlan
      }, '已将修订方案应用到当前 Idea');
    });

    // 跨库新颖性查重
    root.querySelector('#ideaNoveltyBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 查重中…';
      try {
        const nc = await ai('checkIdeaNovelty', { ws: S.ws, idea: { ...fm, body: item.body || '' } });
        await saveIdeaFields({
          noveltyCheck: { ...nc, checkedAt: new Date().toISOString().slice(0, 10) }
        }, `新颖性查重完成：${nc.verdict}`);
      } catch (err) {
        toast('新颖性查重失败：' + err.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('search', 14)}新颖性查重 (SciMON)`; }
      }
    });

    root.querySelectorAll('[data-open-novelty-url]').forEach((b) => b.addEventListener('click', () => {
      window.bridge.shell.open(b.dataset.openNoveltyUrl);
    }));
    root.querySelectorAll('[data-apply-pivot]').forEach((b) => b.addEventListener('click', () => {
      const idx = Number(b.dataset.applyPivot);
      const sug = fm.noveltyCheck && fm.noveltyCheck.pivotSuggestions && fm.noveltyCheck.pivotSuggestions[idx];
      if (!sug) return;
      const nextStep = fm.nextStep ? `${fm.nextStep}\n[SciMON转向] ${sug}` : `[SciMON转向] ${sug}`;
      saveIdeaFields({ nextStep }, '已将转向建议写入下一步计划');
    }));
  }

  async function createIdea(type, title) {
    const id = 'idea-' + Date.now().toString();
    const stamp = new Date().toISOString().slice(0, 10);
    const ideaTitle = String(title || '').trim() || (type === 'todo' ? '未命名待办' : '未命名 Idea');
    const fm = {
      title: ideaTitle, type, status: type === 'todo' ? '待办' : '收件箱',
      priority: '中', source: '', tags: [], refs: extractRefs(ideaTitle),
      problem: '', gap: '', hypothesis: '', methodology: '',
      assumptions: [], rivalExplanations: [], validationPlan: '', groundedPapers: [],
      nextStep: '',
      createdAt: stamp, updatedAt: stamp
    };
    try {
      await call('saveItem', S.ws, 'ideas', id, { frontmatter: fm, body: '' });
      S.search = '';
      S.statusFilter = type;
      S.ideaStageFilter = '';
      S.selectedId = id;
      await renderBoard();
      toast(type === 'todo' ? '待办已快速记录' : 'Idea 已快速记录');
    } catch (error) { toast(error.message, true); }
  }

  function editIdea(item) {
    const title = $('#detailRoot')?.querySelector('[data-inline="title"]');
    if (title) title.click();
  }

  async function createExperimentFromIdea(item) {
    const fm = item.frontmatter || {};
    const id = 'exp-' + Date.now().toString().slice(-6);
    const stamp = new Date().toISOString().slice(0, 10);
    const grounded = Array.isArray(fm.groundedPapers) ? fm.groundedPapers : [];
    const bodyRefs = extractRefs([fm.title, fm.problem, fm.gap, fm.hypothesis, fm.methodology, item.body || ''].join('\n'));
    const relatedPapers = Array.from(new Set(grounded.concat(bodyRefs))).filter(Boolean);
    const protocolParts = [
      fm.methodology ? `## 核心方法设计\n${fm.methodology}` : '',
      fm.validationPlan ? `## 验证与消融协议\n${fm.validationPlan}` : '',
      Array.isArray(fm.rivalExplanations) && fm.rivalExplanations.length
        ? `## 需排除的竞争性解释\n${fm.rivalExplanations.map((r) => `- ${r}`).join('\n')}`
        : '',
      item.body ? `## 来源构想补充\n${item.body}` : ''
    ].filter(Boolean);

    const experiment = {
      title: fm.title || '基于 Idea 的实验',
      date: stamp, status: '计划中', priority: fm.priority || '中',
      tags: Array.isArray(fm.tags) ? fm.tags.slice() : [],
      goal: fm.problem || fm.title || '',
      hypothesis: fm.hypothesis || '',
      protocol: protocolParts.join('\n\n'),
      basedOn: '',
      relatedIdea: item.id,
      relatedPapers,
      environment: {},
      config: { variant: 'baseline', seed: '42' },
      results: { metrics: {}, charts: [], data_files: [], chartConfig: {} },
      conclusion: '',
      nextStep: fm.nextStep || '',
      failure: {},
      createdAt: stamp, updatedAt: stamp
    };
    try {
      await call('saveItem', S.ws, 'experiments', id, { frontmatter: experiment, body: '' });
      // 无损同步 Idea 状态为「已转实验」
      if ((fm.type || 'idea') === 'idea' && fm.status !== '已转实验') {
        const nextIdeaFm = { ...fm, status: '已转实验', updatedAt: stamp };
        await call('saveItem', S.ws, 'ideas', item.id, { frontmatter: nextIdeaFm, body: item.body || '' });
      }
      S.lastSelected.ideas = item.id;
      S.board = 'experiments';
      S.selectedId = id;
      await renderBoard();
      toast('已从 Idea 无损创建关联实验（含假设、验证协议与支撑论文）');
      return id;
    } catch (error) { toast('创建实验失败：' + error.message, true); return null; }
  }

  /** 跨模块入口：从「论文脉络」研究缺口或「实验」反馈直接创建结构化 Idea 并打开。 */
  async function openWithSeed(seed = {}) {
    const id = 'idea-' + Date.now().toString();
    const stamp = new Date().toISOString().slice(0, 10);
    const groundedPapers = Array.isArray(seed.groundedPapers) ? seed.groundedPapers.filter(Boolean) : [];
    const fm = {
      title: String(seed.title || '来自脉络缺口的研究假设').trim(),
      type: 'idea',
      status: '整理中',
      priority: seed.priority || '高',
      source: String(seed.source || '论文脉络'),
      tags: Array.isArray(seed.tags) ? seed.tags.slice() : ['脉络缺口'],
      problem: String(seed.problem || '').trim(),
      gap: String(seed.gap || '').trim(),
      hypothesis: String(seed.hypothesis || '').trim(),
      methodology: String(seed.methodology || '').trim(),
      assumptions: Array.isArray(seed.assumptions) ? seed.assumptions.slice() : [],
      rivalExplanations: Array.isArray(seed.rivalExplanations) ? seed.rivalExplanations.slice() : [],
      validationPlan: String(seed.validationPlan || '').trim(),
      groundedPapers,
      refs: Array.from(new Set(groundedPapers.concat(extractRefs(String(seed.problem || '') + '\n' + String(seed.hypothesis || ''))))),
      nextStep: String(seed.nextStep || '执行五维对抗评审与新颖性查重，再一键转为消融实验'),
      createdAt: stamp,
      updatedAt: stamp
    };
    await call('saveItem', S.ws, 'ideas', id, { frontmatter: fm, body: String(seed.body || '') });
    S.board = 'ideas';
    S.statusFilter = 'idea';
    S.ideaStageFilter = '';
    S.selectedId = id;
    await renderBoard();
    toast('已将研究缺口送入 Idea 孵化工作区');
    return id;
  }

  /** CoI-Agent 文献链批量孵化 Idea 弹窗 */
  async function showCoIIdeationModal() {
    let papers = [];
    let ideaSkills = [];
    try {
      [papers, ideaSkills] = await Promise.all([
        call('listItems', S.ws, 'papers'),
        svc('skills', 'listSkills', 'idea').catch(() => [])
      ]);
    } catch (e) { return toast('读取论文列表失败：' + e.message, true); }

    openModal('CoI 文献链孵化科研 Idea（CoI-Agent / ResearchAgent）', `
      <div class="form-row">
        <div class="form-field"><label>聚焦研究方向 / 主题</label><input id="coiTopicInput" value="${esc(S.ws || '')}" placeholder="例如：隐式动力学表征在长视野 VLA 操控中的应用"></div>
        <div class="form-field" style="max-width:190px"><label>孵化 Skill</label><select id="coiSkillSel">${(ideaSkills.length ? ideaSkills : [{ id: 'chain-of-ideas', name: 'Chain-of-Ideas' }]).map((sk) => `<option value="${esc(sk.id)}">${esc(sk.name)}</option>`).join('')}</select></div>
        <div class="form-field" style="max-width:95px"><label>生成数量</label><select id="coiCountSel"><option value="2">2 个</option><option value="3" selected>3 个</option><option value="4">4 个</option></select></div>
      </div>
      <div class="form-field">
        <label>选择作为文献链锚点的本地论文（默认取前 8 篇，可勾选调整）</label>
        <div class="coi-paper-picker" id="coiPaperPicker">
          ${papers.slice(0, 30).map((p, i) => `<label class="coi-paper-opt"><input type="checkbox" value="${esc(p.id)}" ${i < 8 ? 'checked' : ''}><span>${esc(p.shortName || p.title || p.id)}</span><small>${esc(p.published || '')}</small></label>`).join('') || '<div class="hint">当前工作区暂无论文，将仅按主题孵化</div>'}
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button type="button" class="btn" id="runCoIBtn">${ico('sparkle', 14)}沿文献链生成结构化 Idea</button>
        <span class="hint" id="coiStatusHint">支持离线结构化推导与在线 LLM 深度孵化</span>
      </div>
      <div id="coiResultBox" class="coi-result-box"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, (modal) => {
      let generated = [];
      modal.querySelector('#runCoIBtn').addEventListener('click', async () => {
        const btn = modal.querySelector('#runCoIBtn');
        const box = modal.querySelector('#coiResultBox');
        const selectedIds = new Set(Array.from(modal.querySelectorAll('#coiPaperPicker input:checked')).map((c) => c.value));
        const chosenPapers = papers.filter((p) => selectedIds.has(p.id));
        const topic = modal.querySelector('#coiTopicInput').value.trim();
        const count = Number(modal.querySelector('#coiCountSel').value) || 3;
        const skillId = modal.querySelector('#coiSkillSel').value || 'chain-of-ideas';
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 孵化中…';
        try {
          const res = await ai('generateIdeasFromLineage', { ws: S.ws, papers: chosenPapers, topic, count, skillId });
          generated = Array.isArray(res && res.ideas) ? res.ideas : [];
          modal.querySelector('#coiStatusHint').textContent = res.fallbackUsed
            ? `已离线生成 ${generated.length} 个结构化候选（配置 API Key 可获得深度 LLM 推导）`
            : `已通过 ${res.skillId} 孵化 ${generated.length} 个文献锚定 Idea`;
          box.innerHTML = generated.map((g, idx) => `<div class="coi-cand-card">
            <div class="coi-cand-head">
              <strong>${esc(g.title)}</strong>
              <button type="button" class="btn sm" data-save-coi="${idx}">${ico('plus', 12)}存入 Idea 池</button>
            </div>
            <div class="coi-cand-row"><b>问题：</b>${esc(g.problem)}</div>
            <div class="coi-cand-row"><b>可证伪假设：</b>${esc(g.hypothesis)}</div>
            <div class="coi-cand-row"><b>方法：</b>${esc(g.methodology)}</div>
            <div class="coi-cand-row"><b>竞争解释：</b>${esc((g.rivalExplanations || []).join('；'))}</div>
            ${Array.isArray(g.groundedPapers) && g.groundedPapers.length ? `<div class="hint">支撑文献：${esc(g.groundedPapers.join(', '))}</div>` : ''}
          </div>`).join('');
          box.querySelectorAll('[data-save-coi]').forEach((sb) => sb.addEventListener('click', async () => {
            const cand = generated[Number(sb.dataset.saveCoi)];
            if (!cand) return;
            sb.disabled = true;
            await openWithSeed({ ...cand, source: `CoI 文献链孵化 (${skillId})`, tags: ['CoI孵化'] });
            sb.textContent = '已入库';
          }));
        } catch (err) {
          toast('孵化失败：' + err.message, true);
        } finally {
          if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('sparkle', 14)}沿文献链生成结构化 Idea`; }
        }
      });
    }, 'wide');
  }

  /** Open-Co-Scientist 成对辩论 Elo 锦标赛 + 杂交进化弹窗 */
  async function showIdeaTournamentModal() {
    let items = [];
    try {
      const list = await call('listItems', S.ws, 'ideas');
      const ideasOnly = (list || []).filter((x) => (x.type || 'idea') === 'idea');
      items = (await Promise.all(ideasOnly.map((it) => call('getItem', S.ws, 'ideas', it.id)))).filter(Boolean);
    } catch (e) { return toast('读取 Idea 列表失败：' + e.message, true); }

    if (items.length < 2) return toast('至少需要 2 个 Idea 才能运行 Elo 成对辩论锦标赛', true);

    openModal('Idea 成对辩论 Elo 锦标赛与杂交进化（Open-Co-Scientist）', `
      <div class="hint" style="margin-bottom:8px">勾选 2–6 个候选 Idea 进行两两成对辩论（标准 Elo K=32，初始 1500），筛选最优方向并可融合头部优势生成演化版。</div>
      <div class="coi-paper-picker" id="tourIdeaPicker">
        ${items.slice(0, 16).map((it, i) => `<label class="coi-paper-opt"><input type="checkbox" value="${esc(it.id)}" ${i < Math.min(5, items.length) ? 'checked' : ''}><span>${esc((it.frontmatter && it.frontmatter.title) || it.id)}</span><small>${it.frontmatter && it.frontmatter.elo ? `Elo ${it.frontmatter.elo}` : esc((it.frontmatter && it.frontmatter.status) || '')}</small></label>`).join('')}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn" id="runTourBtn">${ico('zap', 14)}开始成对 Elo 锦标赛</button>
        <button type="button" class="btn ghost" id="runEvolveBtn" disabled>${ico('sparkle', 14)}融合头部 Idea 生成演化版</button>
      </div>
      <div id="tourResultBox" class="coi-result-box"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, (modal) => {
      let lastRankings = [];
      let chosenPool = [];
      modal.querySelector('#runTourBtn').addEventListener('click', async () => {
        const btn = modal.querySelector('#runTourBtn');
        const selIds = new Set(Array.from(modal.querySelectorAll('#tourIdeaPicker input:checked')).map((c) => c.value));
        chosenPool = items.filter((it) => selIds.has(it.id));
        if (chosenPool.length < 2) return toast('请至少勾选 2 个 Idea', true);
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 辩论排序中…';
        try {
          const payload = chosenPool.map((it) => ({ id: it.id, ...(it.frontmatter || {}), body: it.body || '' }));
          const res = await ai('tournamentIdeas', { ideas: payload, skillId: 'co-scientist-tournament' });
          lastRankings = res.rankings || [];
          // 写回 Elo 分数到各 Idea frontmatter
          for (const r of lastRankings) {
            const orig = chosenPool.find((x) => x.id === r.id);
            if (!orig) continue;
            await call('saveItem', S.ws, 'ideas', orig.id, {
              frontmatter: { ...(orig.frontmatter || {}), elo: r.elo, updatedAt: new Date().toISOString().slice(0, 10) },
              body: orig.body || ''
            });
          }
          await refreshItems();
          modal.querySelector('#runEvolveBtn').disabled = false;
          modal.querySelector('#tourResultBox').innerHTML = `
            <div class="section-title">Elo 排名结果${res.fallbackUsed ? '（离线综合评审模型）' : '（AI 成对辩论）'}</div>
            <table class="data-table">
              <thead><tr><th>名次</th><th>Idea</th><th>Elo</th><th>战绩</th><th>评语</th></tr></thead>
              <tbody>${lastRankings.map((r, idx) => `<tr><td>#${idx + 1}</td><td><b>${esc(r.title)}</b></td><td><b>${r.elo}</b></td><td>${r.wins}W-${r.losses}L</td><td>${esc(r.rationale)}</td></tr>`).join('')}</tbody>
            </table>
            <div class="section-title">对阵辩论明细（${(res.matchups || []).length} 场）</div>
            <div class="tour-matchups">${(res.matchups || []).map((m) => `<div class="tour-m-row"><b>${esc(m.aTitle)}</b> vs <b>${esc(m.bTitle)}</b> → 胜方：<span class="tour-win">${esc(m.winnerId === m.aId ? m.aTitle : m.bTitle)}</span><div class="hint">${esc(m.debateSummary || '')}</div></div>`).join('')}</div>`;
          toast('Elo 锦标赛完成，排名已同步至 Idea 卡片');
        } catch (err) {
          toast('锦标赛失败：' + err.message, true);
        } finally {
          if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('zap', 14)}重新运行锦标赛`; }
        }
      });

      modal.querySelector('#runEvolveBtn').addEventListener('click', async () => {
        const btn = modal.querySelector('#runEvolveBtn');
        if (!lastRankings.length) return;
        const topIds = lastRankings.slice(0, 2).map((r) => r.id);
        const topIdeas = topIds.map((id) => chosenPool.find((x) => x.id === id)).filter(Boolean);
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 演化合成中…';
        try {
          const res = await ai('evolveIdeas', {
            ideas: topIdeas.map((x) => ({ id: x.id, ...(x.frontmatter || {}), body: x.body || '' })),
            reviews: topIdeas.map((x) => x.frontmatter && x.frontmatter.review).filter(Boolean),
            skillId: 'co-scientist-tournament'
          });
          const evolved = (res.evolvedIdeas || [])[0];
          if (!evolved) return toast('未生成演化方案', true);
          closeModal();
          await openWithSeed({ ...evolved, source: 'Open-Co-Scientist 杂交进化', tags: ['演化方案'] });
        } catch (err) {
          toast('演化失败：' + err.message, true);
        } finally {
          if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('sparkle', 14)}融合头部 Idea 生成演化版`; }
        }
      });
    }, 'wide');
  }

  function showIdeaSkillsModal() {
    return showDomainSkillsModal('idea', 'Idea 孵化与评审 Skills');
  }

      Object.assign(this, {
        renderIdeaDetail, createIdea, editIdea, createExperimentFromIdea,
        openWithSeed, showCoIIdeationModal, showIdeaTournamentModal, showIdeaSkillsModal
      });
    }
  }
  namespace.IdeaController = IdeaController;
})();
