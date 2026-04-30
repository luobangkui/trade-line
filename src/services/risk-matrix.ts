import type {
  NextTradePlan,
  PermissionStatus,
  PositionPlan,
  PretradeAction,
  PretradeVerdict,
  RiskAction,
  RiskDecision,
  RiskMatrix,
  RiskRule,
  TradeDirection,
  TradingPermissionCard,
} from '../models/types';

export interface TradeIntent {
  date: string;
  timestamp?: string;
  symbol: string;
  name?: string;
  action?: PretradeAction | TradeDirection;
  risk_action?: RiskAction;
  mode?: string;
  planned_amount?: number;
  source_sell_amount?: number;
  net_position_delta?: number;
  current_total_position?: number;
  projected_total_position?: number;
  exit_condition?: string;
  rationale?: string;
  tags?: string[];
  has_pretrade?: boolean;
  position_plan?: PositionPlan;
  next_trade_plan?: NextTradePlan | null;
}

export interface TradePlanMatch {
  status: 'entry_plan' | 'watchlist' | 'position_note' | 'unplanned' | 'none';
  symbol?: string;
  name?: string;
  mode?: string;
  invalidation_condition?: string;
  reason?: string;
  triggers?: string[];
}

export interface RiskEvaluation {
  verdict: PretradeVerdict;
  decision: RiskDecision;
  risk_action: RiskAction;
  matched_rules: string[];
  reasons: string[];
  wait_conditions: string[];
  forbidden_actions: string[];
  max_allowed_amount?: number;
  severity: 'info' | 'warning' | 'critical';
  plan_match: TradePlanMatch;
}

const BUY_LIKE_ACTIONS = new Set<PretradeAction | TradeDirection>([
  'buy', 'add', 'rebuy', 'switch',
]);

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function rule(
  action: RiskAction,
  decision: RiskDecision,
  reason: string,
  extras: Omit<RiskRule, 'id' | 'action' | 'decision' | 'reason'> = {},
): RiskRule {
  return {
    id: `${action}:${decision}`,
    action,
    decision,
    reason,
    ...extras,
  };
}

