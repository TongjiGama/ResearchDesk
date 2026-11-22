(() => {
  const namespace = window.ResearchWorkbench;
  class PaperController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { bindDropZone, refreshItems, toggleStar, renderDetail, renderMarkdown, bindRefClicks, renderBacklinks, showRatingDetail, openModal, closeModal, setListCollapsed } = context.actions;
  // ===== 论文详情 =====
  async function renderPaperDetail(root, item) {
    const fm = item.frontmatter || {};
    const pdfAbs = fm.pdfPath ? await call('absolutePath', S.ws, fm.pdfPath) : '';
    const pdfUrl = fm.pdfPath ? (fm.pdfPath.startsWith('http') ? fm.pdfPath : await call('fileUrl', S.ws, fm.pdfPath)) : '';
    const sideW = Math.max(220, Math.min(720, ((S.cfg.ui && S.cfg.ui.paperSideWidth) || 340)));
    // 详情属性行的 v3 增量字段（必须在下方模板插值前初始化）
    const ratingLine = fm.rating
      ? `<div class="prop-row"><span class="prop-k">可信度</span><span class="prop-v"><span class="rating-badge ${esc(String(fm.rating).toUpperCase())}" data-rating-fm="${esc(fm.rating)}" title="辅助判断、非学术定论 · ${esc(fm.ratingSource || '')}">${esc(String(fm.rating).toUpperCase())}</span>&nbsp;${esc(fm.ratingReason || '')}</span></div>`
      : '';
    const citeSrcSuffix = (!fm.citationSource || fm.citationSource === 'OpenAlex')
      ? `OpenAlex · 抓取于 ${esc(fm.citationFetchedAt || '')}`
      : `${esc(fm.citationSource)} · 抓取于 ${esc(fm.citationFetchedAt || '')}`;
    const citationLine = fm.citedByCount
      ? `<div class="prop-row"><span class="prop-k">引用量</span><span class="prop-v">${Number(fm.citedByCount).toLocaleString('en-US')} 次 · ${citeSrcSuffix}<span class="citation-note">与 Google Scholar 等口径不同</span></span></div>`
      : '';
    const venueLine = fm.venue
      ? `<div class="prop-row"><span class="prop-k">载体</span><span class="prop-v">${esc(fm.venue)}${fm.venueStatus ? ` · ${esc(fm.venueStatus)}` : ''}</span></div>`
      : '';
    const codeLine = fm.codeUrl
      ? `<div class="prop-row"><span class="prop-k">代码</span><span class="prop-v"><a data-open="${esc(fm.codeUrl)}">${ico('code', 12)} GitHub${Number(fm.githubStars) > 0 ? ` · ${Number(fm.githubStars).toLocaleString('en-US')} stars` : ''}</a></span></div>`
      : '';

    root.innerHTML = `<div class="paper-layout">
      <div class="pdf-area">
        ${fm.pdfPath
          ? `<div class="pdf-zoom-shell"><iframe class="pdf-viewer-full" src="${esc(pdfUrl)}"></iframe></div><div class="pdf-zoom-tools"><button class="icon-btn" id="pdfZoomOut" title="缩小 PDF"><span data-ico="minus"></span></button><button class="pdf-zoom-label" id="pdfZoomReset" title="重置为 100%">100%</button><button class="icon-btn" id="pdfZoomIn" title="放大 PDF"><span data-ico="plus"></span></button></div>`
          : `<div class="pdf-none"><div class="empty-icon">◫</div><div>尚未关联 PDF</div><div class="hint">直接把 PDF 拖到此区域上传</div></div>`}
      </div>
      <div class="paper-splitter" id="paperSplitter" title="拖动调整侧栏宽度"></div>
      <aside class="paper-side" id="paperSide" style="width:${sideW}px">
        <div class="ps-head">
          <div class="detail-title">${esc(fm.title || fm.shortName || item.id)}</div>
          <div class="ps-actions">
            <button class="btn sm" id="genNoteBtn">${ico('sparkle', 14)}生成 AI 笔记 + 摘要</button>
            <button class="btn ghost sm" id="openPdfBtn">${ico('folderOpen', 14)}打开 PDF</button>
            <button class="btn ghost sm" id="editPaperBtn">${ico('edit', 14)}编辑</button>
            <button class="btn ghost sm star-toggle ${fm.starred ? 'on' : ''}" id="starPaperBtn" title="标记必引，写作时快速筛出">${ico(fm.starred ? 'star' : 'starOff', 14)}${fm.starred ? '已必引' : '标必引'}</button>
          </div>
        </div>
        <div class="ps-props">
          <div class="prop-row"><span class="prop-k">简称</span><span class="prop-v">${esc(fm.shortName || '—')}</span></div>
          <div class="prop-row"><span class="prop-k">作者</span><span class="prop-v">${esc((fm.authors || []).join(', ') || '—')}</span></div>
          <div class="prop-row"><span class="prop-k">发表</span><span class="prop-v">${esc(fm.published || '—')}</span></div>
          <div class="prop-row"><span class="prop-k">arXiv</span><span class="prop-v">${fm.arxivId ? `<a data-open="${esc('https://arxiv.org/abs/' + fm.arxivId)}">${esc(fm.arxivId)}</a>` : '—'}</span></div>
          ${venueLine}
          ${codeLine}
          ${citationLine}
          ${ratingLine}
          <div class="prop-row"><span class="prop-k">状态</span><span class="prop-v"><select id="statusSelect" class="chip" style="border:1px solid var(--border)">
            ${['待读', '在读', '已读', '精读', '归档'].map((s) => `<option ${s === (fm.status || '待读') ? 'selected' : ''}>${s}</option>`).join('')}
          </select></span></div>
        </div>
        <div class="ps-tabs tabs">
          <button class="tab active" data-ptab="summary">摘要</button>
          <button class="tab" data-ptab="note">AI 笔记</button>
        </div>
        <div class="ps-content" id="paperTabContent"></div>
        <div id="paperBacklinks" class="ps-backlinks"></div>
      </aside>
    </div>`;

    bindDropZone(root.querySelector('.pdf-area'), {
      onFiles: async (paths) => {
        const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
        if (!pdfs.length) throw new Error('此区域只接收 PDF 文件');
        await call('attachPdfToPaper', S.ws, item.id, pdfs);
        toast('PDF 已上传到论文区域');
        await renderDetail();
      }
    });

    const pdfArea = root.querySelector('.pdf-area');
    const pdfShell = root.querySelector('.pdf-zoom-shell');
    const pdfViewer = root.querySelector('.pdf-viewer-full');
    const pdfZoomLabel = root.querySelector('#pdfZoomReset');
    let pdfZoom = 1;
    const applyPdfZoom = (next, anchorX, anchorY) => {
      if (!pdfArea || !pdfShell || !pdfViewer) return;
      const oldZoom = pdfZoom;
      pdfZoom = Math.max(0.5, Math.min(3, Number(next) || 1));
      const rect = pdfArea.getBoundingClientRect();
      const ax = anchorX == null ? rect.width / 2 : anchorX - rect.left;
      const ay = anchorY == null ? rect.height / 2 : anchorY - rect.top;
      const scrollLeft = pdfArea.scrollLeft;
      const scrollTop = pdfArea.scrollTop;
      pdfViewer.style.width = (100 / pdfZoom) + '%';
      pdfViewer.style.height = (100 / pdfZoom) + '%';
      pdfViewer.style.transform = 'scale(' + pdfZoom + ')';
      pdfViewer.style.transformOrigin = '0 0';
      pdfShell.style.width = '100%';
      pdfShell.style.height = '100%';
      pdfShell.style.minWidth = (pdfZoom * 100) + '%';
      pdfShell.style.minHeight = (pdfZoom * 100) + '%';
      if (pdfZoomLabel) pdfZoomLabel.textContent = Math.round(pdfZoom * 100) + '%';
      const ratio = pdfZoom / oldZoom;
      requestAnimationFrame(() => {
        pdfArea.scrollLeft = (scrollLeft + ax) * ratio - ax;
        pdfArea.scrollTop = (scrollTop + ay) * ratio - ay;
      });
    };
    if (pdfArea) {
      pdfArea.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        applyPdfZoom(pdfZoom * Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      }, { passive: false });
      let pinch = null;
      pdfArea.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          const a = e.touches[0], b = e.touches[1];
          pinch = {
            distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
            zoom: pdfZoom
          };
        }
      }, { passive: true });
      pdfArea.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinch) {
          e.preventDefault();
          const a = e.touches[0], b = e.touches[1];
          const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
          const cx = (a.clientX + b.clientX) / 2;
          const cy = (a.clientY + b.clientY) / 2;
          applyPdfZoom(pinch.zoom * (distance / pinch.distance), cx, cy);
        }
      }, { passive: false });
      pdfArea.addEventListener('touchend', () => { pinch = null; }, { passive: true });
      pdfArea.addEventListener('dblclick', (e) => {
        if (e.target.closest('.pdf-zoom-tools')) return;
        applyPdfZoom(pdfZoom === 1 ? 1.5 : 1, e.clientX, e.clientY);
      });
    }
    const zoomBy = (delta) => applyPdfZoom(pdfZoom + delta);
    root.querySelector('#pdfZoomOut')?.addEventListener('click', (e) => { e.stopPropagation(); zoomBy(-0.1); });
    root.querySelector('#pdfZoomIn')?.addEventListener('click', (e) => { e.stopPropagation(); zoomBy(0.1); });
    pdfZoomLabel?.addEventListener('click', (e) => { e.stopPropagation(); applyPdfZoom(1); });

    const tabContent = root.querySelector('#paperTabContent');
    // D48 溯源条：AI 生成的内容显式标注，并给出回到 PDF 核对的通路（不把 AI 输出伪装成事实）
    const traceHint = fm.aiGenerated
      ? `<div class="ai-trace"><span class="ai-trace-tag">${ico('sparkle', 12)}AI 生成${fm.noteUpdatedAt ? ' · ' + esc(fm.noteUpdatedAt) : ''}</span><span class="ai-trace-text">由模型总结，请对照左侧 PDF 原文核验关键结论</span><button class="ai-trace-btn" id="traceToPdfBtn">${ico('arrowRight', 12)}定位 PDF</button></div>`
      : '';
    // 入库论文无 PDF 时的占位引导：只加提示块，不改 paper-layout / 拖拽骨架
    const openPdfDownloadUrl = fm.pdfUrl || (fm.arxivId ? `https://arxiv.org/pdf/${fm.arxivId}.pdf` : '');
    const noPdfHint = fm.pdfPath || (!fm.oaUrl && !openPdfDownloadUrl) ? '' : `<div class="paper-no-pdf">
      ${ico('external', 13)}<span>尚未关联 PDF · 可拖入 PDF 或直接拉取开放原文</span>
      ${openPdfDownloadUrl ? `<button type="button" class="btn ghost sm" id="downloadOaPdfBtn">${ico('download', 12)}拉取开放 PDF</button>` : ''}
      ${fm.oaUrl ? `<a data-open="${esc(fm.oaUrl)}" title="在系统浏览器打开原文页">${ico('external', 12)}打开原文</a>` : ''}
    </div>`;
    const summaryMethodHint = fm.summaryMethod
      ? ` · ${esc(fm.summaryMethod)}${fm.skill && fm.skill !== 'default' ? ` + ${esc(fm.skill)}` : ''}`
      : '';
    const summaryTag = fm.summary
      ? `<span class="summary-source-tag" title="${fm.summarySource === 'ai' ? 'AI 一句话提炼，请核对原文' : 'OpenAlex 摘要节选'}${summaryMethodHint}">${fm.summarySource === 'ai' ? 'AI 提炼' : '摘要节选'}</span>`
      : '';
    const summaryHtml = `${noPdfHint}${traceHint}<div class="field-box">${summaryTag ? `<div class="summary-source-row">${summaryTag}</div>` : ''}${fm.summary ? esc(fm.summary) : '<span class="hint">暂无摘要，点上方「生成 AI 笔记 + 摘要」自动填充。</span>'}</div>`;
    const noteHtml = `${traceHint}<div class="markdown-body">${renderMarkdown(item.body || '<!-- empty -->')}</div>`;
    const tabsMap = { summary: summaryHtml, note: noteHtml };
    function showTab(t) {
      tabContent.innerHTML = tabsMap[t];
      bindRefClicks(tabContent);
      // D48 溯源：定位到左侧 PDF 原文（若列表/工作区栏收起则展开，确保 PDF 可见）
      const traceBtn = tabContent.querySelector('#traceToPdfBtn');
      if (traceBtn) traceBtn.addEventListener('click', () => {
        if (document.getElementById('app').classList.contains('list-collapsed')) setListCollapsed(false);
        const pdfArea = root.querySelector('.pdf-area');
        if (pdfArea) {
          pdfArea.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
          pdfArea.classList.add('pdf-flash');
          setTimeout(() => pdfArea.classList.remove('pdf-flash'), 900);
        }
        if (fm.pdfPath) toast('左侧为 PDF 原文，请核对摘要中的关键结论');
      });
      const dlPdfBtn = tabContent.querySelector('#downloadOaPdfBtn');
      if (dlPdfBtn) dlPdfBtn.addEventListener('click', async () => {
        const targetWs = S.ws;
        const targetId = item.id;
        dlPdfBtn.disabled = true;
        dlPdfBtn.innerHTML = '<span class="spinner"></span> 下载中…';
        try {
          const relPath = await svc('openalex', 'downloadPaperPdf', targetWs, {
            title: fm.title || targetId,
            arxivId: fm.arxivId || '',
            pdfUrl: openPdfDownloadUrl
          });
          const latest = await call('getItem', targetWs, 'papers', targetId);
          const latestFm = (latest && latest.frontmatter) || fm;
          await call('saveItem', targetWs, 'papers', targetId, {
            frontmatter: { ...latestFm, pdfPath: relPath, updatedAt: new Date().toISOString().slice(0, 10) },
            body: (latest && latest.body) || item.body || ''
          });
          toast('PDF 已下载并关联到本论文');
          if (S.ws === targetWs) {
            await refreshItems();
            if (S.board === 'papers' && S.selectedId === targetId) await renderDetail();
          }
        } catch (err) {
          toast('下载 PDF 失败：' + (err.message || ''), true);
          if (dlPdfBtn.isConnected) {
            dlPdfBtn.disabled = false;
            dlPdfBtn.innerHTML = `${ico('download', 12)}拉取开放 PDF`;
          }
        }
      });
    }
    showTab('summary');
    const fmRatingBadge = root.querySelector('[data-rating-fm]');
    if (fmRatingBadge) fmRatingBadge.addEventListener('click', (e) => showRatingDetail({
      grade: String(fm.rating).toUpperCase(),
      reason: fm.ratingReason || '',
      source: fm.ratingSource || '',
      dimensions: {
        venue: [fm.venue, fm.venueType].filter(Boolean).join(' / ') || '—',
        citation: `${fm.citedByCount || 0} 次 · OpenAlex`,
        peerReview: fm.isPreprint ? '预印本 · 无正式评审' : '已发表',
        institution: '未核验',
        recency: fm.published || '未知'
      }
    }, e));
    // 反向链接挂在 paper-side 内、ps-content 之后，不触碰 PDF 分栏与拖拽
    await renderBacklinks(root.querySelector('#paperBacklinks'), item.id);
    root.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('[data-ptab]').forEach((x) => x.classList.toggle('active', x === b));
      showTab(b.dataset.ptab);
    }));

    // 侧栏宽度拖拽
    const splitter = root.querySelector('#paperSplitter');
    const side = root.querySelector('#paperSide');
    const layout = root.querySelector('.paper-layout');
    const paperSideBounds = () => ({
      min: 220,
      max: Math.max(220, Math.min(720, (layout ? layout.clientWidth : window.innerWidth) - 252))
    });
    const initialSideBounds = paperSideBounds();
    const initialSideWidth = Math.max(initialSideBounds.min, Math.min(initialSideBounds.max, side.offsetWidth));
    side.style.width = initialSideWidth + 'px';
    side.style.flexBasis = initialSideWidth + 'px';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('tabindex', '0');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-label', '调整 PDF 与论文属性栏宽度');
    splitter.setAttribute('aria-valuemin', String(paperSideBounds().min));
    splitter.setAttribute('aria-valuemax', String(paperSideBounds().max));
    splitter.setAttribute('aria-valuenow', String(side.offsetWidth));
    splitter.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const pointerId = e.pointerId;
      const startX = e.clientX, startW = side.offsetWidth;
      const pdf = layout ? layout.querySelector('.pdf-viewer-full') : null;
      document.body.classList.add('is-resizing-paper');
      if (pdf) pdf.style.pointerEvents = 'none';
      const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        const bounds = paperSideBounds();
        const next = Math.max(bounds.min, Math.min(bounds.max, startW + startX - ev.clientX));
        side.style.width = next + 'px';
        side.style.flexBasis = next + 'px';
        splitter.setAttribute('aria-valuemax', String(bounds.max));
        splitter.setAttribute('aria-valuenow', String(Math.round(next)));
      };
      const up = async (ev) => {
        if (ev.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-resizing-paper');
        if (pdf) pdf.style.pointerEvents = '';
        try {
          S.cfg = await call('updateConfig', { ui: { paperSideWidth: side.offsetWidth } });
        } catch (error) {
          toast('保存侧栏宽度失败：' + error.message, true);
        }
      };
      splitter.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    splitter.addEventListener('keydown', async (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const bounds = paperSideBounds();
      let next = side.offsetWidth;
      if (e.key === 'ArrowLeft') next += 24;
      if (e.key === 'ArrowRight') next -= 24;
      if (e.key === 'Home') next = bounds.min;
      if (e.key === 'End') next = bounds.max;
      next = Math.max(bounds.min, Math.min(bounds.max, next));
      side.style.width = next + 'px';
      side.style.flexBasis = next + 'px';
      splitter.setAttribute('aria-valuemax', String(bounds.max));
      splitter.setAttribute('aria-valuenow', String(next));
      try {
        S.cfg = await call('updateConfig', { ui: { paperSideWidth: next } });
      } catch (error) {
        toast('保存侧栏宽度失败：' + error.message, true);
      }
    });

    root.querySelector('#statusSelect').addEventListener('change', async (e) => {
      fm.status = e.target.value;
      await call('saveItem', S.ws, 'papers', item.id, { frontmatter: fm, body: item.body });
      toast('状态已更新');
      await refreshItems();
    });
    root.querySelector('#openPdfBtn').addEventListener('click', async () => {
      if (!fm.pdfPath) return toast('未关联 PDF', true);
      const r = await window.bridge.shell.open(pdfAbs);
      if (!r.ok) toast('打开失败：' + r.error, true);
    });
    root.querySelectorAll('.ps-props [data-open]').forEach((a) => {
      a.addEventListener('click', () => window.bridge.shell.open(a.dataset.open));
    });
    root.querySelector('#genNoteBtn').addEventListener('click', () => runAiGenerate(item.id, 'both'));
    root.querySelector('#editPaperBtn').addEventListener('click', () => editPaper(item));
    root.querySelector('#starPaperBtn').addEventListener('click', () => toggleStar(item.id).then(renderDetail));
  }

  async function runAiGenerate(id, mode) {
    const btn = $('#genNoteBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 生成中…'; }
    try {
      if (mode === 'both') await ai('generateNote', S.ws, id);
      else await ai('generateSummaryOnly', S.ws, id);
      const styleName = S.cfg.activeSkill && S.cfg.activeSkill !== 'default' ? S.cfg.activeSkill : '默认四段式';
      toast(`生成完成 · 论文阅读方法 Skill + ${styleName}`);
      await refreshItems();
      await renderDetail();
    } catch (e) { toast('生成失败：' + e.message, true); }
    finally { await renderDetail(); }
  }

  // AI 批量生成（D44）：跳过已有笔记，逐篇生成，实时进度
  async function batchGenerateNotes() {
    const targets = [];
    for (const it of S.items) {
      const full = await call('getItem', S.ws, 'papers', it.id);
      if (!full || !full.body || !full.body.trim()) targets.push(it.id);
    }
    if (!targets.length) return toast('所有论文都已有笔记');
    openModal('AI 批量生成笔记', `
      <div style="margin-bottom:8px">当前工作区共有 <b>${targets.length}</b> 篇论文还没有 AI 笔记。</div>
      <div class="hint">将逐篇调用论文阅读方法 Skill 与当前笔记风格生成笔记和摘要；每篇约 20–60 秒，会消耗 API 额度。失败的会跳过不中断。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="bGo">开始生成</button></div>
    `, (root) => {
      root.querySelector('#bGo').addEventListener('click', async () => {
        closeModal();
        let done = 0, failed = 0;
        for (let i = 0; i < targets.length; i++) {
          toast(`生成中 ${i + 1}/${targets.length}：${targets[i]}…`);
          try { await ai('generateNote', S.ws, targets[i]); done++; }
          catch (e) { failed++; console.error('batch fail', targets[i], e.message); }
          if ((i + 1) % 3 === 0 || i === targets.length - 1) await refreshItems();
        }
        await refreshItems();
        toast(`批量完成：成功 ${done} 篇${failed ? `，失败 ${failed} 篇` : ''}`, failed > 0);
        if (S.selectedId) await renderDetail();
      });
    });
  }

  function editPaper(item) {
    const fm = item.frontmatter || {};
    openModal('编辑论文', `
      <div class="form-row">
        <div class="form-field"><label>简称</label><input id="eShort" value="${esc(fm.shortName || '')}"></div>
        <div class="form-field"><label>发表年月</label><input id="ePub" value="${esc(fm.published || '')}" placeholder="2024-06"></div>
      </div>
      <div class="form-field"><label>完整标题</label><input id="eTitle" value="${esc(fm.title || '')}"></div>
      <div class="form-row" style="margin-top:10px">
        <div class="form-field"><label>arXiv ID</label><input id="eArxiv" value="${esc(fm.arxivId || '')}"></div>
        <div class="form-field"><label>作者（逗号分隔）</label><input id="eAuthors" value="${esc((fm.authors || []).join(', '))}"></div>
      </div>
      <div class="form-field" style="margin-top:10px"><label>PDF 路径（相对工作区，如 pdfs/xxx.pdf）</label><input id="ePdf" value="${esc(fm.pdfPath || '')}"></div>
      <div class="form-field" style="margin-top:10px"><label>笔记正文（Markdown，支持 [[引用]]）</label><textarea id="eBody" class="editor-area" rows="8">${esc(item.body || '')}</textarea></div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="eOk">保存</button></div>
    `, (root) => {
      root.querySelector('#eOk').addEventListener('click', async () => {
        const nf = {
          ...fm,
          shortName: root.querySelector('#eShort').value.trim(),
          title: root.querySelector('#eTitle').value.trim(),
          published: root.querySelector('#ePub').value.trim(),
          arxivId: root.querySelector('#eArxiv').value.trim(),
          authors: root.querySelector('#eAuthors').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          pdfPath: root.querySelector('#ePdf').value.trim()
        };
        const body = root.querySelector('#eBody').value;
        try { await call('saveItem', S.ws, 'papers', item.id, { frontmatter: nf, body }); closeModal(); await refreshItems(); await renderDetail(); toast('已保存'); }
        catch (e) { toast(e.message, true); }
      });
    }, 'wide');
  }

      Object.assign(this, {
        renderPaperDetail, runAiGenerate, batchGenerateNotes, editPaper
      });
    }
  }
  namespace.PaperController = PaperController;
})();
