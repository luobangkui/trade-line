# 交易权限卡接口手册（Trading Permission Card）

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套 SOP：[sop-permission.md](./sop-permission.md)

权限卡是**事前刹车机制** — 每个交易日一张卡，定义当日的状态、最大仓位、允许模式、禁止动作。
后端只做存储 + CRUD，**所有判定逻辑在 agent 这边做**（agent 拉历史数据 → 推理 → POST 写卡）。

> **写卡时的 `date` 字段约定**：写「下一交易日」的卡。例：周一 16:00 写卡 → date=周二。
> 前端徽章会按"盘前显示今日 / 盘后显示下一交易日"自动切换语义。

## 接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST   | `/api/permission`               | upsert（按 date 唯一；locked 时拒写，可加 `?force=1` 强制）|
| GET    | `/api/permission/today`         | 快捷：今日卡（不存在 → 404）|
| GET    | `/api/permission/:date`         | 单日查询 |
| GET    | `/api/permission?start=&end=`   | 区间查询 |
| GET    | `/api/permission/all`           | 全部（无过滤）|
| DELETE | `/api/permission/:date`         | 删除（locked 也允许删，方便"清空重生成"）|
| POST   | `/api/permission/:date/lock`    | 切换锁定 `{ "locked": true\|false }` |

---

## 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `date` | `string` | ✅ | YYYY-MM-DD（主键，每日唯一）|
| `status` | `'protect' \| 'normal' \| 'attack'` | ✅ | 三档：保护 / 正常 / 进攻 |
| `max_total_position` | `number` | ✅ | 最大总仓位 0-1（小数）|
| `allow_margin` | `boolean` | 否 | 是否允许融资，默认 false |
| `allowed_modes` | `string[]` | 否 | 允许的交易模式（如 "A类启动确认", "处理失败仓"）|
| `forbidden_actions` | `string[]` | 否 | 禁止动作（如 "补仓", "倒T", "追涨"）|
| `stop_triggers` | `string[]` | 否 | 触发停手条件（如 "卖出后想马上买入"）|
| `rationale` | `string` | 否 | 一句话总结今天为什么是这个状态 |
| `generated_from` | `object` | 否 | 决策依据（agent 自填用于追溯）|
| `source` | `string` | 否 | `'agent:permission'` / `'manual'` / `'self'`，默认 `'manual'` |
| `locked` | `boolean` | 否 | 锁定后 POST 不覆盖（除非 force=1）|

### `generated_from` 推荐结构

```json
{
  "baseline_stage": "HIGH_RISK",
  "avg_score_3d": 48,
  "recent_mistakes": ["卖出后10分钟新买", "外部信息直接下单"],
  "based_on_dates": ["2026-04-24", "2026-04-25", "2026-04-28"],
  "triggered_rules": ["score_low_3d", "sell_then_buy", "external_info"],
  "reasoning": "score 三档下挫至保护档，叠加近 3 日卖出再买行为模式",
  "extras": {}
}
```

> Agent 应**始终填写 generated_from**，便于事后审查"为什么当天是保护档"。

---

## 写入示例（agent 主用）

```bash
curl -X POST $BASE_URL/api/permission \
  -H 'Content-Type: application/json' \
  -d '{
    "date": "2026-04-29",
    "status": "protect",
    "max_total_position": 0.5,
    "allow_margin": false,
    "allowed_modes": ["处理失败仓", "观察众生/青啤"],
    "forbidden_actions": ["补仓", "倒T", "追涨", "新开后排"],
    "stop_triggers": ["卖出后想马上买入", "当日做了3种模式"],
    "rationale": "近3日 avg_score=48<55 进入保护，HIGH_RISK 阶段叠加外部信息直接下单 mistake",
    "generated_from": {
      "baseline_stage": "HIGH_RISK",
      "avg_score_3d": 48,
      "recent_mistakes": ["卖出后10分钟新买", "外部信息直接下单"],
      "based_on_dates": ["2026-04-24", "2026-04-25", "2026-04-28"],
      "triggered_rules": ["score_low_3d", "sell_then_buy", "external_info"],
      "reasoning": "score 三档下挫；近 3 日卖出后 10 分钟内 2 次新买"
    },
    "source": "agent:permission"
  }'
```

返回：

```json
{
  "success": true,
  "card": { ...完整卡片... }
}
```

## 锁定 / 解锁

```bash
# 锁定（防止 agent 误覆盖手动写好的卡）
curl -X POST $BASE_URL/api/permission/2026-04-29/lock -d '{"locked":true}'

# 解锁
curl -X POST $BASE_URL/api/permission/2026-04-29/lock -d '{"locked":false}'
```

锁定后再 POST 同一日 → 返回 409：

```json
{
  "error": "该日卡片已锁定（locked=true），写入被拒绝。可调用 POST /api/permission/:date/unlock 后再写，或 POST /api/permission?force=1 强制覆盖。",
  "card": { ...原卡片... }
}
```

强制覆盖：

```bash
curl -X POST '$BASE_URL/api/permission?force=1' -d '{...}'
```

## 删除

```bash
curl -X DELETE $BASE_URL/api/permission/2026-04-29
# → { "success": true, "date": "2026-04-29" }
```

`locked=true` 也可删，便于"清空重生成"流程。

## 查询

```bash
# 单日
curl $BASE_URL/api/permission/2026-04-29

# 今日（如不存在 → 404）
curl $BASE_URL/api/permission/today

# 区间
curl '$BASE_URL/api/permission?start=2026-04-01&end=2026-04-30'

# 全部
curl $BASE_URL/api/permission/all
```

---

## 三档状态参考

| 状态 | 触发条件（建议）| max_total_position 参考 |
|---|---|---|
| `protect`（保护）| 近 3 日 avg_score < 55 / 出现严重 mistake / HIGH_RISK 阶段 | 0.2 - 0.5 |
| `normal`（正常）| avg_score 55-70 | 0.5 - 0.7 |
| `attack`（进攻）| avg_score ≥ 70 + baseline 处于 MAIN_UP 等顺风阶段 | 0.7 - 0.9 |

> 上面只是参考，实际 agent 可以叠加自己的规则（详见 [sop-permission.md](./sop-permission.md)）。

---

## 与现有数据的关系

权限卡**不修改任何其他数据**，与以下数据是**只读引用关系**：

| 引用源 | 用途 |
|---|---|
| `baseline_snapshot.market_stage` | 决定基础约束（HIGH_RISK 自动降档）|
| `daily_reviews.avg_score / mistakes` | 决定 score 三档 + 高频错误 |
| `weekly_reviews.recurring_mistakes` | 周级别反复错误 → 升级为禁止动作 |
| `trade_operations`（最近 N 日）| 检测"卖出后 10 分钟买入"等行为模式 |

> Agent 通过普通 GET 接口拉这些数据 → 综合推理 → POST 一条权限卡即可。
> 完整工作流见 [sop-permission.md](./sop-permission.md)。
