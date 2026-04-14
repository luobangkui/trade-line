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
  "deleted_futures": 2,
  "inserted": 2,
  "snapshot": { "market_stage": "MAIN_UP", "emotion_score": 72, ... }
}
```

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
