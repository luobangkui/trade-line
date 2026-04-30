import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  getChatSettings, upsertChatSettings, deleteChatSettings,
  listChatThreads, getChatThread, insertChatThread, updateChatThread, deleteChatThread,
  listChatMessages, listChatProposalsByThread, listPendingProposals, getChatProposal,
} from '../db/store';
import type { ChatAttachment, ChatAuthStyle, ChatSettings, ChatThread } from '../models/types';
import { listTools, applyProposalById, cancelProposalById } from '../services/chat-tools';
import { runAgent } from '../services/chat-agent';
import {
  saveImage, deleteThreadUploads, MAX_BYTES_PER_FILE, MAX_BYTES_PER_REQUEST,
} from '../services/chat-uploads';
import { listRecentAudits } from '../services/chat-audit';
import {
  listSkills, readSkillContent, selectRelevantSkills, getRegistryDebug,
} from '../services/skill-registry';

const router = Router();

const DEFAULT_SETTINGS: Partial<ChatSettings> = {
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  enable_tools: true,
  max_tool_iterations: 12,
  request_timeout_ms: 60000,
  auth_style: 'bearer',
  auth_header_name: 'Authorization',
};

const PRESETS: Array<{ id: string; label: string; patch: Partial<ChatSettings> }> = [
  {
    id: 'openai',
    label: 'OpenAI 兼容（Bearer）',
    patch: {
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      auth_style: 'bearer',
      auth_header_name: 'Authorization',
    },
  },
  {
    id: 'dp-openapi',
    label: 'DP OpenAPI（accessKey）',
    patch: {
      base_url: 'https://openapi.dp.tech/openapi/v1',
      model: 'openapi/claude-4.6-opus',
      auth_style: 'header',
      auth_header_name: 'accessKey',
    },
  },
];

function maskKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function publicSettings(s?: ChatSettings): Record<string, unknown> | null {
  if (!s) return null;
  return {
    base_url: s.base_url,
    api_key_masked: maskKey(s.api_key),
    api_key_set: !!s.api_key,
    model: s.model,
    temperature: s.temperature,
    enable_tools: s.enable_tools,
    max_tool_iterations: s.max_tool_iterations,
    request_timeout_ms: s.request_timeout_ms,
    auth_style: s.auth_style ?? 'bearer',
    auth_header_name: s.auth_header_name ?? 'Authorization',
    system_prompt: s.system_prompt ?? '',
    updated_at: s.updated_at,
  };
}

router.get('/settings', (_req: Request, res: Response) => {
  const settings = getChatSettings();
  return res.json({
    settings: publicSettings(settings),
    defaults: DEFAULT_SETTINGS,
    presets: PRESETS,
  });
});

