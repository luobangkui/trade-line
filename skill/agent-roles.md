# Agent 多角色协作建议

> 入口：[../SKILL.md](../SKILL.md)

不同的 agent 应当承担不同的复盘职责，**通过 source 字段区分**。

## 角色矩阵

| Agent 角色 | source | 主要职责 | 触发时机 | 主要 SOP |
|---|---|---|---|---|
| `news_agent` | `agent:news` | 写入 baseline event/future_event | 实时新闻发生 | [api-baseline.md](./api-baseline.md) |
| `quant_agent` | `agent:quant` | 写入 market_snapshot/emotion_metric | 收盘后 | [api-baseline.md](./api-baseline.md) |
| `strategy_agent` | `agent:strategy` | 写入 stage_signal/position_suggestion | 开盘前 | [api-baseline.md](./api-baseline.md) |
| `daily_reviewer` | `agent:daily` | 给操作打分 + 写 daily plan | 收盘后 | [sop-daily.md](./sop-daily.md) |
| `weekly_reviewer` | `agent:weekly` | 周聚合 + 周记 | 周日晚 | [sop-weekly.md](./sop-weekly.md) |
| `monthly_reviewer` | `agent:monthly` | 月聚合 + 月报 | 月初 1-3 日 | [sop-monthly.md](./sop-monthly.md) |
| **`permission_agent`** | **`agent:permission`** | **生成「明日权限卡」（事前刹车）** | **每日 daily 复盘后** | **[sop-permission.md](./sop-permission.md)** |
| `orchestrator` | `agent:orchestrator` | 检查数据完整度 / override 修正 | 每日固定时间 | [sop-fixup.md](./sop-fixup.md) |

## 协作示例（一日流程）

```
开盘前 (08:30)
  └─ strategy_agent  → POST /baseline/input  data_type=stage_signal

盘中 (09:30-15:00)
  └─ news_agent       → POST /baseline/input  data_type=market_event / future_event

收盘后 (15:30)
  ├─ quant_agent       → POST /baseline/input  data_type=market_snapshot
  └─ daily_reviewer    → 拉取 ops + snapshot
                        → 对每笔 op  POST /review/operation/:id/eval
                        → POST /review/daily/$date/plan

收盘后 (16:00)
  └─ permission_agent → 拉取 baseline + 近 3 日 daily + 近 5 日 ops
                       → 推理三档 + 行为模式 + 禁止动作
                       → POST /api/permission  生成"明日权限卡"

晚间 (21:00)
  └─ orchestrator     → GET /baseline/snapshot  检查完整性
                       → 必要时 POST /baseline/override
                       → GET /api/permission/today  确认明日卡已生成
```

> **第二天开盘前**：用户在前端顶栏一眼看到「🛑 明日权限 保护 仓50% 禁:补仓/倒T」，
> 30 秒决定今天能不能下手 — 这是把复盘转成盈利的关键路径。

## 周末/月初

```
周日晚
  └─ weekly_reviewer   → 完整执行 sop-weekly.md

每月 1-3 日
  └─ monthly_reviewer  → 完整执行 sop-monthly.md
```

## 协作纪律

1. **每个 agent 只写自己负责的数据类型**，不越界
2. **写入永远带 source**，便于后续 `?source=agent:xxx` 过滤追溯
3. **修正用 override 而非 reset**，保留全部历史数据
4. **跨 agent 数据接力**：上游写完后，下游通过 GET 接口读取，不直接传参
5. **PATCH 优于 PUT 优于 POST 新建**：增量更新 journal 用 PATCH，避免覆盖丢失
