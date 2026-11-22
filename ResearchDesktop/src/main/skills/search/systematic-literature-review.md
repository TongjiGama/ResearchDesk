---
id: systematic-literature-review
name: Systematic Review · 严谨综述与布尔检索
version: "1.0"
badge: 系统综述
tier: systematic
githubRepo: https://github.com/marciob/skill-research-papers
license: MIT
attribution: Adapted from marciob/skill-research-papers (MIT), bimajanuri/paper-review-skill (MIT), and PRISMA-S / PICO structured search principles.
defaultSources:
  - openalex
  - crossref
  - arxiv
  - openreview
  - semanticscholar
defaultSort: relevance
maxQueries: 3
enableSnowball: false
enableRcsScreening: true
excludeRejected: true
summary: 借鉴 GitHub skill-research-papers 与 PRISMA-S 规范：按概念分面构造可复现英文检索式与标准布尔式，全源查重、核验同行评审载体，并支持一键导出 BibTeX 与 Markdown 文献综述矩阵。
---

# Systematic Review · 严谨综述与布尔检索规范

来源参考：[marciob/skill-research-papers](https://github.com/marciob/skill-research-papers)（MIT）与 [bimajanuri/paper-review-skill](https://github.com/bimajanuri/paper-review-skill)（MIT）。面向开题报告、Related Work 撰写与系统综述场景。

## 1. 分面拆解与布尔检索式（Concept Blocks & Boolean Syntax）
- 按研究问题将查询拆解为 2–4 个独立概念块（如 **研究对象/任务** × **核心方法** × **约束/评测场景**）。
- 为每个概念块列出主流英文同义词与缩写，组合成可复现、可粘贴到 Google Scholar / Web of Science / Scopus / OpenAlex 的标准布尔检索式。
- 生成 3 条覆盖不同分面组合的检索式并行召回，尽量减少单一表达造成的漏检。

## 2. 证据分级与来源透明（Provenance & Quality Control）
- 明确区分**已同行评审正式发表**（期刊 / 顶会 / 主流会议）与**预印本**（arXiv），不得混淆。
- 过滤 OpenReview 拒稿与撤稿，保留完整 DOI / arXiv ID / 引用量来源与抓取日期。
- 输出结果可直接导出为 **BibTeX** 与 **Markdown 综述矩阵**，每条记录均保留来源数据库与验证标识，杜绝幻觉文献。
