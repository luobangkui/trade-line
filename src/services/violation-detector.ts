import {
  getOperationsByDate, getPermissionCard, getPositionPlansByDate, getPretradeReviewsByDate,
  getNextTradePlan,
} from '../db/store';
import type { PositionPlan, PretradeReview, TradeOperation, TradeViolation } from '../models/types';
import { evaluateTradeIntent, riskMatrixForCard } from './risk-matrix';

function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

function timePart(ts: string): string {
  return ts.slice(11, 16);
}

function isBuyLike(op: TradeOperation): boolean {
  return op.direction === 'buy' || op.direction === 'add';
}

function isSellLike(op: TradeOperation): boolean {
  return op.direction === 'sell' || op.direction === 'reduce';
}

function matchedAllowedPretrade(op: TradeOperation, pretrades: PretradeReview[]): PretradeReview | undefined {
  return pretrades.find((p) =>
    p.symbol === op.symbol
    && new Date(p.timestamp).getTime() <= new Date(op.timestamp).getTime()
    && (p.verdict === 'ALLOW' || p.verdict === 'ALLOW_SMALL')
  );
}

function hasForbidden(cardText: string, keywords: string[]): boolean {
  return keywords.some((k) => cardText.includes(k));
}

function operationText(op: TradeOperation): string {
  return `${op.rationale} ${op.notes ?? ''} ${op.tags.join(' ')}`;
}

function hasStrictMorningBan(cardText: string): boolean {
  return [
    '禁止10:30前', '禁止 10:30 前', '10:30前禁止', '10:30 前禁止',
    '10:30前不买', '10:30 前不买', '10:30前不得买', '10:30 前不得买',
    '早盘禁买', '早盘禁止买入', '禁止早盘买入', '早盘不买', '早盘不得买',
  ].some((k) => cardText.includes(k));
}

function hasMorningCaution(cardText: string): boolean {
  return !hasStrictMorningBan(cardText)
    && ['10:30前', '10:30 前', '早盘'].some((k) => cardText.includes(k));
}

function isStrictReduceOnly(plan?: PositionPlan): boolean {
  if (!plan) return false;
  return (
    plan.allowed_action === 'sell_only'
    || plan.allowed_action === 'reduce_only'
    || plan.allowed_action === 'hold_or_reduce'
    || plan.forbidden_actions.some((a) => ['买入', '加仓', '补仓', '倒T'].some((k) => a.includes(k)))
  );
}

function isFailedPosition(plan?: PositionPlan): boolean {
  return !!plan && (plan.category === 'hard_failed' || plan.category === 'conditional_failed');
}

function makeViolation(
  date: string,
  ruleId: string,
  severity: TradeViolation['severity'],
  title: string,
  detail: string,
  relatedOperationIds: string[],
  suggestedPenalty: string,
): TradeViolation {
  return {
    id: `${date}:${ruleId}:${relatedOperationIds.join(',') || 'day'}`,
    date,
    rule_id: ruleId,
    severity,
    title,
    detail,
    related_operation_ids: relatedOperationIds,
    suggested_penalty: suggestedPenalty,
  };
}