export function defaultRiskMatrix(card?: TradingPermissionCard): RiskMatrix {
  const status: PermissionStatus = card?.status ?? 'protect';
  const allowedModes = card?.allowed_modes ?? [];
  const maxPosition = card?.max_total_position ?? (status === 'attack' ? 0.85 : status === 'normal' ? 0.65 : 0.35);
  const protectRules: RiskRule[] = [
    rule('sell', 'allow', '卖出/清仓属于降低风险，默认允许。'),
    rule('reduce', 'allow', '减仓属于降低风险，默认允许。'),
    rule('hold', 'observe_only', '保护档可持有或观察，不鼓励新增动作。'),
    rule('new_buy', 'forbid', '保护档禁止净新增风险。', {
      require_pretrade: true,
      require_exit_condition: true,
      require_allowed_mode: true,
      allow_net_position_increase: false,
    }),
    rule('switch_position', 'require_pretrade', '保护档允许计划内调仓，但必须净仓位不增加。', {
      require_pretrade: true,
      require_exit_condition: true,
      require_allowed_mode: true,
      allow_net_position_increase: false,
      max_net_position_increase: 0,
    }),
    rule('rebuy_same_symbol', 'require_pretrade', '同票卖后回补容易变成后悔交易，必须预审并冷却。', {
      require_pretrade: true,
      require_exit_condition: true,
      cooldown_minutes: 30,
      allow_net_position_increase: false,
      max_net_position_increase: 0,
    }),
    rule('add_winner', 'allow_small', '保护档只允许小幅加正反馈仓。', {
      require_pretrade: true,
      require_exit_condition: true,
      max_single_trade_position: 0.05,
    }),
    rule('add_loser', 'forbid', '亏损票补仓/摊低成本属于硬纪律禁区。', {
      forbidden_keywords: ['亏损票', '摊低', '补仓', '倒T'],
    }),
  ];
  const normalRules: RiskRule[] = [
    rule('sell', 'allow', '卖出/清仓属于降低风险，默认允许。'),
    rule('reduce', 'allow', '减仓属于降低风险，默认允许。'),
    rule('hold', 'allow', '正常档允许持有。'),
    rule('new_buy', 'require_pretrade', '正常档允许计划内新开仓，但必须有预审和退出条件。', {
      require_pretrade: true,
      require_exit_condition: true,
      require_allowed_mode: true,
      max_net_position_increase: 0.1,
      max_single_trade_position: 0.1,
    }),
    rule('switch_position', 'require_pretrade', '正常档允许调仓，净新增风险需要受限。', {
      require_pretrade: true,
      require_exit_condition: true,
      require_allowed_mode: true,
      max_net_position_increase: 0.05,
    }),
    rule('rebuy_same_symbol', 'require_pretrade', '同票回补必须预审，避免分时反复。', {
      require_pretrade: true,
      require_exit_condition: true,
      cooldown_minutes: 20,
      max_net_position_increase: 0.03,
    }),
    rule('add_winner', 'allow_small', '允许小幅加正反馈仓。', {
      require_pretrade: true,
      require_exit_condition: true,
      max_single_trade_position: 0.08,
    }),
    rule('add_loser', 'forbid', '正常档仍禁止亏损票补仓/摊低成本。', {
      forbidden_keywords: ['亏损票', '摊低', '补仓', '倒T'],
    }),
  ];
  const attackRules: RiskRule[] = [
    ...normalRules.map((r) =>
      r.action === 'new_buy'
        ? { ...r, decision: 'allow_small' as const, reason: '进攻档允许计划内新开仓，但仍受单笔和总仓限制。', max_net_position_increase: 0.15, max_single_trade_position: 0.15 }
        : r.action === 'switch_position'
          ? { ...r, reason: '进攻档允许计划内调仓。', max_net_position_increase: 0.1 }
          : r.action === 'add_winner'
            ? { ...r, decision: 'allow_small' as const, reason: '进攻档允许加正反馈仓，但不能超过单票纪律。', max_single_trade_position: 0.1 }
            : r
    ),
  ];

  return {
    version: 1,
    rules: status === 'protect' ? protectRules : status === 'attack' ? attackRules : normalRules,
    switch_policy: {
      allow_switch: true,
      requires_pretrade: status !== 'attack',
      source_sell_window_minutes: status === 'protect' ? 30 : 60,
      max_switch_net_increase: status === 'protect' ? 0 : status === 'normal' ? 0.05 : 0.1,
      target_requirements: [
        '目标属于 allowed_modes 或已有明确计划',
        '有买错退出条件',
        '不是亏损补仓、追高后排或外部消息直买',
      ],
    },
    circuit_breakers: [
      { id: 'two_losses', trigger: '当日连续两笔亏损交易', restriction: '后续只允许减仓/卖出/观察', severity: 'warning' },
      { id: 'missing_pretrade', trigger: '买入类交易缺少预审', restriction: '次日任何买入必须先预审', severity: 'warning' },
      { id: 'critical_violation', trigger: '当日出现 critical 违规', restriction: '次日维持或降为 protect', severity: 'critical' },
    ],
    recovery_rules: [
      { id: 'two_clean_days', condition: '连续 2 个交易日无 critical 且买入类交易均有预审', restored_permission: 'normal', rationale: '纪律恢复后可回 normal' },
      { id: 'trend_plus_discipline', condition: 'baseline 回到 MAIN_UP/REPAIR_CONFIRM 且近 3 日平均评分 >= 70', restored_permission: 'attack', rationale: '顺风市场叠加纪律达标可进攻' },
    ],
    notes: card?.forbidden_actions?.length ? [`文本摘要禁令：${card.forbidden_actions.join('、')}`] : undefined,
  };
}

export function riskMatrixForCard(card?: TradingPermissionCard): RiskMatrix {
  return card?.risk_matrix ?? defaultRiskMatrix(card);
}

export function matchNextTradePlan(intent: Pick<TradeIntent, 'symbol' | 'next_trade_plan'>): TradePlanMatch {
  const plan = intent.next_trade_plan;
  if (!plan) return { status: 'none' };
  const entry = plan.entries.find((e) => e.symbol === intent.symbol && e.status !== 'cancelled');
  if (entry) {
    return {
      status: 'entry_plan',
      symbol: entry.symbol,
      name: entry.name,
      mode: entry.mode,
      invalidation_condition: entry.invalidation_condition,
      reason: entry.thesis,
      triggers: entry.entry_triggers,
    };
  }
  const watch = plan.watchlist.find((w) => w.symbol === intent.symbol && w.status !== 'cancelled');
  if (watch) {
    return {
      status: 'watchlist',
      symbol: watch.symbol,
      name: watch.name,
      reason: watch.watch_reason,
      triggers: watch.trigger_conditions,
    };
  }
  const note = plan.position_notes.find((p) => p.symbol === intent.symbol);
  if (note) {
    return {
      status: 'position_note',
      symbol: note.symbol,
      name: note.name,
      reason: note.action_plan,
      triggers: note.key_levels,
    };
  }
  return { status: 'unplanned', symbol: intent.symbol };
}

