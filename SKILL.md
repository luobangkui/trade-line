---
name: trade-baseline-review
description: >-
  Trade Baseline v2 复盘工作助手技能。Agent 可使用本技能完成完整的复盘闭环：
  (1) 同步市场客观基线（阶段、情绪、事件、未来观察）；
  (2) 记录用户交易操作并生成评估；
  (3) 自动聚合日/周/月复盘统计 + 历史模式洞察；
  (4) 写入完全独立的复盘日志报告（长文 + 自由小节 + 元数据）；
  (5) 在多种接口间正确选择：编辑覆盖 / 重新聚合 / 清空重推 / 单条删除。
  BASE_URL 为可变参数，默认生产地址 http://vzil1451410.bohrium.tech:50001。
---

# Trade Baseline v2 — Agent 复盘工作助手

> **🎯 本 skill 的目标**：让 agent 不只是"同步数据"，而是能完整执行复盘工作 —
> 从拉取市场数据到生成评估、识别行为模式、写出可执行的改进规则。

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

## 🧭 接口选择决策树（开始任何工作前先看这里）

```
你要做什么？
│
├─ 写入"客观市场"信息
│   ├─ 当日的阶段/情绪/事件 → POST /api/baseline/input
│   ├─ 未来要发生的事件      → POST /api/baseline/input (data_type=future_event)
│   ├─ 修正之前 agent 的误判  → POST /api/baseline/override
│   └─ 完全清空某日重来       → POST /api/baseline/reset/:date
│
├─ 写入"用户操作 / 个人复盘"
│   ├─ 一笔具体操作          → POST /api/review/operation
│   ├─ 给某笔操作打分/评价    → POST /api/review/operation/:id/eval
│   ├─ 当日总结 / 计划        → POST /api/review/daily/:date/plan
│   └─ 删错某笔操作          → DELETE /api/review/operation/:id
│
├─ 写入/修改"周或月的聚合复盘"
│   ├─ 让系统自动重聚合        → POST /api/review/weekly|monthly/:key/aggregate
│   ├─ 改 narrative/改进/手册  → POST /api/review/weekly|monthly/:key/plan
│   ├─ 推倒重来（含手写内容） → DELETE /api/review/weekly|monthly/:key?reaggregate=1
│   └─ 想看历史模式洞察       → GET  /api/review/weekly|monthly/:key/insights
│
├─ 写入"自由复盘日志"（一周/月可写多篇长文）
│   ├─ 新建一篇                → POST /api/review/journal
│   ├─ 增量补内容              → PATCH /api/review/journal/:id
│   ├─ 完整替换                → PUT /api/review/journal/:id
│   └─ 删错一篇                → DELETE /api/review/journal/:id
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
| **DELETE** | **`/api/review/weekly/:week`** | **物理删除该周聚合复盘（含手写内容）；带 `?reaggregate=1` 立即重聚合** |
| GET  | `/api/review/monthly?period=YYYY-MM` | 同上，月粒度 |
| POST | `/api/review/monthly/:month/aggregate` | 手动重新聚合月 |
| POST | `/api/review/monthly/:month/plan`    | 写入/更新月度（含 monthly_thesis）|
| GET  | `/api/review/monthly/:month/insights`| 月度历史洞察 |
| GET  | `/api/review/monthly/:month/children`| 该月各周明细 |
| **DELETE** | **`/api/review/monthly/:month`** | **物理删除该月聚合复盘** |
| GET  | `/api/review/period/timeline?type=week\|month&start=&end=` | 区间内全部周/月聚合（缺失自动聚合）|

**「清空重推」语义（DELETE 接口）：**
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

**三种"重置"操作的差异：**

| 操作 | 接口 | 影响 |
|---|---|---|
| 重新聚合 | `POST /aggregate` | **保留**用户写入字段，仅重算统计 |
| 编辑覆盖 | `POST /plan` | 仅更新指定字段，其他保留 |
| 清空重推 | `DELETE` | **完全清掉**包含手写内容，回到纯自动 |

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

### 复盘日志接口（Review Journal — 完全独立，不依赖 daily 数据）

> 适合作为 **agent 总结报告 / 周记 / 月记**。可写完全独立于交易操作的复盘内容，
> 单一 周/月/自定义 区间下可写多篇日志，支持 markdown 正文 + 自由小节 + 任意 metadata。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST   | `/api/review/journal` | 创建一篇日志 |
| GET    | `/api/review/journals?scope=week&period_key=2026-W17` | 某周/月/自定义下所有日志 |
| GET    | `/api/review/journals?tag=&status=&source=&search=&limit=&offset=` | 全局列表（带过滤分页）|
| GET    | `/api/review/journal/:id` | 单篇详情 |
| PATCH  | `/api/review/journal/:id` | 局部更新（agent 增量写入推荐）|
| PUT    | `/api/review/journal/:id` | 完整替换 |
| DELETE | `/api/review/journal/:id` | 删除 |

**字段定义：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | `'week' \| 'month' \| 'custom'` | ✅ | 归属粒度 |
| `period_key` | `string` | ✅ | 周: `YYYY-Www`；月: `YYYY-MM`；自定义: 任意标识 |
| `title` | `string` | ✅ | 日志标题 |
| `start_date` / `end_date` | `string` | 否 | 显式起止日期（custom 推荐填）|
| `summary` | `string` | 否 | 一段话摘要 |
| `body` | `string` | 否 | 长正文，支持 markdown |
| `sections` | `Array<{title, content, kind?}>` | 否 | 自由小节，agent 可任意扩展 |
| `market_observation` / `strategy_review` | `string` | 否 | 结构化字段 |
| `key_takeaways` / `mistakes` / `improvements` / `playbook_updates` / `next_actions` | `string[]` | 否 | 与 PeriodReview 平行字段（独立存储）|
| `tags` | `string[]` | 否 | 标签 |
| `source` | `string` | 否 | `'self' \| 'agent:xxx' \| 'manual'`，默认 `'manual'` |
| `status` | `'draft' \| 'final'` | 否 | 默认 `'draft'` |
| `metadata` | `Record<string, unknown>` | 否 | agent 可塞任意键值（model、tokens、引用等）|

**示例：agent 写入一篇周报**
```bash
curl -X POST {BASE_URL}/api/review/journal \
  -H 'Content-Type: application/json' \
  -d '{
    "scope": "week",
    "period_key": "2026-W17",
    "title": "本周市场观察 - 高位股开始分化",
    "summary": "AI 算力主线仍强，但部分高位股出现明显分歧，需警惕风格切换",
    "body": "## 总览\n本周虽无操作，但市场结构变化明显...",
    "sections": [
      {"title":"宏观面","kind":"analysis","content":"央行流动性净投放 3000 亿"},
      {"title":"板块观察","kind":"analysis","content":"AI 算力分化为算力链/应用链/数据要素"},
      {"title":"下周交易思路","kind":"plan","content":"1. 主线低位补涨\n2. 避免追高"}
    ],
    "key_takeaways": ["保持空仓的耐心是对的"],
    "improvements": ["建立每周观察清单"],
    "next_actions": ["周一开盘观察主线表现"],
    "tags": ["周记", "市场观察", "agent生成"],
    "source": "agent:advisor",
    "status": "final",
    "metadata": {"model":"claude-opus-4.7","input_tokens":12500}
  }'
