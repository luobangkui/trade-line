import { Router, type Request, type Response } from 'express';
import {
  upsertPermissionCard, getPermissionCard, getPermissionCardsByRange,
  getAllPermissionCards, deletePermissionCard, setPermissionCardLock,
} from '../db/store';
import type {
  TradingPermissionCard, TradingPermissionCardUpsertRequest, PermissionStatus,
} from '../models/types';

const router = Router();

const VALID_STATUS: PermissionStatus[] = ['protect', 'normal', 'attack'];

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function todayYmd(): string {
  const tz = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return tz; // YYYY-MM-DD
}

function buildCard(body: TradingPermissionCardUpsertRequest, existing?: TradingPermissionCard): TradingPermissionCard {
  const now = new Date().toISOString();
  return {
    date: body.date,
    status: body.status,
    max_total_position: body.max_total_position,
    allow_margin: body.allow_margin ?? false,
    allowed_modes: body.allowed_modes ?? [],
    forbidden_actions: body.forbidden_actions ?? [],
    stop_triggers: body.stop_triggers ?? [],
    rationale: body.rationale ?? '',
    generated_from: body.generated_from ?? {},
    source: body.source ?? 'manual',
    locked: body.locked ?? existing?.locked ?? false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

// POST /api/permission —— upsert（覆盖语义；?force=1 强制覆盖 locked）
router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body as TradingPermissionCardUpsertRequest;
    if (!body || !body.date || !isYmd(body.date)) {
      return res.status(400).json({ error: 'date 必填，格式 YYYY-MM-DD' });
    }
    if (!body.status || !VALID_STATUS.includes(body.status)) {
      return res.status(400).json({ error: `status 必填且取值 ∈ ${JSON.stringify(VALID_STATUS)}` });
    }
    if (typeof body.max_total_position !== 'number' || body.max_total_position < 0 || body.max_total_position > 1) {
      return res.status(400).json({ error: 'max_total_position 必填，范围 0-1（小数）' });
    }
    const existing = getPermissionCard(body.date);
    const card = buildCard(body, existing);
    const force = String(req.query['force'] ?? '') === '1';
    const result = upsertPermissionCard(card, { force });
    if (result.locked_skipped) {
      return res.status(409).json({
        error: '该日卡片已锁定（locked=true），写入被拒绝。可调用 POST /api/permission/:date/unlock 后再写，或 POST /api/permission?force=1 强制覆盖。',
        card: result.card,
      });
    }
    return res.json({ success: true, card: result.card });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

// GET /api/permission/today —— 快捷今日
router.get('/today', (_req: Request, res: Response) => {
  const today = todayYmd();
  const card = getPermissionCard(today);
  if (!card) return res.status(404).json({ error: '今日尚无权限卡', date: today });
  return res.json({ card });
});

// GET /api/permission?start=&end=  或  /api/permission/all
router.get('/all', (_req: Request, res: Response) => {
  return res.json({ items: getAllPermissionCards() });
});

router.get('/', (req: Request, res: Response) => {
  const start = String(req.query['start'] ?? '');
  const end = String(req.query['end'] ?? '');
  if (start && end && isYmd(start) && isYmd(end)) {
    return res.json({ items: getPermissionCardsByRange(start, end) });
  }
  return res.json({ items: getAllPermissionCards() });
});

// GET /api/permission/:date
router.get('/:date', (req: Request, res: Response) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  const card = getPermissionCard(date);
  if (!card) return res.status(404).json({ error: '该日无权限卡', date });
  return res.json({ card });
});

// DELETE /api/permission/:date —— 删除（locked 也可删，便于"清空重生成"）
router.delete('/:date', (req: Request, res: Response) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  const ok = deletePermissionCard(date);
  return res.json({ success: ok, date });
});

// POST /api/permission/:date/lock   { locked: true|false }
router.post('/:date/lock', (req: Request, res: Response) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  const locked = req.body?.locked;
  if (typeof locked !== 'boolean') {
    return res.status(400).json({ error: 'body 必须包含 { locked: true|false }' });
  }
  const card = setPermissionCardLock(date, locked);
  if (!card) return res.status(404).json({ error: '该日无权限卡', date });
  return res.json({ success: true, card });
});

export default router;