export function inferRiskAction(intent: Pick<TradeIntent, 'action' | 'risk_action' | 'position_plan' | 'rationale' | 'tags'>): RiskAction {
  if (intent.risk_action) return intent.risk_action;
  if (intent.action === 'sell') return 'sell';
  if (intent.action === 'reduce') return 'reduce';
  if (intent.action === 'hold' || intent.action === 'observe' || intent.action === 'plan') return 'hold';
  if (intent.action === 'switch') return 'switch_position';
  if (intent.action === 'rebuy') return 'rebuy_same_symbol';
  if (intent.action === 'add') {
    const text = `${intent.rationale ?? ''} ${(intent.tags ?? []).join(' ')} ${intent.position_plan?.rationale ?? ''}`;
    if (
      text.includes('亏损票')
      || text.includes('摊低')
      || text.includes('摊低成本')
      || intent.position_plan?.category === 'hard_failed'
      || intent.position_plan?.category === 'conditional_failed'
      || intent.position_plan?.allowed_action === 'sell_only'
      || intent.position_plan?.allowed_action === 'reduce_only'
      || intent.position_plan?.allowed_action === 'hold_or_reduce'
    ) {
      return 'add_loser';
    }
    return 'add_winner';
  }
  return 'new_buy';
}

function verdictForDecision(decision: RiskDecision): PretradeVerdict {
  if (decision === 'forbid' || decision === 'observe_only') return 'REJECT';
  if (decision === 'require_pretrade') return 'WAIT';
  if (decision === 'allow_small') return 'ALLOW_SMALL';
  return 'ALLOW';
}

