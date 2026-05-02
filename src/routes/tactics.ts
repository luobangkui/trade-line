import { Router, type Request, type Response } from 'express';
import {
  archiveTactic, getTactic, listTactics, upsertTactic,
} from '../db/store';
import { parseTacticImportRequest } from '../services/tactic-importer';
import { matchPretradeTactics } from '../services/tactic-matcher';
import type { TacticImportRequest, TacticMatchIntent, TacticStatus } from '../models/types';

const router = Router();

router.post('/import', (req: Request, res: Response) => {
  try {
    const body = req.body as TacticImportRequest;
    const parsed = parseTacticImportRequest(body);
    const imported = [];
    const skipped = [...parsed.skipped];
    for (const tactic of parsed.imported) {
      const r = upsertTactic(tactic, { overwrite: body.overwrite });
      if (r.skipped) skipped.push({ name: tactic.name, reason: r.reason ?? '已存在' });
      else imported.push(r.tactic);
    }
    return res.json({
      success: true,
      imported,
      skipped,
      warnings: parsed.warnings,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'invalid tactic import' });
  }
});

router.get('/', (req: Request, res: Response) => {
  const includeArchived = String(req.query['include_archived'] ?? '') === '1';
  const tag = req.query['tag'] ? String(req.query['tag']) : undefined;
  const rawStatus = req.query['status'] ? String(req.query['status']) : undefined;
  const status = rawStatus === 'draft' || rawStatus === 'active' || rawStatus === 'archived'
    ? rawStatus as TacticStatus
    : undefined;
  return res.json({ items: listTactics({ include_archived: includeArchived, tag, status }) });
});

router.post('/match', (req: Request, res: Response) => {
  try {
    const body = req.body as TacticMatchIntent;
    const result = matchPretradeTactics(body);
    return res.json({ result });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'match failed' });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  const tactic = getTactic(req.params.id);
  if (!tactic) return res.status(404).json({ error: '战法不存在' });
  return res.json({ tactic });
});

router.post('/:id/archive', (req: Request, res: Response) => {
  const tactic = archiveTactic(req.params.id);
  if (!tactic) return res.status(404).json({ error: '战法不存在' });
  return res.json({ success: true, tactic });
});

export default router;
