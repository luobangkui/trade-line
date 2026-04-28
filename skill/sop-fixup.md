# SOP-D：纠错与重置

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套接口详情：[api-baseline.md](./api-baseline.md) · [api-review.md](./api-review.md) · [api-period.md](./api-period.md) · [api-journal.md](./api-journal.md)

**目标**：在 agent 误判、数据写错、需要推倒重来时选择正确的接口。

## 决策表

| 场景 | 推荐操作 |
|---|---|
| 某笔操作记录写错 | `DELETE /api/review/operation/:id` （会级联清评估） |
| 某条 baseline 误判 | `POST /api/baseline/override` （高优先级覆盖，原数据保留） |
| 某日 baseline 完全推倒 | `POST /api/baseline/reset/:date` （物理删除当日所有 inputs） |
| 周/月聚合写错（含手写）| `DELETE /api/review/weekly\|monthly/:key?reaggregate=1` （清空并重聚合） |
| 单篇日志写错 | `DELETE /api/review/journal/:id` |
| 仅想刷新统计、保留手写 | `POST /api/review/weekly\|monthly/:key/aggregate` （这是默认行为） |
| Agent 增量补充日志内容 | `PATCH /api/review/journal/:id` （推荐！比 PUT 安全） |

## 三种"重置"操作的差异

| 操作 | 接口 | 影响 |
|---|---|---|
| 重新聚合 | `POST /aggregate` | **保留**用户写入字段，仅重算统计 |
| 编辑覆盖 | `POST /plan` | 仅更新指定字段，其他保留 |
| 清空重推 | `DELETE` | **完全清掉**包含手写内容，回到纯自动 |

## 「清空重推」语义（DELETE 接口）

- 物理删除 `weekly_reviews` / `monthly_reviews` 表中该 period_key 的记录
- **不影响** daily_reviews / trade_operations / review_journals（彼此完全独立）
- 下次访问 `GET /weekly|monthly?period=...` 时**懒聚合**自动产生纯自动版本（用户/agent 之前手写的 narrative / improvements / playbook_updates / monthly_thesis 全部丢失）
- 适用场景：agent 写错想清空重来 / 想测试纯自动聚合输出 / 想重置后让 agent 重新生成

```bash
# 仅删除（下次 GET 时再懒聚合）
curl -X DELETE {BASE_URL}/api/review/weekly/2026-W17

# 删除并立即重聚合，返回新的纯自动版本
curl -X DELETE {BASE_URL}/api/review/weekly/2026-W17?reaggregate=1
```

## Baseline override 与 reset 的区别

| 操作 | 原始数据 | 适用场景 |
|---|---|---|
| `POST /override` | **保留**（写入 priority=10 的 input） | 纠正 agent 误判，希望保留追溯 |
| `POST /reset/:date` | **物理删除** | 数据完全错了，希望从头来过 |

⚠️ `reset` 不会清理 `future_watchlist`。如需清理某条未来事件，单独 `POST /api/baseline/future/:id/status` 标 `expired`。