export function evaluateTradeIntent(intent: TradeIntent, card?: TradingPermissionCard): RiskEvaluation {
  const matrix = riskMatrixForCard(card);
  const riskAction = inferRiskAction(intent);
  const planMatch = matchNextTradePlan(intent);
  const rules = matrix.rules.filter((r) => r.action === riskAction);
  const baseRule = rules[0] ?? rule(riskAction, 'require_pretrade', '未找到明确矩阵规则，默认要求预审。', { require_pretrade: true });
  const matchedRules = [baseRule.id];
  const reasons = [baseRule.reason];
  const waitConditions: string[] = [];
  const forbiddenActions: string[] = [];
  let decision = baseRule.decision;
  let severity: RiskEvaluation['severity'] = decision === 'forbid' ? 'critical' : decision === 'require_pretrade' ? 'warning' : 'info';

  if (!card && intent.action && BUY_LIKE_ACTIONS.has(intent.action)) {
    return {
      verdict: 'REJECT',
      decision: 'forbid',
      risk_action: riskAction,
      matched_rules: ['missing_permission_card'],
      reasons: ['缺少今日权限卡，买入类动作默认拒绝。'],
      wait_conditions: ['先生成或补齐今日权限卡。'],
      forbidden_actions: ['无权限卡买入'],
      severity: 'critical',
      plan_match: planMatch,
    };
  }

  if (riskAction === 'sell' || riskAction === 'reduce') {
    return {
      verdict: 'ALLOW',
      decision: 'allow',
      risk_action: riskAction,
      matched_rules: matchedRules,
      reasons,
      wait_conditions: [],
      forbidden_actions: [],
      severity: 'info',
      plan_match: planMatch,
    };
  }

  const effectiveMode = intent.mode ?? planMatch.mode;
  const effectiveExitCondition = intent.exit_condition ?? planMatch.invalidation_condition;

  if (planMatch.status === 'entry_plan') {
    matchedRules.push('next_trade_plan_entry');
    reasons.push(`标的在下一交易日开仓计划内：${planMatch.reason ?? '已计划'}`);
  } else if (planMatch.status === 'watchlist') {
    decision = decision === 'forbid' ? decision : 'require_pretrade';
    severity = severity === 'critical' ? severity : 'warning';
    matchedRules.push('next_trade_plan_watchlist');
    waitConditions.push(`标的仍在观察池，需先满足：${(planMatch.triggers ?? []).join('；') || '计划升级条件'}`);
  } else if (
    planMatch.status === 'unplanned'
    && intent.action
    && BUY_LIKE_ACTIONS.has(intent.action)
  ) {
    matchedRules.push('next_trade_plan_unplanned');
    if (card?.status === 'protect' && riskAction === 'new_buy') {
      decision = 'forbid';
      severity = 'critical';
      reasons.push('保护档计划外新开仓默认拒绝。');
      forbiddenActions.push('计划外新开仓');
    } else {
      decision = decision === 'forbid' ? decision : 'require_pretrade';
      severity = severity === 'critical' ? severity : 'warning';
      waitConditions.push('该标的不在下一交易日计划内，需补充强理由并重新预审。');
    }
  }

  if (baseRule.require_allowed_mode && card?.allowed_modes?.length && effectiveMode && !card.allowed_modes.includes(effectiveMode)) {
    decision = 'forbid';
    severity = 'critical';
    matchedRules.push('mode_not_allowed');
    reasons.push(`操作模式「${effectiveMode}」不在今日 allowed_modes 内。`);
    forbiddenActions.push('计划外模式交易');
  }

  if (baseRule.require_exit_condition && !effectiveExitCondition) {
    decision = decision === 'forbid' ? decision : 'require_pretrade';
    severity = severity === 'critical' ? severity : 'warning';
    matchedRules.push('missing_exit_condition');
    waitConditions.push('补充买错退出条件。');
  }

  if (baseRule.require_pretrade && intent.has_pretrade === false) {
    decision = decision === 'forbid' ? decision : 'require_pretrade';
    severity = severity === 'critical' ? severity : 'warning';
    matchedRules.push('pretrade_required');
    waitConditions.push('先记录 ALLOW/ALLOW_SMALL 预审。');
  }

  const netDelta = intent.net_position_delta;
  if (typeof netDelta === 'number') {
    const maxNet = riskAction === 'switch_position'
      ? matrix.switch_policy.max_switch_net_increase
      : baseRule.max_net_position_increase;
    if (baseRule.allow_net_position_increase === false && netDelta > 0) {
      decision = 'forbid';
      severity = 'critical';
      matchedRules.push('net_position_increase_forbidden');
      reasons.push('该动作不允许净仓位增加。');
      forbiddenActions.push('净新增风险');
    } else if (typeof maxNet === 'number' && netDelta > maxNet) {
      decision = 'forbid';
      severity = 'critical';
      matchedRules.push('net_position_delta_exceeded');
      reasons.push(`净仓增加 ${pct(netDelta)} 超过上限 ${pct(maxNet)}。`);
      forbiddenActions.push('超过净新增风险上限');
    }
  }

  if (typeof intent.projected_total_position === 'number' && card && intent.projected_total_position > card.max_total_position) {
    decision = 'forbid';
    severity = 'critical';
    matchedRules.push('max_total_position_exceeded');
    reasons.push(`交易后总仓 ${pct(intent.projected_total_position)} 将超过权限卡上限 ${pct(card.max_total_position)}。`);
    forbiddenActions.push('超过总仓上限');
  }

  if (riskAction === 'switch_position') {
    if (!matrix.switch_policy.allow_switch) {
      decision = 'forbid';
      severity = 'critical';
      matchedRules.push('switch_forbidden');
      reasons.push('今日矩阵不允许跨标的调仓。');
      forbiddenActions.push('跨标的调仓');
    } else if (intent.source_sell_amount == null) {
      decision = decision === 'forbid' ? decision : 'require_pretrade';
      severity = severity === 'critical' ? severity : 'warning';
      matchedRules.push('missing_switch_source');
      waitConditions.push('补充调仓对应的卖出资金来源。');
    } else if (
      typeof intent.planned_amount === 'number'
      && matrix.switch_policy.max_switch_net_increase === 0
      && intent.planned_amount > intent.source_sell_amount
    ) {
      decision = 'forbid';
      severity = 'critical';
      matchedRules.push('switch_amount_exceeded');
      reasons.push('保护档调仓买入金额不能超过对应卖出金额。');
      forbiddenActions.push('调仓变相加仓');
    }
  }

  if (baseRule.decision === 'forbid') {
    forbiddenActions.push(baseRule.reason);
  }

  const verdict = planMatch.status === 'watchlist'
    ? 'WAIT'
    : decision === 'require_pretrade' && intent.has_pretrade ? 'ALLOW_SMALL' : verdictForDecision(decision);
  return {
    verdict,
    decision,
    risk_action: riskAction,
    matched_rules: [...new Set(matchedRules)],
    reasons: [...new Set(reasons)],
    wait_conditions: [...new Set(waitConditions)],
    forbidden_actions: [...new Set(forbiddenActions)],
    max_allowed_amount: baseRule.max_single_trade_amount,
    severity,
    plan_match: planMatch,
  };
}
