# 战法系统接口手册

> 入口：[../SKILL.md](../SKILL.md) ｜ 关联：[sop-pretrade.md](./sop-pretrade.md) · [api-behavior.md](./api-behavior.md)

战法是盘中预审的辅助检查清单：它能指出当前意图符合哪个模式、缺哪些确认、触发哪些禁忌，但不能覆盖权限卡、风控矩阵、退出条件或仓位上限。

## 1. 战法导入 `/api/tactics/import`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tactics/import` | 导入 JSON / Markdown / 结构化 items 战法 |

### 请求字段

| 字段 | 说明 |
|---|---|
| `format` | `auto` / `json` / `markdown`，默认 `auto` |
| `content` | JSON 字符串或 Markdown 战法正文 |
| `items` | 结构化战法数组；传入后优先于 `content` |
| `source` | 来源，如 `manual` / `agent:tactics` |
| `created_by` | 创建者 |
| `overwrite` | 同名或同 id 是否覆盖；默认跳过 |

结构化战法常用字段：

```json
{
  "name": "主线启动确认",
  "aliases": ["A类启动"],
  "category": "entry",
  "tags": ["主线", "启动"],
  "applicable_actions": ["buy"],
  "risk_actions": ["new_buy"],
  "allowed_modes": ["A类启动确认"],
  "setup_conditions": ["市场不是 HIGH_RISK", "板块属于当日主线"],
  "entry_triggers": ["个股放量突破平台", "分时回踩不破关键价"],
  "confirm_signals": ["板块成交额排名靠前"],
  "invalidation_conditions": ["跌破启动日低点"],
  "forbidden_conditions": ["后排跟风冲高", "无量拉升"],
  "position_sizing": "默认小仓试错，单笔不超过总资产 5%"
}
```

## 2. 战法查询

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tactics` | 查询战法列表，可带 `tag` / `status` / `include_archived=1` |
| GET | `/api/tactics/:id` | 查询单条战法，id 可为 `id` / `name` / `alias` |
| POST | `/api/tactics/:id/images` | 为战法追加示意图片 |
| POST | `/api/tactics/:id/archive` | 归档战法 |
| DELETE | `/api/tactics/:id` | 物理删除战法，并清理其示意图片文件 |

### 示意图片

`POST /api/tactics/:id/images` 请求：

```json
{
  "items": [
    { "mime": "image/png", "base64": "data:image/png;base64,...", "source": "tactic-ui" }
  ]
}
```

返回的图片会写入战法的 `illustration_images`，前端通过 `/uploads/<path>` 展示。

## 3. 预审匹配 `/api/tactics/match`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tactics/match` | 根据预审意图匹配候选战法 |

请求字段与预审意图一致：`date`、`symbol`、`name`、`action`、`risk_action`、`mode`、`rationale`、`tags`、`market_stage`、`permission_status`。

返回字段：

| 字段 | 说明 |
|---|---|
| `evaluations` | 候选战法判断列表 |
| `best_match` | 分数最高的候选战法 |
| `suggested_verdict` | 仅输出保守建议，如 `WAIT` / `REJECT` |
| `wait_conditions` | 需要等待或补充确认的条件 |
| `forbidden_actions` | 命中的战法禁忌 |

## 4. Agent 工具

内置 Chat 工具：

- `list_tactics`
- `get_tactic`
- `match_pretrade_tactics`
- `import_tactics`：最方便的导入方式。用户粘贴战法笔记、Markdown 或 JSON 时，Agent 直接调用。
- `delete_tactic`：删除误导入、重复导入或明确废弃的战法。调用前必须先 `list_tactics` 或 `get_tactic` 确认目标，优先传返回的 `id`；如果只是暂时不用，建议归档而不是物理删除。

`import_tactics` 示例：

```json
{
  "format": "auto",
  "content": "# 主线启动确认\n\n## 前置条件\n- 市场不在 HIGH_RISK\n\n## 买点\n- 放量突破平台\n\n## 失效/退出\n- 跌破启动日低点\n\n## 禁止条件\n- 后排跟风冲高",
  "source": "agent:tactics"
}
```

如用户上传或提到示意图片，优先引导去「战法库」UI 上传；若已拿到图片 base64，可在导入后调用 `/api/tactics/:id/images` 追加图片。

盘中预审时建议顺序：

1. `get_today_context(date)` 拉权限卡、计划、持仓和已记录预审。
2. `match_pretrade_tactics(...)` 匹配战法并拿到缺口/禁忌。
3. `fetch_eastmoney_quote` / `fetch_eastmoney_kline` 补行情证据。
4. 综合 `permission`、`risk_matrix`、`next_trade_plan`、战法和行情输出四档结论。
5. `create_pretrade_review` 写入预审，并把用到的 `tactic_evaluations` 一并保存。
