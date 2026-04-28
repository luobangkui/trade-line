# Review Journal 复盘日志接口手册（完全独立，不依赖 daily 数据）

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套 SOP：[sop-weekly.md](./sop-weekly.md) · [sop-monthly.md](./sop-monthly.md)

适合作为 **agent 总结报告 / 周记 / 月记**。可写完全独立于交易操作的复盘内容，
单一周/月/自定义区间下可写多篇日志，支持 markdown 正文 + 自由小节 + 任意 metadata。

## 接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST   | `/api/review/journal` | 创建一篇日志 |
| GET    | `/api/review/journals?scope=week&period_key=2026-W17` | 某周/月/自定义下所有日志 |
| GET    | `/api/review/journals?tag=&status=&source=&search=&limit=&offset=` | 全局列表（带过滤分页）|
| GET    | `/api/review/journal/:id` | 单篇详情 |
| PATCH  | `/api/review/journal/:id` | 局部更新（agent 增量写入推荐）|
| PUT    | `/api/review/journal/:id` | 完整替换 |
| DELETE | `/api/review/journal/:id` | 删除 |

---

## 字段定义

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

---

## 接口示例

### agent 写入一篇周报
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

### agent 增量更新（先建草稿，分多次补内容）
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

---

## 与 PeriodReview 的关系

| 维度 | PeriodReview | ReviewJournal |
|------|--------------|---------------|
| 存储 | `weekly_reviews` / `monthly_reviews` | `review_journals` |
| 数量 | 一个周期一份 | 一个周期可多篇 |
| 数据来源 | 自动聚合自 daily_reviews / trade_operations | 完全独立写入 |
| 适合谁 | 系统统计 + 用户/agent 覆盖几个文字字段 | agent 自由总结报告 / 长文 / markdown |
| 重新聚合 | 会重算统计（保留用户写入的文字字段） | 不存在"聚合"概念，纯用户/agent 写 |

> 前端在周/月详情面板的「📒 复盘日志」区块统一展示该期所有 journal，可点击 `+ 新建日志` 手写、点击单条查看/编辑/删除。

> 文字字段质量标准见 [content-quality.md](./content-quality.md)。
