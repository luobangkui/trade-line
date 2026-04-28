---
name: trade-baseline-review
description: >-
  Trade Baseline v2 复盘工作助手技能（精简入口版）。Agent 可通过本 skill 完成完整复盘闭环：
  (1) 同步市场客观基线；(2) 记录交易操作并自动评估；
  (3) 自动聚合日/周/月复盘 + 历史模式洞察；(4) 写入独立复盘日志报告；
  (5) 在编辑覆盖 / 重新聚合 / 清空重推 / 单条删除多接口间正确选择。
  详细 SOP 与接口手册按需读取 skill/ 子目录对应文件。
  BASE_URL 默认生产地址 http://vzil1451410.bohrium.tech:50001。
---

# Trade Baseline v2 — Agent 复盘工作助手（入口）

> 🎯 让 agent 不只是同步数据，而能完整执行复盘 — 从拉数据、生成评估，到识别行为模式、写出可执行的改进规则。
>
> 📂 本文件是**精简入口（~3k tokens）**。完整 SOP 与接口字段都在 `skill/` 子目录下，按需读取，避免上下文炸裂。

## 配置

| 变量 | 说明 | 值 |
|------|------|----|
| `BASE_URL` | 服务地址 | 生产：`http://vzil1451410.bohrium.tech:50001` / 本地：`http://localhost:50001` |

> ⚠️ 在远程机器内部用 curl 调用时需加 `--noproxy '*'`，否则会被 Privoxy 代理拦截。

---

## 🗺️ 能力地图

```
        ┌─ 客观面 ──────────────────────────────────────┐
        │  baseline (市场基线)                           │
        │    ├─ snapshot      当日阶段/情绪/风险         │
        │    ├─ event         市场事件                   │
        │    ├─ future        未来观察项                 │
        │    └─ override      人工修正                    │
        └────────────────────────────────────────────────┘
                              ↕ 双向关联
        ┌─ 主观面 ──────────────────────────────────────┐
        │  review (个人复盘)                             │
        │    ├─ operation     一笔操作                    │
        │    ├─ evaluation    操作评估 (agent/self)       │
        │    └─ daily         当日复盘汇总 (自动)         │
        └────────────────────────────────────────────────┘
                              ↕ 时间聚合
        ┌─ 聚合面 ──────────────────────────────────────┐
        │  period (周/月聚合) ← 自动 + 编辑覆盖           │
        │  journal (独立日志) ← 纯自由写，可多篇           │
        │  insights (历史洞察) ← 基于历史 N 期对比生成     │
        └────────────────────────────────────────────────┘
```

---

## 🧭 接口选择决策树（开始任何工作前先看这里）

```
你要做什么？
│
├─ 写入"客观市场"信息
│   ├─ 当日的阶段/情绪/事件 → POST /api/baseline/input
│   ├─ 未来要发生的事件      → POST /api/baseline/input (data_type=future_event)
│   ├─ 修正之前 agent 的误判  → POST /api/baseline/override
│   └─ 完全清空某日重来       → POST /api/baseline/reset/:date
│      详情：skill/api-baseline.md
│
├─ 写入"用户操作 / 个人复盘"
│   ├─ 一笔具体操作          → POST /api/review/operation
│   ├─ 给某笔操作打分/评价    → POST /api/review/operation/:id/eval
│   ├─ 当日总结 / 计划        → POST /api/review/daily/:date/plan
│   └─ 删错某笔操作          → DELETE /api/review/operation/:id
│      详情：skill/api-review.md
│
├─ 写入/修改"周或月的聚合复盘"
│   ├─ 让系统自动重聚合        → POST /api/review/weekly|monthly/:key/aggregate
│   ├─ 改 narrative/改进/手册  → POST /api/review/weekly|monthly/:key/plan
│   ├─ 推倒重来（含手写内容） → DELETE /api/review/weekly|monthly/:key?reaggregate=1
│   └─ 想看历史模式洞察       → GET  /api/review/weekly|monthly/:key/insights
│      详情：skill/api-period.md
│
├─ 写入"自由复盘日志"（一周/月可写多篇长文）
│   ├─ 新建一篇                → POST /api/review/journal
│   ├─ 增量补内容              → PATCH /api/review/journal/:id
│   ├─ 完整替换                → PUT /api/review/journal/:id
│   └─ 删错一篇                → DELETE /api/review/journal/:id
│      详情：skill/api-journal.md
│
└─ 查询/读取
    ├─ 某日全景                → GET /api/baseline/snapshot?date= + GET /api/review/daily?date=
    ├─ 时间区间                → GET /api/baseline/timeline?start=&end=
    ├─ 周/月时间轴             → GET /api/review/period/timeline?type=week&start=&end=
    └─ 全部日志（带过滤）       → GET /api/review/journals?scope=&tag=&search=
```

