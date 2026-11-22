---
id: frontier-sota-radar
name: Frontier SOTA Radar · 前沿高潜论文雷达
version: "1.0"
badge: 前沿追踪
tier: frontier
githubRepo: https://github.com/huggingface/skills
license: Apache-2.0
attribution: Inspired by huggingface/skills (Hugging Face Papers) and O0000-code/paper-search-pro arXiv freshness sentinel & OpenReview acceptance verification.
defaultSources:
  - huggingface
  - arxiv
  - openreview
  - openalex
defaultSort: frontier
maxQueries: 3
recentYears: 2
enableSnowball: false
enableRcsScreening: true
excludeRejected: true
summary: 专为发现“最先进、最新、带开源代码”的前沿论文设计：优先聚合 Hugging Face 热门论文、arXiv 最新提交与 OpenReview 顶会录用，按引用增速 + 开源热度 + 顶会信号综合排序。
---

# Frontier SOTA Radar · 前沿高潜论文雷达

来源参考：[huggingface/skills](https://github.com/huggingface/skills) 与 [O0000-code/paper-search-pro](https://github.com/O0000-code/paper-search-pro)。针对“最新 SOTA 论文刚发表时引用量为 0、容易被传统按引用量排序淹没”的痛点优化。

## 1. 检索词聚焦（Frontier Query Strategy）
- 生成 2–3 条偏向近年主流范式、新架构与公开基准的英文检索式：
  1. **精确前沿术语式**：准确覆盖用户提及的新概念与具体方法。
  2. **SOTA / 开源基座式**：结合当前领域常见模型家族、框架词与任务词。
  3. **跨模态/新机制扩展式**：捕捉用不同术语描述同一前沿突破的新作。

## 2. 前沿度排序原则（Frontier Ranking）
- **引用增速优先于历史总引用**：使用时间归一化引用速率，避免十年前的综述永远压过近一年的突破性工作。
- **社区与可复现信号加权**：优先暴露带有官方 GitHub 仓库、高 Star 数或 Hugging Face 社区高 Upvotes 的前沿论文。
- **顶会录用优先识别**：通过 OpenReview 与 arXiv `journal_ref` 及时标出 Oral / Spotlight / Poster 录用状态，过滤拒稿与撤稿。
- **近期窗口聚焦**：默认关注近 2 年（可手动放宽）的最新成果，并对近 6 个月论文显式保留引用时滞提示。

## 3. 筛选与判断边界
- 筛选理由必须点出“新在哪里 / 解决了什么关键瓶颈 / 是否开源可复现”。
- 若摘要未提供指标或代码链接，明确说明未提供，不得臆造 SOTA 结论。
