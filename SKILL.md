---
name: trade-baseline-sync
description: >-
  向 Trade Baseline v2 时间轴决策系统同步数据的技能。支持上传市场快照、事件、情绪指标、
  未来观察项、交易预案等原子输入，并可触发聚合或对快照做人工修正（override）。
  使用前需要确认 BASE_URL（本地默认 http://localhost:3000）。
---

# Trade Baseline v2 — Agent 数据同步技能

## 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BASE_URL` | 服务地址，可本地或远程 | `http://localhost:3000` |

> 所有接口路径均为 `{BASE_URL}/api/baseline/...`

---

## 核心概念

系统分两层：

- **Layer A — 原子输入（inputs）**：Agent 上传的每条数据，永久保留，不可删除，只能追加
- **Layer B — 聚合快照（snapshots）**：由同一天的所有 inputs 自动聚合产生，每次上传后自动触发更新

> **追加 vs 覆盖规则**：
> - 普通上传（`POST /input`）= **追加**，不影响已有数据，自动重新聚合当天快照
> - `override` 类型输入 = **高优先级修正**，会覆盖聚合结论，但原始数据保留不变
> - `POST /override` 接口 = 人工修正专用快捷方式，等价于上传 priority=10 的 override input

---

## 1. 上传单条原子输入（最常用）

### `POST {BASE_URL}/api/baseline/input`

上传后自动触发当日聚合，返回 `input_id` 和 `snapshot_id`。

**请求体字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `time_key` | `string` | ✅ | 日期，格式 `YYYY-MM-DD`，支持未来日期 |
| `data_type` | `string` | ✅ | 见下方类型表 |
| `source` | `string` | ✅ | 来源标识，如 `"news_agent"`, `"manual"` |
| `title` | `string` | ✅ | 简短标题，会出现在时间线卡片上 |
| `payload` | `object` | 否 | 结构化数据，不同 data_type 有约定字段 |
| `confidence` | `number` | 否 | 置信度 0-1，默认 0.8 |
| `priority` | `number` | 否 | 优先级 1-10，默认 5；override 固定 10 |
| `tags` | `string[]` | 否 | 标签，如 `["宏观","地缘"]` |
| `time_type` | `string` | 否 | `"day"` / `"intraday"` / `"week"`，默认 `"day"` |
| `effective_time_range` | `object` | 否 | `{ start: ISO8601, end: ISO8601 }`，未来事件必填 |

### `data_type` 枚举及 payload 约定

| data_type | 说明 | 关键 payload 字段 |
|-----------|------|-----------------|
| `market_snapshot` | 当日行情快照 | `emotion_score`(0-100), `events`(string[]), `limit_up`, `limit_down` |
| `emotion_metric` | 情绪指标（专项） | `emotion_score`(0-100), `score`(同义备选) |
| `market_event` | 市场事件 | `summary`, `impact_direction`(`bullish`/`bearish`/`neutral`), `impact_level`(0-1), `related_sectors`(string[]) |
| `future_event` | 未来事件 ⚠️ | `event_type`, `certainty`(`high`/`medium`/`low`) — **自动路由到 future_watchlist，不进 inputs** |
| `stage_signal` | 阶段信号 | `emotion_score`, `preferred_styles`(string[]), `avoid_styles`(string[]) |
| `position_suggestion` | 仓位建议 | `position_min`(0-1), `position_max`(0-1), `preferred_styles`, `avoid_styles` |
| `trade_plan` | 交易预案 | `summary`(string，会直接作为 action_summary) |
| `risk_alert` | 风险提醒 | `level`(`LOW`/`MEDIUM`/`HIGH`/`EXTREME`), `description` |
| `manual_note` | 主观备注 | 自由结构 |
| `override` | 人工修正 | 见 override 接口，不建议直接用此 type，用 `/override` 接口 |

### 示例：上传市场事件

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

### 示例：上传情绪快照

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

### 示例：上传未来事件（自动进 future_watchlist）

```bash
curl -X POST {BASE_URL}/api/baseline/input \
  -H 'Content-Type: application/json' \
  -d '{
    "time_key": "2026-04-14",
    "data_type": "future_event",
    "source": "calendar_agent",
    "title": "NVIDIA 财报发布，关注 AI 算力需求指引",
    "payload": {
      "event_type": "earnings",
      "certainty": "high"
    },
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

适合 Agent 一次性上传当日多条数据或一批未来事件。

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
      },
      {
        "time_key": "2026-04-16",
        "data_type": "future_event",
        "source": "calendar_agent",
        "title": "某龙头业绩预告窗口开启",
        "payload": { "event_type": "earnings", "certainty": "medium" },
        "effective_time_range": { "start": "2026-04-16T09:00:00+08:00", "end": "2026-04-16T15:30:00+08:00" }
      }
    ]
  }'
```

