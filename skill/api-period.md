# 周 / 月聚合复盘接口手册（PeriodReview + Insights）

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套 SOP：[sop-weekly.md](./sop-weekly.md) · [sop-monthly.md](./sop-monthly.md) · [sop-fixup.md](./sop-fixup.md)

## 接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/review/weekly?period=YYYY-Www` | 查询某周复盘（不存在则即时聚合）|
| GET  | `/api/review/weekly?start=&end=`     | 查询周复盘列表 |
| POST | `/api/review/weekly/:week/aggregate` | 手动重新聚合 |
| POST | `/api/review/weekly/:week/plan`      | 写入/更新周度文字总结 |
| GET  | `/api/review/weekly/:week/insights`  | 基于历史 N 周的模式洞察 + 推荐下期行动 |
| GET  | `/api/review/weekly/:week/children`  | 该周每日明细列表 |
| **DELETE** | **`/api/review/weekly/:week`** | **物理删除该周聚合复盘（含手写）；带 `?reaggregate=1` 立即重聚合** |
| GET  | `/api/review/monthly?period=YYYY-MM` | 同上，月粒度 |
| POST | `/api/review/monthly/:month/aggregate` | 手动重新聚合月 |
| POST | `/api/review/monthly/:month/plan`    | 写入/更新月度（含 monthly_thesis）|
| GET  | `/api/review/monthly/:month/insights`| 月度历史洞察 |
| GET  | `/api/review/monthly/:month/children`| 该月各周明细 |
| **DELETE** | **`/api/review/monthly/:month`** | **物理删除该月聚合复盘** |
| GET  | `/api/review/period/timeline?type=week\|month&start=&end=` | 区间内全部周/月聚合 |

---

## 周键 / 月键格式

- 周：`YYYY-Www`，使用 ISO 8601 周编号（周一为本周起点）。例：`2026-W17`
- 月：`YYYY-MM`。例：`2026-04`

---

## 三种"重置"操作的差异

| 操作 | 接口 | 影响 |
|---|---|---|
| 重新聚合 | `POST /aggregate` | **保留**用户写入字段，仅重算统计 |
| 编辑覆盖 | `POST /plan` | 仅更新指定字段，其他保留 |
| 清空重推 | `DELETE` | **完全清掉**包含手写内容，回到纯自动 |

## 「清空重推」语义（DELETE 接口）

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

---

## 聚合规则

- **操作数加权平均**：`avg_score / baseline_alignment / win_rate` 按各日 operations_count 加权
- **文字字段（key_takeaways/mistakes/next_actions）**：从子周期 daily review 合并去重 Top N
- **`recurring_mistakes`**：同一错误在 ≥2 个子周期出现自动入选
- **`pattern_insights`**：自动检测负面情绪占比 ≥40%、低质量依据占比 ≥25%、契合度 <50 等阈值
- **`narrative`**：自动生成（"本周共 X 笔操作..."），仅当用户/agent 通过 plan 写入非默认格式时被保留
- 用户/agent 通过 `plan` 接口写入的字段（improvements / playbook_updates / monthly_thesis）：**受保护不被自动覆盖**

## 洞察（insights）输出

基于本期之前的 N 期（默认 4），返回：
- `score_trend / alignment_trend / win_rate_trend`：趋势数组
- `recurring_mistakes / recurring_strengths`：≥2 期出现的错误/优势
- `emotion_warnings / rationale_warnings / alignment_warnings`：阈值警示文案
- `recommended_next_actions`：合并后去重的可执行建议（前端可一键回填到 `next_actions`）

---

## 接口示例

### 拉取本周复盘 + 历史洞察
```bash
curl -s "{BASE_URL}/api/review/weekly?period=2026-W17"
curl -s "{BASE_URL}/api/review/weekly/2026-W17/insights?lookback=4"
```

### 写入周复盘文字（agent 用）
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

### 写入月度复盘可额外传 `monthly_thesis`
```bash
curl -X POST {BASE_URL}/api/review/monthly/2026-04/plan \
  -d '{ "monthly_thesis": "高位风险阶段贯穿整月，重点防御", ... }'
```

> 文字字段质量标准见 [content-quality.md](./content-quality.md)。
