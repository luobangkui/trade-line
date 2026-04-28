# SOP-E：明日权限卡生成

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套接口手册：[api-permission.md](./api-permission.md) ｜ 关联 SOP：[sop-daily.md](./sop-daily.md) · [sop-weekly.md](./sop-weekly.md)

**目标**：把复盘从"事后总结"变成"事前刹车"。

每天收盘后或开盘前，agent 综合 **baseline + 近 3 日复盘 + 近 5 日操作行为**，
推理出明日的 `状态 / 最大仓位 / 允许模式 / 禁止动作 / 触发停手条件`，写入一张卡。

> **核心思想**：错误不是记下来，而是**自动扣权限**。把行为模式映射成明日的禁止动作。

---

## 标准流程（5 步）

```
1. 拉数据（只读）
   ├─ GET /api/baseline/snapshot?date=$today                             ← 客观大盘
   ├─ GET /api/review/daily?date=$d  for d in last 3 trading days        ← 近 3 日 daily_review
   ├─ GET /api/review/operations?start=$d_minus_5&end=$today             ← 近 5 日操作明细
   ├─ GET /api/review/weekly/$current_week/insights                      ← 历史模式洞察（可选）
   └─ GET /api/permission/$today                                          ← 看今日有没有锁定的卡

2. 提取关键指标
   - baseline_stage = snapshot.market_stage
   - avg_score_3d   = mean([dr.avg_score for dr in last_3])
   - recent_mistakes= unique(flatten([dr.mistakes for dr in last_3]))
   - 行为模式检测   = 见下文「行为模式检测清单」

3. 推理三档状态（基础档 → 叠加约束）
   见下文「状态判定矩阵」

4. 写入权限卡
   POST /api/permission
   {
     date, status, max_total_position,
     allow_margin, allowed_modes, forbidden_actions, stop_triggers,
     rationale: "一句话说明今天为何这个档",
     generated_from: { baseline_stage, avg_score_3d, recent_mistakes,
                       based_on_dates, triggered_rules, reasoning },
     source: "agent:permission"
   }

5. 自检
   - rationale 是否一句话能解释清楚？
   - generated_from.triggered_rules 是否非空（agent 必须有规则依据）？
   - forbidden_actions 是否真的对应 recent_mistakes 中的至少一条？
   - 这张卡发给用户看，他能不能 30 秒内决定明天怎么做？
```

---

## 状态判定矩阵（基础档）

| 近 3 日 avg_score | baseline_stage | 默认状态 | 默认 max_pos |
|---:|---|---|---:|
| ≥ 70 | MAIN_UP / REPAIR_CONFIRM | `attack` | 0.85 |
| ≥ 70 | HIGH_RISK / DISTRIBUTION | `normal` | 0.5 |
| 55-70 | MAIN_UP / REPAIR_CONFIRM | `normal` | 0.7 |
| 55-70 | HIGH_RISK / DISTRIBUTION | `normal` | 0.5 |
| < 55 | 任意 | `protect` | 0.3 |
| 任意 | CHAOS | `protect` | 0.1 |

**叠加约束（按出现顺序累加，越严越优先）**：

- 周级别 `recurring_mistakes` ≥ 3 条 → 强制 `protect`
- baseline_stage = HIGH_RISK → max_pos 上限 0.5；强制加入禁止动作 `["追高", "新开后排"]`
- 出现"未验证连续买第二笔" → 强制 `protect` 5 个交易日

---

## 行为模式检测清单

> Agent 应在拉到 `recent_ops` 后，用以下规则匹配。**每命中一条，加对应处罚**。

| 规则 ID | 检测逻辑 | 处罚（写入卡片）|
|---|---|---|
| `sell_then_buy` | 同一天有 `sell` 后 ≤ 10 分钟内的 `buy`，近 2 日 ≥ 2 次 | `forbidden_actions += ["10:30 前不新开仓"]`，`max_pos *= 0.5` |
| `loss_t0` | 检测到亏损票上做 `add` + 同日 `reduce`（倒T） | `forbidden_actions += ["亏损票倒T"]`，`max_pos *= 0.7`，2 日内有效 |
| `external_info` | mistakes 含关键词「外部信息/群消息/跟风/听消息」 | `forbidden_actions += ["跟风下单"]`，`max_pos *= 0.6`，3 日有效 |
| `second_buy_unvalidated` | 同标的连续 2 笔 buy 间未出现"已验证"（如 evaluation.alignment ≥ 60 或评估 verdict ≥ good） | `forbidden_actions += ["同类二次买入"]`，5 日有效 |
| `multi_mode_day` | 当日做了 ≥ 3 种 direction（如同时 buy + sell + add） | `next_day.allowed_modes = ["仅卖出"]` |
| `margin_high_risk` | 近 5 日有融资买入非主升票 | `allow_margin = false`，20 日有效 |
| `score_low_3d` | avg_score_3d < 55 | `force_status = protect`，`max_pos = 0.3` |
| `mistake_same_3d` | 同一句 mistake 在 ≥ 2 日 mistakes 中复现 | 把它原文加到 `forbidden_actions` |

> 这些是**默认规则集**。Agent 可以按用户的实际错误演进规则，写到 `generated_from.triggered_rules` 里以便追溯。

---

## rationale 写作准则

写得好的 rationale 让用户**30 秒看懂今天为什么是这个档**。

