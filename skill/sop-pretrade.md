# SOP-F：盘中买入预审

> 入口：[../SKILL.md](../SKILL.md) ｜ 关联：[sop-permission.md](./sop-permission.md) · [api-permission.md](./api-permission.md) · [api-baseline.md](./api-baseline.md)

**目标**：用户盘中想买入前，agent 必须先做外部行情核验、历史走势回顾、权限卡检查和历史错误匹配，最后只输出 `REJECT / WAIT / ALLOW_SMALL / ALLOW`。本 SOP **不负责自动下单**。

## 触发条件

用户出现以下表达时立即使用本 SOP：

- “我想买/加仓/回补/低吸/追一下”
- “这个票能买吗”
- “盘中预审一下”
- “买入前帮我 check”
- “我准备买 X，金额/数量是 Y”

如果用户已经下单，则不要做预审结论，改为记录为事后复盘。

## 用户必须提供

```
标的：代码 + 名称
动作：买入 / 加仓 / 回补 / 换仓
计划金额或数量：
计划价格：
所属模式：例如 A类启动确认 / 处理失败仓 / 防御仓 / 观察试错
买入理由：
买错退出条件：价格、时间或形态条件
当前持仓截图或手填持仓：总资产、现金、总仓位、该票持仓/成本
```

缺少 `所属模式` 或 `买错退出条件` 时，默认 `REJECT`。

## 标准流程

```
1. 查权限
   ├─ GET /api/permission/today
   ├─ 若今日卡不存在，GET /api/permission/:today
   └─ 读取 status / max_total_position / allowed_modes / risk_matrix

2. 查系统内历史
   ├─ GET /api/baseline/snapshot?date=$today
   ├─ GET /api/next-trade-plan?date=$today
   ├─ GET /api/review/daily?start=$last_5&end=$today
   ├─ GET /api/review/operations?start=$last_5&end=$today
   └─ GET /api/review/weekly/$week/insights?lookback=6

3. 查外部行情
   ├─ 个股最新报价：现价、涨跌幅、开高低、成交额、换手率、量比
   ├─ 个股历史走势：近 20/60 日位置、涨跌幅、均线/平台、放量情况
   ├─ 所属板块与当日强度：是否属于今日主线或后排
   └─ 市场背景：指数、涨跌家数、涨停/跌停池、强弱板块

4. 匹配战法
   ├─ 调用 match_pretrade_tactics，传入 action / risk_action / mode / permission_status / market_stage / rationale
   ├─ 读取 best_match、missing_conditions、forbidden_hits
   ├─ 战法缺关键确认时，结论至少降为 WAIT
   └─ 战法命中 forbidden_conditions 时，结论必须 REJECT

5. 做硬规则检查
   ├─ 先识别 risk_action：new_buy / add_winner / add_loser / rebuy_same_symbol / switch_position
   ├─ 优先按 risk_matrix 判断动作权限
   ├─ 是否属于 allowed_modes、是否有买错退出条件
   ├─ 是否在下一交易日计划 entries / watchlist / 计划外
   ├─ 是否会让总仓超过 max_total_position 或净新增风险上限
   ├─ 若为 switch_position，是否有对应卖出资金、是否净仓不增加
   └─ 若为 add_loser / 摊低成本 / 亏损补仓，直接硬拒绝

6. 输出并记录预审结论
   ├─ REJECT：禁止买
   ├─ WAIT：现在不能买，给出等待条件
   ├─ ALLOW_SMALL：只允许极小仓，必须给金额上限
   ├─ ALLOW：仅在权限、模式、行情、退出条件全部合格时使用
   └─ 写 create_pretrade_review 时附带 tactic_evaluations 留痕
```

## 外部行情默认接口

优先使用东方财富；在远程机器内部 curl 时加 `--noproxy '*'`。

### 个股最新报价

```bash
curl --noproxy '*' -sS -A 'Mozilla/5.0' \
  'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f8,f10,f13&secids=0.002317'
```

`secids` 规则：深市 `0.代码`，沪市 `1.代码`。

### 个股历史日 K

```bash
curl --noproxy '*' -sS -A 'Mozilla/5.0' \
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.002317&klt=101&fqt=1&beg=20260101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
```

常用字段：`f51` 日期，`f52` 开盘，`f53` 收盘，`f54` 最高，`f55` 最低，`f56` 成交量，`f57` 成交额，`f58` 振幅，`f59` 涨跌幅，`f60` 涨跌额，`f61` 换手率。

### 市场和板块

行情和涨停/跌停池按 `eastmoney-market-data` skill 的接口执行。若东方财富失败，说明缺失项，不要捏造。

## 硬拒绝规则

命中任一条，结论必须是 `REJECT`：

- 今日权限卡不存在或读取失败，且用户要新买。
- 今日权限卡 `status=protect` 且 `forbidden_actions` 包含“全天新开仓”或同义规则。
- 买入动作不属于 `allowed_modes`。
- 用户没有给出买错退出条件。
- 买入后会超过 `max_total_position`。
- `risk_matrix` 判定为 `forbid`。
- 保护档 `new_buy` 会净新增风险。
- 保护档计划外新开仓。
- `switch_position` 无预审、无卖出资金来源，或买入金额超过对应卖出金额。
- 亏损票补仓、摊低成本、倒 T。
- 同一标的第一笔未验证就想买第二笔。
- 外部消息、群消息、顾问信息没有经过主线/强度/买点/止损验证。
- 命中战法 `forbidden_conditions`。

## 等待规则

不硬拒绝但条件不足时，用 `WAIT`：

- 个股未站回关键价：等待站回并保持 10-15 分钟。
- 标的只在 `watchlist`，等待满足升级为 entries 的触发条件。
- 标的不在 `next_trade_plan`，等待补充强理由并重新生成/修订计划。
- 板块不是当日主线：等待板块进入涨幅/成交额前列。
- 放量不足：等待成交额或量比达到预设条件。
- 市场修复但个人权限未恢复：等待次日权限卡升级。
- 战法关键确认缺失：等待 `match_pretrade_tactics` 返回的 `missing_conditions`。

## 输出模板

```markdown
## 预审结论：REJECT / WAIT / ALLOW_SMALL / ALLOW

标的：代码 名称
计划：价格 / 数量或金额 / 模式

### 结论理由
- 权限卡：status=...，最大仓位=...，命中/未命中 ...
- 行情位置：现价=...，今日涨跌=...，近20日位置=...
- 板块强度：...
- 战法匹配：best_match=...，matched=...，missing=...，forbidden=...
- 历史错误匹配：...

### 如果仍想做，必须等待
- 条件1
- 条件2

### 明确禁止
- 禁止动作1
- 禁止动作2
```

## 结论口径

- `REJECT` 不是看空标的，而是当前用户没有交易权限。
- `WAIT` 必须给可验证的价格/时间/量能条件。
- `ALLOW_SMALL` 必须写金额上限，默认不超过总资产 5% 或权限卡更低阈值。
- `ALLOW` 不能用于 protect 日的净新增风险；protect 日计划内调仓可在净仓不增、有预审、有退出条件时给 `ALLOW_SMALL/ALLOW`。
