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

/* ─────────────────────────────────────────────
 * 周 / 月 复盘聚合 (Period Review)
 * ───────────────────────────────────────────── */

export type PeriodType = 'week' | 'month';

/** 通用聚合周期复盘 (周 + 月共用结构) */
export interface PeriodReview {
  id: string;
  period_type: PeriodType;
  /** 周: 'YYYY-Www' 例 '2026-W17'；月: 'YYYY-MM' 例 '2026-04' */
  period_key: string;
  /** 周期起始日期 (YYYY-MM-DD，闭区间) */
  start_date: string;
  /** 周期结束日期 (YYYY-MM-DD，闭区间) */
  end_date: string;

  /* ── 自动聚合的统计指标 ── */
  operations_count: number;
  active_days: number;            // 该期内有操作的天数
  avg_score: number;
  win_rate?: number;
  baseline_alignment: number;
  emotion_distribution: Record<EmotionState, number>;
  rationale_distribution: Record<RationaleType, number>;
  stage_distribution: Record<string, number>;     // 期内大盘阶段天数
  realized_pnl?: number;
  unrealized_pnl?: number;

  /* ── 文字总结：自动生成 + 用户可覆盖 ── */
  /** 关键收获（可保持的优势） */
  key_takeaways: string[];
  /** 主要错误 */
  mistakes: string[];
  /** 重复出现的错误（横向对比子周期识别） */
  recurring_mistakes: string[];
  /** 模式洞察：从历史数据中挖掘的行为规律 */
  pattern_insights: string[];
  /** 操作手册更新（可执行的规则调整） */
  playbook_updates: string[];
  /** 改进点（用户/agent 写入的具体改进方向） */
  improvements: string[];
  /** 下一期需要关注/行动 */
  next_actions: string[];
  /** 一句话摘要 */
  narrative?: string;
  /** 月度主题（仅 month 使用） */
  monthly_thesis?: string;

  /** 子周期键列表 (周里包含的日期 / 月里包含的周键) */
  child_keys: string[];

  generated_at: string;
  generator_version: string;
}

/** 历史模式洞察输出 (基于过去 N 个同粒度周期对比) */
export interface PeriodInsight {
  period_type: PeriodType;
  current_key: string;
  compared_keys: string[];       // 参与对比的历史 key
  /* ── 趋势 ── */
  score_trend: number[];          // 与 compared_keys 对齐
  alignment_trend: number[];
  win_rate_trend: number[];
  /* ── 提取出来的可执行洞察 ── */
  recurring_mistakes: string[];   // 历史多次出现的错误
  recurring_strengths: string[];  // 历史多次出现的优势
  emotion_warnings: string[];     // 高频负面情绪提示
  rationale_warnings: string[];   // 高频低质量依据 (impulsive 等)
  alignment_warnings: string[];   // 契合度持续偏低提醒
  /* ── 给出的下一期建议 (可一键回填 next_actions) ── */
  recommended_next_actions: string[];
  generated_at: string;
}

export interface PeriodReviewPlanRequest {
  next_actions?: string[];
  key_takeaways?: string[];
  mistakes?: string[];
  improvements?: string[];
  playbook_updates?: string[];
  pattern_insights?: string[];
  narrative?: string;
  monthly_thesis?: string;
}

/* ─────────────────────────────────────────────
 * 复盘日志 (Review Journal) — 完全独立、不依赖 daily 数据
 * 适合作为 agent 总结报告 / 周记 / 月记
 * ───────────────────────────────────────────── */

export type JournalScope = 'week' | 'month' | 'custom';

/** 自由结构的小节，agent 可任意扩展 */
export interface JournalSection {
  title: string;
  content: string;            // 支持纯文本或 markdown
  kind?: string;              // 自定义类型，例如 'analysis' / 'reflection' / 'quote'
}

export interface ReviewJournal {
  id: string;

  /* ── 范围与归属 ── */
  scope: JournalScope;
  /** 周: 'YYYY-Www'；月: 'YYYY-MM'；自定义: 任意标识或 'YYYY-MM-DD..YYYY-MM-DD' */
  period_key: string;
  /** 可选的精确起止日期，用于 custom 或显式标注 */
  start_date?: string;
  end_date?: string;

  /* ── 内容主体 ── */
  title: string;
  summary?: string;           // 一段话摘要
  body?: string;              // 长正文，支持 markdown
  /** 自由结构小节，可任意扩展 */
  sections: JournalSection[];

  /* ── 结构化字段（与 PeriodReview 平行，但完全独立存储） ── */
  market_observation?: string;
  strategy_review?: string;
  key_takeaways: string[];
  mistakes: string[];
  improvements: string[];
  playbook_updates: string[];
  next_actions: string[];