| ❌ 反例 | ✅ 正例 |
|---|---|
| "今日保护模式" | "近 3 日 avg_score=48<55 进入保护；HIGH_RISK 阶段叠加'外部信息直接下单' mistake，禁止补仓追涨" |
| "正常档" | "avg_score=68 处于正常区，但 baseline 切到 HIGH_RISK，仓位上限降至 50%，禁追高" |
| "进攻" | "近 3 日 avg_score=78 + baseline=MAIN_UP，进攻档可至 85% 仓位，仍禁止融资（上周违规过 1 次）" |

**模板**：`[score 描述] + [stage 描述] + [触发的关键规则] + [一条最重要的禁止动作]`

---

## forbidden_actions / stop_triggers 写作

**好的禁止动作 = 具体行为 + 不留模糊空间**

| ❌ 反例 | ✅ 正例 |
|---|---|
| "控制仓位" | "总仓 > 50% 时禁止开新仓" |
| "不要追高" | "单笔进场点位高于近 5 日均价 3% 以上禁止下单" |
| "心态平和" | "10 分钟内连续下单 ≥ 2 笔时强制冷静 30 分钟" |

**触发停手条件 = 心理触发 + 立即执行的动作**

例：
- `卖出后想马上买入 → 等到 10:30 后再决定`
- `当日已有 2 笔亏损 → 当日剩余时间禁止开仓`
- `连续 3 个交易日 alignment < 50% → 第 4 日强制空仓观察`

---

## Python 一键生成示例

```python
from datetime import date, timedelta
import requests

BASE_URL = "http://vzil1451410.bohrium.tech:50001"

def get(path, **params):
    r = requests.get(f"{BASE_URL}{path}", params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def post(path, body, params=None):
    r = requests.post(f"{BASE_URL}{path}", json=body, params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def last_n_trading_days(today_str, n):
    # 简化：跳过周末
    d, out = date.fromisoformat(today_str), []
    while len(out) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5: out.append(d.isoformat())
    return list(reversed(out))

def generate_permission_card(target_date, today=None):
    today = today or date.today().isoformat()
    snap = get(f"/api/baseline/snapshot", date=today)
    last3 = last_n_trading_days(today, 3)
    daily_reviews = [get(f"/api/review/daily", date=d).get("review") for d in last3]
    daily_reviews = [d for d in daily_reviews if d]
    ops = get(f"/api/review/operations",
              start=last_n_trading_days(today, 5)[0], end=today).get("operations", [])

    # ── 推理 ──
    avg_score_3d = sum(d["avg_score"] for d in daily_reviews) / max(len(daily_reviews), 1)
    recent_mistakes = list({m for d in daily_reviews for m in (d.get("mistakes") or [])})
    stage = snap.get("market_stage")

    # 基础档
    if avg_score_3d >= 70:    status, max_pos = "attack", 0.85
    elif avg_score_3d >= 55:  status, max_pos = "normal", 0.7
    else:                     status, max_pos = "protect", 0.3

    # 叠加约束
    triggered, forbidden, stops = [], [], []
    if stage == "HIGH_RISK":
        max_pos = min(max_pos, 0.5)
        forbidden += ["追高", "新开后排"]
        triggered.append("baseline_high_risk")

    # 行为模式（示例：卖出后 10 分钟买入）
    if detect_sell_then_buy(ops):
        forbidden.append("10:30 前不新开仓")
        max_pos *= 0.5
        triggered.append("sell_then_buy")

    # mistake 关键词 → 禁止动作
    if any("外部信息" in m or "跟风" in m for m in recent_mistakes):
        forbidden.append("跟风下单")
        triggered.append("external_info")

    rationale = f"近3日 avg_score={avg_score_3d:.0f}，baseline={stage}，触发{len(triggered)}条规则"

    return post("/api/permission", {
        "date": target_date,
        "status": status,
        "max_total_position": round(max_pos, 2),
        "allow_margin": False,
        "allowed_modes": ["A类启动确认", "处理失败仓"] if status != "protect" else ["处理失败仓", "观察"],
        "forbidden_actions": list(set(forbidden)),
        "stop_triggers": ["卖出后想马上买入", "当日已有2笔亏损"],
        "rationale": rationale,
        "generated_from": {
            "baseline_stage": stage,
            "avg_score_3d": round(avg_score_3d, 1),
            "recent_mistakes": recent_mistakes,
            "based_on_dates": last3,
            "triggered_rules": triggered,
            "reasoning": "根据 score 三档 + stage 约束 + 行为模式检测"
        },
        "source": "agent:permission"
    })
```

---

## 端到端实战（一句话流程）

```
Agent 在每个交易日 16:00（收盘后）执行：
  1. 拉 baseline_snapshot(today) + 近 3 日 daily_review + 近 5 日 operations
  2. 按状态判定矩阵 + 行为模式检测 → 推理出明日卡
  3. POST /api/permission 写入
  4. （可选）若用户在前端「🔒 锁定」过当日卡，用 GET /api/permission/today 检查是否被锁
  5. （可选）打印 rationale 到日志，便于人工 review
```

> 第二天用户开盘前先看顶栏徽章：`🛑 明日权限 保护 仓50% 禁:补仓/倒T 🔒`，
> 一眼掌握今日"权限"，决定能不能下手。
