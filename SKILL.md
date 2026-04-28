---
name: trade-baseline-sync
description: >-
  向 Trade Baseline v2 时间轴决策系统同步数据的技能。支持上传市场快照、事件、情绪指标、
  未来观察项、交易预案等原子输入，并可触发聚合、人工修正（override）或完全重写（reset）。
  BASE_URL 为可变参数，默认生产地址 http://vzil1451410.bohrium.tech:50001。
---

# Trade Baseline v2 — Agent 数据同步技能

## 配置

| 变量 | 说明 | 值 |
|------|------|----|
| `BASE_URL` | 服务地址 | 生产：`http://vzil1451410.bohrium.tech:50001` / 本地：`http://localhost:50001` |

> 所有接口路径均为 `{BASE_URL}/api/baseline/...`
>
> ⚠️ 在远程机器内部用 curl 调用时需加 `--noproxy '*'`，否则会被 Privoxy 代理拦截。

---

## 接口速查表

| 方法 | 路径 | 说明 | 写入模式 |
|------|------|------|----------|
| POST | `/api/baseline/input` | 上传单条原子输入 | **追加** |
| POST | `/api/baseline/input/batch` | 批量上传 | **追加** |
| POST | `/api/baseline/override` | 人工修正聚合结论 | **高优先级覆盖，原数据保留** |
| POST | `/api/baseline/reset/:date` | 完全清空重写某日数据 | **物理删除后重写** |
| POST | `/api/baseline/aggregate/:date` | 手动触发重新聚合 | — |
| GET  | `/api/baseline/snapshot` | 获取某日快照 | — |
| GET  | `/api/baseline/timeline` | 获取时间线区间 | — |
| GET  | `/api/baseline/inputs` | 查看原子输入列表 | — |
| GET  | `/api/baseline/future` | 查看未来观察项 | — |
| POST | `/api/baseline/future/:id/status` | 更新未来事件状态 | — |

### 个人复盘接口（Trade Review）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/review/operation` | 写入单笔操作（自动关联当时 baseline 阶段） |
| POST | `/api/review/operation/batch` | 批量写入操作 |
| GET  | `/api/review/operations?date=` | 查询某日操作（或区间 `start=&end=`）|
| GET  | `/api/review/operation/:id` | 单笔操作 + 全部评估 |
| DELETE | `/api/review/operation/:id` | 删除操作（评估同时清理）|
| POST | `/api/review/operation/:id/eval` | 写入操作评估（agent / self）|
| GET  | `/api/review/daily?date=` | 查询日度复盘汇总 |
| POST | `/api/review/daily/:date/aggregate` | 手动重新聚合日度复盘 |
| POST | `/api/review/daily/:date/plan` | 手写后续计划 / 收获 / 错误 / 情绪总结 |

### 周 / 月复盘接口（Period Review）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/review/weekly?period=YYYY-Www` | 查询某周复盘（不存在则即时聚合）|
| GET  | `/api/review/weekly?start=&end=`     | 查询周复盘列表 |
| POST | `/api/review/weekly/:week/aggregate` | 手动重新聚合 |
| POST | `/api/review/weekly/:week/plan`      | 写入/更新周度文字总结（narrative / 收获 / 错误 / 改进 / 手册 / 行动）|
| GET  | `/api/review/weekly/:week/insights`  | 基于历史 N 周的模式洞察 + 推荐下期行动 |
| GET  | `/api/review/weekly/:week/children`  | 该周每日明细列表 |
| GET  | `/api/review/monthly?period=YYYY-MM` | 同上，月粒度 |
| POST | `/api/review/monthly/:month/aggregate` | 手动重新聚合月 |
| POST | `/api/review/monthly/:month/plan`    | 写入/更新月度（含 monthly_thesis）|
| GET  | `/api/review/monthly/:month/insights`| 月度历史洞察 |
| GET  | `/api/review/monthly/:month/children`| 该月各周明细 |
| GET  | `/api/review/period/timeline?type=week\|month&start=&end=` | 区间内全部周/月聚合（缺失自动聚合）|

**周键 / 月键格式：**
- 周：`YYYY-Www`，使用 ISO 8601 周编号（周一为本周起点）。例：`2026-W17`
- 月：`YYYY-MM`。例：`2026-04`

**示例：拉取本周复盘 + 历史洞察**
```bash
curl -s "{BASE_URL}/api/review/weekly?period=2026-W17"
curl -s "{BASE_URL}/api/review/weekly/2026-W17/insights?lookback=4"
```