  /* ── 标识与元数据 ── */
  tags: string[];
  source: string;             // 'self' | 'agent:xxx' | 'manual'
  status: 'draft' | 'final';  // 草稿 / 定稿
  /** agent 可塞任意键值对（例如关联的研报、模型版本、推理过程引用等） */
  metadata?: Record<string, unknown>;

  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface ReviewJournalCreateRequest {
  scope: JournalScope;
  period_key: string;
  title: string;
  start_date?: string;
  end_date?: string;
  summary?: string;
  body?: string;
  sections?: JournalSection[];
  market_observation?: string;
  strategy_review?: string;
  key_takeaways?: string[];
  mistakes?: string[];
  improvements?: string[];
  playbook_updates?: string[];
  next_actions?: string[];
  tags?: string[];
  source?: string;
  status?: 'draft' | 'final';
  metadata?: Record<string, unknown>;
  created_by?: string;
}

export type ReviewJournalPatchRequest = Partial<ReviewJournalCreateRequest>;

/* ─────────────────────────────────────────────
 * 明日权限卡 (Trading Permission Card)
 * 由 agent 综合 baseline + 近 N 日复盘 + 操作行为 推理生成
 * 后端只做存储 + CRUD，不做规则引擎
 * ───────────────────────────────────────────── */

export type PermissionStatus = 'protect' | 'normal' | 'attack';

/** 卡片决策依据：agent 自填，便于后续追溯/对比 */
export interface PermissionGeneratedFrom {
  baseline_stage?: string;
  avg_score_3d?: number;
  recent_mistakes?: string[];
  /** 用于推理的日期列表（如 last 3 trading days） */
  based_on_dates?: string[];
  /** 触发的规则名（agent 在 prompt 里维护的规则） */
  triggered_rules?: string[];
  /** agent 推理过程，可放短摘要或完整链路 */
  reasoning?: string;
  /** 自由扩展 */
  extras?: Record<string, unknown>;
}

export interface TradingPermissionCard {
  /** 主键：日期 YYYY-MM-DD（每日一张） */
  date: string;
  status: PermissionStatus;
  max_total_position: number;        // 0-1
  allow_margin: boolean;
  allowed_modes: string[];           // ["A类启动确认", "处理失败仓"]
  forbidden_actions: string[];       // ["补仓","倒T","追涨","新开后排"]
  stop_triggers: string[];           // ["卖出后想马上买入","当日做了3种模式"]
  /** 一句话总结今天为何是这个状态 */
  rationale: string;
  /** 决策来源数据 */
  generated_from: PermissionGeneratedFrom;
  /** 'agent:permission' / 'manual' / 'self' */
  source: string;
  /** 锁定后 POST 不会覆盖（除非显式 unlock） */
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface TradingPermissionCardUpsertRequest {
  date: string;
  status: PermissionStatus;
  max_total_position: number;
  allow_margin?: boolean;
  allowed_modes?: string[];
  forbidden_actions?: string[];
  stop_triggers?: string[];
  rationale?: string;
  generated_from?: PermissionGeneratedFrom;
  source?: string;
  locked?: boolean;
}

/* ─────────────────────────────────────────────
 * 持仓计划卡 (Position Plan)
 * 每日逐票定义明日唯一允许动作，作为盘中执行约束
 * ───────────────────────────────────────────── */

export type PositionPlanCategory =
  | 'hard_failed'
  | 'conditional_failed'
  | 'positive_feedback'
  | 'watch'
  | 'defensive'
  | 'closed';

export type PositionPlanAction =
  | 'sell_only'
  | 'reduce_only'
  | 'hold_or_reduce'
  | 'hold_only'
  | 'observe_only'
  | 'no_action';

export interface PositionPlan {
  id: string;
  date: string;
  symbol: string;
  name: string;
  quantity?: number;
  cost_price?: number;
  last_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  position_ratio?: number;
  category: PositionPlanCategory;
  allowed_action: PositionPlanAction;
  invalidation_price?: number;
  rebound_reduce_price?: number;
  forbidden_actions: string[];
  rationale: string;
  source: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface PositionPlanUpsertRequest {
  date: string;
  symbol: string;
  name: string;
  quantity?: number;
  cost_price?: number;
  last_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  position_ratio?: number;
  category: PositionPlanCategory;
  allowed_action: PositionPlanAction;
  invalidation_price?: number;
  rebound_reduce_price?: number;
  forbidden_actions?: string[];
  rationale?: string;
  source?: string;
  locked?: boolean;
}

/* ─────────────────────────────────────────────
 * 盘中买入预审 (Pretrade Review)
 * 不下单，只记录用户意图、检查结论和必须等待/禁止条件
 * ───────────────────────────────────────────── */

export type PretradeAction = 'buy' | 'add' | 'rebuy' | 'switch';
export type PretradeVerdict = 'REJECT' | 'WAIT' | 'ALLOW_SMALL' | 'ALLOW';

export interface PretradeReview {
  id: string;
  date: string;
  timestamp: string;
  symbol: string;
  name: string;
  action: PretradeAction;
  planned_quantity?: number;
  planned_amount?: number;
  planned_price?: number;
  mode: string;
  rationale: string;
  exit_condition: string;
  current_position_note?: string;
  verdict: PretradeVerdict;
  max_allowed_amount?: number;
  reasons: string[];
  wait_conditions: string[];
  forbidden_actions: string[];
  checked_permission_date?: string;
  checked_permission_status?: PermissionStatus;
  linked_position_plan_id?: string;
  market_snapshot?: Record<string, unknown>;
  source: string;
  created_at: string;
}

export interface PretradeReviewCreateRequest {
  date: string;
  timestamp?: string;
  symbol: string;
  name: string;
  action: PretradeAction;
  planned_quantity?: number;
  planned_amount?: number;
  planned_price?: number;
  mode: string;
  rationale: string;
  exit_condition: string;
  current_position_note?: string;
  verdict: PretradeVerdict;
  max_allowed_amount?: number;
  reasons?: string[];
  wait_conditions?: string[];
  forbidden_actions?: string[];
  checked_permission_date?: string;
  checked_permission_status?: PermissionStatus;
  linked_position_plan_id?: string;
  market_snapshot?: Record<string, unknown>;
  source?: string;
}

/* ─────────────────────────────────────────────
 * 违规检测 (Violation Detection)
 * 从交易记录/权限卡/预审记录推导，只读输出
 * ───────────────────────────────────────────── */

export type ViolationSeverity = 'info' | 'warning' | 'critical';

export interface TradeViolation {
  id: string;
  date: string;
  rule_id: string;
  severity: ViolationSeverity;
  title: string;
  detail: string;
  related_operation_ids: string[];
  suggested_penalty: string;
}

/* ─────────────────────────────────────────────
 * 内置聊天 (Chat) — Phase A：基础通道 + 只读工具
 * ───────────────────────────────────────────── */

export type ChatAuthStyle = 'bearer' | 'header';

export interface ChatSettings {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  system_prompt?: string;
  enable_tools: boolean;
  max_tool_iterations: number;
  request_timeout_ms: number;
  auth_style?: ChatAuthStyle;
  auth_header_name?: string;
  updated_at: string;
}

export interface ChatThread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatAttachment {
  type: 'image';
  path: string;       // 相对 data/uploads 的相对路径，如 "thread_xxx/msg_yyy_0.png"
  mime: string;       // image/png | image/jpeg | image/webp
  size: number;       // 字节
  width?: number;
  height?: number;
  source?: string;    // 'paste' | 'drop' | 'pick'，仅供参考
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  attachments?: ChatAttachment[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

/* ─────────────────────────────────────────────
 * 写入工具的提案 (ChatProposal)
 * agent 调用 propose_* 工具时，先生成一条 pending proposal，
 * 由用户在 UI 上点击「应用」/「取消」后才真正落库。
 * ───────────────────────────────────────────── */

export type ChatProposalStatus = 'pending' | 'applied' | 'cancelled' | 'failed' | 'expired';
export type ChatProposalRisk = 'low' | 'medium' | 'high';

export interface ChatProposal {
  id: string;
  thread_id: string;
  /** 触发该提案的 assistant message id（即 LLM 调用 propose_* 工具的那条 message） */
  message_id?: string;
  /** 触发该提案的 tool_call id（OpenAI tool_call_id） */
  tool_call_id?: string;
  /** propose_* 工具名 */
  tool_name: string;
  /** 解析后的参数对象 */
  args: Record<string, unknown>;
  /** 一句话差异描述（用于卡片标题），由 preview() 生成 */
  summary: string;
  /** 影响目标（人类可读，用于审计列表展示） */
  target?: string;
  risk: ChatProposalRisk;
  status: ChatProposalStatus;
  /** 写前的旧值快照（覆盖类必有；新增类可为 null） */
  snapshot_before?: unknown;
  /** apply 之后的真实写入结果（成功后填） */
  result?: unknown;
  error?: string;
  created_at: string;
  decided_at?: string;
  /** 谁应用/取消的：当前总是 'user' */
  decided_by?: string;
}
