# 交易行为系统接口手册（持仓计划 + 预审 + 违规检测）

> 入口：[../SKILL.md](../SKILL.md) ｜ 关联：[sop-pretrade.md](./sop-pretrade.md) · [sop-permission.md](./sop-permission.md)

这些接口是 **手动交易约束层**，不接券商 API，不自动下单。

## 1. 持仓计划卡 `/api/position-plan`

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

## 2. 盘中预审记录 `/api/pretrade`

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

## 3. 违规/风险信号检测 `/api/violations`

只读检测，不自动改权限卡。`critical` 是硬纪律违规；`warning` / `info` 是需要复盘解释的风险信号，不应直接定罪。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/violations?date=YYYY-MM-DD` | 检测某日硬违规与风险信号 |

当前规则：

- `missing_permission_card`：无权限卡仍买入（critical）
- `protect_day_new_buy`：protect 且禁新开时买入（critical）
- `morning_new_buy`：权限卡明确禁止早盘/10:30 前买入，仍发生买入（critical）
- `morning_buy_risk_signal`：权限卡只提到早盘/10:30 条件，但不是明确禁令（warning）
- `sell_then_buy_10m`：跨标的卖出后 10 分钟内买入（critical）
- `same_symbol_sell_then_buy_10m`：同票卖出后 10 分钟内买回，需区分纠错/倒T（warning）
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

盘中闭环顺序：

1. 用户发预审卡。
2. Agent 按 `sop-pretrade.md` 检查。
3. 写 `/api/pretrade`。
4. 用户只能按 `verdict` 执行。
