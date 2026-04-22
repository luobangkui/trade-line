import { v4 as uuidv4 } from 'uuid';
import {
  getOperationsByDate, getEvaluationsByDate, getSnapshotByDate,
  upsertDailyReview, getDailyReview,
} from '../db/store';
import type {
  DailyReviewSummary, EmotionState, RationaleType,
} from '../models/types';

const EMOTION_KEYS: EmotionState[] = [
  'calm', 'confident', 'excited', 'fomo', 'greedy', 'fearful', 'panic', 'regret', 'revenge',
];
const RATIONALE_KEYS: RationaleType[] = [
  'technical', 'fundamental', 'news', 'baseline', 'emotion', 'impulsive', 'system', 'mixed',
];

/** 根据当日操作 + 评估，自动聚合一份日度复盘 */
export function aggregateDailyReview(timeKey: string): DailyReviewSummary {
  const ops = getOperationsByDate(timeKey);
  const evals = getEvaluationsByDate(timeKey);
  const snap = getSnapshotByDate(timeKey);
  const existing = getDailyReview(timeKey);

  // 情绪分布
  const emotion_distribution = Object.fromEntries(
    EMOTION_KEYS.map((k) => [k, 0])
  ) as Record<EmotionState, number>;
  const rationale_distribution = Object.fromEntries(
    RATIONALE_KEYS.map((k) => [k, 0])
  ) as Record<RationaleType, number>;

  for (const o of ops) {
    if (o.emotion_state in emotion_distribution) emotion_distribution[o.emotion_state]++;
    if (o.rationale_type in rationale_distribution) rationale_distribution[o.rationale_type]++;
  }

  // 评分均值（仅按 operation 聚合，每个 op 取最新一条评估）
  const evalByOp = new Map<string, typeof evals[number]>();
  for (const e of evals) {
    const cur = evalByOp.get(e.operation_id);
    if (!cur || e.created_at > cur.created_at) evalByOp.set(e.operation_id, e);
  }
  const evalArr = [...evalByOp.values()];
  const avg_score = evalArr.length
    ? Math.round(evalArr.reduce((s, e) => s + e.score, 0) / evalArr.length)
    : 0;
  const baseline_alignment = evalArr.length
    ? Math.round(evalArr.reduce((s, e) => s + e.alignment_score, 0) / evalArr.length)
    : 0;

  // 胜率：以 verdict 计算 excellent/good 的比例
  const wins = evalArr.filter((e) => e.verdict === 'excellent' || e.verdict === 'good').length;
  const win_rate = evalArr.length ? +(wins / evalArr.length).toFixed(2) : undefined;

  // 情绪总结一句话
  const dominantEmotion = Object.entries(emotion_distribution)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0] as EmotionState | undefined;
  const dominantRationale = Object.entries(rationale_distribution)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0] as RationaleType | undefined;
  const mood_summary = ops.length === 0
    ? '今日无操作'
    : `主导情绪【${dominantEmotion ?? '未标记'}】，主要依据【${dominantRationale ?? '未标记'}】，共 ${ops.length} 笔操作`;

  // 收集 evaluation 中的优缺点 + 建议
  const allPros: string[]   = [];
  const allCons: string[]   = [];
  const allSuggest: string[] = [];
  for (const e of evalArr) {
    allPros.push(...(e.pros ?? []));
    allCons.push(...(e.cons ?? []));
    allSuggest.push(...(e.suggestions ?? []));
  }

  // 用户已有的 plan 字段保留（如果之前手写过 next_actions/key_takeaways）
  const review: DailyReviewSummary = {
    id: existing?.id ?? uuidv4(),
    time_key: timeKey,
    operations_count: ops.length,
    realized_pnl: existing?.realized_pnl,
    unrealized_pnl: existing?.unrealized_pnl,
    win_rate,
    avg_score,
    emotion_distribution,
    rationale_distribution,
    baseline_alignment,
    key_takeaways: existing?.key_takeaways?.length ? existing.key_takeaways : dedupTop(allPros, 3),
    mistakes:      existing?.mistakes?.length      ? existing.mistakes      : dedupTop(allCons, 3),
    next_actions:  existing?.next_actions?.length  ? existing.next_actions  : dedupTop(allSuggest, 5),
    mood_summary:  existing?.mood_summary ?? mood_summary,
    linked_snapshot_time_key: snap?.time_key,
    generated_at: new Date().toISOString(),
  };

  upsertDailyReview(review);
  return review;
}

function dedupTop(arr: string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const key = s.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= n) break;
  }
  return out;
}
