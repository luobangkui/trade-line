import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  insertPretradeReview, getPretradeReview, getPretradeReviewsByDate,
  getPretradeReviewsByRange, deletePretradeReview,
} from '../db/store';
import type {
  PretradeAction, PretradeReview, PretradeReviewCreateRequest, PretradeVerdict,
} from '../models/types';

const router = Router();

const ACTIONS: PretradeAction[] = ['buy', 'add', 'rebuy', 'switch'];
const VERDICTS: PretradeVerdict[] = ['REJECT', 'WAIT', 'ALLOW_SMALL', 'ALLOW'];

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function buildReview(body: PretradeReviewCreateRequest): PretradeReview {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    date: body.date,
    timestamp: body.timestamp ?? now,
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
    source: body.source ?? 'agent:pretrade',
    created_at: now,
  };
}

router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body as PretradeReviewCreateRequest;
    if (!body?.date || !isYmd(body.date)) return res.status(400).json({ error: 'date 必填，格式 YYYY-MM-DD' });
    if (!body.symbol || !body.name) return res.status(400).json({ error: 'symbol/name 必填' });
    if (!ACTIONS.includes(body.action)) return res.status(400).json({ error: `action 必须 ∈ ${JSON.stringify(ACTIONS)}` });
    if (!body.mode) return res.status(400).json({ error: 'mode 必填' });
    if (!body.exit_condition) return res.status(400).json({ error: 'exit_condition 必填' });
    if (!VERDICTS.includes(body.verdict)) return res.status(400).json({ error: `verdict 必须 ∈ ${JSON.stringify(VERDICTS)}` });
    const review = insertPretradeReview(buildReview(body));
    return res.json({ success: true, review });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.get('/', (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  const start = String(req.query['start'] ?? '');
  const end = String(req.query['end'] ?? '');
  if (date && isYmd(date)) return res.json({ items: getPretradeReviewsByDate(date) });
  if (start && end && isYmd(start) && isYmd(end)) return res.json({ items: getPretradeReviewsByRange(start, end) });
  return res.status(400).json({ error: '需提供 date 或 start+end' });
});

router.get('/:id', (req: Request, res: Response) => {
  const review = getPretradeReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'pretrade review 不存在' });
  return res.json({ review });
});

router.delete('/:id', (req: Request, res: Response) => {
  return res.json({ success: deletePretradeReview(req.params.id), id: req.params.id });
});

export default router;
