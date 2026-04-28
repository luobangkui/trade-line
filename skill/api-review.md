# Trade Review 个人复盘接口手册（操作 + 评估 + 日度）

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套 SOP：[sop-daily.md](./sop-daily.md)

复盘系统与 baseline **互补**：baseline 是客观市场判断，复盘是主观操作 + 反思。

## 接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/review/operation` | 写入单笔操作（自动关联当时 baseline 阶段）|
| POST | `/api/review/operation/batch` | 批量写入操作 |
| GET  | `/api/review/operations?date=` | 查询某日操作（或区间 `start=&end=`）|
| GET  | `/api/review/operation/:id` | 单笔操作 + 全部评估 |
| DELETE | `/api/review/operation/:id` | 删除操作（评估同时清理）|
| POST | `/api/review/operation/:id/eval` | 写入操作评估（agent / self）|
| GET  | `/api/review/daily?date=` | 查询日度复盘汇总 |
| POST | `/api/review/daily/:date/aggregate` | 手动重新聚合日度复盘 |
| POST | `/api/review/daily/:date/plan` | 手写后续计划 / 收获 / 错误 / 情绪总结 |

---

## 数据模型

### TradeOperation（一笔操作）

| 字段 | 说明 |
|------|------|
| `time_key` | 日期 YYYY-MM-DD（必填）|
| `timestamp` | 精确时间 ISO8601（可选，缺省取当前）|
| `symbol` / `name` | 标的代码 / 名称（必填）|
| `direction` | `buy` / `sell` / `add` / `reduce` / `hold` / `observe` / `plan`（必填）|
| `quantity` / `price` / `amount` | 数量 / 价格 / 金额（observe/plan 可空，amount 缺省自动计算）|
| `rationale` | 操作依据自由文本（必填）|
| `rationale_type` | `technical` / `fundamental` / `news` / `baseline` / `emotion` / `impulsive` / `system` / `mixed`（必填）|
| `emotion_state` | `calm` / `confident` / `excited` / `fomo` / `greedy` / `fearful` / `panic` / `regret` / `revenge`（必填）|
| `tags` / `notes` | 标签数组 / 备注（可选）|
| `created_by` | 创建者，缺省 `self` |

写入时系统会自动关联当时的 `linked_baseline_stage` 和 `linked_baseline_emotion`。

### OperationEvaluation（操作评估，agent 或 self 写入）

| 字段 | 说明 |
|------|------|
| `evaluator` | `self` / `agent:xxx` / `system`（必填）|
| `score` | 0-100 综合评分（必填）|
| `verdict` | `excellent` / `good` / `neutral` / `poor` / `bad`（必填）|
| `alignment_score` | 与当时 baseline 的契合度 0-100 |
| `pros` / `cons` / `suggestions` | 优点 / 问题 / 建议数组 |
| `next_action_hint` | 下一步动作提示（可选）|

> 同一 `evaluator` 对同一 `operation` 只保留最新一条评估，方便 agent 多次更新。

### DailyReviewSummary（日度汇总，自动聚合）

- 每次写入操作或评估后自动重新聚合
- 包含：胜率、平均评分、Baseline 契合度、情绪/依据分布、关键收获、主要错误、后续计划、情绪总结
- 用户可通过 `POST /daily/:date/plan` 手写覆盖 `next_actions` / `key_takeaways` / `mistakes` / `mood_summary`

---

## 接口示例

### 1. 写入操作
```bash
curl -X POST {BASE_URL}/api/review/operation \
  -H "Content-Type: application/json" \
  -d '{
    "time_key": "2026-04-15",
    "symbol": "600519",
    "name": "贵州茅台",
    "direction": "buy",
    "quantity": 100,
    "price": 1620.5,
    "rationale": "主升期回踩20日均线，量能温和放大",
    "rationale_type": "technical",
    "emotion_state": "calm",
    "tags": ["白酒", "高位"]
  }'
```

### 2. 写入操作评估
```bash
OP_ID=<operation.id>
curl -X POST {BASE_URL}/api/review/operation/$OP_ID/eval \
  -H "Content-Type: application/json" \
  -d '{
    "evaluator": "agent:advisor",
    "score": 65,
    "verdict": "neutral",
    "alignment_score": 30,
    "pros": ["按系统化规则进场"],
    "cons": ["大盘处于HIGH_RISK，仍加仓白酒，与 baseline 相悖"],
    "suggestions": ["高位风险期建议降低仓位至 30-50%", "考虑买入对冲"]
  }'
```

### 3. 写入当日复盘计划
```bash
curl -X POST {BASE_URL}/api/review/daily/2026-04-15/plan \
  -H "Content-Type: application/json" \
  -d '{
    "next_actions": ["明日观察换手率", "若放量则减仓 50%"],
    "key_takeaways": ["系统化纪律的重要性"],
    "mistakes": ["对 baseline 信号的执行力不足"],
    "mood_summary": "今日操作整体偏激进，需控制仓位"
  }'
```

> 文字字段务必遵循 [content-quality.md](./content-quality.md)。

---

## 关键设计

- **自动 baseline 关联**：每次写操作时自动从该日 snapshot 取 `market_stage` 和 `emotion_score`，无需 agent 显式传入
- **多评估并存**：可同时存在 `self` 自评 和多个 `agent:xxx` 评估，前端默认展示最新一条
- **聚合自动触发**：写入 operation 或 evaluation 后立即重新聚合 `daily_review`，无需手动调用
- **next_actions 智能合并**：若用户已手写 plan，聚合时不会覆盖；若用户未填，自动用所有评估的 suggestions 去重填充
- **删除级联**：`DELETE /operation/:id` 会同时清理该操作的所有 evaluations