router.put('/settings', (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const existing = getChatSettings();
    const baseUrl = String(body.base_url ?? existing?.base_url ?? DEFAULT_SETTINGS.base_url ?? '').trim();
    const model = String(body.model ?? existing?.model ?? DEFAULT_SETTINGS.model ?? '').trim();
    const apiKeyInput = body.api_key;
    const apiKey = typeof apiKeyInput === 'string' && apiKeyInput.trim() !== ''
      ? apiKeyInput.trim()
      : (existing?.api_key ?? '');
    if (!baseUrl) return res.status(400).json({ error: 'base_url 必填' });
    if (!model) return res.status(400).json({ error: 'model 必填' });
    if (!apiKey) return res.status(400).json({ error: 'api_key 必填（仅本地 db.json 存储）' });
    if (/api\.openai\.com/.test(baseUrl) && /^openapi\//.test(model)) {
      return res.status(400).json({
        error: '配置不匹配：base_url 仍是 api.openai.com，但 model 是 DP openapi 系列。请改用 DP OpenAPI 预设，或同步把 base_url 改成 https://openapi.dp.tech/openapi/v1 + auth_style=header + auth_header_name=accessKey。',
      });
    }
    const reqAuthStyle = body.auth_style;
    const authStyle: ChatAuthStyle = reqAuthStyle === 'header' || reqAuthStyle === 'bearer'
      ? reqAuthStyle
      : (existing?.auth_style ?? 'bearer');
    const authHeaderName = typeof body.auth_header_name === 'string' && body.auth_header_name.trim()
      ? body.auth_header_name.trim()
      : (existing?.auth_header_name ?? (authStyle === 'header' ? 'accessKey' : 'Authorization'));
    const merged: ChatSettings = {
      base_url: baseUrl,
      api_key: apiKey,
      model,
      temperature: typeof body.temperature === 'number' ? body.temperature : (existing?.temperature ?? 0.2),
      enable_tools: typeof body.enable_tools === 'boolean' ? body.enable_tools : (existing?.enable_tools ?? true),
      max_tool_iterations: Math.max(1, Math.min(50, Number(body.max_tool_iterations ?? existing?.max_tool_iterations ?? 12))),
      request_timeout_ms: Math.max(5000, Math.min(180000, Number(body.request_timeout_ms ?? existing?.request_timeout_ms ?? 60000))),
      auth_style: authStyle,
      auth_header_name: authHeaderName,
      system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt : existing?.system_prompt,
      updated_at: new Date().toISOString(),
    };
    upsertChatSettings(merged);
    return res.json({ success: true, settings: publicSettings(merged) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.delete('/settings', (_req: Request, res: Response) => {
  return res.json({ success: deleteChatSettings() });
});

router.get('/tools', (_req: Request, res: Response) => {
  return res.json({ tools: listTools() });
});

router.get('/threads', (_req: Request, res: Response) => {
  return res.json({ threads: listChatThreads() });
});

router.post('/threads', (req: Request, res: Response) => {
  const title = (req.body?.title ?? '').toString().trim() || `对话 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: `thread_${crypto.randomBytes(6).toString('hex')}`,
    title,
    created_at: now,
    updated_at: now,
    message_count: 0,
  };
  insertChatThread(thread);
  return res.json({ thread });
});

router.get('/threads/:id', (req: Request, res: Response) => {
  const thread = getChatThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread 不存在' });
  const messages = listChatMessages(thread.id);
  return res.json({ thread, messages });
});

router.patch('/threads/:id', (req: Request, res: Response) => {
  const title = (req.body?.title ?? '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title 必填' });
  const updated = updateChatThread(req.params.id, { title });
  if (!updated) return res.status(404).json({ error: 'thread 不存在' });
  return res.json({ thread: updated });
});

router.delete('/threads/:id', (req: Request, res: Response) => {
  const ok = deleteChatThread(req.params.id);
  if (ok) deleteThreadUploads(req.params.id);
  return res.json({ success: ok });
});

// 图片上传：支持 base64（前端已压缩），返回 attachment metadata
// 前端拿到后在发送 message 时把 attachments 数组传过来
router.post('/uploads', (req: Request, res: Response) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (!items.length) return res.status(400).json({ error: 'items 必填' });

    const threadId = (req.body?.thread_id ?? items[0]?.thread_id ?? '').toString();
    if (!threadId) return res.status(400).json({ error: 'thread_id 必填' });

    let totalBytes = 0;
    const saved: ChatAttachment[] = [];
    for (const it of items) {
      const mime = (it.mime ?? '').toString();
      const base64 = (it.base64 ?? '').toString();
      if (!mime || !base64) return res.status(400).json({ error: '每个 item 必须含 mime 和 base64' });
      const bytes = Math.floor(base64.length * 3 / 4);
      totalBytes += bytes;
      if (bytes > MAX_BYTES_PER_FILE) {
        return res.status(413).json({ error: `单图过大：${bytes} > ${MAX_BYTES_PER_FILE}` });
      }
      if (totalBytes > MAX_BYTES_PER_REQUEST) {
        return res.status(413).json({ error: `本次上传总和过大：${totalBytes} > ${MAX_BYTES_PER_REQUEST}` });
      }
      const r = saveImage({
        threadId,
        mime,
        base64,
        width: it.width ? Number(it.width) : undefined,
        height: it.height ? Number(it.height) : undefined,
        source: it.source ? String(it.source) : undefined,
      });
      saved.push(r.attachment);
    }
    return res.json({ attachments: saved });
  } catch (e: any) {
    console.error('[chat] /uploads 失败:', e?.stack ?? e);
    return res.status(400).json({ error: e?.message ?? 'upload failed' });
  }
});

router.post('/threads/:id/messages', async (req: Request, res: Response) => {
  try {
    const content = (req.body?.content ?? '').toString();
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments as ChatAttachment[] : undefined;
    if (!content.trim() && !attachments?.length) return res.status(400).json({ error: 'content 或 attachments 至少一项' });
    const result = await runAgent(req.params.id, content, {}, undefined, attachments);
    return res.json({
      success: true,
      assistant: result.assistant,
      messages: result.inserted_messages,
      iterations: result.iterations,
      tool_invocations: result.tool_invocations,
    });
  } catch (e: any) {
    console.error(`[chat] /threads/${req.params.id}/messages 失败:`, e?.stack ?? e);
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
});

router.post('/threads/:id/messages/stream', async (req: Request, res: Response) => {
  // 显式关闭 socket idle timeout（默认值会主动关闭长连接）
  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  // 2KB 空注释 padding，避免浏览器/中间件在收到首批小数据时不触发 streaming 解析
  try { res.write(`: ${' '.repeat(2048)}\n\n`); } catch {}

  const reqStartedAt = Date.now();
  const trace = (label: string, extra?: Record<string, unknown>) =>
    console.error(`[chat] ${new Date().toISOString()} sse[${req.params.id}] ${label} elapsed=${Date.now() - reqStartedAt}ms`, extra ?? '');
  trace('request started');
  res.on('finish', () => trace('res:finish (response fully sent)'));
  res.on('error', (err) => trace('res:error', { msg: (err as Error).message }));

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('[chat] SSE write failed:', err);
    }
  };

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15000);

  const ctrl = new AbortController();
  let closed = false;
  res.on('close', () => {
    if (res.writableEnded) {
      trace('res:close (after end, ignored)');
      return;
    }
    closed = true;
    trace('res:close BEFORE end - client disconnected', { writableEnded: res.writableEnded });
    if (!ctrl.signal.aborted) ctrl.abort();
  });

  try {
    const content = (req.body?.content ?? '').toString();
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments as ChatAttachment[] : undefined;
    if (!content.trim() && !attachments?.length) {
      send('error', { message: 'content 或 attachments 至少一项' });
      return;
    }
    const thread = getChatThread(req.params.id);
    const isFirstUserMessage = !!thread && thread.message_count === 0;

    send('start', { thread_id: req.params.id, ts: new Date().toISOString() });
    const result = await runAgent(req.params.id, content, {
      onUserMessage: (m) => send('user', m),
      onLLMStart: (iteration) => send('llm_start', { iteration }),
      onAssistantStart: (info) => send('assistant_start', info),
      onAssistantDelta: (info) => send('assistant_delta', info),
      onAssistantStep: (m) => send('assistant_step', m),
      onToolStart: (c) => send('tool_start', c),
      onToolResult: (m) => send('tool_result', m),
      onProposalCreated: (p) => send('proposal_created', p),
    }, ctrl.signal, attachments);

    // 第一条用户消息成功后，若标题仍是默认形式，按用户消息前若干字回填
    if (isFirstUserMessage) {
      const cur = getChatThread(req.params.id);
      if (cur && /^对话 /.test(cur.title)) {
        const newTitle = content.replace(/\s+/g, ' ').slice(0, 24).trim() || cur.title;
        if (newTitle !== cur.title) {
          const updated = updateChatThread(req.params.id, { title: newTitle });
          if (updated) send('thread_renamed', updated);
        }
      }
    }

    if (!closed) {
      send('done', {
        assistant: result.assistant,
        iterations: result.iterations,
        tool_invocations: result.tool_invocations,
      });
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      console.error(`[chat] /threads/${req.params.id}/messages/stream aborted by client`);
      if (!closed) send('aborted', { message: '用户中断' });
    } else {
      console.error(`[chat] /threads/${req.params.id}/messages/stream 失败:`, e?.stack ?? e);
      if (!closed) send('error', { message: e?.message ?? 'unknown' });
    }
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
});

// ── Proposal 路由 ───────────────────────────────────────────
// GET /api/chat/proposals?status=pending  全部待决
// GET /api/chat/proposals?thread_id=xxx   指定会话的全部 proposal（任意状态）
router.get('/proposals', (req: Request, res: Response) => {
  const threadId = (req.query['thread_id'] as string | undefined)?.trim();
  if (threadId) return res.json({ proposals: listChatProposalsByThread(threadId) });
  const status = (req.query['status'] as string | undefined) ?? 'pending';
  if (status === 'pending') return res.json({ proposals: listPendingProposals() });
  return res.status(400).json({ error: '需提供 thread_id 或 status=pending' });
});

router.get('/proposals/:id', (req: Request, res: Response) => {
  const p = getChatProposal(req.params.id);
  if (!p) return res.status(404).json({ error: 'proposal 不存在' });
  return res.json({ proposal: p });
});

router.post('/proposals/:id/apply', async (req: Request, res: Response) => {
  try {
    const r = await applyProposalById(req.params.id, 'user');
    return res.json({ success: true, proposal: r.proposal, result: r.result });
  } catch (e: any) {
    console.error(`[chat] apply proposal ${req.params.id} 失败:`, e?.stack ?? e);
    return res.status(400).json({ error: e?.message ?? 'unknown' });
  }
});

router.post('/proposals/:id/cancel', (req: Request, res: Response) => {
  try {
    const p = cancelProposalById(req.params.id, 'user');
    return res.json({ success: true, proposal: p });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'unknown' });
  }
});

// ── Audit 路由 ──────────────────────────────────────────────
router.get('/audits', (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(500, Number(req.query['limit']) || 50));
  return res.json({ audits: listRecentAudits(limit) });
});

// ── Skill Router 路由（只读）─────────────────────────────────
// GET /api/chat/skills                      列出已注册 skill（不含正文）
// GET /api/chat/skills/debug                查看 registry 元数据（root 路径、来源分布等）
// GET /api/chat/skills/select?q=xxx&limit=  按关键字模拟 router 匹配，返回排序得分
// GET /api/chat/skills/:id                  读取单个 skill 全文（id 可以是 list 返回的 id 或文件名）
router.get('/skills', (_req: Request, res: Response) => {
  return res.json({ skills: listSkills() });
});

router.get('/skills/debug', (_req: Request, res: Response) => {
  return res.json(getRegistryDebug());
});

router.get('/skills/select', (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  if (!q) return res.status(400).json({ error: '需提供 q 关键字' });
  const limit = Math.max(1, Math.min(8, Number(req.query['limit']) || 3));
  const items = selectRelevantSkills(q, { limit });
  return res.json({ query: q, items });
});

router.get('/skills/:id', (req: Request, res: Response) => {
  try {
    const r = readSkillContent(req.params.id);
    return res.json({ skill: r.skill, content: r.content });
  } catch (e: any) {
    return res.status(404).json({ error: e?.message ?? 'unknown' });
  }
});

export default router;
