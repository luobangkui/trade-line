/**
 * 写入工具定义，复用现有 service 落库逻辑。
 *
 * 每个工具描述了：
 *   - parameters: OpenAI 工具调用 schema
 *   - risk: low / medium / high (主要给前端卡片着色用)
 *   - target/preview: 给用户卡片看的"我要做什么"摘要
 *   - snapshot: 写前快照（覆盖类必有，create 类返回 null），用于 audit 与未来回滚
 *   - apply: 实际执行落库
 *
 * direct 类（aggregate / journal append / pretrade / eval / baseline_input）的工具
 * 由 chat-agent 直接调 apply，不走 proposal 流程。
 *
 * confirm 类（覆盖语义 / 创建交易 / 修正客观判断）的工具调用时，
 * agent 端只写一条 ChatProposal，等用户在 UI 点「应用」时才走 apply。
 */
import { v4 as uuidv4 } from 'uuid';
import {
  insertOperation, insertEvaluation, getOperationById,
  updateOperation, deleteOperation,
  insertPretradeReview, insertJournal, updateJournal, getJournalById,
  upsertPermissionCard, getPermissionCard, setPermissionCardLock,
  upsertPositionPlan, getPositionPlan, setPositionPlanLock,
  upsertNextTradePlan, getNextTradePlan, setNextTradePlanLock,
  upsertDailyReview, getDailyReview, getSnapshotByDate,
  insertInput, insertFutureItem, getPeriodReview,
} from '../db/store';
import { aggregateSnapshot } from './aggregator';
import { aggregateDailyReview } from './reviewer';
import { aggregatePeriodReview, applyPeriodPlan } from './period-reviewer';
import type {
  TradeOperation, TradeOperationUploadRequest,
  OperationEvaluation, OperationEvaluationUploadRequest,
  PretradeReview, PretradeReviewCreateRequest,
  ReviewJournal, ReviewJournalCreateRequest, ReviewJournalPatchRequest,
  TradingPermissionCard, TradingPermissionCardUpsertRequest,
  PositionPlan, PositionPlanUpsertRequest,
  NextTradePlan, NextTradePlanUpsertRequest,
  PeriodReviewPlanRequest, PeriodType,
  BaselineInput, FutureWatchItem, InputUploadRequest,
} from '../models/types';

export type WriteToolName =
  | 'create_baseline_input'
  | 'trigger_aggregate_baseline'
  | 'trigger_aggregate_daily_review'
  | 'trigger_aggregate_period_review'
  | 'create_journal'
  | 'patch_journal'
  | 'create_operation_evaluation'
  | 'create_pretrade_review'
  | 'create_trade_operation'
  | 'update_trade_operation'
  | 'delete_trade_operation'
  | 'propose_apply_period_plan'
  | 'propose_upsert_permission_card'
  | 'propose_upsert_position_plan'
  | 'propose_upsert_next_trade_plan'
  | 'propose_override_baseline'
  | 'propose_replace_journal';

export type SideEffect = 'write_direct' | 'write_confirm';

export interface WriteHandler {
  name: WriteToolName;
  description: string;
  parameters: Record<string, unknown>;
  side_effect: SideEffect;
  risk: 'low' | 'medium' | 'high';
  /** 卡片副标题，写明"做什么、对哪个目标" */
  preview: (args: Record<string, unknown>) => { summary: string; target?: string };
  /** 写前快照（无快照可返回 null） */
  snapshot: (args: Record<string, unknown>) => unknown | null;
  /** 实际写入 */
  apply: (args: Record<string, unknown>, ctx: { source: string }) => Promise<unknown> | unknown;
}

const NS_PERIOD: ReadonlyArray<PeriodType> = ['week', 'month'];

function ymd(s: unknown): string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`参数必须为 YYYY-MM-DD 格式，收到：${JSON.stringify(s)}`);
  }
  return s;
}

function str(name: string, args: Record<string, unknown>, required = true): string | undefined {
  const v = args[name];
  if (v == null || v === '') {
    if (required) throw new Error(`参数 ${name} 必填`);
    return undefined;
  }
  return String(v);
}

function strArr(args: Record<string, unknown>, name: string): string[] | undefined {
  const v = args[name];
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error(`参数 ${name} 必须为字符串数组`);
  return v.map((x) => String(x));
}

