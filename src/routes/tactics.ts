import { Router, type Request, type Response } from 'express';
import {
  archiveTactic, deleteTactic, getTactic, listTactics, upsertTactic,
} from '../db/store';
import { parseTacticImportRequest } from '../services/tactic-importer';
import { matchPretradeTactics } from '../services/tactic-matcher';
import {
  deleteAttachmentFiles, saveImage, MAX_BYTES_PER_REQUEST,
} from '../services/chat-uploads';
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

router.post('/:id/images', (req: Request, res: Response) => {
  try {
    const tactic = getTactic(req.params.id);
    if (!tactic) return res.status(404).json({ error: '战法不存在' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (!items.length) return res.status(400).json({ error: 'items 必填' });

    let totalBytes = 0;
    const saved = [];
    for (const it of items) {
      const mime = String(it.mime ?? '');
      const raw = String(it.base64 ?? '');
      const base64 = raw.includes(',') ? raw.split(',').pop() ?? '' : raw;
      if (!mime || !base64) return res.status(400).json({ error: '每个 item 必须包含 mime/base64' });
      totalBytes += Math.floor(base64.length * 3 / 4);
      if (totalBytes > MAX_BYTES_PER_REQUEST) {
        return res.status(413).json({ error: `本次上传总和过大：${totalBytes} > ${MAX_BYTES_PER_REQUEST}` });
      }
      const r = saveImage({
        threadId: `tactic_${tactic.id}`,
        mime,
        base64,
        width: it.width ? Number(it.width) : undefined,
        height: it.height ? Number(it.height) : undefined,
        source: it.source ? String(it.source) : 'tactic',
      });
      saved.push(r.attachment);
    }

    const updated = {
      ...tactic,
      illustration_images: [...(tactic.illustration_images ?? []), ...saved],
      updated_at: new Date().toISOString(),
    };
    upsertTactic(updated, { overwrite: true });
    return res.json({ success: true, images: saved, tactic: updated });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'image upload failed' });
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

router.delete('/:id', (req: Request, res: Response) => {
  const tactic = deleteTactic(req.params.id);
  if (!tactic) return res.status(404).json({ error: '战法不存在' });
  deleteAttachmentFiles(tactic.illustration_images);
  return res.json({ success: true, id: tactic.id, name: tactic.name });
});

export default router;
