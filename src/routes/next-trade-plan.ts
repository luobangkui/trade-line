import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  upsertNextTradePlan, getNextTradePlan, getNextTradePlansByRange,
  getAllNextTradePlans, deleteNextTradePlan, setNextTradePlanLock,
} from '../db/store';
import type {
  NextTradePlan, NextTradePlanItemStatus, NextTradePlanUpsertRequest, RiskAction,
} from '../models/types';

const router = Router();

const ITEM_STATUS: NextTradePlanItemStatus[] = ['planned', 'watch', 'triggered', 'cancelled'];
const RISK_ACTIONS: RiskAction[] = [
  'new_buy', 'add_winner', 'add_loser', 'rebuy_same_symbol', 'switch_position', 'reduce', 'sell', 'hold',
];

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function validatePlanItems(body: NextTradePlanUpsertRequest): string | undefined {
  for (const entry of body.entries ?? []) {
    if (!entry.symbol || !entry.name) return 'entries 每项必须包含 symbol/name';
    if (!entry.mode) return 'entries 每项必须包含 mode';
    if (!entry.thesis) return 'entries 每项必须包含 thesis';
    if (!entry.invalidation_condition) return 'entries 每项必须包含 invalidation_condition';
    if (!Array.isArray(entry.entry_triggers) || entry.entry_triggers.length === 0) {
      return 'entries 每项必须包含非空 entry_triggers';
    }
    if (!ITEM_STATUS.includes(entry.status)) return `entries.status 必须 ∈ ${JSON.stringify(ITEM_STATUS)}`;
    if (entry.risk_action && !RISK_ACTIONS.includes(entry.risk_action)) {
      return `entries.risk_action 必须 ∈ ${JSON.stringify(RISK_ACTIONS)}`;
    }
  }
  for (const item of body.watchlist ?? []) {
    if (!item.symbol || !item.name) return 'watchlist 每项必须包含 symbol/name';
    if (!item.watch_reason) return 'watchlist 每项必须包含 watch_reason';
    if (!Array.isArray(item.trigger_conditions) || item.trigger_conditions.length === 0) {
      return 'watchlist 每项必须包含非空 trigger_conditions';
    }
    if (!ITEM_STATUS.includes(item.status)) return `watchlist.status 必须 ∈ ${JSON.stringify(ITEM_STATUS)}`;
  }
  return undefined;
}

function buildPlan(body: NextTradePlanUpsertRequest, existing?: NextTradePlan): NextTradePlan {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? uuidv4(),
    date: body.date,
    market_view: body.market_view ?? existing?.market_view ?? '',
    max_total_position: body.max_total_position ?? existing?.max_total_position,
    focus_themes: body.focus_themes ?? existing?.focus_themes ?? [],
    no_trade_rules: body.no_trade_rules ?? existing?.no_trade_rules ?? [],
    entries: body.entries ?? existing?.entries ?? [],
    watchlist: body.watchlist ?? existing?.watchlist ?? [],
    position_notes: body.position_notes ?? existing?.position_notes ?? [],
    source: body.source ?? existing?.source ?? 'manual',
    locked: body.locked ?? existing?.locked ?? false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body as NextTradePlanUpsertRequest;
    if (!body?.date || !isYmd(body.date)) return res.status(400).json({ error: 'date 必填，格式 YYYY-MM-DD' });
    if (typeof body.max_total_position === 'number' && (body.max_total_position < 0 || body.max_total_position > 1)) {
      return res.status(400).json({ error: 'max_total_position 范围必须为 0-1' });
    }
    const invalid = validatePlanItems(body);
    if (invalid) return res.status(400).json({ error: invalid });

    const existing = getNextTradePlan(body.date);
    const force = String(req.query['force'] ?? '') === '1';
    const result = upsertNextTradePlan(buildPlan(body, existing), { force });
    if (result.locked_skipped) {
      return res.status(409).json({ error: '该交易计划已锁定，写入被拒绝。可使用 ?force=1 强制覆盖。', plan: result.plan });
    }
    return res.json({ success: true, plan: result.plan });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.get('/all', (_req: Request, res: Response) => {
  return res.json({ items: getAllNextTradePlans() });
});

router.get('/', (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  const start = String(req.query['start'] ?? '');
  const end = String(req.query['end'] ?? '');
  if (date && isYmd(date)) return res.json({ plan: getNextTradePlan(date) ?? null });
  if (start && end && isYmd(start) && isYmd(end)) return res.json({ items: getNextTradePlansByRange(start, end) });
  return res.status(400).json({ error: '需提供 date 或 start+end' });
});

router.get('/:date', (req: Request, res: Response) => {
  const { date } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  return res.json({ plan: getNextTradePlan(date) ?? null });
});

router.post('/:date/lock', (req: Request, res: Response) => {
  const { date } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'body 必须包含 { locked: true|false }' });
  const plan = setNextTradePlanLock(date, req.body.locked);
  if (!plan) return res.status(404).json({ error: '该日无交易计划', date });
  return res.json({ success: true, plan });
});

router.delete('/:date', (req: Request, res: Response) => {
  const { date } = req.params;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  return res.json({ success: deleteNextTradePlan(date), date });
});

export default router;