function num(args: Record<string, unknown>, name: string, required = false): number | undefined {
  const v = args[name];
  if (v == null || v === '') {
    if (required) throw new Error(`参数 ${name} 必填`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须为数字`);
  return n;
}

function nowIso(): string { return new Date().toISOString(); }

/* ─────────────────────────────────────────────
 * 1. create_baseline_input  (direct, low)
 * ───────────────────────────────────────────── */
const tCreateBaselineInput: WriteHandler = {
  name: 'create_baseline_input',
  side_effect: 'write_direct',
  risk: 'low',
  description: '写入一条客观市场基线 input（market_snapshot / market_event / stage_signal / risk_alert / future_event 等）。data_type=future_event 会写入 future_watchlist；其余会触发当日 baseline 重聚合。',
  parameters: {
    type: 'object',
    properties: {
      time_key: { type: 'string', description: '日期 YYYY-MM-DD' },
      data_type: {
        type: 'string',
        enum: [
          'market_snapshot', 'emotion_metric', 'market_event', 'future_event',
          'manual_note', 'trade_plan', 'risk_alert', 'stage_signal',
          'position_suggestion',
        ],
      },
      title: { type: 'string', description: '简短标题' },
      payload: { type: 'object', description: '结构化负载', additionalProperties: true },
      tags: { type: 'array', items: { type: 'string' } },
      priority: { type: 'number', description: '0-10，默认 5' },
      confidence: { type: 'number', description: '0-1，默认 0.8' },
      effective_start: { type: 'string', description: 'ISO 时间，可选；future_event 用作开始时间' },
      effective_end: { type: 'string', description: 'ISO 时间，可选；future_event 的结束时间' },
    },
    required: ['time_key', 'data_type', 'title'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `写入 ${args['time_key']} 的 baseline ${args['data_type']}：${args['title']}`,
    target: `baseline:${args['time_key']}`,
  }),
  snapshot: () => null,
  async apply(args, ctx) {
    const date = ymd(args['time_key']);
    const dataType = String(args['data_type']);
    const title = str('title', args)!;
    const payload = (args['payload'] as Record<string, unknown>) ?? {};
    const tags = strArr(args, 'tags') ?? [];
    const priority = num(args, 'priority') ?? 5;
    const confidence = num(args, 'confidence') ?? 0.8;
    const startTs = str('effective_start', args, false);
    const endTs = str('effective_end', args, false);

    if (dataType === 'future_event') {
      const item: FutureWatchItem = {
        id: uuidv4(),
        expected_time: startTs ?? date,
        expected_end_time: endTs,
        event_type: (payload['event_type'] as string) ?? 'generic',
        title,
        payload,
        certainty: (payload['certainty'] as FutureWatchItem['certainty']) ?? 'medium',
        impact_level: confidence,
        review_status: 'pending',
        linked_snapshot_time_key: date,
        created_at: nowIso(),
      };
      const saved = insertFutureItem(item);
      return { type: 'future_watchlist', id: saved.id };
    }
    const input: BaselineInput = {
      id: uuidv4(),
      time_key: date,
      time_granularity: 'day',
      data_type: dataType as InputUploadRequest['data_type'],
      source: ctx.source,
      source_type: 'agent',
      title,
      payload,
      confidence,
      priority,
      tags,
      effective_start: startTs,
      effective_end: endTs,
      created_at: nowIso(),
      created_by: ctx.source,
      status: 'active',
    };
    insertInput(input);
    const snap = await aggregateSnapshot(date);
    return { input_id: input.id, snapshot_id: snap.id, snapshot_stage: snap.market_stage };
  },
};

/* ─────────────────────────────────────────────
 * 2. trigger_aggregate_baseline
 * ───────────────────────────────────────────── */
const tAggBaseline: WriteHandler = {
  name: 'trigger_aggregate_baseline',
  side_effect: 'write_direct',
  risk: 'low',
  description: '触发某日 baseline snapshot 重聚合（不写入新数据，只是基于已有 inputs 重算阶段/情绪/风险）。',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['date'],
    additionalProperties: false,
  },
  preview: (args) => ({ summary: `重聚合 ${args['date']} 的 baseline snapshot`, target: `baseline:${args['date']}` }),
  snapshot: () => null,
  async apply(args) {
    const date = ymd(args['date']);
    const snap = await aggregateSnapshot(date);
    return { snapshot_id: snap.id, market_stage: snap.market_stage, emotion_score: snap.emotion_score };
  },
};

/* ─────────────────────────────────────────────
 * 3. trigger_aggregate_daily_review
 * ───────────────────────────────────────────── */
const tAggDaily: WriteHandler = {
  name: 'trigger_aggregate_daily_review',
  side_effect: 'write_direct',
  risk: 'low',
  description: '基于当日 operations + evaluations 重新聚合 daily_review（覆盖 avg_score / win_rate / mood_summary 等自动字段；保留 plan 字段如 next_actions）。',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['date'],
    additionalProperties: false,
  },
  preview: (args) => ({ summary: `重聚合 ${args['date']} daily_review`, target: `daily_review:${args['date']}` }),
  snapshot: () => null,
  apply(args) {
    const date = ymd(args['date']);
    const r = aggregateDailyReview(date);
    return { date, operations_count: r.operations_count, avg_score: r.avg_score };
  },
};

/* ─────────────────────────────────────────────
 * 4. trigger_aggregate_period_review
 * ───────────────────────────────────────────── */
const tAggPeriod: WriteHandler = {
  name: 'trigger_aggregate_period_review',
  side_effect: 'write_direct',
  risk: 'low',
  description: '触发周/月聚合复盘重算。type=week 时 period_key 形如 2026-W18；type=month 时形如 2026-04。会保留人工写入字段（narrative/improvements 等）。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['week', 'month'] },
      period_key: { type: 'string', description: '形如 2026-W18 或 2026-04' },
    },
    required: ['type', 'period_key'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `重聚合 ${args['type']} ${args['period_key']}`,
    target: `${args['type']}_review:${args['period_key']}`,
  }),
  snapshot: () => null,
  apply(args) {
    const type = String(args['type']) as PeriodType;
    if (!NS_PERIOD.includes(type)) throw new Error('type 必须为 week / month');
    const key = str('period_key', args)!;
    const r = aggregatePeriodReview(type, key);
    return { period_key: r.period_key, operations_count: r.operations_count, avg_score: r.avg_score };
  },
};

/* ─────────────────────────────────────────────
 * 5. create_journal  (direct)
 * ───────────────────────────────────────────── */
function buildJournal(body: ReviewJournalCreateRequest, source: string): ReviewJournal {
  const now = nowIso();
  return {
    id: uuidv4(),
    scope: body.scope,
    period_key: body.period_key,
    start_date: body.start_date,
    end_date: body.end_date,
    title: body.title,
    summary: body.summary,
    body: body.body,
    sections: body.sections ?? [],
    market_observation: body.market_observation,
    strategy_review: body.strategy_review,
    key_takeaways: body.key_takeaways ?? [],
    mistakes: body.mistakes ?? [],
    improvements: body.improvements ?? [],
    playbook_updates: body.playbook_updates ?? [],
    next_actions: body.next_actions ?? [],
    tags: body.tags ?? [],
    source: body.source ?? source,
    status: body.status ?? 'draft',
    metadata: body.metadata,
    created_at: now,
    updated_at: now,
    created_by: body.created_by ?? body.source ?? source,
  };
}

const tCreateJournal: WriteHandler = {
  name: 'create_journal',
  side_effect: 'write_direct',
  risk: 'low',
  description: '新建一篇复盘日志（追加，不覆盖任何现有数据）。scope: week/month/custom；status 默认 draft，写完整稿才传 final。',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['week', 'month', 'custom'] },
      period_key: { type: 'string', description: 'week→YYYY-Www / month→YYYY-MM / custom→任意' },
      title: { type: 'string' },
      summary: { type: 'string' },
      body: { type: 'string', description: '正文，支持 markdown' },
      market_observation: { type: 'string' },
      strategy_review: { type: 'string' },
      key_takeaways: { type: 'array', items: { type: 'string' } },
      mistakes: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      playbook_updates: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'final'], description: '默认 draft' },
      sections: { type: 'array', items: { type: 'object' } },
    },
    required: ['scope', 'period_key', 'title'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `新建一篇 ${args['scope']} 日志：${args['title']}`,
    target: `journal:${args['scope']}/${args['period_key']}`,
  }),
  snapshot: () => null,
  apply(args, ctx) {
    const j = insertJournal(buildJournal(args as unknown as ReviewJournalCreateRequest, ctx.source));
    return { id: j.id, scope: j.scope, period_key: j.period_key, status: j.status };
  },
};

/* ─────────────────────────────────────────────
 * 6. patch_journal  (direct, low)  — 局部增量更新
 * ───────────────────────────────────────────── */
const tPatchJournal: WriteHandler = {
  name: 'patch_journal',
  side_effect: 'write_direct',
  risk: 'low',
  description: '对已有 journal 做增量更新（例如 append 一段 body 或追加 next_actions）。注意：传入字段会整体替换；如要追加，请先用 read tool 拿到现有内容再合并。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'journal id' },
      title: { type: 'string' },
      summary: { type: 'string' },
      body: { type: 'string' },
      market_observation: { type: 'string' },
      strategy_review: { type: 'string' },
      key_takeaways: { type: 'array', items: { type: 'string' } },
      mistakes: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      playbook_updates: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'final'] },
    },
    required: ['id'],
    additionalProperties: false,
  },
  preview: (args) => ({ summary: `更新 journal ${String(args['id']).slice(0, 12)}…`, target: `journal:${args['id']}` }),
  snapshot: (args) => getJournalById(String(args['id'])) ?? null,
  apply(args) {
    const id = str('id', args)!;
    const { id: _ignore, ...patch } = args as ReviewJournalPatchRequest & { id: string };
    void _ignore;
    const j = updateJournal(id, patch as Partial<ReviewJournal>);
    if (!j) throw new Error(`journal 不存在: ${id}`);
    return { id: j.id, status: j.status, updated_at: j.updated_at };
  },
};

/* ─────────────────────────────────────────────
 * 7. create_operation_evaluation  (direct, low)
 * ───────────────────────────────────────────── */
const tCreateEval: WriteHandler = {
  name: 'create_operation_evaluation',
  side_effect: 'write_direct',
  risk: 'low',
  description: '为某笔交易追加 / 替换一条评估（同一 evaluator 对同一 operation 只保留最新一条）。会触发 daily_review 重聚合。',
  parameters: {
    type: 'object',
    properties: {
      operation_id: { type: 'string' },
      score: { type: 'number', description: '0-100' },
      verdict: { type: 'string', enum: ['excellent', 'good', 'neutral', 'poor', 'bad'] },
      alignment_score: { type: 'number', description: '与当时 baseline 的契合度 0-100，默认 50' },
      pros: { type: 'array', items: { type: 'string' } },
      cons: { type: 'array', items: { type: 'string' } },
      suggestions: { type: 'array', items: { type: 'string' } },
      next_action_hint: { type: 'string' },
      evaluator: { type: 'string', description: '默认 agent:chat' },
    },
    required: ['operation_id', 'score', 'verdict'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `给操作 ${String(args['operation_id']).slice(0, 12)}… 打分 ${args['score']} (${args['verdict']})`,
    target: `eval:${args['operation_id']}`,
  }),
  snapshot: () => null,
  apply(args, ctx) {
    const opId = str('operation_id', args)!;
    const op = getOperationById(opId);
    if (!op) throw new Error(`operation 不存在: ${opId}`);
    const body = args as unknown as OperationEvaluationUploadRequest;
    const ev: OperationEvaluation = {
      id: uuidv4(),
      operation_id: op.id,
      time_key: op.time_key,
      evaluator: body.evaluator ?? ctx.source,
      score: Number(body.score),
      verdict: body.verdict,
      alignment_score: Number(body.alignment_score ?? 50),
      pros: body.pros ?? [],
      cons: body.cons ?? [],
      suggestions: body.suggestions ?? [],
      next_action_hint: body.next_action_hint,
      created_at: nowIso(),
    };
    insertEvaluation(ev);
    aggregateDailyReview(op.time_key);
    return { evaluation_id: ev.id, operation_id: ev.operation_id, score: ev.score, verdict: ev.verdict };
  },
};

/* ─────────────────────────────────────────────
 * 8. create_pretrade_review  (direct, low)
 * ───────────────────────────────────────────── */
const tCreatePretrade: WriteHandler = {
  name: 'create_pretrade_review',
  side_effect: 'write_direct',
  risk: 'low',
  description: '记录一条盘中买入预审日志（不下单，仅留痕）。verdict: REJECT / WAIT / ALLOW_SMALL / ALLOW。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      symbol: { type: 'string' },
      name: { type: 'string' },
      action: { type: 'string', enum: ['buy', 'add', 'rebuy', 'switch'] },
      risk_action: { type: 'string', enum: ['new_buy', 'add_winner', 'add_loser', 'rebuy_same_symbol', 'switch_position', 'reduce', 'sell', 'hold'] },
      mode: { type: 'string', description: '该操作所属模式名，例如 A类启动确认' },
      rationale: { type: 'string' },
      exit_condition: { type: 'string', description: '亏损/触发卖出条件' },
      verdict: { type: 'string', enum: ['REJECT', 'WAIT', 'ALLOW_SMALL', 'ALLOW'] },
      planned_quantity: { type: 'number' },
      planned_amount: { type: 'number' },
      planned_price: { type: 'number' },
      source_sell_symbol: { type: 'string', description: '调仓来源卖出标的代码' },
      source_sell_amount: { type: 'number', description: '调仓来源卖出金额' },
      net_position_delta: { type: 'number', description: '本次交易导致总仓净变化，0.05 表示增加 5%' },
      current_total_position: { type: 'number', description: '交易前总仓位，0-1' },
      projected_total_position: { type: 'number', description: '交易后总仓位，0-1' },
      max_allowed_amount: { type: 'number' },
      reasons: { type: 'array', items: { type: 'string' } },
      wait_conditions: { type: 'array', items: { type: 'string' } },
      forbidden_actions: { type: 'array', items: { type: 'string' } },
      matched_risk_rules: { type: 'array', items: { type: 'string' } },
      current_position_note: { type: 'string' },
      checked_permission_date: { type: 'string', description: 'YYYY-MM-DD' },
      checked_permission_status: { type: 'string', enum: ['protect', 'normal', 'attack'] },
      market_snapshot: { type: 'object', additionalProperties: true },
    },
    required: ['date', 'symbol', 'name', 'action', 'mode', 'rationale', 'exit_condition', 'verdict'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `预审 ${args['symbol']} ${args['action']} → ${args['verdict']}`,
    target: `pretrade:${args['date']}/${args['symbol']}`,
  }),
  snapshot: () => null,
  apply(args, ctx) {
    const body = args as unknown as PretradeReviewCreateRequest;
    const r: PretradeReview = {
      id: uuidv4(),
      date: ymd(body.date),
      timestamp: body.timestamp ?? nowIso(),
      symbol: body.symbol,
      name: body.name,
      action: body.action,
      risk_action: body.risk_action,
      planned_quantity: body.planned_quantity,
      planned_amount: body.planned_amount,
      planned_price: body.planned_price,
      source_sell_symbol: body.source_sell_symbol,
      source_sell_amount: body.source_sell_amount,
      net_position_delta: body.net_position_delta,
      current_total_position: body.current_total_position,
      projected_total_position: body.projected_total_position,
      mode: body.mode,
      rationale: body.rationale,
      exit_condition: body.exit_condition,
      current_position_note: body.current_position_note,
      verdict: body.verdict,
      max_allowed_amount: body.max_allowed_amount,
      reasons: body.reasons ?? [],
      wait_conditions: body.wait_conditions ?? [],
      forbidden_actions: body.forbidden_actions ?? [],
      matched_risk_rules: body.matched_risk_rules ?? [],
      checked_permission_date: body.checked_permission_date,
      checked_permission_status: body.checked_permission_status,
      linked_position_plan_id: body.linked_position_plan_id,
      market_snapshot: body.market_snapshot,
      source: body.source ?? ctx.source,
      created_at: nowIso(),
    };
    insertPretradeReview(r);
    return { id: r.id, verdict: r.verdict };
  },
};

/* ─────────────────────────────────────────────
 * 9. create_trade_operation  (direct, low) — 创建交易记录
 * ───────────────────────────────────────────── */
const tCreateOp: WriteHandler = {
  name: 'create_trade_operation',
  side_effect: 'write_direct',
  risk: 'low',
  description: '记录一笔交易操作（直接落库 + 触发当日 daily_review 重聚合）。direction: buy/sell/add/reduce/hold/observe/plan。注意：写错可用 update_trade_operation 改、delete_trade_operation 删。',
  parameters: {
    type: 'object',
    properties: {
      time_key: { type: 'string', description: 'YYYY-MM-DD' },
      timestamp: { type: 'string', description: 'ISO8601 精确到分（可选；默认现在）' },
      symbol: { type: 'string' },
      name: { type: 'string' },
      direction: { type: 'string', enum: ['buy', 'sell', 'add', 'reduce', 'hold', 'observe', 'plan'] },
      quantity: { type: 'number' },
      price: { type: 'number' },
      amount: { type: 'number', description: '不传则按 quantity*price 算' },
      rationale: { type: 'string', description: '操作依据（自由文本）' },
      rationale_type: {
        type: 'string',
        enum: ['technical', 'fundamental', 'news', 'baseline', 'emotion', 'impulsive', 'system', 'mixed'],
      },
      emotion_state: {
        type: 'string',
        enum: ['calm', 'confident', 'excited', 'fomo', 'greedy', 'fearful', 'panic', 'regret', 'revenge'],
      },
      tags: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['time_key', 'symbol', 'name', 'direction', 'rationale', 'rationale_type', 'emotion_state'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `${args['time_key']} 创建交易：${args['symbol']} ${args['direction']} ${args['quantity'] ?? '?'}@${args['price'] ?? '?'}`,
    target: `operation:${args['time_key']}/${args['symbol']}`,
  }),
  snapshot: () => null,
  apply(args, ctx) {
    const body = args as unknown as TradeOperationUploadRequest;
    const date = ymd(body.time_key);
    const snap = getSnapshotByDate(date);
    const qty = body.quantity ?? 0;
    const price = body.price ?? 0;
    const amount = body.amount ?? (qty && price ? +(qty * price).toFixed(2) : undefined);
    const op: TradeOperation = {
      id: uuidv4(),
      time_key: date,
      timestamp: body.timestamp ?? nowIso(),
      symbol: body.symbol,
      name: body.name,
      direction: body.direction,
      quantity: body.quantity,
      price: body.price,
      amount,
      rationale: body.rationale,
      rationale_type: body.rationale_type,
      emotion_state: body.emotion_state,
      linked_baseline_stage: snap?.market_stage,
      linked_baseline_emotion: snap?.emotion_score,
      tags: body.tags ?? [],
      notes: body.notes,
      created_at: nowIso(),
      created_by: body.created_by ?? ctx.source,
    };
    insertOperation(op);
    aggregateDailyReview(date);
    return { operation_id: op.id, time_key: op.time_key, symbol: op.symbol, direction: op.direction, amount };
  },
};

/* ─────────────────────────────────────────────
 * 9b. update_trade_operation  (direct, low) — 修正一笔交易
 *     仅允许改：quantity/price/amount/timestamp/rationale/rationale_type/emotion_state/tags/notes/direction
 *     不允许改：id/time_key/symbol/name/created_at/created_by/linked_baseline_*
 *     如要改这些请先 delete 再 create。
 * ───────────────────────────────────────────── */
const tUpdateOp: WriteHandler = {
  name: 'update_trade_operation',
  side_effect: 'write_direct',
  risk: 'low',
  description: '修正一笔已记录的交易（手敲错数量/价格/依据/情绪等时使用）。不允许改 time_key/symbol/name —— 这些字段写错请先 delete 再 create。修改后会自动重聚合 daily_review。',
  parameters: {
    type: 'object',
    properties: {
      operation_id: { type: 'string', description: '要修正的 operation id' },
      direction: { type: 'string', enum: ['buy', 'sell', 'add', 'reduce', 'hold', 'observe', 'plan'] },
      quantity: { type: 'number' },
      price: { type: 'number' },
      amount: { type: 'number', description: '不传则按 quantity*price 重新算' },
      timestamp: { type: 'string', description: 'ISO8601' },
      rationale: { type: 'string' },
      rationale_type: {
        type: 'string',
        enum: ['technical', 'fundamental', 'news', 'baseline', 'emotion', 'impulsive', 'system', 'mixed'],
      },
      emotion_state: {
        type: 'string',
        enum: ['calm', 'confident', 'excited', 'fomo', 'greedy', 'fearful', 'panic', 'regret', 'revenge'],
      },
      tags: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['operation_id'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `修正交易 ${String(args['operation_id']).slice(0, 12)}…`,
    target: `operation:${args['operation_id']}`,
  }),
  snapshot: (args) => getOperationById(String(args['operation_id'])) ?? null,
  apply(args) {
    const id = str('operation_id', args)!;
    const old = getOperationById(id);
    if (!old) throw new Error(`operation 不存在: ${id}`);
    const patch: Partial<TradeOperation> = {};
    const keys: (keyof TradeOperation)[] = [
      'direction', 'quantity', 'price', 'amount', 'timestamp',
      'rationale', 'rationale_type', 'emotion_state', 'tags', 'notes',
    ];
    for (const k of keys) {
      if (k in args && args[k] !== undefined) {
        (patch as Record<string, unknown>)[k] = args[k];
      }
    }
    // 若改了 quantity 或 price 但没传 amount，自动重算
    if ((patch.quantity !== undefined || patch.price !== undefined) && patch.amount === undefined) {
      const q = patch.quantity ?? old.quantity ?? 0;
      const p = patch.price ?? old.price ?? 0;
      if (q && p) patch.amount = +(q * p).toFixed(2);
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('未提供任何要修改的字段');
    }
    const after = updateOperation(id, patch);
    if (!after) throw new Error(`update 失败: ${id}`);
    aggregateDailyReview(after.time_key);
    return {
      operation_id: after.id,
      changed_keys: Object.keys(patch),
      before: { quantity: old.quantity, price: old.price, amount: old.amount, direction: old.direction },
      after: { quantity: after.quantity, price: after.price, amount: after.amount, direction: after.direction },
    };
  },
};

/* ─────────────────────────────────────────────
 * 9c. delete_trade_operation  (direct, medium) — 删除一笔交易
 *     破坏性，但完整 audit 含 snapshot_before，可从 jsonl 恢复。
 * ───────────────────────────────────────────── */
const tDeleteOp: WriteHandler = {
  name: 'delete_trade_operation',
  side_effect: 'write_direct',
  risk: 'medium',
  description: '删除一笔交易记录（同步删除该 operation 的全部 evaluation）。破坏性操作，但 audit log 保留完整快照可追溯/恢复。注意：此工具不需用户确认，调前请务必先 read 一次确认目标正确。',
  parameters: {
    type: 'object',
    properties: {
      operation_id: { type: 'string' },
    },
    required: ['operation_id'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `删除交易 ${String(args['operation_id']).slice(0, 12)}…`,
    target: `operation:${args['operation_id']}`,
  }),
  snapshot: (args) => getOperationById(String(args['operation_id'])) ?? null,
  apply(args) {
    const id = str('operation_id', args)!;
    const old = getOperationById(id);
    if (!old) throw new Error(`operation 不存在: ${id}`);
    const ok = deleteOperation(id);
    if (!ok) throw new Error(`delete 失败: ${id}`);
    aggregateDailyReview(old.time_key);
    return {
      deleted_operation_id: id,
      time_key: old.time_key,
      symbol: old.symbol,
      direction: old.direction,
    };
  },
};

/* ─────────────────────────────────────────────
 * 10. propose_apply_period_plan  (confirm, medium)
 * ───────────────────────────────────────────── */
const tProposePeriodPlan: WriteHandler = {
  name: 'propose_apply_period_plan',
  side_effect: 'write_confirm',
  risk: 'medium',
  description: '【需用户确认】覆盖周/月复盘的人工写入字段（narrative / improvements / playbook_updates / next_actions / monthly_thesis 等）。注意会整体替换传入数组。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['week', 'month'] },
      period_key: { type: 'string', description: '形如 2026-W18 / 2026-04' },
      narrative: { type: 'string' },
      monthly_thesis: { type: 'string', description: '仅 month 用' },
      key_takeaways: { type: 'array', items: { type: 'string' } },
      mistakes: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      playbook_updates: { type: 'array', items: { type: 'string' } },
      pattern_insights: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'period_key'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `覆盖 ${args['type']} ${args['period_key']} 的人工字段`,
    target: `${args['type']}_review:${args['period_key']}`,
  }),
  snapshot(args) {
    const type = String(args['type']) as PeriodType;
    const key = str('period_key', args)!;
    return getPeriodReview(type, key) ?? null;
  },
  apply(args) {
    const type = String(args['type']) as PeriodType;
    if (!NS_PERIOD.includes(type)) throw new Error('type 必须为 week / month');
    const key = str('period_key', args)!;
    const body = args as unknown as PeriodReviewPlanRequest;
    const patch: Record<string, unknown> = {};
    if (Array.isArray(body.next_actions)) patch.next_actions = body.next_actions;
    if (Array.isArray(body.key_takeaways)) patch.key_takeaways = body.key_takeaways;
    if (Array.isArray(body.mistakes)) patch.mistakes = body.mistakes;
    if (Array.isArray(body.improvements)) patch.improvements = body.improvements;
    if (Array.isArray(body.playbook_updates)) patch.playbook_updates = body.playbook_updates;
    if (Array.isArray(body.pattern_insights)) patch.pattern_insights = body.pattern_insights;
    if (typeof body.narrative === 'string') patch.narrative = body.narrative;
    if (typeof body.monthly_thesis === 'string' && type === 'month') patch.monthly_thesis = body.monthly_thesis;
    const r = applyPeriodPlan(type, key, patch);
    return { period_key: r.period_key, narrative: r.narrative, next_actions_count: r.next_actions.length };
  },
};

/* ─────────────────────────────────────────────
 * 11. propose_upsert_permission_card  (confirm, high)
 * ───────────────────────────────────────────── */
const tProposePermission: WriteHandler = {
  name: 'propose_upsert_permission_card',
  side_effect: 'write_confirm',
  risk: 'high',
  description: '【需用户确认】写入 / 覆盖某日交易权限卡，决定次日交易刹车（status / max_total_position / forbidden_actions / allowed_modes 等）。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      status: { type: 'string', enum: ['protect', 'normal', 'attack'] },
      max_total_position: { type: 'number', description: '0-1 小数' },
      allow_margin: { type: 'boolean' },
      allowed_modes: { type: 'array', items: { type: 'string' } },
      forbidden_actions: { type: 'array', items: { type: 'string' } },
      stop_triggers: { type: 'array', items: { type: 'string' } },
      risk_matrix: { type: 'object', additionalProperties: true },
      rationale: { type: 'string', description: '一句话总结今日为何这个状态' },
      generated_from: { type: 'object', additionalProperties: true },
      locked: { type: 'boolean', description: '是否锁定（locked 后只能用 force 覆盖）' },
    },
    required: ['date', 'status', 'max_total_position'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `权限卡 ${args['date']} → ${args['status']} / 最大仓位 ${args['max_total_position']}`,
    target: `permission:${args['date']}`,
  }),
  snapshot: (args) => getPermissionCard(ymd(args['date'])) ?? null,
  apply(args, ctx) {
    const body = args as unknown as TradingPermissionCardUpsertRequest;
    const existing = getPermissionCard(body.date);
    const card: TradingPermissionCard = {
      date: body.date,
      status: body.status,
      max_total_position: body.max_total_position ?? existing?.max_total_position,
      allow_margin: body.allow_margin ?? existing?.allow_margin ?? false,
      allowed_modes: body.allowed_modes ?? existing?.allowed_modes ?? [],
      forbidden_actions: body.forbidden_actions ?? existing?.forbidden_actions ?? [],
      stop_triggers: body.stop_triggers ?? existing?.stop_triggers ?? [],
      risk_matrix: body.risk_matrix ?? existing?.risk_matrix,
      rationale: body.rationale ?? existing?.rationale ?? '',
      generated_from: body.generated_from ?? existing?.generated_from ?? {},
      source: body.source ?? ctx.source,
      locked: body.locked ?? existing?.locked ?? false,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    const r = upsertPermissionCard(card, { force: true });
    if (r.locked_skipped) throw new Error('权限卡已锁定且 force 失败（不应发生）');
    if (typeof body.locked === 'boolean') {
      setPermissionCardLock(body.date, body.locked);
    }
    return { date: r.card.date, status: r.card.status, locked: r.card.locked };
  },
};

/* ─────────────────────────────────────────────
 * 12. propose_upsert_position_plan  (confirm, high)
 * ───────────────────────────────────────────── */
const tProposePositionPlan: WriteHandler = {
  name: 'propose_upsert_position_plan',
  side_effect: 'write_confirm',
  risk: 'high',
  description: '【需用户确认】写入 / 覆盖某日某只标的的持仓计划卡（明日唯一允许动作）。category 与 allowed_action 必填。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      symbol: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string', enum: ['hard_failed', 'conditional_failed', 'positive_feedback', 'watch', 'defensive', 'closed'] },
      allowed_action: { type: 'string', enum: ['sell_only', 'reduce_only', 'hold_or_reduce', 'hold_only', 'observe_only', 'no_action'] },
      quantity: { type: 'number' },
      cost_price: { type: 'number' },
      last_price: { type: 'number' },
      market_value: { type: 'number' },
      unrealized_pnl: { type: 'number' },
      position_ratio: { type: 'number', description: '占总仓位 0-1' },
      invalidation_price: { type: 'number', description: '失效价（破位减仓）' },
      rebound_reduce_price: { type: 'number', description: '反抽减仓价' },
      forbidden_actions: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      locked: { type: 'boolean' },
    },
    required: ['date', 'symbol', 'name', 'category', 'allowed_action'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `持仓计划 ${args['date']} ${args['symbol']} → ${args['category']}/${args['allowed_action']}`,
    target: `position_plan:${args['date']}/${args['symbol']}`,
  }),
  snapshot: (args) => getPositionPlan(ymd(args['date']), str('symbol', args)!) ?? null,
  apply(args, ctx) {
    const body = args as unknown as PositionPlanUpsertRequest;
    const existing = getPositionPlan(body.date, body.symbol);
    const plan: PositionPlan = {
      id: existing?.id ?? uuidv4(),
      date: body.date,
      symbol: body.symbol,
      name: body.name,
      quantity: body.quantity,
      cost_price: body.cost_price,
      last_price: body.last_price,
      market_value: body.market_value,
      unrealized_pnl: body.unrealized_pnl,
      position_ratio: body.position_ratio,
      category: body.category,
      allowed_action: body.allowed_action,
      invalidation_price: body.invalidation_price,
      rebound_reduce_price: body.rebound_reduce_price,
      forbidden_actions: body.forbidden_actions ?? [],
      rationale: body.rationale ?? '',
      source: body.source ?? ctx.source,
      locked: body.locked ?? existing?.locked ?? false,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    const r = upsertPositionPlan(plan, { force: true });
    if (r.locked_skipped) throw new Error('持仓计划已锁定且 force 失败');
    if (typeof body.locked === 'boolean') {
      setPositionPlanLock(body.date, body.symbol, body.locked);
    }
    return { date: r.plan.date, symbol: r.plan.symbol, category: r.plan.category, locked: r.plan.locked };
  },
};

/* ─────────────────────────────────────────────
 * 13. propose_upsert_next_trade_plan  (confirm, high)
 * ───────────────────────────────────────────── */
const tProposeNextTradePlan: WriteHandler = {
  name: 'propose_upsert_next_trade_plan',
  side_effect: 'write_confirm',
  risk: 'high',
  description: '【需用户确认】写入 / 覆盖某日下一交易日交易计划（预计开仓、观察池、持仓处理备注）。盘中预审会优先参考该计划。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      market_view: { type: 'string' },
      max_total_position: { type: 'number', description: '计划总仓上限，0-1' },
      focus_themes: { type: 'array', items: { type: 'string' } },
      no_trade_rules: { type: 'array', items: { type: 'string' } },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            name: { type: 'string' },
            mode: { type: 'string' },
            risk_action: { type: 'string', enum: ['new_buy', 'add_winner', 'add_loser', 'rebuy_same_symbol', 'switch_position', 'reduce', 'sell', 'hold'] },
            planned_amount: { type: 'number' },
            planned_position: { type: 'number', description: '计划仓位，0-1' },
            thesis: { type: 'string' },
            entry_triggers: { type: 'array', items: { type: 'string' } },
            invalidation_condition: { type: 'string' },
            priority: { type: 'number' },
            status: { type: 'string', enum: ['planned', 'watch', 'triggered', 'cancelled'] },
            notes: { type: 'string' },
          },
          required: ['symbol', 'name', 'mode', 'thesis', 'entry_triggers', 'invalidation_condition', 'status'],
          additionalProperties: false,
        },
      },
      watchlist: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            name: { type: 'string' },
            watch_reason: { type: 'string' },
            trigger_conditions: { type: 'array', items: { type: 'string' } },
            upgrade_condition: { type: 'string' },
            status: { type: 'string', enum: ['planned', 'watch', 'triggered', 'cancelled'] },
            notes: { type: 'string' },
          },
          required: ['symbol', 'name', 'watch_reason', 'trigger_conditions', 'status'],
          additionalProperties: false,
        },
      },
      position_notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            name: { type: 'string' },
            plan_id: { type: 'string' },
            action_plan: { type: 'string' },
            key_levels: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
          },
          required: ['symbol', 'name', 'action_plan'],
          additionalProperties: false,
        },
      },
      locked: { type: 'boolean' },
    },
    required: ['date'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `下一交易日计划 ${args['date']}：开仓 ${Array.isArray(args['entries']) ? args['entries'].length : 0} / 观察 ${Array.isArray(args['watchlist']) ? args['watchlist'].length : 0}`,
    target: `next_trade_plan:${args['date']}`,
  }),
  snapshot: (args) => getNextTradePlan(ymd(args['date'])) ?? null,
  apply(args, ctx) {
    const body = args as unknown as NextTradePlanUpsertRequest;
    const existing = getNextTradePlan(body.date);
    const plan: NextTradePlan = {
      id: existing?.id ?? uuidv4(),
      date: body.date,
      market_view: body.market_view ?? existing?.market_view ?? '',
      max_total_position: body.max_total_position,
      focus_themes: body.focus_themes ?? existing?.focus_themes ?? [],
      no_trade_rules: body.no_trade_rules ?? existing?.no_trade_rules ?? [],
      entries: body.entries ?? existing?.entries ?? [],
      watchlist: body.watchlist ?? existing?.watchlist ?? [],
      position_notes: body.position_notes ?? existing?.position_notes ?? [],
      source: body.source ?? ctx.source,
      locked: body.locked ?? existing?.locked ?? false,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    const r = upsertNextTradePlan(plan, { force: true });
    if (r.locked_skipped) throw new Error('下一交易日计划已锁定且 force 失败');
    if (typeof body.locked === 'boolean') {
      setNextTradePlanLock(body.date, body.locked);
    }
    return { date: r.plan.date, entries: r.plan.entries.length, watchlist: r.plan.watchlist.length, locked: r.plan.locked };
  },
};

/* ─────────────────────────────────────────────
 * 14. propose_override_baseline  (confirm, medium)
 * ───────────────────────────────────────────── */
const tProposeOverride: WriteHandler = {
  name: 'propose_override_baseline',
  side_effect: 'write_confirm',
  risk: 'medium',
  description: '【需用户确认】对某日 baseline 做人工修正（覆盖 market_stage / emotion_score / risk_level / position_min/max / action_summary）。会触发当日 baseline 重聚合。',
  parameters: {
    type: 'object',
    properties: {
      time_key: { type: 'string', description: 'YYYY-MM-DD' },
      market_stage: { type: 'string', enum: ['CHAOS', 'REPAIR_EARLY', 'REPAIR_CONFIRM', 'MAIN_UP', 'HIGH_RISK', 'DISTRIBUTION', 'UNKNOWN'] },
      emotion_score: { type: 'number', description: '0-100' },
      risk_level: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] },
      position_min: { type: 'number', description: '0-1' },
      position_max: { type: 'number', description: '0-1' },
      action_summary: { type: 'string' },
      note: { type: 'string', description: '修正原因' },
    },
    required: ['time_key'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `修正 ${args['time_key']} 基线 → stage=${args['market_stage'] ?? '?'} / risk=${args['risk_level'] ?? '?'}`,
    target: `baseline_override:${args['time_key']}`,
  }),
  snapshot: (args) => getSnapshotByDate(ymd(args['time_key'])) ?? null,
  async apply(args, ctx) {
    const date = ymd(args['time_key']);
    const input: BaselineInput = {
      id: uuidv4(),
      time_key: date,
      time_granularity: 'day',
      data_type: 'override',
      source: ctx.source,
      source_type: 'user',
      title: `人工修正 ${date}`,
      payload: {
        market_stage: args['market_stage'],
        emotion_score: args['emotion_score'],
        risk_level: args['risk_level'],
        position_min: args['position_min'],
        position_max: args['position_max'],
        action_summary: args['action_summary'],
        note: args['note'],
      },
      confidence: 1.0,
      priority: 10,
      tags: ['override'],
      created_at: nowIso(),
      created_by: ctx.source,
      status: 'active',
    };
    insertInput(input);
    const snap = await aggregateSnapshot(date);
    return { input_id: input.id, snapshot_stage: snap.market_stage, snapshot_risk: snap.risk_level };
  },
};

/* ─────────────────────────────────────────────
 * 14. propose_replace_journal  (confirm, medium)
 * ───────────────────────────────────────────── */
const tProposeReplaceJournal: WriteHandler = {
  name: 'propose_replace_journal',
  side_effect: 'write_confirm',
  risk: 'medium',
  description: '【需用户确认】完整替换一篇 journal（PUT 语义，所有字段以传入为准）。如要增量补内容请使用 patch_journal。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'journal id' },
      scope: { type: 'string', enum: ['week', 'month', 'custom'] },
      period_key: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      body: { type: 'string' },
      market_observation: { type: 'string' },
      strategy_review: { type: 'string' },
      key_takeaways: { type: 'array', items: { type: 'string' } },
      mistakes: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      playbook_updates: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'final'] },
    },
    required: ['id', 'scope', 'period_key', 'title'],
    additionalProperties: false,
  },
  preview: (args) => ({
    summary: `完整替换 journal ${String(args['id']).slice(0, 12)}…：${args['title']}`,
    target: `journal:${args['id']}`,
  }),
  snapshot: (args) => getJournalById(String(args['id'])) ?? null,
  apply(args, ctx) {
    const id = str('id', args)!;
    const cur = getJournalById(id);
    if (!cur) throw new Error(`journal 不存在: ${id}`);
    const body = args as unknown as ReviewJournalCreateRequest;
    const replacement = buildJournal(body, ctx.source);
    const merged: ReviewJournal = {
      ...replacement,
      id: cur.id,
      created_at: cur.created_at,
      updated_at: nowIso(),
    };
    const j = updateJournal(cur.id, merged);
    return { id: j!.id, status: j!.status, updated_at: j!.updated_at };
  },
};

export const WRITE_HANDLERS: Record<WriteToolName, WriteHandler> = {
  create_baseline_input: tCreateBaselineInput,
  trigger_aggregate_baseline: tAggBaseline,
  trigger_aggregate_daily_review: tAggDaily,
  trigger_aggregate_period_review: tAggPeriod,
  create_journal: tCreateJournal,
  patch_journal: tPatchJournal,
  create_operation_evaluation: tCreateEval,
  create_pretrade_review: tCreatePretrade,
  create_trade_operation: tCreateOp,
  update_trade_operation: tUpdateOp,
  delete_trade_operation: tDeleteOp,
  propose_apply_period_plan: tProposePeriodPlan,
  propose_upsert_permission_card: tProposePermission,
  propose_upsert_position_plan: tProposePositionPlan,
  propose_upsert_next_trade_plan: tProposeNextTradePlan,
  propose_override_baseline: tProposeOverride,
  propose_replace_journal: tProposeReplaceJournal,
};

export const WRITE_HANDLER_LIST: WriteHandler[] = Object.values(WRITE_HANDLERS);

export function getWriteHandler(name: string): WriteHandler | undefined {
  return WRITE_HANDLERS[name as WriteToolName];
}
