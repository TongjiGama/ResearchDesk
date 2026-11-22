---
id: citation-snowball
name: Citation Snowball · 引文滚雪球追踪
version: "1.0"
badge: 引文溯源
tier: snowball
githubRepo: https://github.com/bimajanuri/paper-review-skill
license: MIT
attribution: Adapted from bimajanuri/paper-review-skill (MIT) and nealhaddaway/citationchaser backward/forward snowballing methodology.
defaultSources:
  - openalex
  - arxiv
  - openreview
defaultSort: frontier
maxQueries: 2
enableSnowball: true
snowballDirection: both
enableRcsScreening: false
excludeRejected: true
summary: 借鉴 GitHub paper-review-skill 与 citationchaser：先锁定种子论文（含当前工作区相关/必引论文），再执行前向追踪（谁改进了它）与后向溯源（共同奠基文献），挖出关键词搜不到的关键后续工作。
---

# Citation Snowball · 引文滚雪球追踪规范

来源参考：[bimajanuri/paper-review-skill](https://github.com/bimajanuri/paper-review-skill)（MIT）与 [nealhaddaway/citationchaser](https://github.com/nealhaddaway/citationchaser)。用于解决“同一技术脉络的后续改进论文换了命名、单靠关键词搜不到”的核心痛点。

## 1. 种子论文选取（Seed Selection）
- 先用主检索词召回高相关种子论文；若启用了工作区上下文，优先结合当前工作区中与主题匹配或标记为“必引”的论文（带有 OpenAlex ID）作为额外种子。
- 选取最具代表性的前 2–3 篇种子进入引文扩展，控制请求量并避免噪声爆炸。

## 2. 双向引文扩展（Forward & Backward Snowballing）
- **前向追踪（Forward · Who Cited This）**：抓取引用种子论文的最新工作，重点发现**方法改进者、后续 SOTA、评测基准与对比实验**。
- **后向溯源（Backward · Co-cited Foundations）**：统计多篇种子共同引用的奠基文献，快速定位必读的源头论文。
- 每篇经滚雪球发现的论文均保留可追溯标记（前向引用 / 后向奠基 + 关联种子标题），避免把间接关联混同于普通关键词命中。

## 3. 去重与融合
- 与原始关键词检索结果统一按 arXiv ID / DOI / OpenAlex ID / 规范化标题融合。
- 被多篇种子同时连接、且发表较近或引用增速快的后续工作自动上浮。
