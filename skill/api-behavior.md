# 交易行为系统接口手册（持仓计划 + 预审 + 违规检测）

> 入口：[../SKILL.md](../SKILL.md) ｜ 关联：[sop-pretrade.md](./sop-pretrade.md) · [sop-permission.md](./sop-permission.md)

这些接口是 **手动交易约束层**，不接券商 API，不自动下单。

## 1. 下一交易日交易计划 `/api/next-trade-plan`

每日一张，定义明天“计划内开仓 / 观察池 / 持仓处理备注”。盘中预审会先判断交易是否在计划内。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/next-trade-plan` | upsert 某日交易计划，按 `date` 唯一 |
| GET | `/api/next-trade-plan?date=YYYY-MM-DD` | 查询某日计划 |
| GET | `/api/next-trade-plan?start=&end=` | 查询区间计划 |
| GET | `/api/next-trade-plan/all` | 查询全部计划 |
| POST | `/api/next-trade-plan/:date/lock` | 锁定/解锁 |
| DELETE | `/api/next-trade-plan/:date` | 删除计划 |

### 字段

| 字段 | 说明 |
|---|---|
| `date` | 计划适用日期，通常是下一交易日 |
| `market_view` | 对明天市场阶段和情绪的判断 |
| `max_total_position` | 明日计划总仓上限，0-1 |
| `focus_themes` | 明天重点观察主题/板块 |
| `no_trade_rules` | 明天明确禁止的行为 |
| `entries` | 预计可开仓标的；计划内不等于自动买，仍要盘中预审 |
| `watchlist` | 关注池；满足触发条件才可升级为可交易 |
| `position_notes` | 已持仓处理备注，可关联 `/api/position-plan` |
| `locked` | 锁定后默认拒绝覆盖，除非 `?force=1` |

### `entries` 字段

| 字段 | 说明 |
|---|---|
| `symbol` / `name` | 标的 |
| `mode` | 交易模式，如 `A类启动确认` / `计划内调仓` |
| `risk_action` | 可选，默认由预审推断 |
| `planned_amount` / `planned_position` | 计划金额或仓位上限 |
| `thesis` | 开仓依据 |
| `entry_triggers` | 触发条件，如价格、量能、板块强度 |
| `invalidation_condition` | 买错退出条件 |
| `priority` | 优先级 |
| `status` | `planned` / `watch` / `triggered` / `cancelled` |

### 预审口径

- 在 `entries`：获得预审资格，继续检查权限矩阵、仓位、行情和退出条件。
- 在 `watchlist`：默认 `WAIT`，除非明确满足升级条件并重新预审。
- 完全不在计划内：protect 日新开仓默认 `REJECT`；normal/attack 也至少降级为 `WAIT/ALLOW_SMALL`。

## 2. 持仓计划卡 `/api/position-plan`

每日逐票定义“明日唯一允许动作”。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/position-plan` | upsert 单只持仓计划，按 `date+symbol` 唯一 |
| POST | `/api/position-plan/batch` | 批量 upsert |
| GET | `/api/position-plan?date=YYYY-MM-DD` | 查询某日全部计划 |
| GET | `/api/position-plan?start=&end=` | 查询区间计划 |
| GET | `/api/position-plan/:date/:symbol` | 查询单只计划 |
| POST | `/api/position-plan/:date/:symbol/lock` | 锁定/解锁 |
| DELETE | `/api/position-plan/:date/:symbol` | 删除计划 |

### 字段

| 字段 | 说明 |
|---|---|
| `date` | 计划适用日期 |
| `symbol` / `name` | 标的 |
| `quantity` / `cost_price` / `last_price` | 持仓、成本、现价 |
| `category` | `hard_failed` / `conditional_failed` / `positive_feedback` / `watch` / `defensive` / `closed` |
| `allowed_action` | `sell_only` / `reduce_only` / `hold_or_reduce` / `hold_only` / `observe_only` / `no_action` |
| `invalidation_price` | 失效价 |
| `rebound_reduce_price` | 反抽减仓价 |
| `forbidden_actions` | 禁止动作 |
| `rationale` | 为什么这样分类 |

