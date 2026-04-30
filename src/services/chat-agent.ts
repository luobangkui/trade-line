import crypto from 'crypto';
import {
  getChatSettings, getChatThread, listChatMessages, insertChatMessage,
} from '../db/store';
import type {
  ChatAttachment, ChatMessage, ChatProposal, ChatSettings, ChatToolCall,
} from '../models/types';
import { executeTool, getOpenAIToolSchema } from './chat-tools';
import { readImageAsDataUrl } from './chat-uploads';

const TZ = 'Asia/Shanghai';
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

interface DateContext {
  todayYmd: string;
  tomorrowYmd: string;
  todayWeekday: string;
  tomorrowWeekday: string;
  isoWeekKey: string;
  monthKey: string;
  isoNow: string;
}

function getDateContext(now: Date = new Date()): DateContext {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayYmd = fmt.format(now);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const tomorrowYmd = fmt.format(tomorrow);

  const wkday = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return WEEKDAY_CN[map[parts] ?? 0];
  };

  // ISO week 算法：基于 todayYmd 重新构造 UTC 中点避免时区抖动
  const [y, m, d] = todayYmd.split('-').map(Number);
  const utcMid = new Date(Date.UTC(y, m - 1, d));
  const dayNum = utcMid.getUTCDay() || 7;
  utcMid.setUTCDate(utcMid.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcMid.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcMid.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  const isoWeekKey = `${utcMid.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  const monthKey = `${y}-${String(m).padStart(2, '0')}`;

  return {
    todayYmd, tomorrowYmd,
    todayWeekday: wkday(now),
    tomorrowWeekday: wkday(tomorrow),
    isoWeekKey, monthKey,
    isoNow: now.toISOString(),
  };
}

function buildSystemPrompt(custom: string | undefined): string {
  const ctx = getDateContext();
  const header = [
    '你是 trade-line 交易纪律助手，所有回复始终用中文。',
    `当前真实时间（${TZ}，由系统注入，必须以此为准，不要使用训练数据里的日期）：`,
    `  - 今天：${ctx.todayYmd}（周${ctx.todayWeekday}）`,
    `  - 明天：${ctx.tomorrowYmd}（周${ctx.tomorrowWeekday}）`,
    `  - 本 ISO 周：${ctx.isoWeekKey}`,
    `  - 本月：${ctx.monthKey}`,
    `  - 当前时刻 ISO：${ctx.isoNow}`,
    '当用户用"今天 / 明天 / 本周 / 本月 / 下个交易日"等表达时，直接用上面的日期；',
    '如怀疑日期不一致，调用 get_current_time 工具复核，禁止凭训练记忆猜日期。',
  ].join('\n');

  if (custom && custom.trim()) {
    return `${header}\n\n${custom.trim()}`;
  }

  const tail = [
    '',
    '讨论交易、持仓、复盘、纪律时：',
    '1. 先调用 get_today_context / get_baseline_snapshot / get_permission_card 等只读工具拉取最新数据，再下结论；不要凭空假设当日行情或持仓。',
    '2. 提到具体个股时优先使用 fetch_eastmoney_quote / fetch_eastmoney_kline 拿真实数据。',
    '3. 给建议时清晰说明依据（来自哪个工具结果），不要泛泛而谈鸡汤。',
    '4. 当用户问"今天能不能买/卖 X"，必须先看 permission_card 与 position_plan，并提示是否需要补预审记录。',
    '',
    '【写入工具使用规则】（你已经拥有写入权限）：',
    'A. 直接生效（write_direct）—— 大胆调用，无需用户确认，调用即落库：',
    '   ◦ baseline 类：create_baseline_input / trigger_aggregate_baseline',
    '   ◦ 复盘聚合：trigger_aggregate_daily_review / trigger_aggregate_period_review',
    '   ◦ 日志：create_journal / patch_journal',
    '   ◦ 评估：create_operation_evaluation（给已有 operation 打分）',
    '   ◦ 预审：create_pretrade_review',
    '   ◦ 【交易记录】create_trade_operation / update_trade_operation / delete_trade_operation',
    '     — 用户已授权 agent 直接管理交易数据，不用每次确认。',
    '     — 写错没关系：update_* 改字段、delete_* 删错条；audit log 含完整快照可追溯。',
    '     — 关键纪律：调 update / delete 前先 read 一次（get_operations 或 get_operation_with_evaluations）',
    '       确认目标 operation_id 与你脑子里以为的那一笔一致，不要凭记忆下手。',
    '     — 不能改 time_key/symbol/name；这些写错请先 delete 再 create。',
    'B. 需用户确认（write_confirm，propose_*）—— 调用后只生成提案 (proposal)，不会立即生效：',
    '   - propose_apply_period_plan（覆盖周/月 narrative/improvements/next_actions）',
    '   - propose_upsert_permission_card（次日交易刹车卡）',
    '   - propose_upsert_position_plan（逐票明日动作约束）',
    '   - propose_override_baseline（修正客观市场判断）',
    '   - propose_replace_journal（完整替换 journal）',
    '   调 propose_* 后，工具结果会返回 status=pending_user_confirmation。此时务必：',
    '   ① 用一两句话说明你想做什么改动（标的/字段/原因），并提示用户去消息下方点【应用】或【取消】；',
    '   ② 不要假设它已经成功；不要重复调用；不要继续做依赖该写入的下一步动作；',
    '   ③ 如果用户明确说「先别写 / 我自己来 / 只看不动」，立即停止 propose，改用 read 工具。',
    'C. 写入失败/频率超限会以 error 返回，请简要告知用户原因；不要静默重试。',
    'D. 对话目的若是"总结/查询/聊几句"，不要主动 propose；用户明确表达"帮我落卡 / 写复盘 / 记一下 / 改一下"再写。',
  ].join('\n');
  return header + tail;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIChoice {
  index: number;
  finish_reason: string;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  choices: OpenAIChoice[];
  usage?: Record<string, number>;
}

function nowIso(): string { return new Date().toISOString(); }
function uid(prefix: string): string { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function toOpenAI(msg: ChatMessage): OpenAIMessage {
  if (msg.role === 'assistant') {
    return {
      role: 'assistant',
      content: msg.content || '',
      ...(msg.tool_calls?.length
        ? {
            tool_calls: msg.tool_calls.map<OpenAIToolCall>((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    };
  }
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.tool_call_id ?? '',
      name: msg.tool_name,
    };
  }
  // user / system：含附件时改为多模态 content array
  if (msg.role === 'user' && msg.attachments?.length) {
    const parts: OpenAIContentPart[] = [];
    if (msg.content && msg.content.trim()) parts.push({ type: 'text', text: msg.content });
    for (const att of msg.attachments) {
      if (att.type !== 'image') continue;
      const dataUrl = readImageAsDataUrl(att);
      if (!dataUrl) {
        console.error(`[chat] toOpenAI 读图失败 path=${att.path}`);
        continue;
      }
      parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    if (!parts.length) parts.push({ type: 'text', text: '(空消息)' });
    return { role: msg.role, content: parts };
  }
  return { role: msg.role, content: msg.content };
}

function buildEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function buildAuthHeaders(settings: ChatSettings): Record<string, string> {
  const style = settings.auth_style ?? 'bearer';
  if (style === 'header') {
    const name = (settings.auth_header_name ?? 'accessKey').trim() || 'accessKey';
    return { [name]: settings.api_key };
  }
  return { authorization: `Bearer ${settings.api_key}` };
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [`${err.name}: ${err.message}`];
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    parts.push(`cause=${cause.name}: ${cause.message}${code ? ` (code=${code})` : ''}`);
    const innerCause = (cause as Error & { cause?: unknown }).cause;
    if (innerCause instanceof Error) {
      parts.push(`inner=${innerCause.name}: ${innerCause.message}`);
    }
  } else if (cause) {
    parts.push(`cause=${JSON.stringify(cause)}`);
  }
  return parts.join(' | ');
}

interface LLMStreamPart {
  delta_content?: string;
  delta_tool_calls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  finish_reason?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

async function* streamLLM(
  settings: ChatSettings,
  messages: OpenAIMessage[],
  enableTools: boolean,
  externalSignal?: AbortSignal,
): AsyncGenerator<LLMStreamPart> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), settings.request_timeout_ms || 60000);
  const onExternalAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);
  const endpoint = buildEndpoint(settings.base_url);
  const authHeaders = buildAuthHeaders(settings);
  const startedAt = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
      temperature: settings.temperature,
      stream: true,
    };
    if (enableTools) {
      body.tools = getOpenAIToolSchema();
      body.tool_choice = 'auto';
    }
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const elapsed = Date.now() - startedAt;
      const detail = describeFetchError(e);
      const headerNames = Object.keys(authHeaders).join(',');
      console.error(`[chat] ${new Date().toISOString()} fetch error endpoint=${endpoint} model=${settings.model} auth=${headerNames} elapsed=${elapsed}ms ${detail}`);
      throw new Error(`LLM 调用失败（网络层）: ${detail}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[chat] ${new Date().toISOString()} LLM HTTP ${res.status} endpoint=${endpoint} model=${settings.model} body=${text.slice(0, 500)}`);
      throw new Error(`LLM 调用失败 ${res.status}: ${text.slice(0, 500)}`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      // 兼容：服务端忽略了 stream:true，直接返回了一个完整 JSON
      const data = await res.json() as OpenAIResponse;
      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (msg?.content) yield { delta_content: msg.content };
      if (msg?.tool_calls?.length) {
        yield {
          delta_tool_calls: msg.tool_calls.map((tc, i) => ({
            index: i, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments,
          })),
        };
      }
      yield { finish_reason: choice?.finish_reason ?? 'stop', model: data.model, usage: data.usage };
      return;
    }
    if (!res.body) throw new Error('LLM stream 响应没有 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx;
      while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sepIdx).trim();
        buffer = buffer.slice(sepIdx + 2);
        if (!chunk) continue;
        // 一个 chunk 可能多行 data:
        let dataStr = '';
        for (const line of chunk.split('\n')) {
          const ln = line.trim();
          if (ln.startsWith(':')) continue;
          if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
        }
        if (!dataStr) continue;
        if (dataStr === '[DONE]') return;
        let payload: any;
        try { payload = JSON.parse(dataStr); }
        catch { continue; }
        const choice = payload.choices?.[0];
        if (!choice) {
          if (payload.usage) yield { usage: payload.usage, model: payload.model };
          continue;
        }
        const out: LLMStreamPart = { model: payload.model };
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length) out.delta_content = delta.content;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          out.delta_tool_calls = delta.tool_calls.map((tc: any) => ({
            index: tc.index ?? 0,
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          }));
        }
        if (choice.finish_reason) out.finish_reason = choice.finish_reason;
        if (payload.usage) out.usage = payload.usage;
        if (out.delta_content || out.delta_tool_calls || out.finish_reason || out.usage) yield out;
      }
    }
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function summarizeToolResult(value: unknown, limit = 8000): string {
  let str: string;
  if (value === undefined) str = 'null';
  else if (typeof value === 'string') str = value;
  else {
    try { str = JSON.stringify(value); }
    catch { str = String(value); }
  }
  if (str.length > limit) {
    return str.slice(0, limit) + `\n…[truncated, total ${str.length} chars]`;
  }
  return str;
}

export interface RunAgentResult {
  assistant: ChatMessage;
  inserted_messages: ChatMessage[];
  iterations: number;
  tool_invocations: number;
}

export interface AgentHooks {
  onUserMessage?(msg: ChatMessage): void;
  onAssistantStart?(info: { id: string; iteration: number }): void;
  onAssistantDelta?(info: { id: string; delta: string; iteration: number }): void;
  onAssistantStep?(msg: ChatMessage): void;
  onToolStart?(call: { id: string; name: string; arguments: string; iteration: number }): void;
  onToolResult?(msg: ChatMessage): void;
  onLLMStart?(iteration: number): void;
  /** 当 propose_* 工具创建了一条 pending proposal 时触发 */
  onProposalCreated?(proposal: ChatProposal): void;
}

export async function runAgent(
  threadId: string,
  userContent: string,
  hooks: AgentHooks = {},
  abortSignal?: AbortSignal,
  attachments?: ChatAttachment[],
): Promise<RunAgentResult> {
  const settings = getChatSettings();
  if (!settings) throw new Error('请先在「对话设置」里配置 base_url / api_key / model');
  const thread = getChatThread(threadId);
  if (!thread) throw new Error(`thread 不存在: ${threadId}`);
  const attCount = attachments?.length ?? 0;
  console.error(`[chat] ${new Date().toISOString()} runAgent thread=${threadId} base_url=${settings.base_url} model=${settings.model} auth_style=${settings.auth_style ?? 'bearer'} auth_header=${settings.auth_header_name ?? 'Authorization'} key_len=${(settings.api_key || '').length} attachments=${attCount}`);

  const trimmedUser = (userContent ?? '').trim();
  if (!trimmedUser && !attCount) throw new Error('消息内容不能为空');

  const inserted: ChatMessage[] = [];

  const userMsg: ChatMessage = {
    id: uid('msg'),
    thread_id: threadId,
    role: 'user',
    content: trimmedUser,
    created_at: nowIso(),
    ...(attCount ? { attachments } : {}),
  };
  insertChatMessage(userMsg);
  inserted.push(userMsg);
  hooks.onUserMessage?.(userMsg);

  const history = listChatMessages(threadId);
  const systemPrompt = buildSystemPrompt(settings.system_prompt);
  const baseMessages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map(toOpenAI),
  ];

  let iterations = 0;
  let toolInvocations = 0;
  let assistantFinal: ChatMessage | null = null;
  const maxIter = Math.max(1, Math.min(10, settings.max_tool_iterations || 4));

  while (iterations < maxIter) {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    iterations += 1;
    hooks.onLLMStart?.(iterations);

    const assistantId = uid('msg');
    hooks.onAssistantStart?.({ id: assistantId, iteration: iterations });

    let contentBuf = '';
    const toolCallsAcc = new Map<number, ChatToolCall>();
    let finishReason: string | undefined;
    let modelName: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let streamThrew: unknown = null;

    try {
      for await (const part of streamLLM(settings, baseMessages, settings.enable_tools, abortSignal)) {
        if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (part.model) modelName = part.model;
        if (part.usage) usage = part.usage;
        if (part.delta_content) {
          contentBuf += part.delta_content;
          hooks.onAssistantDelta?.({ id: assistantId, delta: part.delta_content, iteration: iterations });
        }
        if (part.delta_tool_calls) {
          for (const dt of part.delta_tool_calls) {
            let acc = toolCallsAcc.get(dt.index);
            if (!acc) {
              acc = { id: dt.id ?? '', name: dt.name ?? '', arguments: '' };
              toolCallsAcc.set(dt.index, acc);
            }
            if (dt.id) acc.id = dt.id;
            if (dt.name) acc.name = dt.name;
            if (dt.arguments) acc.arguments += dt.arguments;
          }
        }
        if (part.finish_reason) finishReason = part.finish_reason;
      }
    } catch (e) {
      streamThrew = e;
      console.error(`[chat] ${new Date().toISOString()} streamLLM threw at iter=${iterations} contentLen=${contentBuf.length} toolAccs=${toolCallsAcc.size} err=`, (e as Error)?.message ?? e);
    }

    const toolCalls: ChatToolCall[] = Array.from(toolCallsAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((c) => c.name);

    // 关键改动：无论 stream 是否抛错，只要拿到了任何内容/工具调用，就持久化 partial assistant message。
    // 这样浏览器端流式渲染的内容不会因为中断后 reload 而消失。
    const hasAnyOutput = !!contentBuf || toolCalls.length > 0;
    if (hasAnyOutput || !streamThrew) {
      const assistantMsg: ChatMessage = {
        id: assistantId,
        thread_id: threadId,
        role: 'assistant',
        content: contentBuf,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        created_at: nowIso(),
        metadata: {
          finish_reason: finishReason,
          usage,
          model: modelName,
          iteration: iterations,
          ...(streamThrew ? { partial: true, error: (streamThrew as Error)?.message ?? String(streamThrew) } : {}),
        },
      };
      insertChatMessage(assistantMsg);
      inserted.push(assistantMsg);
      baseMessages.push(toOpenAI(assistantMsg));
      hooks.onAssistantStep?.(assistantMsg);

      if (streamThrew) {
        // 即使保存了 partial，仍把错误抛出去让上层走错误流程（前端会收到 error 事件）
        throw streamThrew;
      }

      if (!toolCalls.length) {
        assistantFinal = assistantMsg;
        break;
      }
    } else {
      // 没拿到任何内容也没有工具调用，直接抛错让上层处理
      throw streamThrew ?? new Error('LLM 返回为空');
    }

    // 当前 assistant 消息的 id（用于关联 proposal）
    const lastAssistantId = inserted[inserted.length - 1]?.id;

    for (const call of toolCalls) {
      if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
      toolInvocations += 1;
      hooks.onToolStart?.({
        id: call.id, name: call.name, arguments: call.arguments, iteration: iterations,
      });
      const startedAt = Date.now();
      let toolContent: string;
      let toolStatus: 'ok' | 'error' = 'ok';
      try {
        const result = await executeTool(call.name, call.arguments, {
          thread_id: threadId,
          message_id: lastAssistantId,
          tool_call_id: call.id,
          source: 'agent:chat',
          emit_proposal: (p) => hooks.onProposalCreated?.(p),
        });
        toolContent = summarizeToolResult(result);
      } catch (e) {
        toolStatus = 'error';
        toolContent = JSON.stringify({ error: (e as Error).message ?? String(e) });
      }
      const toolMsg: ChatMessage = {
        id: uid('msg'),
        thread_id: threadId,
        role: 'tool',
        content: toolContent,
        tool_call_id: call.id,
        tool_name: call.name,
        created_at: nowIso(),
        metadata: {
          tool_status: toolStatus,
          duration_ms: Date.now() - startedAt,
          arguments: call.arguments,
        },
      };
      insertChatMessage(toolMsg);
      inserted.push(toolMsg);
      baseMessages.push(toOpenAI(toolMsg));
      hooks.onToolResult?.(toolMsg);
    }
  }

  if (!assistantFinal) {
    const fallback: ChatMessage = {
      id: uid('msg'),
      thread_id: threadId,
      role: 'assistant',
      content: `已达到工具迭代上限 (${maxIter})，请重新提问或缩小范围。`,
      created_at: nowIso(),
      metadata: { reason: 'max_iterations' },
    };
    insertChatMessage(fallback);
    inserted.push(fallback);
    hooks.onAssistantStep?.(fallback);
    assistantFinal = fallback;
  }

  return {
    assistant: assistantFinal,
    inserted_messages: inserted,
    iterations,
    tool_invocations: toolInvocations,
  };
}
