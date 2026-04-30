import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  upsertPositionPlan, getPositionPlan, getPositionPlansByDate, getPositionPlansByRange,
  deletePositionPlan, setPositionPlanLock,
} from '../db/store';
import type {
  PositionPlan, PositionPlanAction, PositionPlanCategory, PositionPlanUpsertRequest,
} from '../models/types';

const router = Router();

const CATEGORIES: PositionPlanCategory[] = [
  'hard_failed', 'conditional_failed', 'positive_feedback', 'watch', 'defensive', 'closed',
];
const ACTIONS: PositionPlanAction[] = [
  'sell_only', 'reduce_only', 'hold_or_reduce', 'hold_only', 'observe_only', 'no_action',
];

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function buildPlan(body: PositionPlanUpsertRequest, existing?: PositionPlan): PositionPlan {
  const now = new Date().toISOString();
  return {
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
    source: body.source ?? 'manual',
    locked: body.locked ?? existing?.locked ?? false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body as PositionPlanUpsertRequest;
    if (!body?.date || !isYmd(body.date)) return res.status(400).json({ error: 'date 必填，格式 YYYY-MM-DD' });
    if (!body.symbol || !body.name) return res.status(400).json({ error: 'symbol/name 必填' });
    if (!CATEGORIES.includes(body.category)) return res.status(400).json({ error: `category 必须 ∈ ${JSON.stringify(CATEGORIES)}` });
    if (!ACTIONS.includes(body.allowed_action)) return res.status(400).json({ error: `allowed_action 必须 ∈ ${JSON.stringify(ACTIONS)}` });

    const existing = getPositionPlan(body.date, body.symbol);
    const force = String(req.query['force'] ?? '') === '1';
    const result = upsertPositionPlan(buildPlan(body, existing), { force });
    if (result.locked_skipped) {
      return res.status(409).json({ error: '该持仓计划已锁定，写入被拒绝。可使用 ?force=1 强制覆盖。', plan: result.plan });
    }
    return res.json({ success: true, plan: result.plan });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.post('/batch', (req: Request, res: Response) => {
  try {
    const plans = req.body?.plans as PositionPlanUpsertRequest[] | undefined;
    if (!Array.isArray(plans) || !plans.length) return res.status(400).json({ error: 'plans 必须为非空数组' });
    const force = String(req.query['force'] ?? '') === '1';
    const saved: PositionPlan[] = [];
    const skipped: PositionPlan[] = [];
    for (const body of plans) {
      if (!body?.date || !isYmd(body.date) || !body.symbol || !body.name) continue;
      if (!CATEGORIES.includes(body.category) || !ACTIONS.includes(body.allowed_action)) continue;
      const existing = getPositionPlan(body.date, body.symbol);
      const result = upsertPositionPlan(buildPlan(body, existing), { force });
      if (result.locked_skipped) skipped.push(result.plan);
      else saved.push(result.plan);
    }
    return res.json({ success: true, count: saved.length, locked_skipped: skipped.length, plans: saved, skipped });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.get('/', (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  const start = String(req.query['start'] ?? '');
  const end = String(req.query['end'] ?? '');
  if (date && isYmd(date)) return res.json({ items: getPositionPlansByDate(date) });
  if (start && end && isYmd(start) && isYmd(end)) return res.json({ items: getPositionPlansByRange(start, end) });
  return res.status(400).json({ error: '需提供 date 或 start+end' });
});

router.get('/:date/:symbol', (req: Request, res: Response) => {
  const { date, symbol } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  const plan = getPositionPlan(date, symbol);
  if (!plan) return res.status(404).json({ error: '该日该标的无持仓计划', date, symbol });
  return res.json({ plan });
});

router.post('/:date/:symbol/lock', (req: Request, res: Response) => {
  const { date, symbol } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'body 必须包含 { locked: true|false }' });
  const plan = setPositionPlanLock(date, symbol, req.body.locked);
  if (!plan) return res.status(404).json({ error: '该日该标的无持仓计划', date, symbol });
  return res.json({ success: true, plan });
});

router.delete('/:date/:symbol', (req: Request, res: Response) => {
  const { date, symbol } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  return res.json({ success: deletePositionPlan(date, symbol), date, symbol });
});

export default router;