> **关键原则**：
> 1. **写入不破坏**：所有 POST/PATCH 默认是"追加 + 自动聚合"，不会丢失之前的数据
> 2. **修正用 override / plan**：在原数据上叠加，不要直接 reset
> 3. **重置用 reset / DELETE**：明确知道要清空时才用，不可恢复
> 4. **agent 写入永远带 source 标识**：`source: "agent:你的名字"`，便于追溯

---

## 📚 文档索引（按场景读取）

| 你的目标 | 读这些文件（按需） |
|---|---|
| 做**日复盘**（盘后给操作打分 + 写计划） | [`skill/sop-daily.md`](./skill/sop-daily.md) → 必要时 [`skill/api-review.md`](./skill/api-review.md) |
| 做**周复盘**（周聚合 + 周记 + 历史对比） | [`skill/sop-weekly.md`](./skill/sop-weekly.md) → 必要时 [`skill/api-period.md`](./skill/api-period.md) · [`skill/api-journal.md`](./skill/api-journal.md) |
| 做**月复盘**（月度主题 + 月报 + playbook） | [`skill/sop-monthly.md`](./skill/sop-monthly.md) → 必要时 [`skill/api-period.md`](./skill/api-period.md) · [`skill/api-journal.md`](./skill/api-journal.md) |
| **纠错 / 重置**（agent 写错想推倒重来） | [`skill/sop-fixup.md`](./skill/sop-fixup.md) |
| 同步**客观市场数据**（情绪/事件/快照/未来事件） | [`skill/api-baseline.md`](./skill/api-baseline.md) |
| 写**操作 + 评估**（trade operation / evaluation） | [`skill/api-review.md`](./skill/api-review.md) |
| 写/查**周月聚合 + insights** | [`skill/api-period.md`](./skill/api-period.md) |
| 写**独立日志 / 周报 / 月报**（长文） | [`skill/api-journal.md`](./skill/api-journal.md) |
| 写文字字段（避免空话） | [`skill/content-quality.md`](./skill/content-quality.md) — **每次写文字前都该读** |
| 看**完整端到端示例**（一次完整周复盘 agent） | [`skill/examples-e2e.md`](./skill/examples-e2e.md) |
| **多 agent 协作**（角色分工 / source 命名） | [`skill/agent-roles.md`](./skill/agent-roles.md) |

> **建议读取策略**：
> 1. 始终先读 SKILL.md（本文件）拿决策树
> 2. 按"任务类型"读对应 SOP（一份 ~1-2k tokens）
> 3. 写文字字段时读 `content-quality.md`（~1k tokens）
> 4. 接口字段不熟时再读对应 `api-*.md`
> 5. 遇到不确定的删除/重置，必读 `sop-fixup.md`

---

## ✅ 最终自检清单（每次复盘任务结束前对照）

- [ ] 所有写入都带了 `source: "agent:..."` 标识
- [ ] 写入失败时是否检查了 HTTP 状态码 / response.error
- [ ] 文字字段是否符合 [content-quality.md](./skill/content-quality.md) 准则（含具体场景 + 触发条件 + 量化）
- [ ] 没有产生空话/口号式内容
- [ ] 是否处理了 insights 中的 recurring_mistakes（至少 1 条）
- [ ] 是否避免了重复写入（用 GET 先确认 / 用 PATCH 而非新建）
- [ ] 长文 journal 是否有 status=final（草稿请用 draft）
- [ ] 涉及金额/价格的数字是否准确（不要捏造）
- [ ] 远程调用是否带 `--noproxy '*'`（在沙箱内部）

---

## 🚀 30 秒快速上手

```bash
BASE_URL=http://vzil1451410.bohrium.tech:50001
WEEK="2026-W17"

# 1. 触发周聚合
curl -X POST "$BASE_URL/api/review/weekly/$WEEK/aggregate"

# 2. 拉取本周聚合 + 历史洞察
curl -s "$BASE_URL/api/review/weekly?period=$WEEK"
curl -s "$BASE_URL/api/review/weekly/$WEEK/insights?lookback=4"

# 3. 写入周复盘文字（覆盖 plan 字段）
curl -X POST "$BASE_URL/api/review/weekly/$WEEK/plan" \
  -H 'Content-Type: application/json' \
  -d '{"narrative":"...","improvements":["..."],"playbook_updates":["..."],"next_actions":["..."]}'

# 4. 写一篇周记日志
curl -X POST "$BASE_URL/api/review/journal" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"week","period_key":"'$WEEK'","title":"...","body":"...","status":"final","source":"agent:weekly"}'
```

> 完整流程 + 注意事项见 [skill/sop-weekly.md](./skill/sop-weekly.md) 和 [skill/examples-e2e.md](./skill/examples-e2e.md)。
