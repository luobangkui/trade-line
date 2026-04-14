import { Router } from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { BaselineInput, FutureWatchItem, InputUploadRequest, TimelineNode } from '../models/types';
import {
  insertInput, getSnapshotByDate, getSnapshotsInRange, getAllInputs,
  insertFutureItem, getFutureItemsByRange, getAllFutureItems, updateFutureItemStatus,
} from '../db/store';
import { aggregateSnapshot } from '../services/aggregator';

const router = Router();

function makeInput(body: InputUploadRequest, extra: Partial<BaselineInput> = {}): BaselineInput {
  return {
    id:               uuidv4(),
    time_key:         body.time_key,
    time_granularity: body.time_type ?? 'day',
    data_type:        body.data_type,
    source:           body.source,
    source_type:      'agent',
    title:            body.title,
    payload:          body.payload ?? {},
    confidence:       body.confidence ?? 0.8,
    priority:         body.priority ?? 5,
    tags:             body.tags ?? [],
    effective_start:  body.effective_time_range?.start,
    effective_end:    body.effective_time_range?.end,
    created_at:       new Date().toISOString(),
    created_by:       body.source,
    status:           'active',
    ...extra,
  };
}

function makeFuture(body: InputUploadRequest): FutureWatchItem {
  return {
    id:            uuidv4(),
    expected_time: body.effective_time_range?.start ?? body.time_key,
    event_type:    (body.payload?.['event_type'] as string) ?? 'generic',
    title:         body.title,
    payload:       body.payload ?? {},
    certainty:     (body.payload?.['certainty'] as FutureWatchItem['certainty']) ?? 'medium',
    impact_level:  body.confidence ?? 0.5,
    review_status: 'pending',
    linked_snapshot_time_key: body.time_key,
    created_at:    new Date().toISOString(),
  };
}

// POST /api/baseline/input
router.post('/input', async (req: Request, res: Response) => {
  try {
    const body = req.body as InputUploadRequest;
    if (!body.time_key || !body.data_type || !body.source || !body.title) {
      res.status(400).json({ error: 'Missing: time_key, data_type, source, title' });
      return;
    }
    if (body.data_type === 'future_event') {
      const item = insertFutureItem(makeFuture(body));
      res.json({ success: true, id: item.id, type: 'future_watchlist' });
      return;
    }
    const input = insertInput(makeInput(body));
    const snapshot = await aggregateSnapshot(body.time_key);
    res.json({ success: true, input_id: input.id, snapshot_id: snapshot.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/baseline/input/batch
router.post('/input/batch', async (req: Request, res: Response) => {
  try {
    const { inputs } = req.body as { inputs: InputUploadRequest[] };
    if (!Array.isArray(inputs) || !inputs.length) {
      res.status(400).json({ error: 'inputs[] required' });
      return;
    }
    const affected = new Set<string>();
    const ids: string[] = [];
    for (const body of inputs) {
      if (!body.time_key || !body.data_type || !body.source || !body.title) continue;
      if (body.data_type === 'future_event') {
        insertFutureItem(makeFuture(body));
      } else {
        const inp = insertInput(makeInput(body));
        affected.add(body.time_key);
        ids.push(inp.id);
      }
    }
    const snapshots: Record<string, string> = {};
    for (const date of affected) {
      const s = await aggregateSnapshot(date);
      snapshots[date] = s.id;
    }
    res.json({ success: true, count: ids.length, snapshots });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/baseline/snapshot?date=
router.get('/snapshot', (req: Request, res: Response) => {
  const date = req.query['date'] as string;
  if (!date) { res.status(400).json({ error: 'date required' }); return; }
  const snap = getSnapshotByDate(date);
  if (!snap) { res.status(404).json({ error: `No snapshot for ${date}` }); return; }
  res.json(snap);
});

// GET /api/baseline/timeline?start=&end=
router.get('/timeline', (req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const start = (req.query['start'] as string) ?? '2026-01-01';
  const end   = (req.query['end']   as string) ?? '2026-12-31';

  const snaps   = getSnapshotsInRange(start, end);
  const futures = getFutureItemsByRange(start, end);

  const map = new Map<string, TimelineNode>();

  for (const s of snaps) {
    map.set(s.time_key, {
      date:         s.time_key,
      node_type:    s.time_key > today ? 'future' : s.time_key === today ? 'interpretation' : 'fact',
      is_future:    s.time_key > today,
      snapshot:     s,
      inputs_count: (s.summary['input_count'] as number) ?? 0,
      future_items: [],
      highlight:    s.time_key === today,
    });
  }

  for (const fi of futures) {
    const dk = fi.expected_time.slice(0, 10);
    if (!map.has(dk)) {
      map.set(dk, { date: dk, node_type: 'future', is_future: dk >= today, inputs_count: 0, future_items: [], highlight: false });
    }
    map.get(dk)!.future_items.push(fi);
  }

  const nodes = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  res.json({ nodes, today });
});

// POST /api/baseline/override
router.post('/override', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body.time_key) { res.status(400).json({ error: 'time_key required' }); return; }
    const input = insertInput({
      id: uuidv4(), time_key: body.time_key, time_granularity: 'day',
      data_type: 'override', source: body.source ?? 'manual', source_type: 'user',
      title: `人工修正 ${body.time_key}`, payload: {
        market_stage: body.market_stage, emotion_score: body.emotion_score,
        risk_level: body.risk_level, position_min: body.position_min,
        position_max: body.position_max, action_summary: body.action_summary, note: body.note,
      },
      confidence: 1.0, priority: 10, tags: ['override'],
      created_at: new Date().toISOString(), created_by: body.source ?? 'manual', status: 'active',
    });
    const snapshot = await aggregateSnapshot(body.time_key);
    res.json({ success: true, input_id: input.id, snapshot });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/baseline/inputs?date=
router.get('/inputs', (req: Request, res: Response) => {
  const date = req.query['date'] as string | undefined;
  const all = getAllInputs().filter((i) => !date || i.time_key === date);
  res.json(all);
});

// GET /api/baseline/future
router.get('/future', (_req: Request, res: Response) => {
  res.json(getAllFutureItems().sort((a, b) => a.expected_time.localeCompare(b.expected_time)));
});

// POST /api/baseline/future/:id/status
router.post('/future/:id/status', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body as { status: FutureWatchItem['review_status'] };
  if (!['pending', 'triggered', 'expired', 'fulfilled'].includes(status)) {
    res.status(400).json({ error: 'invalid status' }); return;
  }
  updateFutureItemStatus(id, status);
  res.json({ success: true });
});

// POST /api/baseline/aggregate/:date
router.post('/aggregate/:date', async (req: Request, res: Response) => {
  try {
    const snap = await aggregateSnapshot(req.params['date']!);
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
