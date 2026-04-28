# 端到端示例：一次完整的周复盘 Agent

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套：[sop-weekly.md](./sop-weekly.md) · [content-quality.md](./content-quality.md)

模拟"周复盘 agent"在周日晚执行的完整流程。`BASE_URL=http://localhost:50001`

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

## 这个 agent 完成了什么

1. ✅ 拉取了客观聚合 + 历史洞察 + 子明细三方面数据
2. ✅ 把历史 recurring_mistakes 转成了 playbook
3. ✅ 写了具体的 improvements（含触发条件 + 动作）
4. ✅ 写了一篇带 metadata 的可追溯日志
5. ✅ 自检确认所有写入生效

## Python 版本（结构化封装）

```python
import requests
BASE_URL = "http://localhost:50001"

def post(path, body):
    r = requests.post(f"{BASE_URL}{path}", json=body, timeout=10)
    r.raise_for_status()
    return r.json()

def get(path, **params):
    r = requests.get(f"{BASE_URL}{path}", params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def weekly_review(week_key, agent_name="agent:weekly"):
    post(f"/api/review/weekly/{week_key}/aggregate", {})
    review   = get(f"/api/review/weekly", period=week_key)
    insights = get(f"/api/review/weekly/{week_key}/insights")
    children = get(f"/api/review/weekly/{week_key}/children")
    plan = build_plan(review, insights, children)   # 你的 LLM 推理函数
    post(f"/api/review/weekly/{week_key}/plan", plan)
    post(f"/api/review/journal", build_journal(plan, agent_name))

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
