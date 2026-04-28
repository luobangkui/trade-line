# SOP-A：盘后日复盘

> 入口：[../SKILL.md](../SKILL.md) ｜ 配套接口详情：[api-review.md](./api-review.md) · [api-baseline.md](./api-baseline.md)

**目标**：把当日的客观市场和主观操作完整复盘归档，为周复盘奠基。

## 标准流程（5 步）

```
1. 获取数据
   ├─ GET /api/baseline/snapshot?date=$today    （客观市场）
   └─ GET /api/review/operations?date=$today    （主观操作）

2. 补齐缺失的市场数据（如果 snapshot 不完整）
   POST /api/baseline/input  data_type=market_snapshot  payload.emotion_score / events / limit_up
   POST /api/baseline/input  data_type=stage_signal     payload.preferred_styles / avoid_styles

3. 对每笔操作生成评估（核心）
   for op in operations:
     分析维度：
       a) 与 baseline 契合度：op.linked_baseline_stage 是否合理？
       b) 依据质量：rationale_type ∈ {impulsive, emotion} → 扣分
       c) 情绪健康度：emotion_state ∈ {fomo, panic, revenge} → 警示
       d) 结果：若有 price → 看涨跌验证
     输出 evaluation：
       POST /api/review/operation/$op.id/eval
       { evaluator:"agent:你的名字", score, verdict, alignment_score,
         pros:[...], cons:[...], suggestions:[...] }

4. 写入当日复盘计划
   POST /api/review/daily/$today/plan
   { next_actions:[...], key_takeaways:[...], mistakes:[...], mood_summary }

5. 自检（必做）
   - 是否每笔操作都有 evaluation？
   - mood_summary 是否提到主导情绪和主导依据？
   - next_actions 是否具体到"做什么"，而非"要小心"这种空话？
```

## 评估打分参考

| 维度 | 高分（80+） | 低分（<50） |
|---|---|---|
| 与 baseline 契合度 | 阶段适配 + 风格在 preferred_styles | 阶段错配（如 HIGH_RISK 时追涨）|
| 依据质量 | technical / fundamental / baseline | impulsive / emotion |
| 情绪状态 | calm / confident | fomo / panic / revenge |

## 写入文字字段时

务必遵循 [content-quality.md](./content-quality.md)：含具体场景 + 触发条件 + 量化结果。

## Python 一键日复盘

```python
def daily_review(date, agent_name="agent:daily"):
    snap = get(f"/api/baseline/snapshot", date=date)
    ops  = get(f"/api/review/operations", date=date)
    for op in ops:
        ev = evaluate_operation(op, snap)   # 你的推理函数
        ev["evaluator"] = agent_name
        post(f"/api/review/operation/{op['id']}/eval", ev)
    plan = build_daily_plan(ops, snap)
    post(f"/api/review/daily/{date}/plan", plan)
```
