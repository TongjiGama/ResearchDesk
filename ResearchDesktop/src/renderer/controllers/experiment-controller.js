(() => {
  const namespace = window.ResearchWorkbench;
  class ExperimentController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { bindDropZone, bindInlineFields, bindInlineEntryAdds, refreshExperimentDetail, refreshItems, renderBoard, renderDetail, renderMarkdown, renderTextWithRefs, bindRefClicks, renderBacklinks, confirmDeleteItem, openModal, closeModal, showDomainSkillsModal } = context.actions;

  const fmtNum = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n)) ? Number(n.toFixed(d)) : '—';

  /** 渲染 CS 工程运行速控卡片（命令 / 代码仓 Git Diff / 运行目录同步 / Checkpoints） */
  function csOpsCardHtml(item, fm) {
    const cmd = String(fm.command || '').trim();
    const codeDir = String(fm.codeDir || '').trim();
    const runDir = String(fm.runDir || '').trim();
    const gitSnap = fm.gitSnapshot && typeof fm.gitSnapshot === 'object' ? fm.gitSnapshot : null;
    const frameworks = Array.isArray(fm.detectedFrameworks) ? fm.detectedFrameworks : [];
    const ckpts = Array.isArray(fm.checkpoints) ? fm.checkpoints : [];
    return `<section class="cs-ops-card">
      <div class="cs-ops-head">
        <span class="cs-ops-title">${ico('code', 14)}CS 工程运行锚点（命令 · 代码 Git Diff · 运行目录同步）</span>
        <div class="cs-ops-badges">${frameworks.map((fw) => `<span class="li-tag">${esc(fw)}</span>`).join('')}${gitSnap && gitSnap.commit ? `<span class="cs-git-pill ${gitSnap.dirty ? 'is-dirty' : ''}">${ico('gitBranch', 11)}${esc(gitSnap.commit)}${gitSnap.branch ? ` · ${esc(gitSnap.branch)}` : ''}${gitSnap.dirty ? ' *dirty' : ''}</span>` : ''}</div>
      </div>
      <div class="cs-ops-row">
        <span class="cs-ops-label">启动命令</span>
        <div class="cs-cmd-box" data-inline="command" data-inline-multiline="true" title="点击编辑完整训练/评测命令">${cmd ? `<code>${esc(cmd)}</code>` : '<span class="hint">点击粘贴真实命令（如 CUDA_VISIBLE_DEVICES=0 torchrun ... train.py --lr 1e-4）</span>'}</div>
        <div class="cs-ops-btns">
          <button type="button" class="btn ghost sm" id="csCopyCmdBtn" ${cmd ? '' : 'disabled'} title="复制命令">${ico('copy', 12)}复制</button>
          <button type="button" class="btn ghost sm" id="csCopyTmuxBtn" ${cmd ? '' : 'disabled'} title="复制 tmux 后台运行命令">tmux</button>
          <button type="button" class="btn ghost sm" id="csParseCmdBtn" ${cmd ? '' : 'disabled'} title="从命令行自动解析超参写入参数表">解析参数</button>
        </div>
      </div>
      <div class="cs-ops-row">
        <span class="cs-ops-label">代码仓库</span>
        <div class="cs-path-val" title="${esc(codeDir)}">${codeDir ? `<code>${esc(codeDir)}</code>` : '<span class="hint">未绑定本地代码仓</span>'}</div>
        <div class="cs-ops-btns">
          <button type="button" class="btn ghost sm" id="csPickCodeDirBtn">${ico('folderOpen', 12)}选目录</button>
          <button type="button" class="btn ghost sm" id="csSnapGitBtn" ${codeDir ? '' : 'disabled'}>${ico('gitBranch', 12)}抓 Git Diff</button>
          <button type="button" class="btn ghost sm" id="csViewPatchBtn" title="查看保存的未提交代码 Diff Patch">看 Patch</button>
        </div>
      </div>
      <div class="cs-ops-row">
        <span class="cs-ops-label">运行输出目录</span>
        <div class="cs-path-val" title="${esc(runDir)}">${runDir ? `<code>${esc(runDir)}</code>` : '<span class="hint">未绑定 Hydra / W&amp;B / HF / Lightning / TensorBoard 目录</span>'}</div>
        <div class="cs-ops-btns">
          <button type="button" class="btn ghost sm" id="csPickRunDirBtn">${ico('folderOpen', 12)}选目录</button>
          <button type="button" class="btn sm" id="csSyncRunDirBtn" ${runDir ? '' : 'disabled'}>${ico('refresh', 12)}一键同步日志与曲线</button>
          ${runDir ? `<button type="button" class="btn ghost sm" id="csOpenRunDirBtn">${ico('external', 12)}打开</button>` : ''}
        </div>
      </div>
      ${gitSnap && gitSnap.diffStat ? `<div class="cs-diff-stat"><span class="hint">Git 改动摘要：</span><code>${esc(gitSnap.diffStat.split(/\r?\n/).slice(-1)[0] || gitSnap.diffStat)}</code></div>` : ''}
      ${ckpts.length ? `<div class="cs-ckpt-row"><span class="cs-ops-label">Checkpoints</span><div class="cs-ckpt-chips">${ckpts.slice(0, 6).map((c) => `<span class="cs-ckpt-chip" title="${esc(c.relPath)}">${esc(c.name)} <small>${esc(c.sizeMb)}MB</small></span>`).join('')}${ckpts.length > 6 ? `<span class="hint">+${ckpts.length - 6}</span>` : ''}</div></div>` : ''}
    </section>`;
  }

  // ===== 实验详情 =====
  function renderExpDetail(root, item) {
    const fm = item.frontmatter || {};
    const relatedPapers = Array.isArray(fm.relatedPapers) ? fm.relatedPapers : [];
    const savedDesign = fm.aiDesign && typeof fm.aiDesign === 'object' ? fm.aiDesign : null;
    const savedDiag = fm.aiDiagnosis && typeof fm.aiDiagnosis === 'object' ? fm.aiDiagnosis : null;
    const keepBadge = fm.keepDecision || '';
    const keepText = keepBadge === 'keep' ? 'KEEP · 支持假设' : keepBadge === 'discard' ? 'DISCARD · 推翻假设' : keepBadge === 'blocked' ? 'BLOCKED · 阻塞' : '';

    root.innerHTML = `<div class="detail">
      <div class="detail-head">
        <div class="idea-kicker">EXPERIMENT · ${esc(item.id)}${keepText ? ` · <span class="exp-keep-pill is-${esc(keepBadge)}">${esc(keepText)}</span>` : ''}</div>
        <div class="detail-title"><span data-inline="title" title="点击编辑实验名称">${esc(fm.title || item.id)}</span></div>
        <div class="detail-meta">
          <span>日期：<span data-inline="date" data-inline-type="date" title="点击编辑日期">${esc(fm.date || '—')}</span></span>
          <span>状态：<span class="li-flag flag-${esc(fm.status || '')}" data-inline="status" data-inline-options="草稿|计划中|进行中|阻塞|完成|失败|已归档" title="点击修改状态">${esc(fm.status || '草稿')}</span></span>
          <span>优先级：<span data-inline="priority" data-inline-options="高|中|低" title="点击修改优先级">${esc(fm.priority || '中')}</span></span>
          <span>基于：<span data-inline="basedOn" title="点击编辑基线">${esc(fm.basedOn || '—')}</span>${fm.basedOn ? ` <a data-ref="${esc(fm.basedOn)}" title="打开基线">↗</a>` : ''}</span>
          <span>关联灵感：<span data-inline="relatedIdea" title="点击编辑关联灵感">${esc(fm.relatedIdea || '—')}</span>${fm.relatedIdea ? ` <a data-ref="${esc(fm.relatedIdea)}" title="打开关联灵感">↗</a>` : ''}</span>
        </div>
        <div class="exp-head-actions">
          <button class="btn sm" id="expIngestCurrentBtn" title="从真实输出目录或粘贴终端日志同步当前实验">${ico('download', 13)}同步目录/日志</button>
          <button class="btn ghost sm" id="expSweepCurrentBtn" title="基于当前命令/参数生成多卡 Sweep 与集群脚本">${ico('zap', 13)}生成 Sweep</button>
          <button class="btn ghost sm" id="aiDesignExpBtn">${ico('sparkle', 13)}AI 消融设计</button>
          <button class="btn ghost sm" id="aiAnalyzeExpBtn">${ico('shield', 13)}AI 诊断复盘</button>
          ${fm.relatedIdea ? `<button class="btn ghost sm" id="syncToIdeaBtn" title="将实验结论与极性回流至关联 Idea（HypoRefine）">${ico('lightbulb', 13)}回流 Idea</button>` : ''}
          <button class="btn ghost sm" id="cloneExpBtn">${ico('layers', 13)}复制为新版本</button>
          <button class="btn ghost sm" id="importDataBtn">${ico('upload', 13)}导入结果文件</button>
          <button class="btn ghost sm" id="reproExportBtn">${ico('code', 13)}复现包</button>
          <button class="btn ghost sm btn-danger-ghost" id="delExpBtn">${ico('trash', 13)}删除</button>
        </div>
      </div>
      ${csOpsCardHtml(item, fm)}
      <div class="tabs">
        <button class="tab active" data-etab="design">设计</button>
        <button class="tab" data-etab="params">参数</button>
        <button class="tab" data-etab="results">结果与统计</button>
      </div>
      <div id="expTabContent"></div>
      <div id="expBacklinks"></div>
    </div>`;

    const cfg = fm.config || {};
    const results = fm.results || {};
    const metricsHtml = (results.metrics && Object.keys(results.metrics).length)
      ? `<div class="metric-cards">${Object.entries(results.metrics).map(([k, v]) => `<div class="metric-card"><div class="mc-label">${esc(k)}</div><div class="mc-value" data-inline="results.metrics" data-inline-key="${esc(k)}" title="点击编辑指标值">${esc(v)}</div></div>`).join('')}<button class="btn ghost sm" type="button" data-inline-add="metrics">${ico('plus', 13)}添加指标</button></div>`
      : '<div class="hint">暂无指标。<button class="btn ghost sm" type="button" data-inline-add="metrics">添加指标</button></div>';
    const env = fm.environment || {};
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    const failure = fm.failure || {};
    bindInlineFields(root.querySelector('.detail-head'), item, 'experiments', 'design');
    bindInlineFields(root.querySelector('.cs-ops-card'), item, 'experiments', 'design');
    bindCsOpsCard(root, item);

    const designCardHtml = savedDesign ? `<div class="exp-ai-card">
      <div class="eac-head"><b>DOE 与混杂审计清单（K-Dense / ReviewerAblation）</b></div>
      ${savedDesign.nullHypothesis ? `<div class="hint">零假设 H0：${esc(savedDesign.nullHypothesis)}</div>` : ''}
      ${savedDesign.successCriteria ? `<div class="eac-row"><b>量化成功标准：</b>${esc(savedDesign.successCriteria)}</div>` : ''}
      ${Array.isArray(savedDesign.confoundingChecks) && savedDesign.confoundingChecks.length ? `<ul class="eac-checks">${savedDesign.confoundingChecks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </div>` : '';

    const diagCardHtml = savedDiag ? `<div class="exp-ai-card is-diag">
      <div class="eac-head"><b>AI 诊断结论：${esc(savedDiag.verdict || '')}</b></div>
      <ul class="eac-checks">${(savedDiag.findings || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${savedDiag.negativeResultEntry ? `<div class="eac-neg">负结果台账：${esc(savedDiag.negativeResultEntry)}</div>` : ''}
    </div>` : '';

    const tabsMap = {
      design: `<div class="inline-edit-hint">点击字段即可编辑；输入 / 可引用论文；失焦自动保存，多行内容按 Ctrl+Enter 保存。</div>
               <div class="section-title">研究目标</div><div class="field-box" data-inline="goal" data-inline-multiline="true" title="点击编辑研究目标">${renderTextWithRefs(fm.goal || '点击添加研究目标')}</div>
               <div class="section-title">目的与可证伪假设</div><div class="field-box" data-inline="hypothesis" data-inline-multiline="true" title="点击编辑目的与假设">${renderTextWithRefs(fm.hypothesis || '点击添加目的与假设')}</div>
               ${designCardHtml}
               <div class="section-title">执行协议</div><div class="field-box markdown-body" data-inline="protocol" data-inline-multiline="true" title="点击编辑执行协议">${renderMarkdown(fm.protocol || '')}</div>
               <div class="section-title">关联参考论文（relatedPapers · 自动纳入反向链接）</div>
               <div class="exp-rel-papers" id="expRelatedPapersBox">
                 ${relatedPapers.map((p) => {
                   const pid = typeof p === 'string' ? p : (p && p.id) || '';
                   return `<span class="idea-paper-chip"><span class="md-ref" data-ref="${esc(pid)}">${esc(pid)}</span><button type="button" class="chip-rm" data-rm-ep="${esc(pid)}" title="移除">×</button></span>`;
                 }).join('') || '<span class="hint">尚未关联参考论文</span>'}
                 <button type="button" class="btn ghost sm" id="expAddPaperBtn">${ico('plus', 12)}关联论文</button>
               </div>
               <div class="section-title">结论</div><div class="field-box" data-inline="conclusion" data-inline-multiline="true" title="点击编辑结论">${renderTextWithRefs(fm.conclusion || '点击添加结论')}</div>
               ${diagCardHtml}
               <div class="section-title">下一步行动</div><div class="field-box" data-inline="nextStep" data-inline-multiline="true" title="点击编辑下一步">${renderTextWithRefs(fm.nextStep || '点击添加下一步行动')}</div>
               <div class="section-title">失败复盘与负结果记录</div><div class="failure-box"><b data-inline="failure.type" title="点击编辑失败类别">${esc(failure.type || '点击填写失败类别')}</b><div data-inline="failure.cause" data-inline-multiline="true" title="点击编辑失败原因">${renderTextWithRefs(failure.cause || '点击填写失败原因')}</div><div class="hint" data-inline="failure.action" data-inline-multiline="true" title="点击编辑修复动作">修复：${renderTextWithRefs(failure.action || '点击填写修复动作')}</div></div>
               <div class="section-title">标签与版本链</div><div class="experiment-tags" data-inline="tags" data-inline-type="tags" title="点击添加标签">${tags.length ? tags.map((t) => `<span class="li-tag">${esc(t)}</span>`).join('') : '<span class="hint">点击添加标签</span>'}</div><div class="timeline-item">基于 ${fm.basedOn ? `<a data-ref="${esc(fm.basedOn)}">${esc(fm.basedOn)}</a>` : '—'} 改进</div>`,
      params: `<div class="section-title">配置与参数（支持从命令行 / Hydra YAML / W&amp;B 自动导入）</div><div class="field-grid">${Object.keys(cfg).length ? Object.entries(cfg).map(([k, v]) => `<div class="field-box"><div class="field-label">${esc(k)}</div><div class="field-value" data-inline="config" data-inline-key="${esc(k)}" title="点击编辑参数">${esc(v)}</div></div>`).join('') : '<div class="hint">暂无参数</div>'}<button class="btn ghost sm" type="button" data-inline-add="config">${ico('plus', 13)}添加参数</button></div>
               <div class="section-title">复现环境 <button class="btn ghost sm" type="button" id="captureEnvBtn" style="margin-left:auto">${ico('zap', 12)}一键采集本机环境</button></div><div class="field-grid">
                 ${[['系统 / 设备', 'environment.system', env.system || env.device], ['框架与版本', 'environment.framework', env.framework], ['Python', 'environment.python', env.python], ['代码提交', 'environment.codeCommit', env.codeCommit], ['数据版本', 'environment.dataVersion', env.dataVersion], ['随机种子', 'environment.seed', env.seed]].map(([k, p, v]) => `<div class="field-box"><div class="field-label">${esc(k)}</div><div class="field-value" data-inline="${p}" title="点击编辑">${esc(v || '点击填写')}</div></div>`).join('')}
               </div>`,
      results: `<div class="inline-edit-hint">支持拖入 CSV / TSV / JSON / JSONL / LOG / TensorBoard .tfevents 自动绘图、EMA 平滑与 rliable 统计分析。</div>
                <div class="section-title">结果记录</div><div class="field-box" data-inline="results.summary" data-inline-multiline="true" title="点击记录任意类型的实验结果">${renderTextWithRefs(results.summary || '点击记录观察、定性结论、失败现象或其他结果')}</div>
                <div class="section-title">关键指标</div>${metricsHtml}
                <div id="expStatsPanel"></div>
                <div id="resultFiles"></div>`
    };
    const tc = root.querySelector('#expTabContent');
    async function showTab(t) {
      if (window.Charts) Charts.destroyAll();
      tc.innerHTML = tabsMap[t];
      bindRefClicks(root);
      bindInlineFields(tc, item, 'experiments', t);
      bindInlineEntryAdds(tc, item, t);
      if (t === 'design') bindRelatedPapers(tc, item);
      if (t === 'params') bindEnvCapture(tc, item);
      if (t === 'results') await renderResultFiles(tc, item);
    }
    showTab('design');
    root.querySelectorAll('[data-etab]').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('[data-etab]').forEach((x) => x.classList.toggle('active', x === b));
      showTab(b.dataset.etab);
    }));
    bindRefClicks(root);
    renderBacklinks(root.querySelector('#expBacklinks'), item.id);

    root.querySelector('#expIngestCurrentBtn').addEventListener('click', () => showQuickIngestModal({ expId: item.id }));
    root.querySelector('#expSweepCurrentBtn').addEventListener('click', () => showSweepModal(item));
    root.querySelector('#aiDesignExpBtn').addEventListener('click', () => openAiDesignModal(item));
    root.querySelector('#aiAnalyzeExpBtn').addEventListener('click', () => openAiAnalyzeModal(item));
    root.querySelector('#syncToIdeaBtn')?.addEventListener('click', () => syncToIdea(item.id));
    root.querySelector('#reproExportBtn').addEventListener('click', () => openReproModal(item));
    root.querySelector('#cloneExpBtn').addEventListener('click', () => cloneExperiment(item));
    root.querySelector('#delExpBtn').addEventListener('click', () => confirmDeleteItem('experiments', item.id));
    root.querySelector('#importDataBtn').addEventListener('click', async () => {
      const paths = await window.bridge.dialog.openFiles({ multi: true, title: '选择实验结果文件（支持 CSV/JSON/LOG/tfevents/PNG）' });
      if (!paths.length) return;
      try {
        const names = await call('importDataFiles', S.ws, item.id, paths);
        toast(`已导入 ${names.length} 个文件`);
        await renderDetail();
      } catch (e) { toast(e.message, true); }
    });
  }

  /** 绑定 CS 工程运行卡片事件（复制命令 / tmux / 解析超参 / 抓 Git Diff / 同步运行目录） */
  function bindCsOpsCard(root, item) {
    const fm = item.frontmatter || {};
    const cmd = String(fm.command || '').trim();
    root.querySelector('#csCopyCmdBtn')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cmd); toast('已复制启动命令'); } catch (_) { toast('复制失败', true); }
    });
    root.querySelector('#csCopyTmuxBtn')?.addEventListener('click', async () => {
      const sess = String(item.id || 'exp').replace(/[^A-Za-z0-9_-]/g, '_');
      const tmuxCmd = `tmux new-session -d -s "${sess}" '${cmd.replace(/'/g, "'\\''")} 2>&1 | tee ${sess}.log; exec bash' && tmux attach -t "${sess}"`;
      try { await navigator.clipboard.writeText(tmuxCmd); toast('已复制 tmux 后台会话启动命令'); } catch (_) { toast('复制失败', true); }
    });
    root.querySelector('#csParseCmdBtn')?.addEventListener('click', async () => {
      try {
        const res = await svc('experiment', 'parseCliCommand', cmd);
        const keys = Object.keys(res.config || {});
        if (!keys.length) return toast('命令中未识别到 --flag 或 Hydra key=val 参数');
        const nf = {
          ...fm,
          config: { ...(fm.config || {}), ...res.config },
          environment: { ...(fm.environment || {}), ...(res.seed ? { seed: res.seed } : {}) },
          updatedAt: new Date().toISOString().slice(0, 10)
        };
        await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: nf, body: item.body || '' });
        item.frontmatter = nf;
        await refreshExperimentDetail('params');
        toast(`已从命令自动解析 ${keys.length} 项超参到参数表`);
      } catch (e) { toast('解析命令失败：' + e.message, true); }
    });
    root.querySelector('#csPickCodeDirBtn')?.addEventListener('click', async () => {
      const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择本地代码仓库目录' });
      if (!dirs.length) return;
      try {
        const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, { expId: item.id, codeDir: dirs[0] });
        await refreshItems();
        await renderDetail();
        toast(res.gitCaptured ? '已绑定代码仓并抓取 Git Commit 与未提交 Diff' : '已绑定代码目录（非 Git 仓库）');
      } catch (e) { toast(e.message, true); }
    });
    root.querySelector('#csSnapGitBtn')?.addEventListener('click', async () => {
      try {
        const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, { expId: item.id, codeDir: fm.codeDir });
        await refreshItems();
        await renderDetail();
        toast(res.gitCaptured ? '已更新 Git 快照并存档 code_diff.patch' : '目标目录不是 Git 仓库', !res.gitCaptured);
      } catch (e) { toast(e.message, true); }
    });
    root.querySelector('#csViewPatchBtn')?.addEventListener('click', async () => {
      const df = await call('readDataFile', S.ws, item.id, 'code_diff.patch').catch(() => null);
      if (!df || !df.content) return toast('当前实验暂无未提交代码 Diff（工作区干净或尚未抓取 Git 快照）');
      openModal(`代码改动 Diff：${item.id}`, `<pre class="cs-diff-pre">${esc(df.content)}</pre><div class="modal-actions"><button class="btn" data-close>关闭</button></div>`, null, 'wide');
    });
    root.querySelector('#csPickRunDirBtn')?.addEventListener('click', async () => {
      const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择实验运行输出目录（Hydra / W&B / HF / TensorBoard / Lightning）' });
      if (!dirs.length) return;
      try {
        const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, { expId: item.id, runDir: dirs[0] });
        await refreshItems();
        await renderDetail();
        toast(`已同步目录：${res.configCount} 项参数 · ${res.metricCount} 项指标 · ${res.curveCount} 条曲线`);
      } catch (e) { toast(e.message, true); }
    });
    root.querySelector('#csSyncRunDirBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 同步中…';
      try {
        const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, { expId: item.id, runDir: fm.runDir });
        await refreshItems();
        await renderDetail();
        toast(`刷新同步完成：${res.metricCount} 项指标 · ${res.curveCount} 条曲线 · ${res.checkpointCount} 个权重`);
      } catch (err) {
        toast('同步失败：' + err.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('refresh', 12)}一键同步日志与曲线`; }
      }
    });
    root.querySelector('#csOpenRunDirBtn')?.addEventListener('click', () => window.bridge.shell.open(fm.runDir));
  }

  /** 三合一零手工 CS 运行导入弹窗（扫描真实目录 / 粘贴命令与日志 / 批量扫描 outputs 父目录） */
  function showQuickIngestModal(opts = {}) {
    const targetExpId = opts.expId || '';
    const modalTitle = targetExpId ? `同步真实运行数据到 ${targetExpId}` : '快捷导入 CS 实验（零手工录入）';
    openModal(modalTitle, `
      <div class="export-tabs" id="ingestTabs">
        <button type="button" class="btn sm" data-itab="dir">${ico('folderOpen', 12)}扫描运行目录</button>
        <button type="button" class="btn ghost sm" data-itab="paste">${ico('code', 12)}粘贴命令 / 终端日志</button>
        ${!targetExpId ? `<button type="button" class="btn ghost sm" data-itab="batch">${ico('layers', 12)}批量扫描 outputs/ 目录</button>` : ''}
      </div>
      <div id="ingestPaneDir" class="ingest-pane active">
        <div class="hint" style="margin-bottom:8px">自动识别 Hydra (<code>.hydra/config.yaml</code>)、HuggingFace (<code>trainer_state.json</code>)、W&amp;B (<code>wandb-summary.json</code>)、PyTorch Lightning (<code>metrics.csv</code>)、TensorBoard (<code>.tfevents</code>) 与 <code>.log</code>。</div>
        <div class="form-row">
          <div class="form-field"><label>实验标题（留空则自动用目录名）</label><input id="ingTitle" placeholder="例如：OpenVLA-LoRA-r16-seed42"></div>
        </div>
        <div class="form-row">
          <div class="form-field"><label>训练输出目录（Run Dir）</label><div style="display:flex;gap:6px"><input id="ingRunDir" placeholder="选择或粘贴本地输出目录路径"><button type="button" class="btn ghost sm" id="pickIngRunDir">浏览…</button></div></div>
        </div>
        <div class="form-row">
          <div class="form-field"><label>代码仓库目录（可选 · 自动抓取 Git Commit 与未提交 Diff）</label><div style="display:flex;gap:6px"><input id="ingCodeDir" placeholder="选择本地 Git 代码仓"><button type="button" class="btn ghost sm" id="pickIngCodeDir">浏览…</button></div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button type="button" class="btn" id="doIngestDirBtn">${ico('download', 13)}${targetExpId ? '同步到当前实验' : '一键扫描并创建实验'}</button>
        </div>
      </div>
      <div id="ingestPanePaste" class="ingest-pane">
        <div class="hint" style="margin-bottom:8px">直接粘贴你在本地或 SSH 远程服务器（AutoDL / 集群）跑的命令与终端输出，自动拆解超参、提取指标、生成曲线 CSV 并检测 OOM/NaN。</div>
        <div class="form-row">
          <div class="form-field"><label>实验标题（可选）</label><input id="ingPasteTitle" placeholder="例如：Pi0-JEPA-aux0.1-seed42"></div>
        </div>
        <div class="form-field"><label>启动命令（支持 torchrun / accelerate / argparse --key val / Hydra a.b=c / 续行符）</label><textarea id="ingCmdText" class="editor-area" style="min-height:68px" placeholder="CUDA_VISIBLE_DEVICES=0,1 torchrun --nproc_per_node=2 train.py --lr 1e-4 --batch_size 32 --lora_rank 16 --seed 42"></textarea></div>
        <div class="form-field" style="margin-top:8px"><label>终端训练/评测日志（支持 PyTorch / tqdm / HF Trainer dict / LIBERO 输出，可选）</label><textarea id="ingLogText" class="editor-area" style="min-height:130px" placeholder="Epoch 1/10 | step=100 | train_loss: 0.842 | eval_acc: 64.2%\nEpoch 2/10 | step=200 | train_loss: 0.511 | eval_acc: 75.8%"></textarea></div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button type="button" class="btn" id="doIngestPasteBtn">${ico('sparkle', 13)}${targetExpId ? '解析并写入当前实验' : '一键解析并创建实验'}</button>
        </div>
      </div>
      <div id="ingestPaneBatch" class="ingest-pane">
        <div class="hint" style="margin-bottom:8px">选择一个包含多次运行的父目录（如 <code>outputs/</code>、<code>lightning_logs/</code>、<code>wandb/</code>），自动列出全部子实验并批量导入。</div>
        <div class="form-row">
          <div class="form-field"><div style="display:flex;gap:6px"><input id="ingBatchDir" placeholder="选择父级输出目录"><button type="button" class="btn ghost sm" id="pickIngBatchDir">浏览…</button><button type="button" class="btn sm" id="scanIngBatchBtn">扫描子目录</button></div></div>
        </div>
        <div id="ingBatchList" class="ablation-list" style="margin-top:8px"></div>
        <div style="margin-top:10px"><button type="button" class="btn" id="doIngestBatchBtn" disabled>批量导入勾选的运行</button></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, (modal) => {
      modal.querySelectorAll('[data-itab]').forEach((b) => b.addEventListener('click', () => {
        const t = b.dataset.itab;
        modal.querySelectorAll('[data-itab]').forEach((x) => x.classList.toggle('ghost', x !== b));
        modal.querySelector('#ingestPaneDir').classList.toggle('active', t === 'dir');
        modal.querySelector('#ingestPanePaste').classList.toggle('active', t === 'paste');
        modal.querySelector('#ingestPaneBatch').classList.toggle('active', t === 'batch');
      }));
      modal.querySelector('#pickIngRunDir').addEventListener('click', async () => {
        const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择运行输出目录' });
        if (dirs.length) modal.querySelector('#ingRunDir').value = dirs[0];
      });
      modal.querySelector('#pickIngCodeDir').addEventListener('click', async () => {
        const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择本地代码仓库目录' });
        if (dirs.length) modal.querySelector('#ingCodeDir').value = dirs[0];
      });
      modal.querySelector('#doIngestDirBtn').addEventListener('click', async () => {
        const runDir = modal.querySelector('#ingRunDir').value.trim();
        const codeDir = modal.querySelector('#ingCodeDir').value.trim();
        const title = modal.querySelector('#ingTitle').value.trim();
        if (!runDir && !codeDir) return toast('请至少选择运行输出目录或代码仓库目录', true);
        try {
          const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, {
            expId: targetExpId || undefined,
            createNew: !targetExpId,
            runDir, codeDir, title
          });
          closeModal();
          S.selectedId = res.expId;
          await refreshItems();
          await renderDetail();
          toast(`导入成功：${res.configCount} 项参数 · ${res.metricCount} 项指标 · ${res.curveCount} 条曲线`);
        } catch (err) { toast('导入失败：' + err.message, true); }
      });

      modal.querySelector('#doIngestPasteBtn').addEventListener('click', async () => {
        const command = modal.querySelector('#ingCmdText').value.trim();
        const rawLog = modal.querySelector('#ingLogText').value.trim();
        const title = modal.querySelector('#ingPasteTitle').value.trim();
        if (!command && !rawLog) return toast('请粘贴启动命令或终端日志', true);
        try {
          const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, {
            expId: targetExpId || undefined,
            createNew: !targetExpId,
            command, rawLog, title
          });
          closeModal();
          S.selectedId = res.expId;
          await refreshItems();
          await renderDetail();
          toast(`已解析写入：${res.configCount} 项参数 · ${res.metricCount} 项指标${res.curveCount ? ' · 已生成训练曲线 CSV' : ''}`);
        } catch (err) { toast('解析失败：' + err.message, true); }
      });

      let batchRuns = [];
      modal.querySelector('#pickIngBatchDir')?.addEventListener('click', async () => {
        const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择包含多组运行的父目录' });
        if (dirs.length) modal.querySelector('#ingBatchDir').value = dirs[0];
      });
      modal.querySelector('#scanIngBatchBtn')?.addEventListener('click', async () => {
        const dir = modal.querySelector('#ingBatchDir').value.trim();
        if (!dir) return toast('请先选择父目录', true);
        try {
          const res = await svc('experiment', 'batchScanRunsFolder', dir);
          batchRuns = res.runs || [];
          const listEl = modal.querySelector('#ingBatchList');
          if (!batchRuns.length) {
            listEl.innerHTML = '<div class="hint">未在该目录下发现包含配置/指标/曲线的子实验目录</div>';
            modal.querySelector('#doIngestBatchBtn').disabled = true;
            return;
          }
          listEl.innerHTML = batchRuns.map((r, i) => `<label class="ablation-card">
            <input type="checkbox" data-batch-i="${i}" checked>
            <div><strong>${esc(r.dirName)}</strong> ${(r.frameworks || []).map((f) => `<span class="li-tag">${esc(f)}</span>`).join('')}
            <div class="hint">${r.configCount} 项参数 · ${r.metricCount} 项指标${r.metricsPreview ? ` · ${esc(r.metricsPreview)}` : ''}</div></div>
          </label>`).join('');
          modal.querySelector('#doIngestBatchBtn').disabled = false;
        } catch (err) { toast('扫描失败：' + err.message, true); }
      });
      modal.querySelector('#doIngestBatchBtn')?.addEventListener('click', async () => {
        const picks = Array.from(modal.querySelectorAll('[data-batch-i]:checked')).map((c) => batchRuns[Number(c.dataset.batchI)]).filter(Boolean);
        if (!picks.length) return toast('请至少勾选 1 个子目录', true);
        let ok = 0;
        let lastId = '';
        for (const r of picks) {
          try {
            const res = await svc('experiment', 'ingestRunIntoExperiment', S.ws, { createNew: true, runDir: r.runDir, title: r.dirName });
            ok++;
            lastId = res.expId;
          } catch (_) { /* continue */ }
        }
        closeModal();
        if (lastId) S.selectedId = lastId;
        await refreshItems();
        await renderDetail();
        toast(`批量导入完成：成功导入 ${ok} / ${picks.length} 个实验运行`);
      });
    }, 'wide');
  }

  /** 超参 Sweep 笛卡尔网格与多卡 / tmux / Slurm / Hydra multirun 脚本生成器 */
  function showSweepModal(sourceItem = null) {
    const fm = (sourceItem && sourceItem.frontmatter) || {};
    const defaultCmd = String(fm.command || 'python train.py --lr 1e-4 --lora_rank 16 --seed 42').trim();
    openModal('超参 Sweep 矩阵与集群启动脚本生成器', `
      <div class="form-field"><label>基准命令（自动识别 argparse <code>--key val</code> 与 Hydra <code>key=val</code>）</label><input id="swBaseCmd" value="${esc(defaultCmd)}"></div>
      <div class="form-row" style="margin-top:8px">
        <div class="form-field"><label>超参维度（每行一条，格式 <code>参数名: 值1, 值2, 值3</code>）</label><textarea id="swAxes" class="editor-area" style="min-height:86px">lr: 1e-4, 3e-4
seed: 42, 1024, 2025</textarea></div>
        <div class="form-field" style="max-width:170px">
          <label>可用 GPU ID</label><input id="swGpus" value="0,1">
          <label style="margin-top:8px">会话/任务名</label><input id="swSession" value="${esc((sourceItem && sourceItem.id) || 'vla_sweep')}">
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button type="button" class="btn sm" id="swBuildBtn">${ico('zap', 13)}生成 Sweep 网格与脚本</button>
        <button type="button" class="btn ghost sm" id="swSpawnCardsBtn" disabled>${ico('layers', 13)}批量生成实验卡片</button>
      </div>
      <div id="swOutputBox" style="margin-top:10px"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, (modal) => {
      let lastSweep = null;
      const build = async () => {
        const baseCmd = modal.querySelector('#swBaseCmd').value.trim();
        const gpus = modal.querySelector('#swGpus').value.trim() || '0';
        const sessionName = modal.querySelector('#swSession').value.trim() || 'cs_sweep';
        const axes = modal.querySelector('#swAxes').value.split(/\r?\n/).map((ln) => {
          const idx = ln.indexOf(':');
          if (idx < 0) return null;
          return { key: ln.slice(0, idx).trim(), values: ln.slice(idx + 1).trim() };
        }).filter(Boolean);
        try {
          lastSweep = await svc('experiment', 'generateSweepMatrix', baseCmd, axes, { gpus, sessionName });
          modal.querySelector('#swSpawnCardsBtn').disabled = false;
          let scriptKey = 'multiGpuScript';
          modal.querySelector('#swOutputBox').innerHTML = `
            <div class="hint" style="margin-bottom:6px">共生成 <b>${lastSweep.totalRuns}</b> 组组合（语法：${esc(lastSweep.syntaxStyle)}）${lastSweep.truncated ? ' · 已安全上限截断至 64 组' : ''}</div>
            <div class="export-tabs">
              <button type="button" class="btn sm" data-sw-tab="multiGpuScript">多卡并行队列</button>
              <button type="button" class="btn ghost sm" data-sw-tab="bashScript">顺序 Bash</button>
              <button type="button" class="btn ghost sm" data-sw-tab="tmuxScript">tmux 后台</button>
              <button type="button" class="btn ghost sm" data-sw-tab="slurmScript">Slurm Array</button>
              <button type="button" class="btn ghost sm" data-sw-tab="hydraMultirunCmd">Hydra -m</button>
              <button type="button" class="btn ghost sm" id="swCopyBtn" style="margin-left:auto">${ico('copy', 12)}复制脚本</button>
            </div>
            <textarea id="swScriptArea" class="editor-area" rows="12" readonly>${esc(lastSweep.multiGpuScript)}</textarea>`;
          const area = modal.querySelector('#swScriptArea');
          modal.querySelectorAll('[data-sw-tab]').forEach((b) => b.addEventListener('click', () => {
            scriptKey = b.dataset.swTab;
            modal.querySelectorAll('[data-sw-tab]').forEach((x) => x.classList.toggle('ghost', x !== b));
            area.value = lastSweep[scriptKey] || '';
          }));
          modal.querySelector('#swCopyBtn').addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(area.value); toast('已复制集群 Sweep 脚本'); } catch (_) { area.select(); }
          });
        } catch (err) { toast('生成 Sweep 失败：' + err.message, true); }
      };
      modal.querySelector('#swBuildBtn').addEventListener('click', build);
      modal.querySelector('#swSpawnCardsBtn').addEventListener('click', async () => {
        if (!lastSweep || !lastSweep.runs.length) return;
        try {
          const res = await svc('experiment', 'saveSweepChildren', S.ws, sourceItem ? sourceItem.id : '', lastSweep.runs);
          closeModal();
          await refreshItems();
          toast(`已批量创建 ${res.createdIds.length} 张 Sweep 实验卡片（含精确命令与超参）`);
        } catch (err) { toast('批量创建失败：' + err.message, true); }
      });
      build();
    }, 'wide');
  }

  function bindRelatedPapers(container, item) {
    const fm = item.frontmatter || {};
    const related = Array.isArray(fm.relatedPapers) ? fm.relatedPapers.slice() : [];
    const saveRel = async (nextList, msg) => {
      const nf = { ...fm, relatedPapers: nextList, updatedAt: new Date().toISOString().slice(0, 10) };
      await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: nf, body: item.body || '' });
      item.frontmatter = nf;
      await refreshExperimentDetail('design');
      toast(msg);
    };
    container.querySelectorAll('[data-rm-ep]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = btn.dataset.rmEp;
      saveRel(related.filter((x) => (typeof x === 'string' ? x : x && x.id) !== target), '已移除关联论文');
    }));
    container.querySelector('#expAddPaperBtn')?.addEventListener('click', async () => {
      try {
        const papers = await call('listItems', S.ws, 'papers');
        const used = new Set(related.map((x) => (typeof x === 'string' ? x : x && x.id)));
        const avail = (papers || []).filter((p) => !used.has(p.id));
        if (!avail.length) return toast('没有更多可关联的论文', true);
        const sel = document.createElement('select');
        sel.className = 'inline-editor';
        sel.style.width = 'auto';
        sel.innerHTML = `<option value="">选择论文…</option>` + avail.map((p) => `<option value="${esc(p.id)}">${esc(p.shortName || p.title || p.id)}</option>`).join('');
        container.querySelector('#expAddPaperBtn').replaceWith(sel);
        sel.focus();
        sel.addEventListener('change', () => { if (sel.value) saveRel(related.concat([sel.value]), '已关联参考论文'); });
        sel.addEventListener('blur', () => { if (!sel.value) refreshExperimentDetail('design'); });
      } catch (err) { toast('读取论文失败：' + err.message, true); }
    });
  }

  function bindEnvCapture(container, item) {
    container.querySelector('#captureEnvBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 采集中…';
      try {
        const info = await window.bridge.env.capture({ cwd: (item.frontmatter && item.frontmatter.codeDir) || undefined });
        if (!info || !info.ok) throw new Error((info && info.error) || '采集失败');
        const fm = { ...(item.frontmatter || {}) };
        const prev = fm.environment && typeof fm.environment === 'object' ? fm.environment : {};
        fm.environment = {
          ...prev,
          system: [info.os, ...(info.gpu || [])].filter(Boolean).join(' · '),
          python: info.python || prev.python || '',
          framework: info.torch ? `PyTorch ${info.torch}` : (prev.framework || ''),
          codeCommit: info.git && info.git.available
            ? `${info.git.commit}${info.git.branch ? ` (${info.git.branch})` : ''}${info.git.dirty ? ' *dirty' : ''}`
            : (prev.codeCommit || '')
        };
        fm.updatedAt = new Date().toISOString().slice(0, 10);
        await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: fm, body: item.body || '' });
        item.frontmatter = fm;
        await refreshExperimentDetail('params');
        toast('已安全采集本机复现环境（只读命令）');
      } catch (err) {
        toast('环境采集失败：' + err.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ico('zap', 12)}一键采集本机环境`; }
      }
    });
  }

  /** AI 实验设计与 AuthorAblation / ReviewerAblation 矩阵弹窗 */
  async function openAiDesignModal(item) {
    const fm = item.frontmatter || {};
    let linkedIdea = null;
    if (fm.relatedIdea) {
      try {
        const got = await call('getItem', S.ws, 'ideas', fm.relatedIdea);
        if (got) linkedIdea = { id: got.id, ...(got.frontmatter || {}), body: got.body || '' };
      } catch (_) { /* ignore */ }
    }
    const papers = await call('listItems', S.ws, 'papers').catch(() => []);
    const relSet = new Set((Array.isArray(fm.relatedPapers) ? fm.relatedPapers : []).map((x) => (typeof x === 'string' ? x : x && x.id)));
    const relPapers = relSet.size ? papers.filter((p) => relSet.has(p.id)) : papers.slice(0, 5);

    openModal('AI 科学实验设计与消融矩阵（K-Dense / Ablation-Bench）', `
      <div class="hint" style="margin-bottom:10px">生成 H1/H0、三类变量、ReviewerAblation 混杂审计清单，以及可一键批量派生子实验卡片的 AuthorAblation 消融矩阵。</div>
      <div id="expDesignBody"><div class="spinner"></div> 正在设计实验与消融方案…</div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, async (modal) => {
      const body = modal.querySelector('#expDesignBody');
      try {
        const res = await ai('designExperiment', {
          idea: linkedIdea || { title: fm.title, problem: fm.goal, hypothesis: fm.hypothesis, methodology: fm.protocol },
          papers: relPapers,
          parentExp: { id: item.id, ...fm },
          skillId: 'experimental-design-ablation'
        });
        const vars = res.variables || {};
        const matrix = Array.isArray(res.ablationMatrix) ? res.ablationMatrix : [];
        body.innerHTML = `
          <div class="exp-ai-card">
            <div><b>H1（研究假设）：</b>${esc(res.hypothesis)}</div>
            ${res.nullHypothesis ? `<div class="hint" style="margin-top:4px"><b>H0（零假设）：</b>${esc(res.nullHypothesis)}</div>` : ''}
            <div style="margin-top:6px"><b>量化成功判据：</b>${esc(res.successCriteria)}</div>
          </div>
          <div class="exp-vars-grid">
            <div class="field-box"><div class="field-label">自变量 (Independent)</div><ul>${(vars.independent || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
            <div class="field-box"><div class="field-label">因变量 (Dependent)</div><ul>${(vars.dependent || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
            <div class="field-box"><div class="field-label">控制变量 (Controls)</div><ul>${(vars.controls || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
          </div>
          <div class="section-title">ReviewerAblation 混杂审计清单</div>
          <ul class="eac-checks">${(res.confoundingChecks || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
          <div class="section-title">AuthorAblation 消融矩阵（${matrix.length} 组）</div>
          <div class="ablation-list">${matrix.map((arm, idx) => `
            <label class="ablation-card">
              <input type="checkbox" data-abl-i="${idx}" checked>
              <div>
                <strong>${esc(arm.name)}</strong> <span class="li-tag">${esc(arm.role || 'ablation')}</span>
                <div class="hint">配置变更：<code>${esc(JSON.stringify(arm.changedConfig || {}))}</code></div>
                <div>${esc(arm.hypothesis || '')}</div>
              </div>
            </label>`).join('')}</div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn ghost sm" id="applyDesignToCurrentBtn">${ico('check', 13)}写入当前实验设计</button>
            <button type="button" class="btn sm" id="spawnAblationsBtn">${ico('gitBranch', 13)}一键生成勾选的消融子实验卡片</button>
          </div>`;

        body.querySelector('#applyDesignToCurrentBtn').addEventListener('click', async () => {
          const nf = {
            ...fm,
            hypothesis: res.hypothesis || fm.hypothesis,
            aiDesign: {
              nullHypothesis: res.nullHypothesis || '',
              variables: vars,
              successCriteria: res.successCriteria || '',
              confoundingChecks: res.confoundingChecks || []
            },
            updatedAt: new Date().toISOString().slice(0, 10)
          };
          await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: nf, body: item.body || '' });
          item.frontmatter = nf;
          await refreshExperimentDetail('design');
          toast('已将实验设计与混杂审计清单写入当前实验');
        });

        body.querySelector('#spawnAblationsBtn').addEventListener('click', async () => {
          const picks = Array.from(body.querySelectorAll('[data-abl-i]:checked')).map((cb) => matrix[Number(cb.dataset.ablI)]).filter(Boolean);
          if (!picks.length) return toast('请至少勾选一组消融方案', true);
          try {
            const created = await svc('experiment', 'createAblationChildren', S.ws, item.id, picks);
            closeModal();
            await refreshItems();
            toast(`已批量派生 ${created.createdIds.length} 张消融子实验卡片（均挂在 basedOn: ${item.id} 下）`);
          } catch (err) { toast('派生子实验失败：' + err.message, true); }
        });
      } catch (err) {
        body.innerHTML = `<div class="hint" style="color:var(--red)">生成失败：${esc(err.message)}</div>`;
      }
    }, 'wide');
  }

  /** AI 实验结果与失败日志诊断 + 负结果台账 + 下一轮补丁弹窗 */
  async function openAiAnalyzeModal(item) {
    const fm = item.frontmatter || {};
    openModal('AI 实验结果诊断与负结果复盘（Autoresearch / Statistical Analysis）', `
      <div id="expAnalyzeBody"><div class="spinner"></div> 正在扫描日志与指标并执行诊断…</div>
      <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>
    `, async (modal) => {
      const body = modal.querySelector('#expAnalyzeBody');
      try {
        let parentExp = null;
        if (fm.basedOn) parentExp = await call('getItem', S.ws, 'experiments', fm.basedOn).catch(() => null);
        const files = await call('listDataFiles', S.ws, item.id).catch(() => []);
        const logExcerpts = [];
        for (const f of files.filter((x) => /\.(log|txt|jsonl|json|csv|tsv)$/i.test(x)).slice(0, 4)) {
          const df = await call('readDataFile', S.ws, item.id, f).catch(() => null);
          if (df && !df.binary && df.content) logExcerpts.push(`--- ${f} ---\n${String(df.content).slice(-1200)}`);
        }
        const res = await ai('analyzeExperimentResults', {
          exp: { id: item.id, ...fm },
          parentExp,
          statsSummary: item._lastStatsSummary || null,
          logExcerpts,
          skillId: 'statistical-analysis-diagnosis'
        });
        body.innerHTML = `
          <div class="exp-ai-card is-diag">
            <div class="eac-head">
              <span class="exp-keep-pill is-${esc(res.keepDecision || 'inconclusive')}">${esc((res.keepDecision || 'inconclusive').toUpperCase())}</span>
              <strong>${esc(res.verdict || '')}</strong>
              ${res.fallbackUsed ? '<span class="iac-tag">确定性诊断引擎</span>' : '<span class="iac-tag is-ai">AI 深度诊断</span>'}
            </div>
            <div class="section-title">量化发现</div>
            <ul class="eac-checks">${(res.findings || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
            ${res.failureDiagnosis ? `<div class="section-title">根因与修复建议</div><div class="failure-box">${esc(res.failureDiagnosis)}</div>` : ''}
            ${res.negativeResultEntry ? `<div class="section-title">负结果台账条目</div><div class="eac-neg">${esc(res.negativeResultEntry)}</div>` : ''}
          </div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn sm" id="saveDiagBtn">${ico('check', 13)}写入结论 / 失败复盘与裁决</button>
            <button type="button" class="btn ghost sm" id="spawnPatchExpBtn">${ico('layers', 13)}按建议派生下一版实验</button>
            ${fm.relatedIdea ? `<button type="button" class="btn ghost sm" id="diagSyncIdeaBtn">${ico('lightbulb', 13)}同步回流至关联 Idea</button>` : ''}
          </div>`;

        body.querySelector('#saveDiagBtn').addEventListener('click', async () => {
          const nextStatus = res.keepDecision === 'keep' ? '完成' : res.keepDecision === 'discard' ? '失败' : res.keepDecision === 'blocked' ? '阻塞' : fm.status;
          const nf = {
            ...fm,
            status: nextStatus,
            keepDecision: res.keepDecision || '',
            verdict: res.verdict || '',
            conclusion: [res.verdict, ...(res.findings || [])].filter(Boolean).join('；'),
            negativeResultEntry: res.negativeResultEntry || fm.negativeResultEntry || '',
            failure: res.failureDiagnosis
              ? { type: (res.logIssues && res.logIssues[0] && res.logIssues[0].type) || '实验未达预期', cause: res.failureDiagnosis, action: (res.nextExperimentPatch && res.nextExperimentPatch.hypothesis) || '' }
              : (fm.failure || {}),
            aiDiagnosis: { verdict: res.verdict, keepDecision: res.keepDecision, findings: res.findings, negativeResultEntry: res.negativeResultEntry },
            updatedAt: new Date().toISOString().slice(0, 10)
          };
          await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: nf, body: item.body || '' });
          item.frontmatter = nf;
          closeModal();
          await refreshExperimentDetail('design');
          toast('已将诊断结论与裁决写回实验记录');
        });

        body.querySelector('#spawnPatchExpBtn').addEventListener('click', async () => {
          const patch = res.nextExperimentPatch || {};
          const arm = {
            name: patch.title || `${fm.title || item.id}（修复迭代）`,
            role: 'iteration',
            changedConfig: patch.configPatch || {},
            hypothesis: patch.hypothesis || '',
            rationale: res.failureDiagnosis || '基于上一版诊断建议的针对性迭代'
          };
          const created = await svc('experiment', 'createAblationChildren', S.ws, item.id, [arm]);
          closeModal();
          S.selectedId = created.createdIds[0];
          await refreshItems();
          await renderDetail();
          toast('已派生下一版迭代实验');
        });

        body.querySelector('#diagSyncIdeaBtn')?.addEventListener('click', async () => {
          closeModal();
          await syncToIdea(item.id);
        });
      } catch (err) {
        body.innerHTML = `<div class="hint" style="color:var(--red)">诊断失败：${esc(err.message)}</div>`;
      }
    }, 'wide');
  }

  /** 导出可复现脚本、YAML 配置与 ELN 卡片 */
  async function openReproModal(item) {
    try {
      const bundle = await svc('experiment', 'generateReproBundle', { id: item.id, frontmatter: item.frontmatter || {} });
      let active = 'configYaml';
      openModal(`可复现实验包：${item.id}`, `
        <div class="export-tabs">
          <button type="button" class="btn sm" data-repro-tab="configYaml">config.yaml</button>
          <button type="button" class="btn ghost sm" data-repro-tab="runScriptSh">run_experiment.sh</button>
          <button type="button" class="btn ghost sm" data-repro-tab="elnMarkdown">ELN 协议卡</button>
          <button type="button" class="btn ghost sm" id="copyReproBtn" style="margin-left:auto">${ico('copy', 12)}复制内容</button>
        </div>
        <textarea id="reproArea" class="editor-area" rows="15" readonly>${esc(bundle.configYaml)}</textarea>
        <div class="modal-actions"><button class="btn" data-close>完成</button></div>
      `, (modal) => {
        const area = modal.querySelector('#reproArea');
        modal.querySelectorAll('[data-repro-tab]').forEach((b) => b.addEventListener('click', () => {
          active = b.dataset.reproTab;
          modal.querySelectorAll('[data-repro-tab]').forEach((x) => x.classList.toggle('ghost', x !== b));
          area.value = bundle[active] || '';
        }));
        modal.querySelector('#copyReproBtn').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(area.value); toast('已复制可复现模板'); } catch (_) { area.select(); toast('请按 Ctrl+C 复制'); }
        });
      }, 'wide');
    } catch (err) { toast('生成复现包失败：' + err.message, true); }
  }

  /** HypoRefine：将实验结论与极性回流至关联 Idea */
  async function syncToIdea(expId) {
    const exp = await call('getItem', S.ws, 'experiments', expId);
    if (!exp) return toast('实验不存在', true);
    const ideaId = String((exp.frontmatter && exp.frontmatter.relatedIdea) || '').trim();
    if (!ideaId) return toast('当前实验未填写「关联灵感」ID，无法回流', true);
    const ideaItem = await call('getItem', S.ws, 'ideas', ideaId);
    if (!ideaItem) return toast(`未找到关联 Idea：${ideaId}`, true);
    toast('正在执行 HypoRefine 实验结论回流…');
    try {
      const res = await ai('refineIdeaFromExperiment', {
        idea: { id: ideaItem.id, ...(ideaItem.frontmatter || {}), body: ideaItem.body || '' },
        experiment: { id: exp.id, ...(exp.frontmatter || {}), body: exp.body || '' },
        skillId: 'co-scientist-tournament'
      });
      const nextFm = {
        ...(ideaItem.frontmatter || {}),
        ...(res.updatedIdea || {}),
        updatedAt: new Date().toISOString().slice(0, 10)
      };
      delete nextFm.body;
      delete nextFm.id;
      await call('saveItem', S.ws, 'ideas', ideaItem.id, { frontmatter: nextFm, body: ideaItem.body || '' });
      toast(`已回流至「${nextFm.title || ideaItem.id}」：${res.deltaSummary}`);
      return res;
    } catch (err) {
      toast('回流 Idea 失败：' + err.message, true);
      return null;
    }
  }

  /** CS 实验总榜、多种子 booktabs 论文表（rliable IQM）、EMA 曲线叠加与 Git 代码 Diff 对比工作台 */
  async function showCompareModal() {
    let cmp;
    let expDetails = [];
    try {
      cmp = await svc('experiment', 'compareExperiments', S.ws, []);
      const ids = ((cmp && cmp.rows) || []).map((r) => r.id);
      expDetails = (await Promise.all(ids.map((id) => call('getItem', S.ws, 'experiments', id).catch(() => null)))).filter(Boolean);
    } catch (e) { return toast('对比加载失败：' + e.message, true); }
    const allRows = (cmp && cmp.rows) || [];
    if (!allRows.length) return toast('当前工作区还没有实验记录', true);
    const detailById = new Map(expDetails.map((d) => [d.id, d.frontmatter || {}]));

    const renderTreeHtml = (nodes) => {
      if (!nodes || !nodes.length) return '<div class="hint">暂无演进关系</div>';
      return `<ul class="exp-tree-ul">${nodes.map((n) => {
        const mText = Object.entries(n.metrics || {}).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' · ');
        return `<li>
          <div class="exp-tree-node">
            <span class="exp-keep-pill is-${esc(n.verdictBadge || 'running')}">${esc((n.verdictBadge || 'running').toUpperCase())}</span>
            <button type="button" class="exp-tree-jump" data-jump-exp="${esc(n.id)}">${esc(n.title)}</button>
            <span class="hint">${esc(n.id)}${mText ? ` · ${esc(mText)}` : ''}</span>
          </div>
          ${n.children && n.children.length ? renderTreeHtml(n.children) : ''}
        </li>`;
      }).join('')}</ul>`;
    };

    openModal(`CS 实验总榜 · 多种子论文表 · EMA 曲线叠加（${allRows.length} 个运行）`, `
      <div class="export-tabs" id="cmpSubTabs">
        <button type="button" class="btn sm" data-ctab="board">1. 实验总榜 &amp; 参数 Diff</button>
        <button type="button" class="btn ghost sm" data-ctab="seeds">2. 多种子聚合 &amp; 顶会 booktabs 表</button>
        <button type="button" class="btn ghost sm" data-ctab="curves">3. 多实验曲线叠加 &amp; EMA 平滑</button>
        <button type="button" class="btn ghost sm" data-ctab="tree">4. 演进树 &amp; Git 代码 Diff</button>
      </div>
      <div class="exp-cmp-controls">
        <div class="exp-cmp-picks" id="expCmpPicks">
          ${allRows.map((r) => `<label class="exp-cmp-chip"><input type="checkbox" value="${esc(r.id)}" checked><span>${esc(r.title)}</span></label>`).join('')}
        </div>
      </div>

      <div id="cmpPaneBoard" class="ingest-pane active">
        <div class="exp-cmp-bar" style="margin-bottom:8px">
          <label>基准基线：<select id="expCmpBaseline">${allRows.map((r) => `<option value="${esc(r.id)}">${esc(r.title)} (${esc(r.id)})</option>`).join('')}</select></label>
          <button type="button" class="btn ghost sm" id="copyCmpMdBtn">${ico('copy', 12)}复制 Markdown</button>
          <button type="button" class="btn ghost sm" id="copyCmpLatexBtn">${ico('code', 12)}复制 LaTeX</button>
        </div>
        <div id="expCmpTableHost" class="data-table-wrap"></div>
      </div>

      <div id="cmpPaneSeeds" class="ingest-pane">
        <div class="exp-cmp-bar" style="margin-bottom:8px">
          <span class="hint">自动忽略 <code>seed</code> 字段将同配置实验归组，计算 <b>Mean ± Std</b>、<b>rliable IQM</b> 与相对基线组的 Welch t-test 显著星号（* p&lt;0.05, ** p&lt;0.01）。</span>
          <button type="button" class="btn sm" id="copyBooktabsBtn" style="margin-left:auto">${ico('code', 12)}复制顶会 booktabs LaTeX</button>
          <button type="button" class="btn ghost sm" id="copyAggMdBtn">${ico('copy', 12)}复制 Markdown</button>
        </div>
        <div id="expAggTableHost" class="data-table-wrap"></div>
        <textarea id="expBooktabsPreview" class="editor-area" rows="8" readonly style="margin-top:8px"></textarea>
      </div>

      <div id="cmpPaneCurves" class="ingest-pane">
        <div class="exp-cmp-bar" style="margin-bottom:8px">
          <label>指标列：<select id="expOverlayMetricSel"><option value="">自动匹配首数值列</option></select></label>
          <label class="ema-slider-wrap">TensorBoard EMA 平滑：<input type="range" id="expOverlayEma" min="0" max="0.95" step="0.05" value="0.4"><span id="expOverlayEmaVal">0.40</span></label>
        </div>
        <div id="expOverlayChartHost"></div>
      </div>

      <div id="cmpPaneTree" class="ingest-pane">
        <div class="section-title">实验演进树（basedOn Lineage Tree · Keep/Discard 剪枝视图）</div>
        <div class="exp-tree-box" id="expLineageTreeBox">${renderTreeHtml(cmp.lineageTree)}</div>
        <div class="section-title">代码版本 Git Diff 对比（同一代码仓的两个实验）</div>
        <div class="exp-cmp-bar">
          <select id="gitDiffExpA">${allRows.map((r) => `<option value="${esc(r.id)}">${esc(r.title)} (${esc(((detailById.get(r.id) || {}).environment || {}).codeCommit || '无 commit')})</option>`).join('')}</select>
          <span class="hint">vs</span>
          <select id="gitDiffExpB">${allRows.map((r, i) => `<option value="${esc(r.id)}" ${i === 1 ? 'selected' : ''}>${esc(r.title)} (${esc(((detailById.get(r.id) || {}).environment || {}).codeCommit || '无 commit')})</option>`).join('')}</select>
          <button type="button" class="btn ghost sm" id="runGitDiffBtn">${ico('gitBranch', 12)}对比代码改动</button>
        </div>
        <pre id="gitDiffOut" class="cs-diff-pre" style="margin-top:8px;max-height:220px">选择两个带代码仓与 Git Commit 的实验点击对比…</pre>
      </div>

      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>
    `, (modal) => {
      let currentCmp = cmp;
      let currentAgg = null;
      let parsedCurvesCache = [];

      modal.querySelectorAll('[data-ctab]').forEach((b) => b.addEventListener('click', () => {
        const t = b.dataset.ctab;
        modal.querySelectorAll('[data-ctab]').forEach((x) => x.classList.toggle('ghost', x !== b));
        modal.querySelector('#cmpPaneBoard').classList.toggle('active', t === 'board');
        modal.querySelector('#cmpPaneSeeds').classList.toggle('active', t === 'seeds');
        modal.querySelector('#cmpPaneCurves').classList.toggle('active', t === 'curves');
        modal.querySelector('#cmpPaneTree').classList.toggle('active', t === 'tree');
        if (t === 'curves') drawOverlayChart();
      }));

      const drawOverlayChart = () => {
        const host = modal.querySelector('#expOverlayChartHost');
        if (!window.Charts || !window.Stats) { host.innerHTML = '<div class="hint">图表模块未加载</div>'; return; }
        const chosenMetric = modal.querySelector('#expOverlayMetricSel').value;
        const emaW = Number(modal.querySelector('#expOverlayEma').value) || 0;
        modal.querySelector('#expOverlayEmaVal').textContent = emaW.toFixed(2);
        const series = [];
        let labels = [];
        for (const itemCurve of parsedCurvesCache) {
          const { title, parsed } = itemCurve;
          const xCol = parsed.columns[0];
          const yCol = (chosenMetric && parsed.columns.includes(chosenMetric))
            ? chosenMetric
            : (parsed.columns.find((c, idx) => idx > 0 && parsed.rows.some((row) => typeof row[c] === 'number')) || parsed.columns[1]);
          if (!yCol) continue;
          const xs = parsed.rows.map((row) => String(row[xCol]));
          if (xs.length > labels.length) labels = xs;
          const rawVals = parsed.rows.map((row) => (typeof row[yCol] === 'number' ? row[yCol] : null));
          const smoothed = emaW > 0 ? Stats.emaSmooth(rawVals, emaW) : rawVals;
          series.push({ label: `${title} (${yCol})`, data: smoothed });
        }
        if (!series.length) {
          host.innerHTML = '<div class="hint">所选实验暂无可叠加的 CSV / TSV / TensorBoard 曲线文件</div>';
          return;
        }
        host.innerHTML = '<div class="chart-canvas-wrap" style="height:260px"><canvas id="expOverlayCanvas"></canvas></div>';
        Charts.destroy('exp:overlay');
        Charts.renderSimple('exp:overlay', host.querySelector('#expOverlayCanvas'), labels, series, 'line');
      };

      const refreshCompare = async () => {
        const pickedIds = Array.from(modal.querySelectorAll('#expCmpPicks input:checked')).map((c) => c.value);
        const baselineId = modal.querySelector('#expCmpBaseline').value;
        if (!pickedIds.length) {
          modal.querySelector('#expCmpTableHost').innerHTML = '<div class="hint">请至少勾选 1 个实验</div>';
          return;
        }
        [currentCmp, currentAgg] = await Promise.all([
          svc('experiment', 'compareExperiments', S.ws, pickedIds, { baselineId }),
          svc('experiment', 'aggregateByConfig', S.ws, pickedIds)
        ]);
        const rows = currentCmp.rows || [];
        const diffKeys = currentCmp.configDiffKeys || [];
        const mKeys = currentCmp.metricKeys || [];
        const bestMap = currentCmp.bestByMetric || {};

        modal.querySelector('#expCmpTableHost').innerHTML = `<table class="data-table exp-cmp-table">
          <thead><tr><th>实验</th><th>裁决</th><th>Commit</th>${diffKeys.map((k) => `<th class="is-diff-col">cfg:${esc(k)}</th>`).join('')}${mKeys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => {
            const dFm = detailById.get(r.id) || {};
            const commit = (dFm.environment && dFm.environment.codeCommit) || '—';
            return `<tr>
              <td><button type="button" class="exp-tree-jump" data-jump-exp="${esc(r.id)}">${esc(r.title)}</button>${r.id === currentCmp.baselineId ? ' <span class="li-tag">Base</span>' : ''}</td>
              <td><span class="exp-keep-pill is-${esc(r.verdictBadge)}">${esc((r.verdictBadge || '').toUpperCase())}</span></td>
              <td><code>${esc(String(commit).slice(0, 14))}</code></td>
              ${diffKeys.map((k) => `<td class="is-diff-cell">${esc(r.config[k] !== undefined ? String(r.config[k]) : '—')}</td>`).join('')}
              ${mKeys.map((k) => {
                const v = r.metrics[k];
                if (v === undefined || v === '') return '<td>—</td>';
                const d = r.metricDeltas && r.metricDeltas[k];
                const isBest = bestMap[k] && bestMap[k].id === r.id && rows.length > 1;
                let deltaHtml = '';
                if (d && r.id !== currentCmp.baselineId) {
                  const sign = d.delta >= 0 ? '+' : '';
                  deltaHtml = ` <span class="cmp-delta ${d.delta >= 0 ? 'is-pos' : 'is-neg'}">(${sign}${d.delta}${d.pct !== null ? `, ${sign}${d.pct}%` : ''})</span>`;
                }
                return `<td class="${isBest ? 'is-best-cell' : ''}">${esc(v)}${deltaHtml}</td>`;
              }).join('')}
            </tr>`;
          }).join('')}</tbody>
        </table>`;

        // 渲染多种子聚合表与 booktabs LaTeX
        const groups = (currentAgg && currentAgg.groups) || [];
        const aggKeys = (currentAgg && currentAgg.metricKeys) || [];
        const rankMap = (currentAgg && currentAgg.rankByMetric) || {};
        modal.querySelector('#expAggTableHost').innerHTML = groups.length ? `<table class="data-table exp-cmp-table">
          <thead><tr><th>实验变体（忽略 seed 归组）</th><th>Seeds (N)</th>${aggKeys.map((k) => `<th>${esc(k)} (Mean ± Std)</th><th>IQM (${esc(k)})</th>`).join('')}</tr></thead>
          <tbody>${groups.map((g) => `<tr>
            <td><b>${esc(g.label)}</b><div class="hint">${esc(g.runIds.join(', '))}</div></td>
            <td>${g.seedCount}${g.seedCount < 3 ? ' <span class="smc-warn">N&lt;3</span>' : ''}</td>
            ${aggKeys.map((k) => {
              const st = g.stats[k];
              if (!st || st.mean === null) return '<td>—</td><td>—</td>';
              const p = g.pValues && g.pValues[k];
              const star = p !== undefined ? (p < 0.01 ? ' **' : p < 0.05 ? ' *' : '') : '';
              const isBest = rankMap[k] && rankMap[k].bestKey === g.key && groups.length > 1;
              return `<td class="${isBest ? 'is-best-cell' : ''}">${st.mean.toFixed(2)}${st.n > 1 ? ` ± ${st.std.toFixed(2)}` : ''}${star}${p !== undefined ? `<div class="hint">p=${p.toFixed(4)}</div>` : ''}</td><td>${st.iqm !== null ? st.iqm.toFixed(2) : '—'}</td>`;
            }).join('')}
          </tr>`).join('')}</tbody>
        </table>` : '<div class="hint">暂无可聚合指标</div>';
        modal.querySelector('#expBooktabsPreview').value = (currentAgg && currentAgg.booktabsLatex) || '';

        modal.querySelectorAll('[data-jump-exp]').forEach((b) => b.addEventListener('click', async () => {
          closeModal();
          S.selectedId = b.dataset.jumpExp;
          await refreshItems();
          await renderDetail();
        }));

        // 预加载所选实验曲线数据
        parsedCurvesCache = [];
        const metricColSet = new Set();
        for (const r of rows) {
          const csvName = (r.dataFiles || []).find((f) => /\.(csv|tsv)$/i.test(f));
          if (!csvName) continue;
          const df = await call('readDataFile', S.ws, r.id, csvName).catch(() => null);
          if (!df || df.binary || !df.content) continue;
          const parsed = Stats.parseStructuredData(csvName, df.content);
          if (!parsed.ok || !parsed.rows.length || parsed.columns.length < 2) continue;
          parsed.columns.slice(1).forEach((c) => metricColSet.add(c));
          parsedCurvesCache.push({ id: r.id, title: r.title, parsed });
        }
        const mSel = modal.querySelector('#expOverlayMetricSel');
        const prevVal = mSel.value;
        mSel.innerHTML = '<option value="">自动匹配首数值列</option>' + Array.from(metricColSet).map((c) => `<option value="${esc(c)}" ${c === prevVal ? 'selected' : ''}>${esc(c)}</option>`).join('');
        if (modal.querySelector('#cmpPaneCurves').classList.contains('active')) drawOverlayChart();
      };

      modal.querySelectorAll('#expCmpPicks input').forEach((c) => c.addEventListener('change', refreshCompare));
      modal.querySelector('#expCmpBaseline').addEventListener('change', refreshCompare);
      modal.querySelector('#expOverlayMetricSel').addEventListener('change', drawOverlayChart);
      modal.querySelector('#expOverlayEma').addEventListener('input', drawOverlayChart);
      modal.querySelector('#copyCmpMdBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(currentCmp.markdownTable || ''); toast('已复制 Markdown 对比表'); } catch (_) { toast('复制失败', true); }
      });
      modal.querySelector('#copyCmpLatexBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(currentCmp.latexTable || ''); toast('已复制 LaTeX 表'); } catch (_) { toast('复制失败', true); }
      });
      modal.querySelector('#copyBooktabsBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText((currentAgg && currentAgg.booktabsLatex) || ''); toast('已复制顶会 booktabs LaTeX 表格'); } catch (_) { toast('复制失败', true); }
      });
      modal.querySelector('#copyAggMdBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText((currentAgg && currentAgg.markdownTable) || ''); toast('已复制多种子聚合 Markdown 表'); } catch (_) { toast('复制失败', true); }
      });
      modal.querySelector('#runGitDiffBtn').addEventListener('click', async () => {
        const idA = modal.querySelector('#gitDiffExpA').value;
        const idB = modal.querySelector('#gitDiffExpB').value;
        const fmA = detailById.get(idA) || {};
        const fmB = detailById.get(idB) || {};
        const codeDir = fmA.codeDir || fmB.codeDir || '';
        const cA = (fmA.gitSnapshot && fmA.gitSnapshot.commit) || (fmA.environment && fmA.environment.codeCommit) || '';
        const cB = (fmB.gitSnapshot && fmB.gitSnapshot.commit) || (fmB.environment && fmB.environment.codeCommit) || '';
        const out = modal.querySelector('#gitDiffOut');
        if (!codeDir || !cA || !cB) {
          out.textContent = '请先在两个实验的「CS 工程运行锚点」中绑定代码仓库并抓取 Git Commit，再进行代码 Diff 对比。';
          return;
        }
        const res = await svc('experiment', 'compareCodeCommits', codeDir, cA, cB);
        out.textContent = res.ok ? `=== ${res.commitA} .. ${res.commitB} ===\n${res.diffStat}\n\n${res.diffPatch}` : `对比失败：${res.error}`;
      });
      refreshCompare();
    }, 'wide cs-exp-modal');
  }

  /** 负结果台账弹窗（Negative Result Ledger） */
  async function showNegativeLedgerModal() {
    let entries = [];
    try { entries = await svc('experiment', 'listNegativeResults', S.ws); } catch (e) { return toast('读取负结果台账失败：' + e.message, true); }
    openModal(`负结果与死胡同台账（${entries.length} 条 · KalarisLabs / Autoresearch）`, `
      <div class="hint" style="margin-bottom:10px">自动汇总失败、退化或阻塞实验的参数配置、根因与教训，避免后续重复踩坑。</div>
      ${entries.length ? `<div class="ledger-list">${entries.map((e) => `<div class="ledger-card">
        <div class="ledger-head">
          <span class="exp-keep-pill is-${esc(e.badge)}">${esc(e.badge.toUpperCase())}</span>
          <button type="button" class="exp-tree-jump" data-jump-ledger="${esc(e.id)}">${esc(e.title)}</button>
          <span class="hint" style="margin-left:auto">${esc(e.date)} · ${esc(e.failureType)}</span>
        </div>
        <div class="ledger-cause">${esc(e.failureCause || '未记录具体原因')}</div>
        ${Object.keys(e.config || {}).length ? `<div class="hint">配置：<code>${esc(JSON.stringify(e.config))}</code></div>` : ''}
        ${e.fixAction ? `<div class="ledger-fix">改进/规避动作：${esc(e.fixAction)}</div>` : ''}
      </div>`).join('')}</div>` : '<div class="chart-empty">当前工作区尚无负结果记录（实验标为失败/阻塞或经 AI 诊断为 Discard 后自动归档）</div>'}
      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>
    `, (modal) => {
      modal.querySelectorAll('[data-jump-ledger]').forEach((b) => b.addEventListener('click', async () => {
        closeModal();
        S.selectedId = b.dataset.jumpLedger;
        await refreshItems();
        await renderDetail();
      }));
    }, 'wide');
  }

  function showExperimentSkillsModal() {
    return showDomainSkillsModal('experiment', '实验设计与分析 Skills');
  }

  /** 归一化单个数据文件的图表配置；缺省 = 首列横轴 + 首数值列纵轴 + 折线。 */
  function normalizeChartCfg(saved, parsed) {
    const s = saved || {};
    const headers = parsed.headers || [];
    const nums = parsed.numericColumns || [];
    const xKey = headers.indexOf(s.xKey) >= 0 ? s.xKey : (headers[0] || '');
    let yKeys = Array.isArray(s.yKeys)
      ? s.yKeys.filter((k) => headers.indexOf(k) >= 0 && nums.some((n) => n.name === k))
      : [];
    if (!yKeys.length && nums.length) yKeys = [nums[0].name];
    return {
      type: s.type === 'bar' ? 'bar' : 'line',
      xKey: xKey,
      yKeys: yKeys,
      yAxes: (s.yAxes && typeof s.yAxes === 'object') ? s.yAxes : {}
    };
  }

  /** 与图表同源的表格预览 HTML（P1-1：不再 split(delim) 直切）。 */
  function dataTableHtml(parsed, limit = 12) {
    if (!parsed || parsed.error || !parsed.headers || !parsed.headers.length) return '';
    const rows = (parsed.rows || []).slice(0, limit);
    if (!rows.length) return '';
    return `<table class="data-table"><thead><tr>${parsed.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  /** 图表配置写回该实验 md 的 results.chartConfig，保留 metrics/charts/data_files 与正文。 */
  async function saveChartConfig(item, fileName, cfg) {
    const fm = { ...(item.frontmatter || {}) };
    const results = { ...(fm.results || {}) };
    const chartConfig = { ...(results.chartConfig || {}) };
    chartConfig[fileName] = {
      type: cfg.type,
      xKey: cfg.xKey,
      yKeys: cfg.yKeys.slice(),
      yAxes: { ...(cfg.yAxes || {}) }
    };
    results.chartConfig = chartConfig;
    fm.results = results;
    try {
      await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: fm, body: item.body || '' });
      item.frontmatter = fm;
    } catch (e) {
      toast('图表配置保存失败：' + e.message, true);
    }
  }

  /** 图表卡片 HTML（含 TensorBoard 风格 EMA 平滑滑块）。 */
  function chartCardHtml(key, fileName, parsed, cfg, canvasId) {
    const xOpts = parsed.headers.map((h) => `<option value="${esc(h)}" ${h === cfg.xKey ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const yControls = parsed.numericColumns.map((c) => {
      const checked = cfg.yKeys.indexOf(c.name) >= 0;
      const axis = cfg.yAxes[c.name] === 'y1' ? 'y1' : 'y';
      return `<label class="cc-y"><input type="checkbox" data-y="${esc(c.name)}" ${checked ? 'checked' : ''}>${esc(c.name)}</label>` +
        `<select class="cc-axis" data-axis="${esc(c.name)}" title="主轴 / 右轴"><option value="y" ${axis === 'y' ? 'selected' : ''}>主轴</option><option value="y1" ${axis === 'y1' ? 'selected' : ''}>右轴</option></select>`;
    }).join('');
    return `<div class="chart-card" data-chart-key="${esc(key)}" data-file="${esc(fileName)}">
      <div class="chart-card-head">
        <span class="chart-card-title">${ico('chart', 13)} ${esc(fileName)}</span>
        <span class="spacer"></span>
        <label class="ema-inline-ctrl" title="TensorBoard 指数移动平均平滑">EMA <input type="range" data-ema min="0" max="0.95" step="0.05" value="0"><span data-ema-val>0.00</span></label>
        <span class="chart-type-switch">
          <button class="chart-type-btn ${cfg.type === 'line' ? 'active' : ''}" data-type="line">折线</button>
          <button class="chart-type-btn ${cfg.type === 'bar' ? 'active' : ''}" data-type="bar">柱状</button>
        </span>
        <button class="mini-btn" data-cfg-toggle title="配置列映射">${ico('settings', 13)}配置</button>
        <button class="mini-btn" data-export title="导出 PNG 到 experiments/data/">${ico('download', 13)}导出</button>
      </div>
      <div class="chart-canvas-wrap"><canvas id="${canvasId}" data-chart-key="${esc(key)}"></canvas></div>
      <div class="chart-config" data-cfg-panel>
        <div class="cc-group"><span class="cc-label">横轴</span><select data-x>${xOpts}</select></div>
        <div class="cc-group"><span class="cc-label">纵轴（数值列）</span>${yControls || '<span class="hint">未识别到数值列</span>'}</div>
        <div class="cc-group"><span class="cc-axes">右轴用于量纲差异大的序列；配置自动保存到该实验 md</span></div>
      </div>
    </div>`;
  }

  /** 对 parsed 表按 EMA 平滑纵轴数值列生成绘图视图（不修改原始数据）。 */
  function smoothedParsedForChart(parsed, yKeys, weight) {
    if (!weight || !window.Stats || !parsed || !Array.isArray(parsed.rows)) return parsed;
    const headers = parsed.headers || [];
    const colIdx = new Set((yKeys || []).map((k) => headers.indexOf(k)).filter((i) => i >= 0));
    if (!colIdx.size) return parsed;
    const rows = parsed.rows.map((r) => r.slice());
    colIdx.forEach((ci) => {
      const colVals = rows.map((r) => {
        const n = Number(String(r[ci] || '').replace(/,/g, '').replace(/%$/, ''));
        return Number.isFinite(n) ? n : null;
      });
      const sm = Stats.emaSmooth(colVals, weight);
      for (let ri = 0; ri < rows.length; ri++) {
        if (sm[ri] !== null) rows[ri][ci] = String(sm[ri]);
      }
    });
    return { ...parsed, rows };
  }

  /** 绑定单个图表卡片：类型 / 横轴 / 纵轴 / 右轴 / EMA 平滑 / 配置展开 / PNG 导出。 */
  function bindChartCard(card, state, item, fileName) {
    const canvas = card.querySelector('canvas');
    const key = state.key;
    const cfg = state.cfg;
    let emaWeight = 0;
    const redraw = () => {
      if (!window.Charts) return;
      Charts.destroy(key);
      const dataToPlot = emaWeight > 0 ? smoothedParsedForChart(state.parsed, cfg.yKeys, emaWeight) : state.parsed;
      Charts.render(key, canvas, dataToPlot, cfg);
      canvas._chartState = { ...state, parsed: dataToPlot };
    };
    const commit = async () => {
      redraw();
      card.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === cfg.type));
      await saveChartConfig(item, fileName, cfg);
      toast('图表配置已保存');
    };
    const emaSlider = card.querySelector('[data-ema]');
    const emaVal = card.querySelector('[data-ema-val]');
    if (emaSlider) {
      emaSlider.addEventListener('input', () => {
        emaWeight = Number(emaSlider.value) || 0;
        if (emaVal) emaVal.textContent = emaWeight.toFixed(2);
        redraw();
      });
    }
    card.querySelectorAll('[data-type]').forEach((btn) => btn.addEventListener('click', () => {
      if (cfg.type === btn.dataset.type) return;
      cfg.type = btn.dataset.type;
      commit();
    }));
    const xSel = card.querySelector('[data-x]');
    if (xSel) xSel.addEventListener('change', () => { cfg.xKey = xSel.value; commit(); });
    card.querySelectorAll('[data-y]').forEach((cb) => cb.addEventListener('change', () => {
      cfg.yKeys = Array.from(card.querySelectorAll('[data-y]:checked')).map((x) => x.dataset.y);
      commit();
    }));
    card.querySelectorAll('[data-axis]').forEach((sel) => sel.addEventListener('change', () => {
      const yAxes = {};
      card.querySelectorAll('[data-axis]').forEach((s) => { if (s.value === 'y1') yAxes[s.dataset.axis] = 'y1'; });
      cfg.yAxes = yAxes;
      commit();
    }));
    const panel = card.querySelector('[data-cfg-panel]');
    const toggle = card.querySelector('[data-cfg-toggle]');
    if (panel && toggle) toggle.addEventListener('click', () => panel.classList.toggle('open'));
    const exportBtn = card.querySelector('[data-export]');
    if (exportBtn) exportBtn.addEventListener('click', async () => {
      if (!window.Charts) return toast('图表库未加载', true);
      const dataUrl = Charts.exportPng(key);
      if (!dataUrl) return toast('导出失败', true);
      try {
        const base = fileName.replace(/\.(csv|tsv)$/i, '');
        const saved = await call('saveDataFileBase64', S.ws, item.id, base + '-chart.png', dataUrl);
        toast('已保存到 experiments/data/' + saved);
      } catch (e) { toast(e.message, true); }
    });
  }

  /** 基于 window.Stats 对解析出的结构化数值列渲染纯 JS 统计摘要（含 rliable IQM）与基线显著性检验面板 */
  async function renderStatsSummary(container, item, numericSeriesMap, extractedMetrics) {
    const panel = container.querySelector('#expStatsPanel');
    if (!panel || !window.Stats) return;
    const keys = Object.keys(numericSeriesMap);
    if (!keys.length && !Object.keys(extractedMetrics).length) {
      panel.innerHTML = '';
      return;
    }

    const cards = keys.slice(0, 6).map((col) => {
      const st = Stats.summarize(numericSeriesMap[col]);
      if (!st.n) return '';
      return `<div class="stat-metric-card">
        <div class="smc-head"><b>${esc(col)}</b><span class="smc-n">N=${st.n}</span>${st.lowNWarning ? '<span class="smc-warn">小样本警告</span>' : ''}</div>
        <div class="smc-main">${fmtNum(st.mean)} ± ${fmtNum(st.std)}</div>
        <div class="smc-sub">IQM ${fmtNum(st.iqm)} · 95% CI [${fmtNum(st.ci95[0])}, ${fmtNum(st.ci95[1])}]</div>
      </div>`;
    }).filter(Boolean);

    let sigHtml = '';
    const parentId = String((item.frontmatter && item.frontmatter.basedOn) || '').trim();
    if (parentId && keys.length) {
      try {
        const pFiles = await call('listDataFiles', S.ws, parentId);
        const parentSeries = {};
        for (const pf of (pFiles || []).filter((x) => /\.(csv|tsv|jsonl|json|log|txt)$/i.test(x)).slice(0, 4)) {
          const pdf = await call('readDataFile', S.ws, parentId, pf);
          if (!pdf || pdf.binary || !pdf.content) continue;
          const pp = Stats.parseStructuredData(pf, pdf.content);
          if (!pp.ok) continue;
          (pp.columns || []).forEach((col) => {
            const vals = (pp.rows || []).map((r) => Number(r[col])).filter((v) => Number.isFinite(v));
            if (vals.length >= 2 && !parentSeries[col]) parentSeries[col] = vals;
          });
        }
        const sharedCols = keys.filter((k) => !/^(step|epoch|seed|id|idx)$/i.test(k) && Array.isArray(parentSeries[k]) && numericSeriesMap[k].length >= 2);
        if (sharedCols.length) {
          const col = sharedCols[0];
          const welch = Stats.welchTTest(numericSeriesMap[col], parentSeries[col]);
          const mwu = Stats.mannWhitneyU(numericSeriesMap[col], parentSeries[col]);
          const cd = Stats.cohensD(numericSeriesMap[col], parentSeries[col]);
          item._lastStatsSummary = { column: col, welch, mwu, cohensD: cd, lowNWarning: numericSeriesMap[col].length < 3 || parentSeries[col].length < 3 };
          sigHtml = `<div class="stat-sig-box">
            <div class="ssb-head"><b>与基线 ${esc(parentId)} 统计显著性检验（列：${esc(col)}）</b><span class="exp-keep-pill ${welch.significant ? 'is-keep' : 'is-running'}">${welch.significant ? 'p < 0.05 显著' : '未达显著阈值'}</span></div>
            <div class="ssb-metrics">
              <span>Δ Mean = <b>${welch.meanDiff >= 0 ? '+' : ''}${fmtNum(welch.meanDiff)}</b></span>
              <span>Welch t-test p = <b>${fmtNum(welch.pValue, 4)}</b> (df=${fmtNum(welch.df, 1)})</span>
              <span>Mann-Whitney U p = <b>${fmtNum(mwu.pValue, 4)}</b></span>
              <span>Cohen's d = <b>${fmtNum(cd.d, 2)}</b> (${esc(cd.magnitude)})</span>
            </div>
          </div>`;
        }
      } catch (_) { /* ignore parent stats errors */ }
    }

    const extractEntries = Object.entries(extractedMetrics);
    panel.innerHTML = `<div class="section-title">纯 JS 统计分析与显著性检验（rliable IQM / Statistical Analysis）${extractEntries.length ? `<button type="button" class="btn ghost sm" id="applyParsedMetricsBtn" style="margin-left:auto">${ico('check', 12)}将提取的 ${extractEntries.length} 项指标写入记录</button>` : ''}</div>
      ${cards.length ? `<div class="stat-metric-grid">${cards.join('')}</div>` : ''}
      ${sigHtml}`;

    panel.querySelector('#applyParsedMetricsBtn')?.addEventListener('click', async () => {
      const fm = { ...(item.frontmatter || {}) };
      const results = { ...(fm.results || {}) };
      results.metrics = { ...(results.metrics || {}), ...extractedMetrics };
      fm.results = results;
      fm.updatedAt = new Date().toISOString().slice(0, 10);
      await call('saveItem', S.ws, 'experiments', item.id, { frontmatter: fm, body: item.body || '' });
      item.frontmatter = fm;
      await refreshExperimentDetail('results');
      toast(`已写入 ${extractEntries.length} 项自动提取的指标`);
    });
  }

  async function renderResultFiles(container, item) {
    const holder = container.querySelector('#resultFiles');
    if (!holder) return;
    const files = await call('listDataFiles', S.ws, item.id);
    const images = files.filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f));
    const tfeventsFiles = files.filter((f) => /events\.out\.tfevents|\.tfevents$/i.test(f));
    const dataFiles = files.filter((f) => /\.(csv|tsv|jsonl?|txt|md|log|ya?ml|xml|toml|html?|tex|py|r|js|ts|ipynb|sh|rst|sql|m|c|cpp|h|java|patch)$/i.test(f));
    const otherFiles = files.filter((f) => !images.includes(f) && !dataFiles.includes(f) && !tfeventsFiles.includes(f));
    const chartCfg = ((item.frontmatter || {}).results || {}).chartConfig || {};
    let html = '';
    const jobs = [];
    const numericSeriesMap = {};
    const extractedMetrics = {};
    let idx = 0;

    if (images.length) {
      const imgs = await Promise.all(images.map(async (f) => {
        const df = await call('readDataFile', S.ws, item.id, f);
        return `<div class="chart-box"><img src="${esc(df && df.url ? df.url : '')}"><div class="chart-cap">${esc(f)}</div></div>`;
      }));
      html += `<div class="section-title">图片结果</div><div class="chart-grid">${imgs.join('')}</div>`;
    }

    if (tfeventsFiles.length) {
      html += `<div class="section-title">TensorBoard 原生标量曲线（纯 JS 解析 .tfevents）</div>`;
      for (const tf of tfeventsFiles) {
        try {
          const parsedTf = await svc('experiment', 'readTfeventsForChart', S.ws, item.id, tf);
          if (parsedTf && parsedTf.ok && parsedTf.csvText && window.CSV) {
            Object.assign(extractedMetrics, parsedTf.finalMetrics || {});
            const parsedCsv = CSV.parse(parsedTf.csvText);
            if (!parsedCsv.error && parsedCsv.numericColumns.length) {
              const cfg = normalizeChartCfg(chartCfg[tf], parsedCsv);
              const key = 'result:' + item.id + ':' + tf;
              const canvasId = 'chartCanvas' + (idx++);
              html += chartCardHtml(key, tf, parsedCsv, cfg, canvasId);
              jobs.push({ key, canvasId, parsed: parsedCsv, cfg, file: tf });
            }
          }
        } catch (_) { /* ignore broken tfevents */ }
      }
    }

    if (dataFiles.length) {
      html += `<div class="section-title">数据与文本结果</div>`;
      for (const f of dataFiles) {
        const df = await call('readDataFile', S.ws, item.id, f);
        html += `<div class="data-file-item"><span class="df-name">${esc(f)}</span><button class="btn ghost sm" data-df="${esc(f)}">查看</button></div>`;
        if (!df || df.binary) continue;
        if (window.Stats && /\.(csv|tsv|jsonl?|log|txt)$/i.test(f)) {
          const sp = Stats.parseStructuredData(f, df.content);
          if (sp && sp.ok) {
            Object.entries(sp.metrics || {}).forEach(([mk, mv]) => { extractedMetrics[mk] = String(mv); });
            (sp.columns || []).forEach((col) => {
              if (/^(step|epoch|seed|id|idx)$/i.test(col)) return;
              const vals = (sp.rows || []).map((r) => Number(r[col])).filter((v) => Number.isFinite(v));
              if (vals.length >= 2 && !numericSeriesMap[col]) {
                numericSeriesMap[col] = vals;
                const st = Stats.summarize(vals);
                if (st.mean !== null && extractedMetrics[col] === undefined) extractedMetrics[col] = String(Number(st.mean.toFixed(4)));
              }
            });
          }
        }
        if (/\.(csv|tsv)$/i.test(f)) {
          const parsed = window.CSV
            ? CSV.parse(df.content, { delimiter: /\.tsv$/i.test(f) ? '\t' : undefined })
            : { headers: [], rows: [], numericColumns: [], error: 'CSV 解析器未加载' };
          if (parsed.error || !parsed.numericColumns.length) {
            html += `<div class="chart-empty">${ico('chart', 18)}<span>${esc(parsed.error || '未识别到数值列，无法生成图表；仍可查看下方表格预览')}</span></div>`;
            if (!parsed.error) html += `<div class="data-table-wrap">${dataTableHtml(parsed, 12)}</div>`;
            continue;
          }
          const cfg = normalizeChartCfg(chartCfg[f], parsed);
          const key = 'result:' + item.id + ':' + f;
          const canvasId = 'chartCanvas' + (idx++);
          html += chartCardHtml(key, f, parsed, cfg, canvasId);
          html += `<div class="data-table-wrap">${dataTableHtml(parsed, 12)}</div>`;
          jobs.push({ key: key, canvasId: canvasId, parsed: parsed, cfg: cfg, file: f });
        } else {
          const lines = String(df.content || '').split(/\r?\n/).filter(Boolean).slice(0, 12);
          html += `<div class="data-table-wrap"><table class="data-table">${lines.map((ln, i) => `<tr>${i === 0 ? `<th>${esc(ln)}</th>` : `<td>${esc(ln)}</td>`}</tr>`).join('')}</table></div>`;
        }
      }
    }
    if (otherFiles.length) {
      html += `<div class="section-title">其他结果文件</div>${otherFiles.map((f) => {
        const ext = f.includes('.') ? f.split('.').pop().toUpperCase() : '文件';
        return `<div class="data-file-item"><span class="df-name">${esc(f)}</span><span class="hint">${esc(ext)}</span><button class="btn ghost sm" data-df="${esc(f)}">打开文件</button></div>`;
      }).join('')}`;
    }
    if (!files.length) {
      html += `<div class="chart-empty" style="margin-top:12px">${ico('upload', 18)}<span>还没有结果文件，直接拖入 CSV/TSV/JSON/JSONL/LOG/TensorBoard .tfevents/PNG，或点击上方「同步目录/日志」自动接入。</span></div>`;
    }
    holder.innerHTML = html;
    await renderStatsSummary(container, item, numericSeriesMap, extractedMetrics);

    bindDropZone(holder, {
      onFiles: async (paths) => {
        const names = await call('importDataFiles', S.ws, item.id, paths);
        toast(`已上传 ${names.length} 个实验文件`);
        await renderDetail();
      }
    });

    holder.querySelectorAll('[data-df]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const df = await call('readDataFile', S.ws, item.id, b.dataset.df);
        if (!df) return toast('结果文件不存在或无法读取', true);
        if (df.binary) {
          const result = await window.bridge.shell.open(df.path);
          if (!result || result.ok !== true) toast(result && result.error ? result.error : '系统打开文件失败', true);
        } else {
          openModal(b.dataset.df, `<pre style="background:var(--surface-3);padding:12px;border-radius:8px;overflow:auto;max-height:60vh">${esc(df.content)}</pre><div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>`);
        }
      } catch (e) { toast(e.message, true); }
    }));

    if (window.Charts) {
      jobs.forEach((job) => {
        const canvas = holder.querySelector('#' + job.canvasId);
        if (!canvas) return;
        const state = { key: job.key, parsed: job.parsed, cfg: job.cfg };
        canvas._chartState = state;
        Charts.render(job.key, canvas, job.parsed, job.cfg);
        const card = canvas.closest('.chart-card');
        if (card) bindChartCard(card, state, item, job.file);
      });
    }
  }

  async function cloneExperiment(item) {
    try {
      const id = await call('cloneExperiment', S.ws, item.id);
      S.selectedId = id;
      await refreshItems();
      await renderDetail();
      toast('已复制为新版本');
    } catch (e) { toast(e.message, true); }
  }

  function createExperiment() {
    const id = 'exp-' + Date.now().toString().slice(-6);
    const stamp = new Date().toISOString().slice(0, 10);
    const fm = {
      title: '未命名实验',
      date: stamp,
      status: '草稿',
      priority: '中',
      tags: [],
      goal: '',
      hypothesis: '',
      protocol: '',
      basedOn: '',
      relatedIdea: '',
      relatedPapers: [],
      command: '',
      codeDir: '',
      runDir: '',
      environment: {},
      config: {},
      results: { metrics: {}, charts: [], data_files: [], chartConfig: {} },
      conclusion: '',
      nextStep: '',
      failure: {},
      createdAt: stamp,
      updatedAt: stamp
    };
    call('saveItem', S.ws, 'experiments', id, { frontmatter: fm, body: '' }).then(async () => {
      S.selectedId = id;
      await refreshItems();
      await renderDetail();
      toast('实验已加入列表，可直接同步目录/粘贴命令或点击字段填写');
    }).catch((e) => toast(e.message, true));
  }

  function editExperiment(item) {
    const title = $('#detailRoot')?.querySelector('[data-inline="title"]');
    if (title) title.click();
  }

      Object.assign(this, {
        renderExpDetail, normalizeChartCfg, dataTableHtml, saveChartConfig,
        chartCardHtml, bindChartCard, renderResultFiles, cloneExperiment,
        createExperiment, showQuickIngestModal, showSweepModal,
        showCompareModal, showNegativeLedgerModal,
        showExperimentSkillsModal, syncToIdea, editExperiment
      });
    }
  }
  namespace.ExperimentController = ExperimentController;
})();
