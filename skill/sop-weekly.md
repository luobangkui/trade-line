# SOP-B：周复盘

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套接口详情：[api-period.md](./api-period.md) · [api-journal.md](./api-journal.md)

**目标**：跳出单日得失，识别本周的行为模式，输出可执行的周度规则。

## 标准流程（5+1 步）

```
1. 自动聚合（一行触发）
   POST /api/review/weekly/$week/aggregate
   → 系统会基于本周所有 daily_review 生成统计 + 自动文字

2. 拉取本周聚合 + 历史洞察 + 子周期明细
   GET /api/review/weekly?period=$week
   GET /api/review/weekly/$week/insights?lookback=4   ← 关键：与过去 4 周对比
   GET /api/review/weekly/$week/children              ← 7 天明细

3. 综合分析（agent 推理重点）
   a) 比对 insights 中的 score_trend / alignment_trend
      - 上升趋势？说明在改进，强化保持点
      - 下降趋势？必须找到原因
   b) 比对 recurring_mistakes
      - 历史 ≥2 次出现的错误 + 本周仍在 → 必须升级为 playbook 规则
   c) 分析 emotion / rationale 分布
      - FOMO/impulsive 占比 >25% → 必须列入 improvements

4. 写入周复盘文字（核心动作）
   POST /api/review/weekly/$week/plan
   {
     narrative: "一句话总结本周的核心叙事（不是统计描述）",
     key_takeaways: ["3-5 条具体的、可复用的优势"],
     mistakes:      ["3-5 条具体的、有因果的错误"],
     improvements:  ["每条都是可执行的具体规则"],
     playbook_updates: ["新规则: ..." 用于持久化到操作手册],
     next_actions:  ["下周第一周要做的 3-6 件事"]
   }

5. 写一篇周记（可选但推荐 — 长文叙事）
   POST /api/review/journal
   { scope:"week", period_key:"$week", title:"...",
     summary:"...", body:"## ... markdown 长文",
     sections:[{title:"宏观",content:"..."}, ...],
     status:"final", source:"agent:你的名字",
     metadata:{ model, input_tokens, ... } }

6. 自检
   - playbook_updates 是否真的"可执行"（含数字阈值/明确触发条件）？
   - 是否把 insights 中的 recurring_mistakes 至少处理了一条？
   - narrative 是否避免了"统计复读"（"本周共 4 笔操作..."这种）？
```

## 关键 insights 字段

| 字段 | 含义 | 触发动作 |
|---|---|---|
| `recurring_mistakes` | ≥2 期出现的错误 | 必须升级为 playbook_updates |
| `recurring_strengths` | ≥2 期出现的优势 | 强化到 key_takeaways |
| `emotion_warnings` | 负面情绪占比 ≥40% 警示 | 写入 mistakes + improvements |
| `rationale_warnings` | 低质量依据占比 ≥25% | 写入 improvements |
| `alignment_warnings` | 契合度 <50 警示 | 写入 mistakes |
| `recommended_next_actions` | 综合推荐 | 一键回填到 next_actions |

## 写入文字字段时

务必遵循 [content-quality.md](./content-quality.md)：含具体场景 + 触发条件 + 量化结果。

## Python 一键周复盘

```python
def weekly_review(week_key, agent_name="agent:weekly"):
    post(f"/api/review/weekly/{week_key}/aggregate", {})
    review   = get(f"/api/review/weekly", period=week_key)
    insights = get(f"/api/review/weekly/{week_key}/insights")
    children = get(f"/api/review/weekly/{week_key}/children")
    plan = build_plan(review, insights, children)   # 你的推理函数
    post(f"/api/review/weekly/{week_key}/plan", plan)
    post(f"/api/review/journal", build_journal(plan, agent_name))
```

## 端到端完整示例

见 [examples-e2e.md](./examples-e2e.md)。