## 3. 盘中预审记录 `/api/pretrade`

用户盘中想买入前，agent 按 `sop-pretrade.md` 拉行情、查权限、给结论后，把预审记录写入这里。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/pretrade` | 写入一条预审记录 |
| GET | `/api/pretrade?date=YYYY-MM-DD` | 查询某日预审 |
| GET | `/api/pretrade?start=&end=` | 查询区间预审 |
| GET | `/api/pretrade/:id` | 查询单条 |
| DELETE | `/api/pretrade/:id` | 删除误写预审 |

### 结论

`verdict` 只能是：

- `REJECT`：禁止交易
- `WAIT`：等待条件
- `ALLOW_SMALL`：小仓允许，必须写 `max_allowed_amount`
- `ALLOW`：完整允许

缺少 `mode` 或 `exit_condition` 时，不应写 `ALLOW/ALLOW_SMALL`。

预审记录可附带结构化风控字段：

| 字段 | 说明 |
|---|---|
| `risk_action` | `new_buy` / `add_winner` / `add_loser` / `rebuy_same_symbol` / `switch_position` / `reduce` / `sell` / `hold` |
| `source_sell_symbol` / `source_sell_amount` | 调仓来源卖出标的和金额 |
| `net_position_delta` | 本次交易导致总仓净变化，0.05 表示增加 5% |
| `current_total_position` / `projected_total_position` | 交易前后总仓位 |
| `matched_risk_rules` | 命中的 `risk_matrix.rules[].id` |

## 4. 违规/风险信号检测 `/api/violations`

只读检测，不自动改权限卡。`critical` 是硬纪律违规；`warning` / `info` 是需要复盘解释的风险信号，不应直接定罪。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/violations?date=YYYY-MM-DD` | 检测某日硬违规与风险信号 |

当前规则：

- `missing_permission_card`：无权限卡仍买入（critical）
- `protect_day_new_buy`：protect 且禁新开时买入（critical）
- `morning_new_buy`：权限卡明确禁止早盘/10:30 前买入，仍发生买入（critical）
- `morning_buy_risk_signal`：权限卡只提到早盘/10:30 条件，但不是明确禁令（warning）
- `switch_position_blocked`：调仓违反风控矩阵（如 protect 日变相加仓、无权限模式）
- `switch_position_needs_review`：调仓缺少预审/资金来源/退出条件，需要复盘确认
- `same_symbol_sell_then_buy_window`：同票卖出后矩阵冷却窗口内买回，需区分纠错/倒T（warning）
- `second_buy_unvalidated`：同标的多次买入，且缺少逐笔有效预审（warning）
- `loss_position_add`：失败仓/只减不加/禁补仓条件下仍加仓，或文本明确摊低（critical）
- `add_position_risk_signal`：加仓但未命中失败仓/禁补证据，仅作复盘信号（info）
- `multi_mode_day`：单日多模式混做（info）
- `missing_pretrade_review`：买入前缺少有效预审

## 使用建议

盘后闭环顺序：

1. 写入当日成交和评估。
2. `GET /api/violations?date=$today` 检测违规。
3. 根据违规结果写次日权限卡。
4. 根据持仓截图写次日 `/api/position-plan`。
5. 写次日 `/api/next-trade-plan`，明确计划内开仓、观察池和不做事项。

盘中闭环顺序：

1. 用户发预审卡。
2. Agent 先查 `/api/next-trade-plan?date=$today`，判断计划内/观察池/计划外。
3. Agent 按 `sop-pretrade.md` 检查权限矩阵、仓位和行情。
4. 写 `/api/pretrade`。
5. 用户只能按 `verdict` 执行。