**示例：写入周复盘文字（agent 用）**
```bash
curl -X POST {BASE_URL}/api/review/weekly/2026-W17/plan \
  -H 'Content-Type: application/json' \
  -d '{
    "narrative": "本周 HIGH_RISK 阶段纪律松懈，上头加仓代价沉重",
    "improvements": ["HIGH_RISK 阶段强制减仓至 30%-50%", "禁止 FOMO 状态下进场"],
    "playbook_updates": ["新规则: HIGH_RISK 阶段每日开盘前评估持仓，超 50% 强制降至 50%"],
    "next_actions": ["重点关注 AI 算力主线", "CPI 前一日清空高位股"]
  }'
```

**写入月度复盘可额外传 `monthly_thesis`**：
```bash
curl -X POST {BASE_URL}/api/review/monthly/2026-04/plan \
  -d '{ "monthly_thesis": "高位风险阶段贯穿整月，重点防御", ... }'
```

**聚合规则（Period）**
- 操作数加权平均：`avg_score / baseline_alignment / win_rate` 按各日 operations_count 加权
- 文字字段（key_takeaways/mistakes/next_actions）：从子周期 daily review 合并去重 Top N
- `recurring_mistakes`：同一错误在 ≥2 个子周期出现自动入选
- `pattern_insights`：自动检测负面情绪占比 ≥40%、低质量依据占比 ≥25%、契合度 <50 等阈值
- `narrative`：自动生成（"本周共 X 笔操作..."），仅当用户/agent 通过 plan 写入非默认格式时被保留
- 用户/agent 通过 `plan` 接口写入的字段（improvements/playbook_updates/monthly_thesis）：受保护不被自动覆盖

**洞察（insights）输出**：基于本期之前的 N 期（默认 4），返回：
- `score_trend / alignment_trend / win_rate_trend`：趋势数组
- `recurring_mistakes / recurring_strengths`：≥2 期出现的错误/优势
- `emotion_warnings / rationale_warnings / alignment_warnings`：阈值警示文案
- `recommended_next_actions`：合并后去重的可执行建议（前端可一键回填到 `next_actions`）

---

## 核心概念

**两层架构：**
- **Layer A — 原子输入（inputs）**：Agent 上传的每条原始数据，三种写入模式下行为不同
- **Layer B — 聚合快照（snapshots）**：由同一天所有 inputs 自动聚合产生，每次写入后自动刷新

**三种写入模式对比：**

| 模式 | 接口 | 原始数据 | 快照结论 | 适用场景 |
|------|------|----------|----------|----------|
| 追加 | `POST /input` `POST /input/batch` | 永久保留 | 重新聚合 | 日常 Agent 写入 |
| 修正 | `POST /override` | 永久保留 | 最新 override 优先 | 纠正 Agent 误判 |
| 重写 | `POST /reset/:date` | **物理删除** | 重新聚合 | 数据完全替换 |

---

## 1. 上传单条原子输入（最常用）

### `POST {BASE_URL}/api/baseline/input`

**请求体字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `time_key` | `string` | ✅ | 日期 `YYYY-MM-DD`，支持历史/当日/未来 |
| `data_type` | `string` | ✅ | 见下方类型表 |
| `source` | `string` | ✅ | 来源标识，如 `"news_agent"` |
| `title` | `string` | ✅ | 简短标题，显示在时间线卡片上 |
| `payload` | `object` | 否 | 结构化数据，不同 data_type 有约定字段 |
| `confidence` | `number` | 否 | 置信度 0-1，默认 0.8 |
| `priority` | `number` | 否 | 优先级 1-10，默认 5 |
| `tags` | `string[]` | 否 | 标签，如 `["宏观","地缘"]` |
| `time_type` | `string` | 否 | `"day"` / `"intraday"` / `"week"`，默认 `"day"` |
| `effective_time_range` | `object` | 否 | `{ start: ISO8601, end: ISO8601 }`，未来事件必填 |

**`data_type` 枚举及 payload 约定：**

