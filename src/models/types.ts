export type TimeGranularity = 'day' | 'intraday' | 'week';

export type DataType =
  | 'market_snapshot'
  | 'emotion_metric'
  | 'market_event'
  | 'future_event'
  | 'manual_note'
  | 'trade_plan'
  | 'risk_alert'
  | 'stage_signal'
  | 'position_suggestion'
  | 'override';

export type MarketStage =
  | 'CHAOS'
  | 'REPAIR_EARLY'
  | 'REPAIR_CONFIRM'
  | 'MAIN_UP'
  | 'HIGH_RISK'
  | 'DISTRIBUTION'
  | 'UNKNOWN';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type NodeType = 'fact' | 'interpretation' | 'future';
export type Certainty = 'high' | 'medium' | 'low';
export type ReviewStatus = 'pending' | 'triggered' | 'expired' | 'fulfilled';

export interface BaselineInput {
  id: string;
  time_key: string;
  time_granularity: TimeGranularity;
  data_type: DataType;
  source: string;
  source_type: 'agent' | 'user' | 'system';
  title: string;
  payload: Record<string, unknown>;
  confidence: number;
  priority: number;
  tags: string[];
  effective_start?: string;
  effective_end?: string;
  created_at: string;
  created_by: string;
  status: 'active' | 'superseded' | 'archived';
}

export interface BaselineSnapshot {
  id: string;
  time_key: string;
  time_granularity: TimeGranularity;
  market_stage: MarketStage;
  emotion_score: number;
  risk_level: RiskLevel;
  position_min: number;
  position_max: number;
  preferred_styles: string[];
  avoid_styles: string[];
  action_summary: string;
  core_events: string[];
  future_watch_items: string[];
  summary: Record<string, unknown>;
  generated_at: string;
  generator_version: string;
}

export interface BaselineRelation {
  snapshot_id: string;
  input_id: string;
  contribution_type: string;
  contribution_weight: number;
}

export interface FutureWatchItem {
  id: string;
  expected_time: string;       // 事件开始时间（ISO8601）
  expected_end_time?: string;  // 事件结束时间（ISO8601），有时间范围的事件必填
  event_type: string;
  title: string;
  payload: Record<string, unknown>;
  certainty: Certainty;
  impact_level: number;
  review_status: ReviewStatus;
  linked_snapshot_time_key?: string;
  created_at: string;
}

export interface InputUploadRequest {
  time_key: string;
  time_type?: TimeGranularity;
  data_type: DataType;
  source: string;
  title: string;
  payload?: Record<string, unknown>;
  confidence?: number;
  tags?: string[];
  effective_time_range?: { start: string; end: string };
  priority?: number;
}

export interface TimelineNode {
  date: string;
  node_type: NodeType;
  is_future: boolean;
  snapshot?: BaselineSnapshot;
  inputs_count: number;
  future_items: FutureWatchItem[];   // 即将到来的未来事件（在该日期之后 7 天内）
  active_events?: FutureWatchItem[]; // 当天正在进行中的事件（start <= date <= end）
  highlight: boolean;
}

export interface TimelineResponse {
  nodes: TimelineNode[];
  today: string;
}

/* ─────────────────────────────────────────────
 * 个人操作复盘 (Personal Trade Review)
 * ───────────────────────────────────────────── */

export type TradeDirection =
  | 'buy'        // 建仓 / 加仓
  | 'sell'       // 减仓 / 清仓
  | 'add'        // 加仓
  | 'reduce'     // 减仓
  | 'hold'       // 持有不动（主动决策）
  | 'observe'    // 观望未操作（关注但没动）
  | 'plan';      // 计划交易（未执行）

export type RationaleType =
  | 'technical'    // 技术面（K线/均线/量价）
  | 'fundamental'  // 基本面（业绩/估值）
  | 'news'         // 消息面（公告/政策/事件）
  | 'baseline'     // 基于 baseline 决策（主升期加仓等）
  | 'emotion'      // 情绪驱动（恐慌/贪婪）
  | 'impulsive'    // 上头/冲动（无依据的纯感觉）
  | 'system'       // 系统化交易（机械执行规则）
  | 'mixed';       // 多种混合

export type EmotionState =
  | 'calm'      // 冷静
  | 'confident' // 自信
  | 'excited'   // 兴奋
  | 'fomo'      // 错失恐惧
  | 'greedy'    // 贪婪
  | 'fearful'   // 恐惧
  | 'panic'     // 恐慌
  | 'regret'    // 后悔
  | 'revenge';  // 报复性交易

export type Verdict = 'excellent' | 'good' | 'neutral' | 'poor' | 'bad';

/** 一笔操作记录 */
export interface TradeOperation {
  id: string;
  time_key: string;                  // YYYY-MM-DD
  timestamp: string;                 // ISO8601 精确到分
  symbol: string;                    // 代码 (600519)
  name: string;                      // 名称 (贵州茅台)
  direction: TradeDirection;
  quantity?: number;                 // 数量（股/手），observe/plan 可空
  price?: number;                    // 价格
  amount?: number;                   // 金额（自动计算或手填）
  rationale: string;                 // 操作依据（自由文本）
  rationale_type: RationaleType;
  emotion_state: EmotionState;
  linked_baseline_stage?: MarketStage;  // 操作时的大盘阶段（自动关联）
  linked_baseline_emotion?: number;     // 操作时的大盘情绪指数（自动关联）
  tags: string[];
  notes?: string;                    // 额外备注
  created_at: string;
  created_by: string;                // 'self' | agent_name
}

/** 操作评估（agent 生成或自评） */
export interface OperationEvaluation {
  id: string;
  operation_id: string;
  time_key: string;
  evaluator: string;                 // 'self' | 'agent:xxx' | 'system'
  score: number;                     // 0-100
  verdict: Verdict;
  alignment_score: number;           // 与当时 baseline 的契合度 0-100
  pros: string[];                    // 做对的点
  cons: string[];                    // 做错的点
  suggestions: string[];             // 优化建议
  next_action_hint?: string;         // 下一步动作提示
  created_at: string;
}

/** 日度复盘汇总 */
export interface DailyReviewSummary {
  id: string;
  time_key: string;                  // YYYY-MM-DD
  operations_count: number;
  realized_pnl?: number;             // 已实现盈亏
  unrealized_pnl?: number;           // 浮盈浮亏
  win_rate?: number;                 // 0-1
  avg_score: number;                 // 当日所有评估的均分
  emotion_distribution: Record<EmotionState, number>;
  rationale_distribution: Record<RationaleType, number>;
  baseline_alignment: number;        // 平均与 baseline 契合度
  key_takeaways: string[];           // 关键收获
  mistakes: string[];                // 主要错误
  next_actions: string[];            // 后续计划
  mood_summary?: string;             // 情绪总结一句话
  linked_snapshot_time_key?: string;
  generated_at: string;
}

export interface TradeOperationUploadRequest {
  time_key: string;
  timestamp?: string;
  symbol: string;
  name: string;
  direction: TradeDirection;
  quantity?: number;
  price?: number;
  amount?: number;
  rationale: string;
  rationale_type: RationaleType;
  emotion_state: EmotionState;
  tags?: string[];
  notes?: string;
  created_by?: string;
}

export interface OperationEvaluationUploadRequest {
  operation_id: string;
  evaluator: string;
  score: number;
  verdict: Verdict;
  alignment_score: number;
  pros?: string[];
  cons?: string[];
  suggestions?: string[];
  next_action_hint?: string;
}

export interface DailyReviewPlanRequest {
  next_actions: string[];
  key_takeaways?: string[];
  mistakes?: string[];
  mood_summary?: string;
}
