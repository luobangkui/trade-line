# SOP-C：月复盘

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套接口详情：[api-period.md](./api-period.md) · [api-journal.md](./api-journal.md)

**目标**：识别月度主题，沉淀 1-2 条核心 playbook，规划下月策略。

## 标准流程（5 步）

```
1. 触发月聚合 + 拉取数据
   POST /api/review/monthly/$month/aggregate
   GET /api/review/monthly?period=$month
   GET /api/review/monthly/$month/insights
   GET /api/review/monthly/$month/children   ← 4-5 周明细

2. 分析（重点不同于周）
   a) 月度主题：从 stage_distribution 找出主导阶段（如"主升期 6 天 + 高位 8 天"）
   b) 阶段切换的反应：在阶段切换日（CHAOS→REPAIR→MAIN_UP→HIGH_RISK）你做对了什么/错了什么
   c) 月度纪律性：active_days/总交易日 < 50% 是好事还是坏事？取决于阶段
   d) PnL 与契合度的关系：契合度高 ≠ 赚钱，要追问

3. 写入月度复盘
   POST /api/review/monthly/$month/plan
   {
     monthly_thesis: "本月的核心叙事（一句话定调）",
     narrative: "...",
     key_takeaways / mistakes / improvements / playbook_updates / next_actions
   }

4. 写一篇月报 journal（强烈推荐）
   POST /api/review/journal
   { scope:"month", period_key:"$month",
     title:"X月月报 - <主题词>",
     summary:"...",
     body:"## 月度总览\n## 关键转折\n## 月度自评\n...",
     sections:[
       {title:"数据复盘",kind:"data",content:"胜率/收益/回撤"},
       {title:"心理复盘",kind:"reflection",content:"..."},
       {title:"下月策略",kind:"plan",content:"..."}
     ],
     status:"final", source:"agent:你的名字" }

5. 自检
   - monthly_thesis 是否一句话能概括？
   - 是否产生了至少 1 条月度级别的 playbook（不是周级别的细节）？
   - 月报 journal 是否有"下月策略"小节？
```

## 月级 vs 周级 playbook 区别

| 类型 | 周级 playbook（不算数）| 月级 playbook（要的）|
|---|---|---|
| 时间尺度 | 单周特定动作 | 长期持有的规则 |
| 反例 | "下周避开高位股" | — |
| 正例 | — | "新规则: 月度仓位中枢按主导阶段动态调整：MAIN_UP 70%、HIGH_RISK 40%" |

## 写入文字字段时

务必遵循 [content-quality.md](./content-quality.md)，特别是 `monthly_thesis` 段。