| data_type | 说明 | 关键 payload 字段 |
|-----------|------|-----------------|
| `market_snapshot` | 当日行情快照 | `emotion_score`(0-100), `events`(string[]), `limit_up`, `limit_down` |
| `emotion_metric` | 情绪指标 | `emotion_score`(0-100) |
| `market_event` | 市场事件 | `summary`, `impact_direction`(`bullish`/`bearish`/`neutral`), `impact_level`(0-1), `related_sectors`(string[]) |
| `future_event` | 未来事件 ⚠️ | `event_type`, `certainty`(`high`/`medium`/`low`) — **自动路由到 future_watchlist** |
| `stage_signal` | 阶段信号 | `emotion_score`, `preferred_styles`(string[]), `avoid_styles`(string[]) |
| `position_suggestion` | 仓位建议 | `position_min`(0-1), `position_max`(0-1), `preferred_styles`, `avoid_styles` |
| `trade_plan` | 交易预案 | `summary`(string，直接作为 action_summary) |
| `risk_alert` | 风险提醒 | `level`(`LOW`/`MEDIUM`/`HIGH`/`EXTREME`), `description` |
| `manual_note` | 主观备注 | 自由结构 |

**示例：上传市场事件**
```bash
curl -X POST {BASE_URL}/api/baseline/input \
  -H 'Content-Type: application/json' \
  -d '{
    "time_key": "2026-04-14",
    "data_type": "market_event",
    "source": "news_agent",
    "title": "中东局势升级导致避险情绪升温",
    "payload": {
      "summary": "早盘避险方向走强，成长风格承压",
      "impact_direction": "risk_off",
      "impact_level": 0.72,
      "related_sectors": ["黄金", "油气"]
    },
    "confidence": 0.78,
    "tags": ["宏观", "地缘"]
  }'
```

**示例：上传情绪快照**
```bash
curl -X POST {BASE_URL}/api/baseline/input \
  -H 'Content-Type: application/json' \
  -d '{
    "time_key": "2026-04-14",
    "data_type": "market_snapshot",
    "source": "quant_agent",
    "title": "2026-04-14 量化情绪快照",
    "payload": {
      "emotion_score": 76,
      "events": ["主线AI算力持续强化", "高位股炸板率回升"],
      "limit_up": 87,
      "limit_down": 12
    },
    "confidence": 0.92,
    "priority": 8
  }'
```

**示例：上传未来事件**
```bash
curl -X POST {BASE_URL}/api/baseline/input \
  -H 'Content-Type: application/json' \
  -d '{
    "time_key": "2026-04-14",
    "data_type": "future_event",
    "source": "calendar_agent",
    "title": "NVIDIA 财报发布，关注 AI 算力需求指引",
    "payload": { "event_type": "earnings", "certainty": "high" },
    "confidence": 0.95,
    "effective_time_range": {
      "start": "2026-04-23T21:00:00+08:00",
      "end": "2026-04-24T06:00:00+08:00"
    }
  }'
```

---

## 2. 批量上传

### `POST {BASE_URL}/api/baseline/input/batch`

```bash
curl -X POST {BASE_URL}/api/baseline/input/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [
      {
        "time_key": "2026-04-14",
        "data_type": "emotion_metric",
        "source": "sentiment_agent",
        "title": "NLP 情绪评分",
        "payload": { "emotion_score": 79 },
        "confidence": 0.85
      },
      {
        "time_key": "2026-04-14",
        "data_type": "stage_signal",
        "source": "strategy_agent",
        "title": "阶段研判信号",
        "payload": {
          "emotion_score": 79,
          "preferred_styles": ["AI算力", "机器人"],
          "avoid_styles": ["高位追涨"]
        },
        "confidence": 0.88,
        "priority": 8
      }
    ]
  }'
```

---

## 3. 人工修正（override）

### `POST {BASE_URL}/api/baseline/override`

**不删除原始数据**，写入 priority=10 的 override input，聚合时优先采用。适合纠正 Agent 误判、添加主观判断。