```

**示例：agent 增量更新（先创建草稿，分多次补内容）**
```bash
# 第一次：先建草稿
JID=$(curl -sX POST {BASE_URL}/api/review/journal \
  -d '{"scope":"month","period_key":"2026-04","title":"4月月报","status":"draft","source":"agent:advisor"}' \
  | jq -r '.journal.id')

# 第二次：补充正文 + sections
curl -X PATCH {BASE_URL}/api/review/journal/$JID \
  -d '{"body":"...","sections":[{"title":"数据复盘","content":"..."}]}'

# 第三次：定稿
curl -X PATCH {BASE_URL}/api/review/journal/$JID \
  -d '{"status":"final","next_actions":["建立条件单自动止损系统"]}'
```

**与 PeriodReview 的关系**

| 维度 | PeriodReview | ReviewJournal |
|------|--------------|---------------|
| 存储 | `weekly_reviews` / `monthly_reviews` | `review_journals` |
| 数量 | 一个周期一份 | 一个周期可多篇 |
| 数据来源 | 自动聚合自 daily_reviews / trade_operations | 完全独立写入 |
| 适合谁 | 系统统计 + 用户/agent 覆盖几个文字字段 | agent 自由总结报告 / 长文 / markdown |
| 重新聚合 | 会重算统计（保留用户写入的文字字段） | 不存在"聚合"概念，纯用户/agent 写 |

> 前端在周/月详情面板的「📒 复盘日志」区块统一展示该期所有 journal，可点击 `+ 新建日志` 手写、点击单条查看/编辑/删除。

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

## 8. 典型 Agent 工作流（简化版 — 完整 SOP 见后文「🎯 复盘 Agent 工作流 SOP」章节）

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

### 典型流程（简化示例 — 完整周/月复盘 SOP 见后文「🎯 复盘 Agent 工作流 SOP」章节）

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

---

# 🎯 复盘 Agent 工作流 SOP（核心章节）

> 上面的"接口速查"和"字段定义"是手册；这一节是**操作指南**。
> Agent 在执行复盘任务时，**优先遵循这里的 SOP**，再去查具体接口。

## SOP-A：盘后日复盘（每日收盘后）

**目标**：把当日的客观市场和主观操作完整复盘归档，为周复盘奠基。

```
1. 获取数据
   ├─ GET /api/baseline/snapshot?date=$today    （客观市场）
   └─ GET /api/review/operations?date=$today    （主观操作）

