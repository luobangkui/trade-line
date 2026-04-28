import { v4 as uuidv4 } from 'uuid';
import {
  getDailyReviewsByRange, getOperationsByRange, getSnapshotsInRange,
  upsertPeriodReview, getPeriodReview, getRecentPeriodReviewsBefore,
} from '../db/store';
import type {
  PeriodReview, PeriodType, PeriodInsight,
  EmotionState, RationaleType, DailyReviewSummary,
} from '../models/types';

const EMOTION_KEYS: EmotionState[] = [
  'calm', 'confident', 'excited', 'fomo', 'greedy', 'fearful', 'panic', 'regret', 'revenge',
];
const RATIONALE_KEYS: RationaleType[] = [
  'technical', 'fundamental', 'news', 'baseline', 'emotion', 'impulsive', 'system', 'mixed',
];
const NEGATIVE_EMOTIONS: EmotionState[] = ['fomo', 'greedy', 'fearful', 'panic', 'revenge', 'regret'];
const LOW_QUALITY_RATIONALES: RationaleType[] = ['impulsive', 'emotion'];

/* ────────────────────────────────────────────────
 * 周键 / 月键工具
 * ──────────────────────────────────────────────── */

/** 获取 ISO 周编号；返回 'YYYY-Www'，与日期相同年份基于 ISO 8601。 */
export function isoWeekKey(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date + (date.length === 10 ? 'T00:00:00Z' : '')) : new Date(date);
  // 复制并以 UTC 计算 ISO week（参考 ISO-8601）
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;          // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);   // 移到本周周四
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 由 'YYYY-Www' 反推该周的周一/周日 (YYYY-MM-DD) */
export function isoWeekRange(weekKey: string): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(weekKey);
  if (!m) throw new Error(`invalid weekKey: ${weekKey}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO week 1 包含该年第一个周四
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;             // 周一=0
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

/** 'YYYY-MM' 月键 */
export function monthKey(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date + (date.length === 10 ? 'T00:00:00Z' : '')) : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 由 'YYYY-MM' 计算月初/月末 */
export function monthRange(monthKey: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`invalid monthKey: ${monthKey}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));        // 月末
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** 列出 [start,end] 内出现的所有周键 */
export function listWeekKeysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  let prev = '';
  while (cur <= last) {
    const k = isoWeekKey(cur);
    if (k !== prev) {
      out.push(k);
      prev = k;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** 列出 [start,end] 内出现的所有月键 */
export function listMonthKeysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (cur <= last) {
    const k = monthKey(cur);
    if (!out.length || out[out.length - 1] !== k) out.push(k);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/* ────────────────────────────────────────────────
 * 聚合
 * ──────────────────────────────────────────────── */

interface RangeInfo { start: string; end: string; childKeys: string[] }

function resolveRange(type: PeriodType, periodKey: string): RangeInfo {
  if (type === 'week') {
    const { start, end } = isoWeekRange(periodKey);
    // child = 该周内每一天（7天）
    const child: string[] = [];
    const cur = new Date(start + 'T00:00:00Z');
    const last = new Date(end + 'T00:00:00Z');
    while (cur <= last) {
      child.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return { start, end, childKeys: child };
  }
  // month
  const { start, end } = monthRange(periodKey);
  // child = 该月内出现的所有周键
  return { start, end, childKeys: listWeekKeysInRange(start, end) };
}

function dedupTopN(arr: string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = (s ?? '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= n) break;
  }
  return out;
}

/** 找到出现次数 ≥2 的字符串（保持出现顺序） */
function repeatedItems(arr: string[], minCount = 2): string[] {
  const counter = new Map<string, number>();
  for (const s of arr) {
    const k = (s ?? '').trim();
    if (!k) continue;
    counter.set(k, (counter.get(k) ?? 0) + 1);
  }
  return [...counter.entries()].filter(([, v]) => v >= minCount).map(([k]) => k);
}

/** 主聚合入口：周或月 */
export function aggregatePeriodReview(type: PeriodType, periodKey: string): PeriodReview {
  const { start, end, childKeys } = resolveRange(type, periodKey);
  const dailies = getDailyReviewsByRange(start, end);
  const ops = getOperationsByRange(start, end);
  const snaps = getSnapshotsInRange(start, end);
  const existing = getPeriodReview(type, periodKey);

  // ── 基础统计 ──
  const operations_count = ops.length;
  const active_days = new Set(ops.map((o) => o.time_key)).size;

  const emotion_distribution = Object.fromEntries(EMOTION_KEYS.map((k) => [k, 0])) as Record<EmotionState, number>;
  const rationale_distribution = Object.fromEntries(RATIONALE_KEYS.map((k) => [k, 0])) as Record<RationaleType, number>;
  for (const o of ops) {
    if (o.emotion_state in emotion_distribution) emotion_distribution[o.emotion_state]++;
    if (o.rationale_type in rationale_distribution) rationale_distribution[o.rationale_type]++;
  }

  const stage_distribution: Record<string, number> = {};
  for (const s of snaps) {
    stage_distribution[s.market_stage] = (stage_distribution[s.market_stage] ?? 0) + 1;
  }

  // 评分按操作数加权 (空操作日不参与平均)
  let scoreNum = 0, scoreDen = 0;
  let alignNum = 0, alignDen = 0;
  let winNum = 0, winDen = 0;
  for (const d of dailies) {
    const w = Math.max(1, d.operations_count);
    if (d.avg_score) { scoreNum += d.avg_score * w; scoreDen += w; }
    if (d.baseline_alignment) { alignNum += d.baseline_alignment * w; alignDen += w; }
    if (typeof d.win_rate === 'number') { winNum += d.win_rate * w; winDen += w; }
  }
  const avg_score = scoreDen ? Math.round(scoreNum / scoreDen) : 0;
  const baseline_alignment = alignDen ? Math.round(alignNum / alignDen) : 0;
  const win_rate = winDen ? +(winNum / winDen).toFixed(2) : undefined;

  // ── 文字归并 ──
  const allTakeaways: string[] = [];
  const allMistakes: string[] = [];
  const allActions: string[] = [];
  for (const d of dailies) {
    allTakeaways.push(...(d.key_takeaways ?? []));
    allMistakes.push(...(d.mistakes ?? []));
    allActions.push(...(d.next_actions ?? []));
  }

  // 重复出现的错误（≥2 天提到的同一个错误，作为"反复犯的"）
  const recurring = repeatedItems(allMistakes, 2);

  // 模式洞察：自动从分布中提取行为规律
  const pattern_insights: string[] = [];
  const negCount = NEGATIVE_EMOTIONS.reduce((s, k) => s + (emotion_distribution[k] ?? 0), 0);
  if (operations_count > 0 && negCount / operations_count >= 0.4) {
    const top = NEGATIVE_EMOTIONS
      .map((k) => [k, emotion_distribution[k] ?? 0] as const)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0)
      .slice(0, 2)
      .map(([k]) => emotionLabel(k))
      .join('/');
    pattern_insights.push(`本期 ${Math.round(negCount / operations_count * 100)}% 操作伴随负面情绪 (${top})，需重点纪律性`);
  }
  const lowQ = LOW_QUALITY_RATIONALES.reduce((s, k) => s + (rationale_distribution[k] ?? 0), 0);
  if (operations_count > 0 && lowQ / operations_count >= 0.25) {
    pattern_insights.push(`非系统化依据占比 ${Math.round(lowQ / operations_count * 100)}%（情绪驱动/上头），建议补强基本面或系统化框架`);
  }
  if (baseline_alignment > 0 && baseline_alignment < 50) {
    pattern_insights.push(`与 baseline 平均契合度仅 ${baseline_alignment}%，多次背离客观市场判断`);
  }

  const stageTop = Object.entries(stage_distribution).sort((a, b) => b[1] - a[1])[0];

  // 月度主题（仅 month）— 从 stage_distribution 中提炼
  let monthly_thesis: string | undefined = existing?.monthly_thesis;
  if (type === 'month' && !monthly_thesis && stageTop) {
    monthly_thesis = `本月主导阶段：${stageLabel(stageTop[0])}（${stageTop[1]}天）`;
  }

  const autoNarrative = ops.length === 0
    ? `${type === 'week' ? '本周' : '本月'}无操作`
    : `${type === 'week' ? '本周' : '本月'}共 ${operations_count} 笔操作（活跃 ${active_days} 天），平均评分 ${avg_score}，与 baseline 契合度 ${baseline_alignment}%${stageTop ? `，主导阶段 ${stageLabel(stageTop[0])}` : ''}`;

  // 仅当 existing 是用户手写（非默认生成的格式）时才保留
  const isAutoGenerated = (s?: string): boolean => {
    if (!s) return true;
    return /^(本周|本月)(无操作|共 \d+ 笔操作)/.test(s);
  };
  const narrative = isAutoGenerated(existing?.narrative) ? autoNarrative : existing!.narrative;

  const review: PeriodReview = {
    id: existing?.id ?? uuidv4(),
    period_type: type,
    period_key: periodKey,
    start_date: start,
    end_date: end,
    operations_count,
    active_days,
    avg_score,
    win_rate,
    baseline_alignment,
    emotion_distribution,
    rationale_distribution,
    stage_distribution,
    realized_pnl: existing?.realized_pnl,
    unrealized_pnl: existing?.unrealized_pnl,
    key_takeaways:  existing?.key_takeaways?.length  ? existing.key_takeaways  : dedupTopN(allTakeaways, 5),
    mistakes:       existing?.mistakes?.length       ? existing.mistakes       : dedupTopN(allMistakes, 5),
    recurring_mistakes: existing?.recurring_mistakes?.length ? existing.recurring_mistakes : recurring.slice(0, 5),
    pattern_insights:   existing?.pattern_insights?.length   ? existing.pattern_insights   : pattern_insights.slice(0, 5),
    playbook_updates:   existing?.playbook_updates ?? [],
    improvements:       existing?.improvements ?? [],
    next_actions:   existing?.next_actions?.length   ? existing.next_actions   : dedupTopN(allActions, 6),
    narrative,
    monthly_thesis,
    child_keys: childKeys,
    generated_at: new Date().toISOString(),
    generator_version: 'v1',
  };

  upsertPeriodReview(review);
  return review;
}

/** 用户/Agent 写入的字段：直接覆盖；之后立即重新聚合 + 保留覆盖字段 */
export function applyPeriodPlan(
  type: PeriodType,
  periodKey: string,
  patch: Partial<PeriodReview>,
): PeriodReview {
  let review = getPeriodReview(type, periodKey);
  if (!review) review = aggregatePeriodReview(type, periodKey);
  const merged: PeriodReview = {
    ...review,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ),
    period_type: type,
    period_key: periodKey,
    generated_at: new Date().toISOString(),
  };
  upsertPeriodReview(merged);
  return merged;
}

/* ────────────────────────────────────────────────
 * 历史模式洞察 — 给当前周期生成下一期建议
 * ──────────────────────────────────────────────── */

export function buildPeriodInsight(type: PeriodType, periodKey: string, lookback = 4): PeriodInsight {
  const history = getRecentPeriodReviewsBefore(type, periodKey, lookback);
  const compared_keys = history.map((h) => h.period_key);

  const score_trend = history.map((h) => h.avg_score ?? 0);
  const alignment_trend = history.map((h) => h.baseline_alignment ?? 0);
  const win_rate_trend = history.map((h) => Math.round(((h.win_rate ?? 0) * 100)));

  // 重复错误：在 ≥2 个历史周期都出现过的 mistake
  const allMistakesByPeriod = history.map((h) =>
    [...new Set([...(h.mistakes ?? []), ...(h.recurring_mistakes ?? [])].map((s) => s.trim()).filter(Boolean))],
  );
  const allTakeawaysByPeriod = history.map((h) =>
    [...new Set((h.key_takeaways ?? []).map((s) => s.trim()).filter(Boolean))],
  );

  const recurring_mistakes = countAcrossPeriods(allMistakesByPeriod, 2).slice(0, 5);
  const recurring_strengths = countAcrossPeriods(allTakeawaysByPeriod, 2).slice(0, 5);

  // 情绪/依据警示：求各历史周期分布的均值，超阈值的提示
  const emotion_warnings: string[] = [];
  const rationale_warnings: string[] = [];
  if (history.length) {
    const emoSum: Record<string, number> = {};
    const ratSum: Record<string, number> = {};
    let opsSum = 0;
    for (const h of history) {
      opsSum += h.operations_count ?? 0;
      for (const [k, v] of Object.entries(h.emotion_distribution ?? {})) emoSum[k] = (emoSum[k] ?? 0) + v;
      for (const [k, v] of Object.entries(h.rationale_distribution ?? {})) ratSum[k] = (ratSum[k] ?? 0) + v;
    }
    if (opsSum > 0) {
      for (const ek of NEGATIVE_EMOTIONS) {
        const ratio = (emoSum[ek] ?? 0) / opsSum;
        if (ratio >= 0.2) {
          emotion_warnings.push(`【${emotionLabel(ek)}】历史出现率 ${Math.round(ratio * 100)}%，需提前预案`);
        }
      }
      for (const rk of LOW_QUALITY_RATIONALES) {
        const ratio = (ratSum[rk] ?? 0) / opsSum;
        if (ratio >= 0.15) {
          rationale_warnings.push(`【${rationaleLabel(rk)}】操作占比 ${Math.round(ratio * 100)}%，下期减少冲动决策`);
        }
      }
    }
  }

  const alignment_warnings: string[] = [];
  if (alignment_trend.length >= 2) {
    const avg = alignment_trend.reduce((s, v) => s + v, 0) / alignment_trend.length;
    if (avg < 55) alignment_warnings.push(`近 ${alignment_trend.length} 期 baseline 契合度均值 ${Math.round(avg)}%，存在与客观信号系统性背离`);
    if (alignment_trend[alignment_trend.length - 1] < alignment_trend[0]) {
      alignment_warnings.push('契合度呈下降趋势，纪律性减弱');
    }
  }

  // 推荐 next_actions = 重复错误对应的"避免" + 重复优势对应的"保持" + 警示对应的"调整"
  const recommended_next_actions: string[] = [];
  for (const m of recurring_mistakes) recommended_next_actions.push(`避免再犯：${m}`);
  for (const s of recurring_strengths) recommended_next_actions.push(`保持优势：${s}`);
  recommended_next_actions.push(...emotion_warnings, ...rationale_warnings, ...alignment_warnings);

  return {
    period_type: type,
    current_key: periodKey,
    compared_keys,
    score_trend,
    alignment_trend,
    win_rate_trend,
    recurring_mistakes,
    recurring_strengths,
    emotion_warnings,
    rationale_warnings,
    alignment_warnings,
    recommended_next_actions: dedupTopN(recommended_next_actions, 8),
    generated_at: new Date().toISOString(),
  };
}

function countAcrossPeriods(periodArrays: string[][], minPeriods: number): string[] {
  const counter = new Map<string, number>();
  for (const arr of periodArrays) {
    for (const s of new Set(arr)) {
      counter.set(s, (counter.get(s) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .filter(([, v]) => v >= minPeriods)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

/* ────────────────────────────────────────────────
 * 标签辅助
 * ──────────────────────────────────────────────── */

const EMO_LABEL: Record<string, string> = {
  calm: '冷静', confident: '自信', excited: '兴奋', fomo: 'FOMO', greedy: '贪婪',
  fearful: '恐惧', panic: '恐慌', regret: '后悔', revenge: '报复',
};
const RAT_LABEL: Record<string, string> = {
  technical: '技术面', fundamental: '基本面', news: '消息面', baseline: '基于Baseline',
  emotion: '情绪驱动', impulsive: '上头', system: '系统化', mixed: '混合',
};
const STAGE_LABEL: Record<string, string> = {
  CHAOS: '混乱期', REPAIR_EARLY: '修复早期', REPAIR_CONFIRM: '修复确认',
  MAIN_UP: '主升行情', HIGH_RISK: '高位风险', DISTRIBUTION: '出货期', UNKNOWN: '未知',
};

function emotionLabel(k: EmotionState | string): string { return EMO_LABEL[k] ?? k; }
function rationaleLabel(k: RationaleType | string): string { return RAT_LABEL[k] ?? k; }
function stageLabel(k: string): string { return STAGE_LABEL[k] ?? k; }

/* ────────────────────────────────────────────────
 * 子周期辅助 (供路由展示)
 * ──────────────────────────────────────────────── */

export function listChildSummaries(type: PeriodType, periodKey: string): {
  key: string; ops: number; avg_score: number; alignment: number; mood?: string;
}[] {
  const { start, end } = resolveRange(type, periodKey);
  if (type === 'week') {
    const dailies = getDailyReviewsByRange(start, end);
    const map = new Map<string, DailyReviewSummary>();
    for (const d of dailies) map.set(d.time_key, d);
    const child: string[] = [];
    const cur = new Date(start + 'T00:00:00Z');
    const last = new Date(end + 'T00:00:00Z');
    while (cur <= last) {
      child.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return child.map((k) => {
      const d = map.get(k);
      return {
        key: k,
        ops: d?.operations_count ?? 0,
        avg_score: d?.avg_score ?? 0,
        alignment: d?.baseline_alignment ?? 0,
        mood: d?.mood_summary,
      };
    });
  }
  // month → child weeks
  const weekKeys = listWeekKeysInRange(start, end);
  return weekKeys.map((wk) => {
    const w = getPeriodReview('week', wk);
    return {
      key: wk,
      ops: w?.operations_count ?? 0,
      avg_score: w?.avg_score ?? 0,
      alignment: w?.baseline_alignment ?? 0,
      mood: w?.narrative,
    };
  });
}