---

## 3. 覆盖 / 人工修正

### `POST {BASE_URL}/api/baseline/override`

**不删除原始数据**，而是写入一条 priority=10 的 override input，聚合时优先采用。

适合：
- 手工纠正 Agent 误判的阶段
- 标记"假修复"、"结构性顶部"等主观判断
- 调整建议仓位区间

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
    "action_summary": "高位结构分歧，以主线核心为主，严控追高，准备降仓",
    "note": "人工判断：当前亢奋度偏高，部分信号被 Agent 低估",
    "source": "manual"
  }'
```

**可覆盖的字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `market_stage` | `string` | 强制指定阶段，见阶段枚举 |
| `emotion_score` | `number` | 强制覆盖情绪分（0-100） |
| `risk_level` | `string` | `LOW` / `MEDIUM` / `HIGH` / `EXTREME` |
| `position_min` | `number` | 仓位下限（0-1） |
| `position_max` | `number` | 仓位上限（0-1） |
| `action_summary` | `string` | 操作建议文字 |
| `note` | `string` | 修正备注，仅存档用 |
| `source` | `string` | 修正来源，默认 `"manual"` |

> 如需再次覆盖，直接重新调用即可，最新 override 优先级最高。

---

## 4. 查询接口

### 获取某日快照

```bash
GET {BASE_URL}/api/baseline/snapshot?date=2026-04-14
```

响应示例：
```json
{
  "id": "...",
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
  "summary": { "input_count": 3, "sources": ["market_agent", "manual"], "has_override": false }
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

### 查看所有未来观察项

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

## 5. 市场阶段枚举

| stage | 中文 | emotion 范围 | 建议仓位 | 风险 | 颜色 |
|-------|------|-------------|----------|------|------|
| `CHAOS` | 混乱期 | 0-25 | 0-10% | EXTREME | #ef4444 |
| `REPAIR_EARLY` | 修复早期 | 25-45 | 10-30% | HIGH | #f97316 |
| `REPAIR_CONFIRM` | 修复确认 | 45-62 | 30-50% | MEDIUM | #eab308 |
| `MAIN_UP` | 主升行情 | 62-78 | 50-80% | LOW | #22c55e |
| `HIGH_RISK` | 高位风险 | 78-90 | 30-50% | HIGH | #a855f7 |
| `DISTRIBUTION` | 出货期 | 90-100 | 0-20% | EXTREME | #6366f1 |

---

## 6. 聚合规则（Agent 需知）

1. **emotion_score 加权平均**：来自 `market_snapshot` / `emotion_metric` / `stage_signal` 的 score，权重 = `confidence × priority`
2. **override 最高优先级**：只要当天有 override input，其字段直接覆盖聚合结论
3. **core_events 提取**：从 `market_event` 和 `market_snapshot` 的 `events[]` 字段合并去重
4. **future_watch_items**：自动关联未来 7 天内 pending 的 future_watchlist 条目
5. **preferred/avoid styles**：从 `stage_signal` 和 `position_suggestion` 的对应字段合并

---

## 7. 典型 Agent 工作流

### 盘后复盘 Agent

```
1. 爬取当日涨停跌停、成交量、情绪指标
2. POST /input  data_type=market_snapshot  payload.emotion_score=xx
3. POST /input  data_type=market_event     title=今日核心事件摘要
4. POST /input  data_type=stage_signal     payload.preferred_styles=[...]
5. （可选）POST /input  data_type=trade_plan  payload.summary=明日操作建议
```

### 新闻/事件 Agent

```
1. 检测到重要新闻
2. 判断是当日事件还是未来事件
3. 当日: POST /input  data_type=market_event
4. 未来: POST /input  data_type=future_event  + effective_time_range
```

### Orchestrator 日终汇总

```
1. GET /snapshot?date=today  检查当天聚合状态
2. 若 input_count < 3，补充缺失数据
3. 若 has_override=false 且阶段判断存疑，POST /override 修正
4. GET /future 检查近 7 天观察项，到期的更新 status=triggered/expired
```