2. 补齐缺失的市场数据（如果 snapshot 不完整）
   POST /api/baseline/input  data_type=market_snapshot  payload.emotion_score / events / limit_up
   POST /api/baseline/input  data_type=stage_signal     payload.preferred_styles / avoid_styles

3. 对每笔操作生成评估（核心）
   for op in operations:
     分析维度：
       a) 与 baseline 契合度：op.linked_baseline_stage 是否合理？
       b) 依据质量：rationale_type ∈ {impulsive, emotion} → 扣分
       c) 情绪健康度：emotion_state ∈ {fomo, panic, revenge} → 警示
       d) 结果：若有 price → 看涨跌验证
     输出 evaluation：
       POST /api/review/operation/$op.id/eval
       { evaluator:"agent:你的名字", score, verdict, alignment_score,
         pros:[...], cons:[...], suggestions:[...] }

4. 写入当日复盘计划
   POST /api/review/daily/$today/plan
   { next_actions:[...], key_takeaways:[...], mistakes:[...], mood_summary }

5. 自检（必做）
   - 是否每笔操作都有 evaluation？
   - mood_summary 是否提到主导情绪和主导依据？
   - next_actions 是否具体到"做什么"，而非"要小心"这种空话？
```

## SOP-B：周复盘（周末或周一早盘前）

**目标**：跳出单日得失，识别本周的行为模式，输出可执行的周度规则。

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

## SOP-C：月复盘（每月初 1-3 日）

**目标**：识别月度主题，沉淀 1-2 条核心 playbook，规划下月策略。

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

## SOP-D：纠错与重置（遇到 agent 误判或想推倒重来）

| 场景 | 推荐操作 |
|---|---|
| 某笔操作记录写错 | `DELETE /api/review/operation/:id` (会级联清评估) |
| 某条 baseline 误判 | `POST /api/baseline/override` (高优先级覆盖，原数据保留) |
| 某日 baseline 完全推倒 | `POST /api/baseline/reset/:date` (物理删除当日所有 inputs) |
| 周/月聚合写错（含手写）| `DELETE /api/review/weekly|monthly/:key?reaggregate=1` (清空并重聚合) |
| 单篇日志写错 | `DELETE /api/review/journal/:id` |
| 仅想刷新统计、保留手写 | `POST /api/review/weekly|monthly/:key/aggregate` (这是默认行为) |
| Agent 增量补充日志内容 | `PATCH /api/review/journal/:id` (推荐！比 PUT 安全) |

---

# 📐 复盘内容质量准则（agent 必读）

写入文字字段时，**永远遵循这张表**。差的复盘和好的复盘的差距，几乎全在表达精度上。

## key_takeaways（关键收获）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "今天表现不错" | "REPAIR_CONFIRM 阶段加仓主线核心标的的策略奏效，单笔 +5.2%" |
| "保持纪律性" | "在 emotion=82 时主动选择减仓 50%，避免了后续 -3% 的回撤" |
| "心态稳定" | "盘中出现板块异动时，按 baseline 信号继续持有未追涨，结果验证了主升趋势" |

**判断标准**：含**具体场景**（阶段/价位/事件）+ **具体行为** + **可量化结果或可复用规则**。

## mistakes（主要错误）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "亏钱了" | "HIGH_RISK 阶段 (emotion=82) 仍开仓追高 300750，违反 baseline 减仓信号，单笔 -7%" |
| "不该追高" | "4/9 在 FOMO 状态下加仓宁德，进场点比 4/7 高 4.2%，是上头加仓" |
| "情绪化" | "连续两笔失败后产生 revenge 情绪，立刻在 4/14 复仇式开仓，再亏 -5%" |

**判断标准**：含**触发场景** + **违反了什么规则** + **结果或代价**。每条 mistake 都应该能直接转成一条 improvement。

## improvements（改进点）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "要更冷静" | "FOMO 状态触发时强制冷静 30 分钟，期间禁止下单" |
| "控制仓位" | "HIGH_RISK 阶段（emotion>78）开盘前若仓位>50%，强制减至 50% 以下" |
| "不追高" | "单笔进场点位若高于近 5 日均价 3% 以上，必须回滚等待" |

**判断标准**：**触发条件 + 阈值 + 强制动作** 三件套。能写成 if-then 规则的才算。

## playbook_updates（操作手册更新）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "纪律性" | "新规则: baseline 契合度连续 3 天 <50% 自动暂停交易 1 天" |
| "学会止盈" | "新规则: 单笔浮盈 >10% 时自动挂单减仓 50%，剩余仓位移止损至成本价" |

**判断标准**：是**长期规则**而非**本周特定动作**；通常以"新规则:"或"调整规则:"开头。

## next_actions（下期行动）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "继续观察" | "周一开盘观察主线 5 分钟成交量，若<10亿则继续空仓" |
| "保持耐心" | "本周内若出现 2 个交易日 alignment <50%，触发周中冷静日，停止新开仓" |

**判断标准**：含**时间节点** + **观察对象** + **触发条件**。

## monthly_thesis（月度主题，仅月）

| ❌ 反例 | ✅ 正例 |
|---|---|
| "市场震荡" | "高位风险阶段贯穿整月，重点防御，防止主升幻觉" |
| "关注政策" | "主升 → 高位过渡月，前期吃肉后期防守，教训在月中切换太晚" |

**判断标准**：一句话能让任何人秒懂这个月发生了什么 + 你的应对态度。

---

# 📚 端到端示例：一次完整的周复盘 Agent

> 模拟"周复盘 agent"在周日晚执行的完整流程。BASE_URL=http://localhost:50001

```bash
WEEK="2026-W17"
AGENT="agent:weekly-reviewer"

