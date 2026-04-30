import {
  getOperationsByDate, getPermissionCard, getPretradeReviewsByDate,
} from '../db/store';
import type { TradeOperation, TradeViolation } from '../models/types';

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

function hasForbidden(cardText: string, keywords: string[]): boolean {
  return keywords.some((k) => cardText.includes(k));
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
  if (morningBuys.length > 0 && hasForbidden(cardText, ['10:30前', '10:30 前', '早盘'])) {
    violations.push(makeViolation(
      date,
      'morning_new_buy',
      'critical',
      '10:30 前发生买入/加仓',
      `权限卡限制早盘买入，但 ${morningBuys.map((o) => `${o.name}${timePart(o.timestamp)}`).join('、')} 发生买入/加仓。`,
      morningBuys.map((o) => o.id),
      '次日所有买入必须先预审；若再次发生，次日只允许卖出。',
    ));
  }

  const sellThenBuyIds: string[] = [];
  for (const sell of sellOps) {
    for (const buy of buyOps) {
      const gap = minutesBetween(sell.timestamp, buy.timestamp);
      if (gap >= 0 && gap <= 10) {
        sellThenBuyIds.push(sell.id, buy.id);
      }
    }
  }
  if (sellThenBuyIds.length > 0) {
    violations.push(makeViolation(
      date,
      'sell_then_buy_10m',
      'critical',
      '卖出后 10 分钟内买入',
      '检测到卖出后 10 分钟内买入/换仓，说明现金没有冷却。',
      [...new Set(sellThenBuyIds)],
      '次日卖出后现金必须保留到下一交易日。',
    ));
  }

  const buyBySymbol = new Map<string, TradeOperation[]>();
  for (const op of buyOps) {
    buyBySymbol.set(op.symbol, [...(buyBySymbol.get(op.symbol) ?? []), op]);
  }
  const repeatedBuys = [...buyBySymbol.values()].filter((arr) => arr.length >= 2).flat();
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

  const lossAdds = buyOps.filter((o) =>
    o.direction === 'add'
    || `${o.rationale} ${o.notes ?? ''} ${o.tags.join(' ')}`.includes('亏损票')
    || `${o.rationale} ${o.notes ?? ''} ${o.tags.join(' ')}`.includes('摊低')
  );
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

  const directions = new Set(ops.map((o) => o.direction));
  if (directions.size >= 3) {
    violations.push(makeViolation(
      date,
      'multi_mode_day',
      'warning',
      '单日多模式混做',
      `当天出现 ${[...directions].join('/')} 等多种方向，容易从处理失败仓切换成重新进攻。`,
      ops.map((o) => o.id),
      '次日只允许一种模式，默认处理失败仓。',
    ));
  }

  const pretradeMatchedOps = new Set<string>();
  for (const op of buyOps) {
    const matched = pretrades.find((p) =>
      p.symbol === op.symbol
      && new Date(p.timestamp).getTime() <= new Date(op.timestamp).getTime()
      && (p.verdict === 'ALLOW' || p.verdict === 'ALLOW_SMALL')
    );
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