```bash
curl -X POST {BASE_URL}/api/baseline/override \
  -H 'Content-Type: application/json' \
  -d '{
    "time_key": "2026-04-14",
    "market_stage": "HIGH_RISK",
    "emotion_score": 82,
    "risk_level": "HIGH",
    "position_min": 0.3,
    "position_max": 0.45,
    "action_summary": "高位结构分歧，严控追高，准备降仓",
    "note": "人工判断：当前亢奋度偏高，Agent 低估了风险",
    "source": "manual"
  }'
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `time_key` | string | ✅ 必填 |
| `market_stage` | string | 强制指定阶段 |
| `emotion_score` | number | 强制覆盖情绪分（0-100） |
| `risk_level` | string | `LOW` / `MEDIUM` / `HIGH` / `EXTREME` |
| `position_min` | number | 仓位下限（0-1） |
| `position_max` | number | 仓位上限（0-1） |
| `action_summary` | string | 操作建议文字 |
| `note` | string | 修正备注（仅存档） |
| `source` | string | 来源，默认 `"manual"` |

---

## 4. 完全重写（reset）

### `POST {BASE_URL}/api/baseline/reset/:date`

**物理删除**该日所有 inputs 和关联 relations，然后写入新数据重新聚合。历史不可追溯，谨慎使用。

```bash
# 仅清空，不写新数据
curl -X POST {BASE_URL}/api/baseline/reset/2026-04-14 \
  -H 'Content-Type: application/json' \
  -d '{}'

# 清空并写入新数据（inputs 中 time_key 可省略，自动使用 URL 中的日期）
curl -X POST {BASE_URL}/api/baseline/reset/2026-04-14 \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [
      {
        "data_type": "market_snapshot",
        "source": "quant_agent",
        "title": "重写后的市场快照",
        "payload": { "emotion_score": 72, "events": ["主线明确"] },
        "confidence": 0.9
      },
      {
        "data_type": "stage_signal",
        "source": "strategy_agent",
        "title": "重写后的阶段信号",
        "payload": { "emotion_score": 72, "preferred_styles": ["AI算力"], "avoid_styles": ["追高"] },
        "confidence": 0.88
      }
    ]
  }'
```

响应：
```json
{
  "success": true,
  "deleted_inputs": 6,
  "inserted": 2,
  "snapshot": { "market_stage": "MAIN_UP", "emotion_score": 72, ... }
}
```

> **注意**：`reset` 不会清理 `future_watchlist`。未来观察项是全局数据，按 `expected_time` 在多天快照中展示，不属于某一天独有。
> 如需清理某条未来事件，请单独调用 `POST /api/baseline/future/:id/status` 将其标记为 `expired`。

---

## 5. 查询接口

### 获取某日快照
```bash
GET {BASE_URL}/api/baseline/snapshot?date=2026-04-14
```

响应示例：
```json
{
  "time_key": "2026-04-14",
  "market_stage": "HIGH_RISK",
  "emotion_score": 83,
  "risk_level": "HIGH",
  "position_min": 0.3,
  "position_max": 0.5,
  "preferred_styles": ["AI算力核心", "低位补涨"],
  "avoid_styles": ["追高", "高位博弈"],
  "action_summary": "以主线核心为主，不追高",
  "core_events": ["主线AI板块持续强化", "高位股出现分歧"],
  "future_watch_items": ["2026-04-15 CPI 数据公布"],
  "summary": { "input_count": 6, "sources": ["market_agent", "manual"], "has_override": false }
}
```

### 获取时间线区间
```bash
GET {BASE_URL}/api/baseline/timeline?start=2026-04-01&end=2026-04-30
```

### 查看某日原子输入
```bash
GET {BASE_URL}/api/baseline/inputs?date=2026-04-14
```

### 查看未来观察项
```bash
GET {BASE_URL}/api/baseline/future
```

### 手动触发重新聚合
```bash
POST {BASE_URL}/api/baseline/aggregate/2026-04-14
```

### 更新未来事件状态
```bash
POST {BASE_URL}/api/baseline/future/{id}/status
Content-Type: application/json

