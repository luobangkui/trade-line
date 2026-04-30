# Chat 通道 API（Phase A：基础聊天 + 只读工具）

> 内置在 trade-line 的对话面板，使用 OpenAI 兼容协议接入任意 LLM；当前阶段只暴露**只读工具**，agent 不能直接写库。

## 1. 设置 `/api/chat/settings`

| 方法 | 描述 |
|------|------|
| `GET /api/chat/settings` | 返回当前设置（`api_key` 仅返回掩码，`api_key_set` 标记是否已配置）以及默认值。 |
| `PUT /api/chat/settings` | 更新设置；body 任意子集，缺省字段保留旧值。`api_key` 留空也会保留旧值。 |
| `DELETE /api/chat/settings` | 清空设置。 |

字段说明：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `base_url` | string | `https://api.openai.com/v1` | 兼容 OpenAI `/chat/completions` 的 base url |
| `api_key` | string | — | 仅写入；返回时为掩码 |
| `model` | string | `gpt-4o-mini` | 模型名 |
| `temperature` | number | `0.2` | 0~2 |
| `enable_tools` | boolean | `true` | 是否带上工具定义 |
| `max_tool_iterations` | number | `12` | 单轮对话内 LLM↔tool 往返上限（1~50；默认 12 适合多数复盘场景） |
| `request_timeout_ms` | number | `60000` | LLM 请求超时（5000~180000） |
| `auth_style` | `bearer` \| `header` | `bearer` | 鉴权方式 |
| `auth_header_name` | string | `Authorization`（bearer 模式无效）/ `accessKey`（header 模式默认） | 当 `auth_style=header` 时使用 |
| `system_prompt` | string | 内置 | 留空走默认 system prompt |

鉴权方式说明：

- `bearer`（默认）：发送 `Authorization: Bearer <api_key>`，适配 OpenAI / GLM / Qwen / DeepSeek / 火山引擎等绝大多数 OpenAI 兼容服务。
- `header`：发送 `<auth_header_name>: <api_key>`，**不带 `Bearer ` 前缀**，适配 DP OpenAPI 这类要求自定义 header 的网关。

`GET /api/chat/settings` 还会返回 `presets`，UI 端用作快速填充，例如：

```json
{
  "presets": [
    { "id": "openai",     "label": "OpenAI 兼容（Bearer）",
      "patch": { "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini",
                 "auth_style": "bearer", "auth_header_name": "Authorization" } },
    { "id": "dp-openapi", "label": "DP OpenAPI（accessKey）",
      "patch": { "base_url": "https://openapi.dp.tech/openapi/v1", "model": "openapi/claude-4.6-opus",
                 "auth_style": "header", "auth_header_name": "accessKey" } }
  ]
}
```

DP OpenAPI 实际请求等价于：

```bash
curl -s https://openapi.dp.tech/openapi/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "accessKey: <你的 key>" \
  -d '{ "model": "openapi/claude-4.6-opus", "messages": [...], "tools": [...] }'
```

> 密钥只保存在本地 `data/db.json`，请勿在共享主机上配置生产密钥。

## 2. 会话 `/api/chat/threads`

| 方法 | 描述 |
|------|------|
| `GET /api/chat/threads` | 列出全部会话（按 `updated_at` 倒序）。 |
| `POST /api/chat/threads` `{title?}` | 新建会话。 |
| `GET /api/chat/threads/:id` | 获取会话 + 全部消息（含 tool 调用记录）。 |
| `PATCH /api/chat/threads/:id` `{title}` | 重命名。 |
| `DELETE /api/chat/threads/:id` | 删除会话及其消息。 |

## 3. 发消息（同步 agent loop）

`POST /api/chat/threads/:id/messages` `{ content }`

- 服务端会把用户消息写入 → 调 LLM → 若返回 `tool_calls` 则按顺序执行工具并把结果回填 → 直到模型给出最终文本或达到 `max_tool_iterations`。
- 响应：

```json
{
  "success": true,
  "assistant": { /* 最终 assistant 消息 */ },
  "messages": [ /* 本次新增的全部消息（含 tool 中间步骤） */ ],
  "iterations": 2,
  "tool_invocations": 3
}
```

- 若未配置设置，会立即 500 报错且**不会**写入用户消息。

## 4. 已注册的只读工具

`GET /api/chat/tools` 返回完整列表。当前包括：

### 本地数据
- `list_skill_docs` / `read_skill_doc(name)`：读取 `skill/*.md` 与 `SKILL.md`
- `get_baseline_snapshot(date)` / `get_baseline_inputs(date)` / `get_baseline_timeline(start,end)`
- `get_daily_review(date)`
- `get_operations(date|start+end)` / `get_operation_with_evaluations(id)`
- `get_weekly_review(period_key)` / `get_weekly_insights(period_key, lookback?)`
- `get_permission_card(date)` / `get_permission_cards(start,end)`
- `get_position_plans(date|start+end)` / `get_position_plan(date,symbol)`
- `get_pretrade_reviews(date|start+end)` / `get_pretrade_review(id)`
- `get_violations(date)`
- `get_today_context(date)`：一次拿当日 baseline / permission / position-plan / pretrade / violations

### 东方财富行情
- `fetch_eastmoney_indices()`
- `fetch_eastmoney_quote({ secids: [...] })`：可裸代码或 `0./1.` 前缀
- `fetch_eastmoney_kline({ secid, period?, beg?, end? })`：周期 `D|W|M`
- `fetch_eastmoney_zt_pool({ date })` / `fetch_eastmoney_dt_pool({ date })`
- `fetch_eastmoney_concept_boards({ direction?, limit? })`：`direction = up|down`

> 说明：所有工具 `side_effect = read`，不会写库；写入类操作（创建预审/计划卡/复盘）请继续走原有 REST 接口。

## 5. 默认 system prompt（节选）

> "讨论交易/持仓/复盘时：先调用 `get_today_context` 等只读工具拿真实数据；提到具体个股优先 `fetch_eastmoney_quote / kline`；回复要明确说明依据来自哪个工具；当前阶段所有工具均只读，不要承诺执行任何写入操作。"

如需自定义可在「对话设置」中覆盖。