# === Step 1: 拉取本周聚合数据 ===
REVIEW=$(curl -s "$BASE_URL/api/review/weekly?period=$WEEK")
INSIGHTS=$(curl -s "$BASE_URL/api/review/weekly/$WEEK/insights?lookback=4")
CHILDREN=$(curl -s "$BASE_URL/api/review/weekly/$WEEK/children")

# 关键字段：
#   REVIEW.avg_score / .baseline_alignment / .emotion_distribution
#   INSIGHTS.recurring_mistakes / .alignment_trend / .recommended_next_actions
#   CHILDREN[*].avg_score 看每天波动

# === Step 2: 模型推理（伪代码）===
# - 分析本周与历史 4 周的对比
# - 提取本周的核心叙事
# - 把 INSIGHTS.recurring_mistakes 转化为 1-2 条 playbook_updates

# === Step 3: 写入周复盘文字 ===
curl -X POST "$BASE_URL/api/review/weekly/$WEEK/plan" -H 'Content-Type: application/json' -d '{
  "narrative": "本周虽无操作，但市场结构明显从主升切向高位风险，空仓策略验证有效",
  "key_takeaways": [
    "在 HIGH_RISK 信号出现的第一时间清仓避险，避免了后续 -3% 的回撤",
    "通过监控炸板率从 12% 升至 38% 提前识别风格切换"
  ],
  "mistakes": [
    "本周前两天对主升尾段的恋战导致空仓时间过晚 1 天"
  ],
  "improvements": [
    "建立每周观察清单：炸板率、涨停板高度、领涨股换手率",
    "HIGH_RISK 阶段强制空仓 1 个交易日观察，禁止任何开仓"
  ],
  "playbook_updates": [
    "新规则：连续 3 天炸板率 >30% 自动触发空仓评估"
  ],
  "next_actions": [
    "周一开盘观察主线 5 分钟量能，<10 亿则继续观望",
    "若高位股普跌则切换为低位补涨标的扫描模式"
  ]
}'