{ "status": "fulfilled" }   # pending / triggered / expired / fulfilled
```

---

## 6. 市场阶段枚举

| stage | 中文 | emotion 范围 | 建议仓位 | 风险 | 颜色 |
|-------|------|-------------|----------|------|------|
| `CHAOS` | 混乱期 | 0–25 | 0–10% | EXTREME | #ef4444 |
| `REPAIR_EARLY` | 修复早期 | 25–45 | 10–30% | HIGH | #f97316 |
| `REPAIR_CONFIRM` | 修复确认 | 45–62 | 30–50% | MEDIUM | #eab308 |
| `MAIN_UP` | 主升行情 | 62–78 | 50–80% | LOW | #22c55e |
| `HIGH_RISK` | 高位风险 | 78–90 | 30–50% | HIGH | #a855f7 |
| `DISTRIBUTION` | 出货期 | 90–100 | 0–20% | EXTREME | #6366f1 |

---

## 7. 聚合规则（Agent 需知）

1. **emotion_score 加权平均**：来自 `market_snapshot` / `emotion_metric` / `stage_signal` 的 score，权重 = `confidence × priority`
2. **override 最高优先级**：只要当天有 override input，其字段直接覆盖聚合结论
3. **core_events 提取**：从 `market_event` 和 `market_snapshot` 的 `events[]` 字段合并去重，最多 8 条
4. **future_watch_items**：自动关联未来 7 天内 pending 的 future_watchlist 条目
5. **preferred/avoid styles**：从 `stage_signal` 和 `position_suggestion` 的对应字段合并去重

---

## 8. 典型 Agent 工作流

### 盘后复盘 Agent
```
1. 获取当日涨停跌停、成交量、情绪指标数据
2. POST /input  data_type=market_snapshot  payload.emotion_score=xx  payload.events=[...]
3. POST /input  data_type=market_event     title=今日核心事件
4. POST /input  data_type=stage_signal     payload.preferred_styles=[...]
5. （可选）POST /input  data_type=trade_plan  payload.summary=明日操作建议
```

### 数据重跑 Agent（重新计算某日）
```
1. POST /reset/:date  body.inputs=[新数据数组]   # 清空重写
   或
   POST /aggregate/:date                          # 保留数据，仅重新聚合
```

### 新闻/事件 Agent
```
1. 检测到重要新闻
2. 判断是当日还是未来事件
3. 当日: POST /input  data_type=market_event
4. 未来: POST /input  data_type=future_event  + effective_time_range
```

### Orchestrator 日终汇总
```
1. GET /snapshot?date=today        检查当天聚合状态
2. 若 input_count < 3              补充缺失数据
3. 若 has_override=false 且存疑   POST /override 修正
4. GET /future                     检查近 7 天观察项，到期更新 status
```

---

## 个人操作复盘（Trade Review）

复盘系统与 baseline **互补**：baseline 是客观市场判断，复盘是主观操作 + 反思。

### 数据模型

**TradeOperation**（一笔操作）
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

**OperationEvaluation**（操作评估，agent 或 self 写入）
| 字段 | 说明 |
|------|------|
| `evaluator` | `self` / `agent:xxx` / `system`（必填）|
| `score` | 0-100 综合评分（必填）|
| `verdict` | `excellent` / `good` / `neutral` / `poor` / `bad`（必填）|
| `alignment_score` | 与当时 baseline 的契合度 0-100 |
| `pros` / `cons` / `suggestions` | 优点 / 问题 / 建议数组 |
| `next_action_hint` | 下一步动作提示（可选）|

> 同一 `evaluator` 对同一 `operation` 只保留最新一条评估，方便 agent 多次更新。

**DailyReviewSummary**（日度汇总，自动聚合）
- 每次写入操作或评估后自动重新聚合
- 包含：胜率、平均评分、Baseline 契合度、情绪/依据分布、关键收获、主要错误、后续计划、情绪总结
- 用户可通过 `POST /daily/:date/plan` 手写覆盖 `next_actions` / `key_takeaways` / `mistakes` / `mood_summary`

### 典型流程

#### 1. 用户/Agent 写入操作
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

#### 2. Agent 给操作打分
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

#### 3. 用户写入后续计划
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

#### 4. Agent 复盘 Agent 工作流
```
循环每个交易日:
  ops = GET /api/review/operations?date=$d
  for op in ops:
    snap = GET /api/baseline/snapshot?date=$d
    分析 op.rationale + op.emotion_state + op.linked_baseline_stage
    生成 evaluation:
      - score: 综合打分
      - alignment: 与 snap 的契合度
      - pros/cons: 具体优缺点
      - suggestions: 操作建议
    POST /api/review/operation/$op.id/eval
  # 汇总自动触发，可选手动:
  POST /api/review/daily/$d/aggregate
```

### 关键设计

- **自动 baseline 关联**：每次写操作时自动从该日 snapshot 取 `market_stage` 和 `emotion_score`，无需 agent 显式传入
- **多评估并存**：可同时存在 `self` 自评 和多个 `agent:xxx` 评估，前端默认展示最新一条
- **聚合自动触发**：写入 operation 或 evaluation 后立即重新聚合 `daily_review`，无需手动调用
- **next_actions 智能合并**：若用户已手写 plan，聚合时不会覆盖；若用户未填，自动用所有评估的 suggestions 去重填充
- **删除级联**：`DELETE /operation/:id` 会同时清理该操作的所有 evaluations
