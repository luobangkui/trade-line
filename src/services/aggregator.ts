import { v4 as uuidv4 } from 'uuid';
import type { BaselineInput, BaselineSnapshot, MarketStage, RiskLevel } from '../models/types';
import {
  getInputsByTimeKey, upsertSnapshot, insertRelation,
  getSnapshotByDate, getFutureItemsByRange,
} from '../db/store';

// ── 阶段规则 ──────────────────────────────────────────────

export interface StageRule {
  stage: MarketStage;
  label: string;
  color: string;
  bgColor: string;
  minEmotion: number;
  maxEmotion: number;
  description: string;
  posMin: number;
  posMax: number;
  risk: RiskLevel;
}

export const STAGE_RULES: StageRule[] = [
  { stage: 'CHAOS',          label: '混乱期',   color: '#ef4444', bgColor: '#450a0a', minEmotion: 0,  maxEmotion: 25,  description: '市场失控，亏钱效应蔓延，规避为主',       posMin: 0.0, posMax: 0.1, risk: 'EXTREME' },
  { stage: 'REPAIR_EARLY',   label: '修复早期', color: '#f97316', bgColor: '#431407', minEmotion: 25, maxEmotion: 45,  description: '底部信号出现，核心龙头企稳，轻仓观察',   posMin: 0.1, posMax: 0.3, risk: 'HIGH'    },
  { stage: 'REPAIR_CONFIRM', label: '修复确认', color: '#eab308', bgColor: '#422006', minEmotion: 45, maxEmotion: 62,  description: '主线逐渐清晰，修复信号增多，可逐步建仓', posMin: 0.3, posMax: 0.5, risk: 'MEDIUM'  },
  { stage: 'MAIN_UP',        label: '主升行情', color: '#22c55e', bgColor: '#052e16', minEmotion: 62, maxEmotion: 78,  description: '赚钱效应扩散，主线明确，积极持仓跟随',   posMin: 0.5, posMax: 0.8, risk: 'LOW'     },
  { stage: 'HIGH_RISK',      label: '高位风险', color: '#a855f7', bgColor: '#2e1065', minEmotion: 78, maxEmotion: 90,  description: '情绪过热，追高风险加大，控制仓位上限',   posMin: 0.3, posMax: 0.5, risk: 'HIGH'    },
  { stage: 'DISTRIBUTION',   label: '出货期',   color: '#6366f1', bgColor: '#1e1b4b', minEmotion: 90, maxEmotion: 101, description: '极度亢奋，主力派发，大幅减仓保护利润',   posMin: 0.0, posMax: 0.2, risk: 'EXTREME' },
];

export function getStageRule(stage: MarketStage): StageRule {
  return STAGE_RULES.find((r) => r.stage === stage) ?? STAGE_RULES[0]!;
}

export function emotionToStage(score: number): MarketStage {
  return STAGE_RULES.find((r) => score >= r.minEmotion && score < r.maxEmotion)?.stage ?? 'UNKNOWN';
}

// ── 聚合逻辑 ──────────────────────────────────────────────

function calcEmotion(inputs: BaselineInput[]): number {
  const relevant = inputs.filter(
    (i) => i.data_type === 'emotion_metric' || i.data_type === 'market_snapshot' || i.data_type === 'stage_signal',
  );
  if (!relevant.length) return 50;

  let wSum = 0, wTotal = 0;
  for (const inp of relevant) {
    const score = Number(inp.payload['emotion_score'] ?? inp.payload['score'] ?? 50);
    const w = inp.confidence * inp.priority;
    wSum += score * w;
    wTotal += w;
  }
  return wTotal > 0 ? Math.min(100, Math.max(0, Math.round(wSum / wTotal))) : 50;
}

function extractEvents(inputs: BaselineInput[]): string[] {
  const evts: string[] = [];
  for (const inp of inputs.filter((i) => i.data_type === 'market_event' || i.data_type === 'market_snapshot')) {
    const pEvts = inp.payload['events'] as string[] | undefined;
    if (Array.isArray(pEvts)) evts.push(...pEvts);
    else if (inp.title) evts.push(inp.title);
  }
  return [...new Set(evts)].slice(0, 8);
}

function extractStyles(inputs: BaselineInput[], field: string): string[] {
  return [...new Set(
    inputs
      .filter((i) => i.data_type === 'position_suggestion' || i.data_type === 'stage_signal')
      .flatMap((i) => (i.payload[field] as string[] | undefined) ?? []),
  )];
}

function buildSummary(inputs: BaselineInput[], stage: MarketStage): string {
  const plan = inputs.find((i) => i.data_type === 'trade_plan');
  if (plan?.payload['summary']) return String(plan.payload['summary']);
  return getStageRule(stage).description;
}

export async function aggregateSnapshot(timeKey: string): Promise<BaselineSnapshot> {
  const inputs = getInputsByTimeKey(timeKey);

  // override 优先
  const override = inputs
    .filter((i) => i.data_type === 'override')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  let emotionScore: number;
  let marketStage: MarketStage;
  let riskLevel: RiskLevel;
  let posMin: number;
  let posMax: number;

  if (override) {
    emotionScore = Number(override.payload['emotion_score'] ?? calcEmotion(inputs));
    marketStage  = (override.payload['market_stage'] as MarketStage) ?? emotionToStage(emotionScore);
    const rule   = getStageRule(marketStage);
    riskLevel    = (override.payload['risk_level'] as RiskLevel) ?? rule.risk;
    posMin       = Number(override.payload['position_min'] ?? rule.posMin);
    posMax       = Number(override.payload['position_max'] ?? rule.posMax);
  } else {
    emotionScore = calcEmotion(inputs);
    marketStage  = emotionToStage(emotionScore);
    const rule   = getStageRule(marketStage);
    riskLevel    = rule.risk;
    posMin       = rule.posMin;
    posMax       = rule.posMax;
  }

  const coreEvents      = extractEvents(inputs);
  const preferredStyles = extractStyles(inputs, 'preferred_styles');
  const avoidStyles     = extractStyles(inputs, 'avoid_styles');
  const actionSummary   = buildSummary(inputs, marketStage);

  // 未来 7 天观察项
  const d = new Date(timeKey);
  const t1 = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
  const t7 = new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const futureItems = getFutureItemsByRange(t1, t7)
    .filter((f) => f.review_status === 'pending')
    .map((f) => `${f.expected_time.slice(0, 10)} ${f.title}`);

  const existing = getSnapshotByDate(timeKey);
  const snap: BaselineSnapshot = {
    id:               existing?.id ?? uuidv4(),
    time_key:         timeKey,
    time_granularity: 'day',
    market_stage:     marketStage,
    emotion_score:    emotionScore,
    risk_level:       riskLevel,
    position_min:     posMin,
    position_max:     posMax,
    preferred_styles: preferredStyles,
    avoid_styles:     avoidStyles,
    action_summary:   actionSummary,
    core_events:      coreEvents,
    future_watch_items: futureItems,
    summary: {
      input_count: inputs.length,
      sources: [...new Set(inputs.map((i) => i.source))],
      has_override: !!override,
    },
    generated_at:      new Date().toISOString(),
    generator_version: '2.0',
  };

  upsertSnapshot(snap);
  for (const inp of inputs) {
    insertRelation({ snapshot_id: snap.id, input_id: inp.id, contribution_type: inp.data_type, contribution_weight: inp.confidence * inp.priority });
  }
  return snap;
}