# === Step 4: 写一篇详细周记（长文 + 元数据，便于追溯）===
curl -X POST "$BASE_URL/api/review/journal" -H 'Content-Type: application/json' -d "{
  \"scope\": \"week\",
  \"period_key\": \"$WEEK\",
  \"title\": \"W17 周记 - 主升尾段到高位过渡的识别\",
  \"summary\": \"本周市场结构明显从主升切向高位风险，提前识别风格切换避免回撤\",
  \"body\": \"## 总览\n本周市场结构变化明显，炸板率从周一 12% 上升到周五 38%。\n\n## 关键观察\n- AI 算力主线虽强但内部分化\n- 高位股开始显著分歧\n\n## 反思\n仍有 1 天的恋战，需在 HIGH_RISK 信号当日就行动。\",
  \"sections\": [
    {\"title\": \"宏观面\", \"kind\": \"analysis\", \"content\": \"央行流动性净投放 3000 亿\"},
    {\"title\": \"板块观察\", \"kind\": \"analysis\", \"content\": \"AI 分化为算力链/应用链/数据要素\"},
    {\"title\": \"下周交易思路\", \"kind\": \"plan\", \"content\": \"主线低位补涨 + 严格执行 HIGH_RISK 规则\"}
  ],
  \"key_takeaways\": [\"提前识别高位分歧避免回撤\"],
  \"improvements\": [\"建立每周观察清单\"],
  \"playbook_updates\": [\"新规则：连续 3 天炸板率 >30% 自动触发空仓评估\"],
  \"next_actions\": [\"周一开盘观察主线 5 分钟量能\"],
  \"tags\": [\"周记\", \"市场观察\", \"agent生成\"],
  \"source\": \"$AGENT\",
  \"status\": \"final\",
  \"metadata\": {\"model\": \"claude-opus-4.7\", \"input_tokens\": 12500, \"based_on_insights\": true}
}"

# === Step 5: 自检（必做）===
# 重新拉一次确认
curl -s "$BASE_URL/api/review/weekly?period=$WEEK" | jq '.improvements, .playbook_updates, .next_actions'
curl -s "$BASE_URL/api/review/journals?scope=week&period_key=$WEEK" | jq '.items[] | {title, status, source}'
```

**这个 agent 完成了什么**：
1. ✅ 拉取了客观聚合 + 历史洞察 + 子明细三方面数据
2. ✅ 把历史 recurring_mistakes 转成了 playbook
3. ✅ 写了具体的 improvements（含触发条件 + 动作）
4. ✅ 写了一篇带 metadata 的可追溯日志
5. ✅ 自检确认所有写入生效

---

# 🤖 Agent 多角色协作建议

不同的 agent 应当承担不同的复盘职责，**通过 source 字段区分**：

| Agent 角色 | source | 主要职责 | 触发时机 |
|---|---|---|---|
| `news_agent` | agent:news | 写入 baseline event/future_event | 实时新闻发生 |
| `quant_agent` | agent:quant | 写入 market_snapshot/emotion_metric | 收盘后 |
| `strategy_agent` | agent:strategy | 写入 stage_signal/position_suggestion | 开盘前 |
| `daily_reviewer` | agent:daily | 给操作打分 + 写 daily plan | 收盘后 |
| `weekly_reviewer` | agent:weekly | 周聚合 + 周记 | 周日晚 |
| `monthly_reviewer` | agent:monthly | 月聚合 + 月报 | 月初 1-3 日 |
| `orchestrator` | agent:orchestrator | 检查数据完整度 / override 修正 | 每日固定时间 |

**协作示例**：
- `news_agent` 全天监听新闻 → 写入 future_event
- 收盘后 `quant_agent` 写入快照 → `strategy_agent` 写入阶段信号
- `daily_reviewer` 拉取所有 op + snapshot → 给操作打分 → 写 daily plan
- 每周日晚 `weekly_reviewer` 触发周聚合 → 写 plan + journal
- `orchestrator` 在每个环节后检查完整度，必要时 override

---

# ✅ 最终自检清单（每次复盘任务结束前对照）

- [ ] 所有写入都带了 `source: "agent:..."` 标识
- [ ] 写入失败时是否检查了 HTTP 状态码 / response.error
- [ ] 文字字段是否符合"质量准则"（含具体场景 + 触发条件 + 量化）
- [ ] 没有产生空话/口号式内容
- [ ] 是否处理了 insights 中的 recurring_mistakes（至少 1 条）
- [ ] 是否避免了重复写入（用 GET 先确认 / 用 PATCH 而非新建）
- [ ] 长文 journal 是否有 status=final（草稿请用 draft）
- [ ] 涉及金额/价格的数字是否准确（不要捏造）
- [ ] 远程调用是否带 `--noproxy '*'`（在沙箱内部）

---

# 📦 附：常用 agent 代码片段

```python
import requests, datetime
BASE_URL = "http://localhost:50001"

def post(path, body):
    r = requests.post(f"{BASE_URL}{path}", json=body, timeout=10)
    r.raise_for_status()
    return r.json()

def get(path, **params):
    r = requests.get(f"{BASE_URL}{path}", params=params, timeout=10)
    r.raise_for_status()
    return r.json()

# === 一键周复盘 ===
def weekly_review(week_key, agent_name="agent:weekly"):
    post(f"/api/review/weekly/{week_key}/aggregate", {})
    review   = get(f"/api/review/weekly", period=week_key)
    insights = get(f"/api/review/weekly/{week_key}/insights")
    children = get(f"/api/review/weekly/{week_key}/children")
    # ... LLM 推理 ...
    plan = build_plan(review, insights, children)   # 你的推理函数
    post(f"/api/review/weekly/{week_key}/plan", plan)
    post(f"/api/review/journal", build_journal(plan, agent_name))

# === 一键日复盘 ===
def daily_review(date, agent_name="agent:daily"):
    snap = get(f"/api/baseline/snapshot", date=date)
    ops  = get(f"/api/review/operations", date=date)
    for op in ops:
        ev = evaluate_operation(op, snap)
        ev["evaluator"] = agent_name
        post(f"/api/review/operation/{op['id']}/eval", ev)
    plan = build_daily_plan(ops, snap)
    post(f"/api/review/daily/{date}/plan", plan)
```
