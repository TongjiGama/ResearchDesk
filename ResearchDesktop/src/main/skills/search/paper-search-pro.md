---
id: paper-search-pro
name: Paper Search Pro · 多源系统检索
version: "1.0"
badge: 多源联邦
tier: standard
githubRepo: https://github.com/O0000-code/paper-search-pro
license: Apache-2.0
attribution: Adapted from O0000-code/paper-search-pro multi-source discovery, query planning, and RCS screening workflow for local Electron execution.
defaultSources:
  - openalex
  - arxiv
  - openreview
  - huggingface
  - crossref
defaultSort: frontier
maxQueries: 3
enableSnowball: false
enableRcsScreening: false
excludeRejected: true
summary: 借鉴 GitHub paper-search-pro 技能：多维度拆解检索词，并行检索 OpenAlex、arXiv、OpenReview、HF Papers 与 Crossref，自动跨源去重并用 OpenReview/Crossref 正式发表载体修正 arXiv 镜像偏差。
---

# Paper Search Pro · 多源系统检索规范

来源参考：[O0000-code/paper-search-pro](https://github.com/O0000-code/paper-search-pro)（Apache-2.0）。本文件为适配科研台本地多源检索引擎的内置可执行检索 Skill。

## 1. 检索策略规划（Query Planning）
- 不要把用户的自然语言问题原封不动地单次搜索；先拆解为 **2–3 条互补的英文检索式**：
  1. **核心主题式（Core）**：保留任务、对象、关键缩写（如 VLA、World Model、Diffusion Policy）。
  2. **方法与同义词式（Synonyms）**：补充学界常用的等价术语或上位/下位方法名，提高召回率。
  3. **前沿路线式（Frontier）**：聚焦近年主流架构、基准或代表性改进方向，避免漏掉最新命名。
- 仅将本地工作区论文标题作为学科术语锚点，不得据此缩小或偏离用户本次提问主题。
- 同时生成一条可供 Google Scholar / Scopus / OpenAlex / CNKI 复用的布尔检索式（Boolean Query）。

## 2. 多源分工与融合规则（Federated Routing & Fusion）
- **OpenAlex（主库 L1）**：提供广覆盖书目索引、引用量与 `referenced_works` 引文网络。
- **arXiv（新鲜度哨兵 L2）**：捕获最近数天至数月尚未完成 OpenAlex 归档的最新预印本与直连 PDF。
- **OpenReview（AI 顶会录用校对 L2）**：识别 ICLR / NeurIPS / ICML / CoRL / RSS 等顶会录用状态（Oral / Spotlight / Poster），自动覆盖 `arXiv` 预印本标签，并默认过滤 Rejected / Withdrawn 稿件。
- **Hugging Face Papers（前沿社区与代码信号 L2）**：补充社区点赞（Upvotes）、官方 GitHub 代码仓库与 Star 数。
- **Crossref（正式出版物 DOI 核验 L3）**：补充期刊与会议正式出版信息。
- **Semantic Scholar（可选增强 L3）**：在用户启用或配置 API Key 时补充高影响力引用数（Influential Citations）与 TLDR。

## 3. 相关性筛选量表（RCS 0–10）
当启用 AI 相关性筛选时，对候选论文按 0–10 分打分：
- **8–10（核心必读）**：直接解决用户的核心研究问题，或为该方向的代表性前沿方法/基准。
- **6–7（高度相关）**：方法、任务或关键机制高度契合，具备直接借鉴价值。
- **4–5（一般相关）**：属于相邻子方向，可作为背景参考。
- **0–3（边缘或偏题）**：仅关键词表面重合，实质不相关。
- 严禁基于未提供的实验细节编造评价；判断须严格立足标题、载体与摘要证据。
