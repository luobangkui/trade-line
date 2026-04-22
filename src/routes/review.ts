import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  insertOperation, getOperationsByDate, getOperationById, getOperationsByRange,
  deleteOperation, insertEvaluation, getEvaluationsByOperation, getEvaluationsByDate,
  getDailyReview, getDailyReviewsByRange, upsertDailyReview, getSnapshotByDate,
} from '../db/store';
import { aggregateDailyReview } from '../services/reviewer';
import type {
  TradeOperation, TradeOperationUploadRequest,
  OperationEvaluation, OperationEvaluationUploadRequest,
  DailyReviewPlanRequest,
} from '../models/types';

const router = Router();

function makeOperation(body: TradeOperationUploadRequest): TradeOperation {
  const snap = getSnapshotByDate(body.time_key);
  const qty = body.quantity ?? 0;
  const price = body.price ?? 0;
  const amount = body.amount ?? (qty && price ? +(qty * price).toFixed(2) : undefined);

  return {
    id:        uuidv4(),
    time_key:  body.time_key,
    timestamp: body.timestamp ?? new Date().toISOString(),
    symbol:    body.symbol,
    name:      body.name,
    direction: body.direction,
    quantity:  body.quantity,
    price:     body.price,
    amount,
    rationale: body.rationale,
    rationale_type: body.rationale_type,
    emotion_state:  body.emotion_state,
    linked_baseline_stage:   snap?.market_stage,
    linked_baseline_emotion: snap?.emotion_score,
    tags:       body.tags ?? [],
    notes:      body.notes,
    created_at: new Date().toISOString(),
    created_by: body.created_by ?? 'self',
  };
}

// POST /api/review/operation —— 单笔操作写入
router.post('/operation', (req: Request, res: Response) => {
  try {
    const body = req.body as TradeOperationUploadRequest;
    if (!body.time_key || !body.symbol || !body.direction || !body.rationale_type || !body.emotion_state) {
      return res.status(400).json({
        error: '缺少必填字段：time_key, symbol, direction, rationale_type, emotion_state',
      });
    }
    const op = insertOperation(makeOperation(body));
    aggregateDailyReview(body.time_key);
    res.json({ success: true, operation: op });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/review/operation/batch —— 批量操作写入
router.post('/operation/batch', (req: Request, res: Response) => {
  try {
    const { operations } = req.body as { operations: TradeOperationUploadRequest[] };
    if (!Array.isArray(operations) || !operations.length) {
      return res.status(400).json({ error: 'operations 必须为非空数组' });
    }
    const ids: string[] = [];
    const dates = new Set<string>();
    for (const body of operations) {
      if (!body.time_key || !body.symbol || !body.direction) continue;
      const op = insertOperation(makeOperation(body));
      ids.push(op.id);
      dates.add(body.time_key);
    }
    for (const d of dates) aggregateDailyReview(d);
    res.json({ success: true, count: ids.length, dates: [...dates] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/review/operations?date=YYYY-MM-DD
router.get('/operations', (req: Request, res: Response) => {
  const date = req.query['date'] as string;
  const start = req.query['start'] as string;
  const end = req.query['end'] as string;
  if (start && end) {
    return res.json(getOperationsByRange(start, end));
  }
  if (!date) return res.status(400).json({ error: '需提供 date 或 start+end' });
  res.json(getOperationsByDate(date));
});

// GET /api/review/operation/:id —— 单个操作 + 其全部评估
router.get('/operation/:id', (req: Request, res: Response) => {
  const op = getOperationById(req.params.id);
  if (!op) return res.status(404).json({ error: 'operation 不存在' });
  const evals = getEvaluationsByOperation(op.id);
  res.json({ operation: op, evaluations: evals });
});

// DELETE /api/review/operation/:id
router.delete('/operation/:id', (req: Request, res: Response) => {
  const op = getOperationById(req.params.id);
  if (!op) return res.status(404).json({ error: 'operation 不存在' });
  deleteOperation(req.params.id);
  aggregateDailyReview(op.time_key);
  res.json({ success: true });
});

// POST /api/review/operation/:id/eval —— 写入操作评估（agent 或 self）
router.post('/operation/:id/eval', (req: Request, res: Response) => {
  try {
    const op = getOperationById(req.params.id);
    if (!op) return res.status(404).json({ error: 'operation 不存在' });

    const body = req.body as OperationEvaluationUploadRequest;
    if (typeof body.score !== 'number' || !body.evaluator || !body.verdict) {
      return res.status(400).json({ error: '缺少必填字段：evaluator, score, verdict' });
    }
    const ev: OperationEvaluation = {
      id:               uuidv4(),
      operation_id:     op.id,
      time_key:         op.time_key,
      evaluator:        body.evaluator,
      score:            body.score,
      verdict:          body.verdict,
      alignment_score:  body.alignment_score ?? 50,
      pros:             body.pros ?? [],
      cons:             body.cons ?? [],
      suggestions:      body.suggestions ?? [],
      next_action_hint: body.next_action_hint,
      created_at:       new Date().toISOString(),
    };
    insertEvaluation(ev);
    aggregateDailyReview(op.time_key);
    res.json({ success: true, evaluation: ev });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/review/daily?date=YYYY-MM-DD
router.get('/daily', (req: Request, res: Response) => {
  const date = req.query['date'] as string;
  const start = req.query['start'] as string;
  const end = req.query['end'] as string;
  if (start && end) return res.json(getDailyReviewsByRange(start, end));
  if (!date) return res.status(400).json({ error: '需提供 date 或 start+end' });
  const review = getDailyReview(date);
  if (!review) return res.json({});
  res.json(review);
});

// POST /api/review/daily/:date/aggregate —— 手动重新聚合
router.post('/daily/:date/aggregate', (req: Request, res: Response) => {
  try {
    const review = aggregateDailyReview(req.params.date);
    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/review/daily/:date/plan —— 写入/更新当日的 next_actions / takeaways / mistakes
router.post('/daily/:date/plan', (req: Request, res: Response) => {
  try {
    const date = req.params.date;
    const body = req.body as DailyReviewPlanRequest;
    let review = getDailyReview(date);
    if (!review) review = aggregateDailyReview(date);
    if (Array.isArray(body.next_actions))   review.next_actions = body.next_actions;
    if (Array.isArray(body.key_takeaways))  review.key_takeaways = body.key_takeaways;
    if (Array.isArray(body.mistakes))       review.mistakes = body.mistakes;
    if (typeof body.mood_summary === 'string') review.mood_summary = body.mood_summary;
    review.generated_at = new Date().toISOString();
    upsertDailyReview(review);
    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
