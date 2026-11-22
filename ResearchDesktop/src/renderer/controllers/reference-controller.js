(() => {
  const namespace = window.ResearchWorkbench;
  class ReferenceController {
    constructor(context) {
      const S = context.state;
      const { $, $$, esc } = context.dom;
      const { call, ai, svc } = context.services;
      const { boardIcon, boardName, IDEA_STAGES, TODO_STAGES, ideaStage } = context.constants;
      const { toast } = context.ui;
      const { bindDropZone, applyUiPrefs, setTheme, renderBoard, refreshItems, renderDetail, openModal, closeModal } = context.actions;
  // ---------- 引用渲染与跳转 ----------
  function renderMarkdown(text) {
    if (!text || text.trim() === '<!-- empty -->') return '<div class="hint">暂无内容，点击此处直接编辑。</div>';
    let html = text.replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
      const { target, label } = parseReference(raw);
      return `<span class="md-ref" data-ref="${esc(target)}">${esc(label)}</span>`;
    });
    if (window.marked) html = window.marked.parse(html);
    return html;
  }

  function renderTextWithRefs(text) {
    const source = String(text == null ? '' : text);
    const re = /\[\[([^\]]+)\]\]/g;
    let html = '';
    let last = 0;
    let match;
    while ((match = re.exec(source))) {
      html += esc(source.slice(last, match.index)).replace(/\r?\n/g, '<br>');
      const { target, label } = parseReference(match[1]);
      html += `<span class="md-ref" data-ref="${esc(target)}">${esc(label)}</span>`;
      last = re.lastIndex;
    }
    return html + esc(source.slice(last)).replace(/\r?\n/g, '<br>');
  }

  function parseReference(raw) {
    const value = String(raw || '').trim();
    const separator = value.indexOf('|');
    const target = (separator < 0 ? value : value.slice(0, separator)).trim();
    const label = (separator < 0 ? target : value.slice(separator + 1)).trim() || target;
    return { target, label };
  }

  function extractRefs(text) {
    const out = new Set();
    const re = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(text))) {
      const { target } = parseReference(m[1]);
      if (target) out.add(target);
    }
    return Array.from(out);
  }
  /**
   * 绑定引用跳转；opts.closeModalOnJump 供论断中心先关模态再跳转（默认行为不变）。
   * data-board 明确来源板块时优先直取，避免同名 id 跨板块消歧错误。
   */
  async function bindRefClicks(container, opts = {}) {
    if (!container) return;
    container.querySelectorAll('[data-ref], .md-ref, [data-open]').forEach((el) => {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', async () => {
        if (el.dataset.open) { window.bridge.shell.open(el.dataset.open); return; }
        const ref = el.dataset.ref;
        let target = null;
        if (el.dataset.board) {
          const direct = await call('getItem', S.ws, el.dataset.board, ref);
          if (direct) {
            const fm = direct.frontmatter || {};
            target = { board: el.dataset.board, id: ref, label: fm.shortName || fm.title || ref };
          }
        }
        if (!target) target = await call('resolveRef', S.ws, ref);
        if (!target) { offerCreateRefTarget(ref, el.dataset.board); return; }
        if (opts.closeModalOnJump) closeModal();
        if (target.board !== S.board) S.board = target.board;
        S.selectedId = target.id;
        await renderBoard();
        await renderDetail();
      });
    });
  }

  /** P1-3：失效引用弹确认，可在推断板块中新建同名条目，原 [[name]] 自然生效。 */
  function offerCreateRefTarget(ref, hintedBoard) {
    const guessed = hintedBoard || (/^exp-/i.test(ref) ? 'experiments' : 'ideas');
    const boardOpts = ['papers', 'ideas', 'experiments'].map((b) =>
      `<option value="${b}" ${b === guessed ? 'selected' : ''}>${boardName(b)}</option>`).join('');
    openModal('新建引用目标', `
      <div class="hint" style="margin-bottom:8px">引用 [[${esc(ref)}]] 尚未找到对应条目。要新建并自动建立链接吗？</div>
      <div class="form-field"><label>目标板块</label><select id="rfBoard">${boardOpts}</select></div>
      <div class="form-field" style="margin-top:10px"><label>标题</label><input id="rfTitle" value="${esc(ref)}"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="rfOk">创建</button></div>
    `, (root) => {
      root.querySelector('#rfOk').addEventListener('click', async () => {
        const board = root.querySelector('#rfBoard').value;
        const title = root.querySelector('#rfTitle').value.trim() || ref;
        const stamp = new Date().toISOString().slice(0, 10);
        const id = (board === 'experiments' ? 'exp-' : board === 'ideas' ? 'idea-' : '') + Date.now().toString().slice(-6);
        let fm;
        if (board === 'experiments') {
          fm = { title, date: stamp, status: '计划中', hypothesis: '', basedOn: '', relatedIdea: '', config: {}, results: { metrics: {}, charts: [], data_files: [] }, conclusion: '', createdAt: stamp, updatedAt: stamp };
        } else if (board === 'ideas') {
          fm = { title, type: 'idea', status: '收件箱', source: '', refs: [], createdAt: stamp, updatedAt: stamp };
        } else {
          fm = { title, shortName: title, authors: [], published: '', arxivId: '', pdfPath: '', status: '待读', noteUpdatedAt: '', skill: 'default', summary: '', createdAt: stamp, updatedAt: stamp };
        }
        try {
          await call('saveItem', S.ws, board, id, { frontmatter: fm, body: '' });
          closeModal();
          if (board !== S.board) S.board = board;
          S.selectedId = id;
          await renderBoard();
          await renderDetail();
          toast('已创建引用目标：' + title);
        } catch (e) { toast(e.message, true); }
      });
      const input = root.querySelector('#rfTitle');
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') root.querySelector('#rfOk').click(); });
    });
  }

  /** 论文 / Idea / 实验详情共用的「被引用（N）」折叠区块。 */
  async function renderBacklinks(container, id) {
    if (!container) return;
    let links = [];
    try { links = await call('getBacklinks', S.ws, id) || []; } catch (e) { links = []; }
    const body = links.length
      ? `<div class="bl-list">${links.map((l) => `<div class="bl-item" data-ref="${esc(l.id)}" data-board="${esc(l.board)}" tabindex="0" title="跳转到${boardName(l.board)} · ${esc(l.id)}"><span class="bl-ico">${ico(boardIcon(l.board), 14)}</span><span class="bl-title">${esc(l.label)}</span><span class="bl-via">${esc(l.via)}</span></div>`).join('')}</div>`
      : `<div class="bl-empty">${ico('link', 14)}<span>还没有其他条目引用它。在 Idea 或实验文本中输入 / 可选择论文，也可直接写 [[${esc(id)}]]。</span></div>`;
    container.innerHTML = `<details class="backlink-block"><summary>${ico('link', 14)}被引用<span class="bl-badge">${links.length}</span></summary>${body}</details>`;
    await bindRefClicks(container);
  }

  // ---------- 导入 PDF ----------
  async function importPdfs() {
    const paths = await window.bridge.dialog.openFiles({ multi: true, title: '选择 PDF 文件', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!paths.length) return;
    try {
      const created = await call('importPdfs', S.ws, paths);
      toast(`已导入 ${created.length} 篇论文`);
      await refreshItems();
    } catch (e) { toast(e.message, true); }
  }
  async function batchImport() {
    const dirs = await window.bridge.dialog.openFiles({ directory: true, title: '选择存放论文的文件夹（会递归扫描 PDF）' });
    if (!dirs.length) return;
    const dir = dirs[0];
    toast('正在扫描 PDF…');
    const pdfs = scanPdfRecursive(dir);
    if (!pdfs.length) return toast('未找到 PDF', true);
    try {
      const created = await call('importPdfs', S.ws, pdfs);
      toast(`已扫描导入 ${created.length} 篇论文`);
      await refreshItems();
    } catch (e) { toast(e.message, true); }
  }
  function scanPdfRecursive(dir) {
    // 由主进程提供递归能力：借助 store.importPdfs 接受目录时展开
    return [dir]; // 占位：主进程 importPdfs 会展开目录
  }

  function confirmDeleteItem(board, id) {
    openModal('确认删除', `
      <div style="color:var(--red);margin-bottom:8px">确定删除「${esc(id)}」吗？</div>
      <div class="hint">对应的 Markdown 笔记会被删除（PDF/数据文件保留）。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn danger" id="dOk">删除</button></div>
    `, (root) => {
      root.querySelector('#dOk').addEventListener('click', async () => {
        try { await call('deleteItem', S.ws, board, id); closeModal(); S.selectedId = null; await refreshItems(); await renderDetail(); toast('已删除'); }
        catch (e) { toast(e.message, true); }
      });
    });
  }

  // ---------- 设置 ----------
  function showSettings() {
    const api = S.cfg.api || {};
    const curTheme = (S.cfg.ui && S.cfg.ui.theme) || 'classic';
    openModal('设置', `
      <div class="section-title">界面主题</div>
      <div class="theme-preview">
        <div class="theme-card ${curTheme === 'classic' ? 'active' : ''}" data-theme="classic">
          <div class="theme-swatch classic"></div>
          <div class="theme-card-label">简约</div>
          <div class="theme-card-desc">浅色学术风 · 清爽专注</div>
        </div>
        <div class="theme-card ${curTheme === 'neo' ? 'active' : ''}" data-theme="neo">
          <div class="theme-swatch neo"></div>
          <div class="theme-card-label">炫酷</div>
          <div class="theme-card-desc">深色霓虹 · 玻璃发光</div>
        </div>
      </div>
      <div class="section-title">AI 模型（OpenAI 兼容接口）</div>
      <div class="form-field"><label>API 地址（Base URL）</label><input id="sBase" value="${esc(api.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
      <div class="form-field" style="margin-top:10px"><label>API 密钥</label><input id="sKey" type="password" value="${esc(api.apiKey || '')}" placeholder="sk-..."></div>
      <div class="form-field" style="margin-top:10px"><label>模型名称</label><input id="sModel" value="${esc(api.model || '')}" placeholder="gpt-4o-mini"></div>
      <div class="section-title">多源论文检索（OpenAlex / Semantic Scholar）</div>
      <div class="form-field"><label>OpenAlex Personal API key（可选，留空走免 key）</label><input id="sOaKey" value="${esc(((S.cfg.openalex || {}).apiKey) || '')}" placeholder="留空即可免 key 检索"></div>
      <div class="form-field" style="margin-top:10px"><label>Semantic Scholar API key（可选，填写可避免 429 限流并补充高影响力引用）</label><input id="sS2Key" type="password" value="${esc(((S.cfg.search || {}).semanticScholarApiKey) || '')}" placeholder="可选，留空自动按免 key 降级"></div>
      <div class="form-field" style="margin-top:10px"><label>默认检索条数</label><select id="sOaPerPage">
        ${[10, 20, 50].map((n) => `<option value="${n}" ${Number((S.cfg.openalex || {}).perPage || 20) === n ? 'selected' : ''}>${n} 条</option>`).join('')}
      </select></div>
      <div class="hint" style="margin-top:8px">引用量口径以 OpenAlex 为主，与 Google Scholar 不同；arXiv / OpenReview / HF Papers / Crossref 均免 key 可用；key 明文存本机 app-config.json。</div>
      <div class="section-title">笔记 skill</div>
      <div class="form-field"><label>当前风格</label><select id="sSkill">${S.skills.map((k) => `<option value="${esc(k.name)}" ${k.name === S.cfg.activeSkill ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost sm" id="sLearnSkill">✦ 从笔记样本学习新风格</button>
        <button class="btn ghost sm" id="sImportSkill">导入 SKILL.md</button>
        <button class="btn ghost sm" id="sTestApi">测试连接</button>
      </div>
      <div class="skill-drop-zone" id="skillDropZone">${ico('upload', 18)}<span>将 SKILL.md 拖到此处直接导入</span></div>
      <div class="hint" style="margin-top:10px">密钥以明文保存在 data/app-config.json（本机）。所有数据仅存本地。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="sOk">保存</button></div>
    `, (root) => {
      let pickedTheme = curTheme;
      root.querySelectorAll('.theme-card').forEach((card) => {
        card.addEventListener('click', async () => {
          pickedTheme = card.dataset.theme;
          root.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c === card));
          await setTheme(pickedTheme);
        });
      });
      root.querySelector('#sOk').addEventListener('click', async () => {
        const patch = {
          api: { baseUrl: root.querySelector('#sBase').value.trim(), apiKey: root.querySelector('#sKey').value.trim(), model: root.querySelector('#sModel').value.trim() },
          activeSkill: root.querySelector('#sSkill').value,
          openalex: {
            apiKey: root.querySelector('#sOaKey').value.trim(),
            perPage: Number(root.querySelector('#sOaPerPage').value) || 20
          },
          search: {
            semanticScholarApiKey: root.querySelector('#sS2Key').value.trim()
          },
          ui: { theme: pickedTheme }
        };
        try { S.cfg = await call('updateConfig', patch); applyUiPrefs(); closeModal(); toast('设置已保存'); }
        catch (e) { toast(e.message, true); }
      });
      root.querySelector('#sTestApi').addEventListener('click', async () => {
        try { await call('updateConfig', { api: { baseUrl: root.querySelector('#sBase').value.trim(), apiKey: root.querySelector('#sKey').value.trim(), model: root.querySelector('#sModel').value.trim() } }); await ai('testConnection'); toast('连接成功'); }
        catch (e) { toast('连接失败：' + e.message, true); }
      });
      root.querySelector('#sImportSkill').addEventListener('click', async () => {
        const paths = await window.bridge.dialog.openFiles({ title: '选择 SKILL.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
        if (!paths.length) return;
        try { const name = await call('importSkill', paths[0]); S.skills = await call('listSkills'); toast('已导入 skill：' + name); showSettings(); }
        catch (e) { toast(e.message, true); }
      });
      root.querySelector('#sLearnSkill').addEventListener('click', showLearnSkill);
      bindDropZone(root.querySelector('#skillDropZone'), {
        onFiles: async (paths) => {
          const md = paths.find((p) => /\.md$/i.test(p));
          if (!md) throw new Error('请拖入 SKILL.md 文件');
          const name = await call('importSkill', md);
          S.skills = await call('listSkills');
          toast('已导入 skill：' + name);
          showSettings();
        }
      });
    });
  }

  // ---------- 模态框 ----------
  // 从笔记样本学习新 skill（D44）：粘贴一篇自己的笔记 → AI 提炼风格规范 → 保存为 skill
  function showLearnSkill() {
    openModal('从笔记样本学习新风格', `
      <div class="form-field"><label>skill 名称（保存后可在笔记 skill 下拉中选用）</label><input id="lName" placeholder="例如：我的精读风格"></div>
      <div class="form-field" style="margin-top:10px"><label>粘贴一篇你自己写的论文笔记样本（结构/语气/详略将被学习）</label>
        <textarea id="lSample" class="editor-area" rows="10" placeholder="把你自己写的一篇完整笔记粘贴到这里…&#10;AI 会提炼它的结构、字段、语气与详略，生成一份可复用的风格规范"></textarea></div>
      <div class="hint" style="margin-top:8px">学习结果保存到 data/skills/，可随时在设置中切换；之后每篇论文都按这个风格生成。</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="lGo"><span style="margin-right:4px">✦</span>学习并保存</button></div>
    `, (root) => {
      root.querySelector('#lGo').addEventListener('click', async () => {
        const name = root.querySelector('#lName').value.trim() || 'my-style';
        const sample = root.querySelector('#lSample').value;
        const btn = root.querySelector('#lGo');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 学习中…';
        try {
          const saved = await ai('learnSkill', sample, name);
          S.skills = await call('listSkills');
          S.cfg = await call('updateConfig', { activeSkill: saved });
          closeModal(); toast('已学习并启用新风格：' + saved);
          showSettings();
        } catch (e) { toast('学习失败：' + e.message, true); btn.disabled = false; btn.innerHTML = '✦ 学习并保存'; }
      });
    });
  }

      Object.assign(this, {
        renderMarkdown, renderTextWithRefs, extractRefs, bindRefClicks, offerCreateRefTarget,
        renderBacklinks, importPdfs, batchImport, scanPdfRecursive,
        confirmDeleteItem, showSettings, showLearnSkill
      });
    }
  }
  namespace.ReferenceController = ReferenceController;
})();
