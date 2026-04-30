import { Router, type Request, type Response } from 'express';
import { detectTradeViolations } from '../services/violation-detector';

const router = Router();

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

router.get('/', (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  if (!isYmd(date)) return res.status(400).json({ error: '需提供 date=YYYY-MM-DD' });
  const items = detectTradeViolations(date);
  return res.json({ date, items, total: items.length });
});

export default router;