export function detectTradeViolations(date: string): TradeViolation[] {
  const ops = getOperationsByDate(date);
  const permission = getPermissionCard(date);
  const pretrades = getPretradeReviewsByDate(date);
  const nextTradePlan = getNextTradePlan(date) ?? null;
  const positionPlans = new Map(getPositionPlansByDate(date).map((p) => [p.symbol, p]));
  const violations: TradeViolation[] = [];
  const cardText = permission ? JSON.stringify(permission) : '';

  const buyOps = ops.filter(isBuyLike);
  const sellOps = ops.filter(isSellLike);

  if (!permission && buyOps.length > 0) {
    violations.push(makeViolation(
      date,
      'missing_permission_card',
      'critical',
      '无今日权限卡仍发生买入',
      `当天没有权限卡，但发生 ${buyOps.length} 笔买入/加仓。`,
      buyOps.map((o) => o.id),
      '次日禁止新开仓，直到补齐权限卡。',
    ));
  }

  if (
    permission?.status === 'protect'
    && hasForbidden(cardText, ['全天新开仓', '不新开仓', '禁止新开仓'])
    && buyOps.length > 0
  ) {
    violations.push(makeViolation(
      date,
      'protect_day_new_buy',
      'critical',
      '保护档发生买入/加仓',
      `权限卡为 protect，且禁止新开仓，但当天发生 ${buyOps.length} 笔买入/加仓。`,
      buyOps.map((o) => o.id),
      '次日维持 protect，并将最大仓位下调或保持不高于 35%。',
    ));
  }

  const morningBuys = buyOps.filter((o) => timePart(o.timestamp) < '10:30');
  if (morningBuys.length > 0 && hasStrictMorningBan(cardText)) {
    violations.push(makeViolation(
      date,
      'morning_new_buy',
      'critical',
      '10:30 前发生买入/加仓',
      `权限卡限制早盘买入，但 ${morningBuys.map((o) => `${o.name}${timePart(o.timestamp)}`).join('、')} 发生买入/加仓。`,
      morningBuys.map((o) => o.id),
      '次日所有买入必须先预审；若再次发生，次日只允许卖出。',
    ));
  } else if (morningBuys.length > 0 && hasMorningCaution(cardText)) {
    violations.push(makeViolation(
      date,
      'morning_buy_risk_signal',
      'warning',
      '早盘买入需要复核',
      `权限卡提到早盘/10:30 条件，但不是明确禁令；当天 ${morningBuys.map((o) => `${o.name}${timePart(o.timestamp)}`).join('、')} 发生买入/加仓，需要人工复核是否符合条件。`,
      morningBuys.map((o) => o.id),
      '不自动惩罚；复盘时要求补充触发条件与预审依据。',
    ));
  }

  const switchSignals: TradeViolation[] = [];
  const sameSymbolSellThenBuyIds: string[] = [];
  const switchWindowMinutes = riskMatrixForCard(permission).switch_policy.source_sell_window_minutes;
  for (const sell of sellOps) {
    for (const buy of buyOps) {
      const gap = minutesBetween(sell.timestamp, buy.timestamp);
      if (gap >= 0 && gap <= switchWindowMinutes) {
        if (sell.symbol === buy.symbol) {
          sameSymbolSellThenBuyIds.push(sell.id, buy.id);
        } else {
          const matchedPretrade = matchedAllowedPretrade(buy, pretrades);
          const evaluation = evaluateTradeIntent({
            date,
            timestamp: buy.timestamp,
            symbol: buy.symbol,
            name: buy.name,
            action: 'switch',
            risk_action: 'switch_position',
            mode: matchedPretrade?.mode,
            planned_amount: buy.amount,
            source_sell_amount: sell.amount,
            net_position_delta: matchedPretrade?.net_position_delta,
            exit_condition: matchedPretrade?.exit_condition,
            rationale: operationText(buy),
            tags: buy.tags,
            has_pretrade: !!matchedPretrade,
            position_plan: positionPlans.get(buy.symbol),
            next_trade_plan: nextTradePlan,
          }, permission);
          if (evaluation.severity === 'critical') {
            switchSignals.push(makeViolation(
              date,
              'switch_position_blocked',
              'critical',
              '调仓动作违反风控矩阵',
              `卖出 ${sell.name} 后买入 ${buy.name}，命中：${evaluation.reasons.join('；')}`,
              [sell.id, buy.id],
              '次日调仓必须先预审，且不得净新增风险。',
            ));
          } else if (!matchedPretrade || evaluation.verdict === 'WAIT' || evaluation.verdict === 'REJECT') {
            switchSignals.push(makeViolation(
              date,
              'switch_position_needs_review',
              'warning',
              '调仓动作需要补充预审依据',
              `卖出 ${sell.name} 后买入 ${buy.name}，当前不直接判硬违规，但需补充：${[
                ...evaluation.reasons,
                ...evaluation.wait_conditions,
              ].join('；')}`,
              [sell.id, buy.id],
              '不自动惩罚；复盘时确认是否为净仓不增的计划内调仓。',
            ));
          }
        }
      }
    }
  }
  violations.push(...switchSignals);
  if (sameSymbolSellThenBuyIds.length > 0) {
    violations.push(makeViolation(
      date,
      'same_symbol_sell_then_buy_window',
      'warning',
      '同票卖出后短时间内买回',
      `检测到同一标的卖出后 ${switchWindowMinutes} 分钟窗口内买回，可能是纠错，也可能是倒T/情绪性反复，需要复盘判定。`,
      [...new Set(sameSymbolSellThenBuyIds)],
      '不自动惩罚；若复盘判定为倒T或情绪反复，次日该票只允许减仓。',
    ));
  }

  const buyBySymbol = new Map<string, TradeOperation[]>();
  for (const op of buyOps) {
    buyBySymbol.set(op.symbol, [...(buyBySymbol.get(op.symbol) ?? []), op]);
  }
  const repeatedBuys = [...buyBySymbol.values()]
    .filter((arr) => {
      if (arr.length < 2) return false;
      const validPretradeCount = arr.filter((op) => pretrades.some((p) =>
        p.symbol === op.symbol
        && new Date(p.timestamp).getTime() <= new Date(op.timestamp).getTime()
        && (p.verdict === 'ALLOW' || p.verdict === 'ALLOW_SMALL')
      )).length;
      return validPretradeCount < arr.length;
    })
    .flat();
  if (repeatedBuys.length > 0) {
    violations.push(makeViolation(
      date,
      'second_buy_unvalidated',
      'warning',
      '同一标的连续买入',
      `当天存在同一标的多次买入/加仓：${[...new Set(repeatedBuys.map((o) => o.name))].join('、')}。`,
      repeatedBuys.map((o) => o.id),
      '同一标的第一笔未收盘验证前，不允许第二笔买入。',
    ));
  }

  const lossAdds = buyOps.filter((o) => {
    const text = operationText(o);
    const plan = positionPlans.get(o.symbol);
    return (
      text.includes('亏损票')
      || text.includes('摊低')
      || text.includes('摊低成本')
      || (o.direction === 'add' && isFailedPosition(plan))
      || (o.direction === 'add' && isStrictReduceOnly(plan))
      || (o.direction === 'add' && hasForbidden(cardText, ['禁止补仓', '不补仓', '禁补', '禁止加仓', '不加仓']))
    );
  });
  if (lossAdds.length > 0) {
    violations.push(makeViolation(
      date,
      'loss_position_add',
      'critical',
      '亏损票补仓/摊低倾向',
      `检测到 ${lossAdds.length} 笔亏损票补仓或摊低成本倾向。`,
      lossAdds.map((o) => o.id),
      '该标的 3 个交易日内只允许减仓，不允许补仓或倒T。',
    ));
  }

  const plainAdds = buyOps.filter((o) =>
    o.direction === 'add' && !lossAdds.some((bad) => bad.id === o.id)
  );
  if (plainAdds.length > 0) {
    violations.push(makeViolation(
      date,
      'add_position_risk_signal',
      'info',
      '加仓动作需要复盘确认',
      `当天有 ${plainAdds.length} 笔加仓，但未命中失败仓/禁止补仓/摊低成本证据；作为风险信号记录，不直接定性违规。`,
      plainAdds.map((o) => o.id),
      '复盘时确认加仓是否来自系统内信号；若只是补亏损票，再升级为纪律违规。',
    ));
  }

  const directions = new Set(ops.map((o) => o.direction));
  if (directions.size >= 3) {
    violations.push(makeViolation(
      date,
      'multi_mode_day',
      'info',
      '单日多模式混做',
      `当天出现 ${[...directions].join('/')} 等多种方向，容易从处理失败仓切换成重新进攻。`,
      ops.map((o) => o.id),
      '不自动惩罚；复盘时要求归因，必要时次日只允许一种模式。',
    ));
  }

  const pretradeMatchedOps = new Set<string>();
  for (const op of buyOps) {
    const matched = matchedAllowedPretrade(op, pretrades);
    if (matched) pretradeMatchedOps.add(op.id);
  }
  const noPretrade = buyOps.filter((o) => !pretradeMatchedOps.has(o.id));
  if (noPretrade.length > 0) {
    violations.push(makeViolation(
      date,
      'missing_pretrade_review',
      'warning',
      '买入前缺少有效预审',
      `当天 ${noPretrade.length} 笔买入/加仓没有匹配到更早的 ALLOW/ALLOW_SMALL 预审记录。`,
      noPretrade.map((o) => o.id),
      '次日任何买入前必须记录预审卡；未预审下单即记系统外交易。',
    ));
  }

  return violations;
}
