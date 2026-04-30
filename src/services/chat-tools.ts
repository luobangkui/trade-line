import {
  getSnapshotByDate, getSnapshotsInRange, getInputsByTimeKey,
  getOperationsByDate, getOperationsByRange, getOperationById, getEvaluationsByOperation,
  getDailyReview, getPeriodReview,
  getPermissionCard, getPermissionCardsByRange,
  getPositionPlansByDate, getPositionPlansByRange, getPositionPlan,
  getPretradeReviewsByDate, getPretradeReviewsByRange, getPretradeReview,
} from '../db/store';
import { detectTradeViolations } from './violation-detector';
import {
  aggregatePeriodReview, buildPeriodInsight, isoWeekKey, monthKey,
} from './period-reviewer';
import { WRITE_HANDLER_LIST, getWriteHandler } from './chat-write-tools';
import {
  insertChatProposal, getChatProposal, updateChatProposal,
} from '../db/store';
import {
  appendAudit, rateLimitCheck, rateLimitRefund, RATE_LIMIT_PER_MIN, type AuditEntry,
} from './chat-audit';
import {
  listSkills as registryListSkills,
  readSkillContent as registryReadSkill,
  selectRelevantSkills as registrySelectSkills,
} from './skill-registry';
import type { ChatProposal, ChatProposalStatus, SkillDoc } from '../models/types';
import crypto from 'crypto';

// ── 工具定义 ───────────────────────────────────────────

export type ToolSideEffect = 'read' | 'write_direct' | 'write_confirm';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  side_effect: ToolSideEffect;
  risk?: 'low' | 'medium' | 'high';
  /** read / write_direct 用：直接调用即可 */
  handler?: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<unknown>;
}

export interface ToolExecCtx {
  /** 触发该 tool call 的会话 / 消息上下文（read 类工具可不读） */
  thread_id?: string;
  message_id?: string;
  tool_call_id?: string;
  /** 谁触发：agent:chat（LLM 发起）或 user（apply proposal） */
  source?: string;
  /** write_confirm 类需要把生成的 proposal 通过此回调推到前端 */
  emit_proposal?: (p: ChatProposal) => void;
}

function isYmd(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function strParam(name: string, args: Record<string, unknown>, required = true): string | undefined {
  const v = args[name];
  if (v == null || v === '') {
    if (required) throw new Error(`参数 ${name} 必填`);
    return undefined;
  }
  return String(v);
}

function ymdParam(name: string, args: Record<string, unknown>, required = true): string | undefined {
  const v = strParam(name, args, required);
  if (v == null) return undefined;
  if (!isYmd(v)) throw new Error(`参数 ${name} 必须为 YYYY-MM-DD 格式`);
  return v;
}

function summarizeSkillForList(d: SkillDoc) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    source: d.source,
    display_path: d.display_path,
    triggers: d.triggers,
    priority: d.priority,
    tags: d.tags,
    size: d.size,
    has_frontmatter: d.has_frontmatter,
  };
}

// ── 东方财富工具（只读）────────────────────────────────

interface EmJson { rc?: number; data?: any; [key: string]: any }

function normalizeSecid(secid: string): string {
  if (secid.includes('.')) return secid;
  if (/^(60|68|110|113|511|512|513|515|518|588|9)/.test(secid)) return `1.${secid}`;
  return `0.${secid}`;
}

async function emFetch(url: string, timeoutMs = 8000): Promise<EmJson> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 trade-line-chat' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`东财接口返回 ${r.status}`);
    const text = await r.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEastmoneyQuotes(secids: string[]): Promise<unknown> {
  if (!secids.length) throw new Error('secids 不能为空');
  const ids = secids.map(normalizeSecid).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f8,f10,f13&secids=${ids}`;
  const data = await emFetch(url);
  const diff = data?.data?.diff ?? [];
  return diff.map((x: any) => ({
    code: x.f12, name: x.f14, market: x.f13, price: x.f2, pct: x.f3, change: x.f4,
    volume: x.f5, amount: x.f6, high: x.f15, low: x.f16, open: x.f17, prev_close: x.f18,
    turnover: x.f8, vol_ratio: x.f10,
  }));
}

async function fetchEastmoneyKline(secid: string, period = 'D', beg?: string, end?: string): Promise<unknown> {
  const klt = period === 'W' ? '102' : period === 'M' ? '103' : '101';
  const begStr = (beg ?? '20250101').replace(/-/g, '');
  const endStr = (end ?? '20500101').replace(/-/g, '');
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${normalizeSecid(secid)}&klt=${klt}&fqt=1&beg=${begStr}&end=${endStr}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const data = await emFetch(url);
  const klines = (data?.data?.klines ?? []) as string[];
  return klines.map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(',');
    return {
      date,
      open: Number(open), close: Number(close), high: Number(high), low: Number(low),
      volume: Number(volume), amount: Number(amount),
      amplitude_pct: Number(amplitude), pct: Number(pct), change: Number(change),
      turnover_pct: Number(turnover),
    };
  });
}

const INDEX_SECIDS: Array<{ key: string; name: string; secid: string }> = [
  { key: 'shanghai', name: '上证指数', secid: '1.000001' },
  { key: 'shenzhen', name: '深证成指', secid: '0.399001' },
  { key: 'chinext', name: '创业板指', secid: '0.399006' },
  { key: 'csi500', name: '中证500', secid: '0.399905' },
  { key: 'star50', name: '科创50', secid: '1.000688' },
];

async function fetchEastmoneyIndices(): Promise<unknown> {
  const out: Record<string, any> = {};
  for (const { key, name, secid } of INDEX_SECIDS) {
    try {
      const data = await emFetch(`https://push2.eastmoney.com/api/qt/stock/get?fltt=2&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60&secid=${secid}`);
      const d = data?.data ?? {};
      const close = Number(d.f43);
      const prev = Number(d.f60);
      const pct = prev ? +(((close - prev) / prev) * 100).toFixed(2) : null;
      out[key] = { name, code: d.f57, close, prev_close: prev, high: d.f44, low: d.f45, open: d.f46, volume: d.f47, amount: d.f48, vol_ratio: d.f50, pct };
    } catch (e) {
      out[key] = { name, error: String((e as Error).message) };
    }
  }
  return out;
}

function ymdCompact(d: string): string {
  return d.replace(/-/g, '');
}

async function fetchPool(endpoint: string, date: string): Promise<unknown> {
  const url = `https://push2ex.eastmoney.com/${endpoint}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${ymdCompact(date)}`;
  const data = await emFetch(url);
  const tc = data?.data?.tc;
  const pool = (data?.data?.pool ?? []) as any[];
  return {
    total_announced: tc,
    detail_count: pool.length,
    items: pool.slice(0, 50).map((x) => ({
      code: x.c, name: x.n, pct: x.zdp,
      first_time: x.fbt, last_time: x.lbt,
      reason: x.hybk, plates: x.gn,
      lbc: x.lbc, zbc: x.zbc, hs: x.hs,
    })),
  };
}

async function fetchEastmoneyZTPool(date: string): Promise<unknown> {
  return fetchPool('getTopicZTPool', date);
}

async function fetchEastmoneyDTPool(date: string): Promise<unknown> {
  return fetchPool('getTopicDTPool', date);
}

async function fetchEastmoneyConceptBoards(direction: 'up' | 'down' = 'up', limit = 15): Promise<unknown> {
  const po = direction === 'up' ? 1 : 0;
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=${po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f12,f14,f2,f3,f4,f5,f6,f8,f10,f20`;
  const data = await emFetch(url);
  return (data?.data?.diff ?? []).map((x: any) => ({
    code: x.f12, name: x.f14, price: x.f2, pct: x.f3, change: x.f4,
    volume: x.f5, amount: x.f6, turnover: x.f8, vol_ratio: x.f10, market_cap: x.f20,
  }));
}

// ── 工具表 ─────────────────────────────────────────────

function defineRead(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    name, description, parameters, side_effect: 'read',
    handler: async (args) => handler(args),
  };
}

// 把 WRITE_HANDLERS 转为 ToolDefinition 列表
function buildWriteToolDefinitions(): ToolDefinition[] {
  return WRITE_HANDLER_LIST.map((h): ToolDefinition => ({
    name: h.name,
    description: h.description,
    parameters: h.parameters,
    side_effect: h.side_effect,
    risk: h.risk,
    // 写工具的真正分发逻辑放在 executeTool 里（要走 audit / 频率限制 / proposal）
  }));
}

function nowInShanghai(): Record<string, string> {
  const now = new Date();
  const tz = 'Asia/Shanghai';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayYmd = fmt.format(now);
  const tomorrowYmd = fmt.format(new Date(now.getTime() + 86_400_000));
  const wkdayShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const tomorrowShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(now.getTime() + 86_400_000));
  const cnMap: Record<string, string> = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
  const [y, m, d] = todayYmd.split('-').map(Number);
  const utcMid = new Date(Date.UTC(y, m - 1, d));
  const dayNum = utcMid.getUTCDay() || 7;
  utcMid.setUTCDate(utcMid.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcMid.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcMid.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return {
    today: todayYmd,
    today_weekday: cnMap[wkdayShort] ?? wkdayShort,
    tomorrow: tomorrowYmd,
    tomorrow_weekday: cnMap[tomorrowShort] ?? tomorrowShort,
    iso_week_key: `${utcMid.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`,
    month_key: `${y}-${String(m).padStart(2, '0')}`,
    iso_now_utc: now.toISOString(),
    timezone: tz,
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  defineRead(
    'get_current_time',
    '获取服务器当前时间（Asia/Shanghai 时区），返回今天/明天日期、星期、ISO 周 key、月 key。当用户提到"今天/明天/本周/本月"或对日期有疑问时必须调用。',
    { type: 'object', properties: {}, additionalProperties: false },
    () => nowInShanghai(),
  ),
  defineRead(
    'list_skill_docs',
    '列出已注册的 skill（仓库内置 SKILL.md / skill/*.md 与用户级 ~/.trade-line/skills/）。返回每个 skill 的 id/name/description/triggers/source 等元信息，不含正文。',
    { type: 'object', properties: {}, additionalProperties: false },
    () => {
      const docs = registryListSkills();
      return {
        entry: docs.find((d) => d.source === 'repo:entry')?.id ?? null,
        total: docs.length,
        docs: docs.map(summarizeSkillForList),
      };
    },
  ),
  defineRead(
    'read_skill_doc',
    '读取某个 skill 的完整 markdown 正文。name 可传：① skill id（如 "repo:doc:sop-pretrade.md" / "user:dir:my-skill"）② skill 名（如 "sop-pretrade"）③ 兼容旧用法 "SKILL.md" / "sop-pretrade.md"。先调 list_skill_docs / search_skills 拿 id 更稳。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill id / name / 文件名' } },
      required: ['name'],
      additionalProperties: false,
    },
    (args) => {
      const r = registryReadSkill(strParam('name', args)!);
      return {
        skill: summarizeSkillForList(r.skill),
        content: r.content,
      };
    },
  ),
  defineRead(
    'search_skills',
    '按关键字/触发词在已注册 skill 中检索，返回最相关的若干条（仅元信息+命中原因，不含正文）。配合 read_skill_doc 使用：先 search 再读全文。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键字，可以是中文短语或任务意图描述' },
        limit: { type: 'number', description: '返回条数上限，默认 5（最大 8）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    (args) => {
      const q = strParam('query', args)!;
      const limit = Math.max(1, Math.min(8, Number(args['limit'] ?? 5) || 5));
      const items = registrySelectSkills(q, { limit });
      return {
        query: q,
        total: items.length,
        items: items.map((it) => ({
          ...summarizeSkillForList(it.skill),
          score: it.score,
          matches: it.matches,
        })),
      };
    },
  ),
  defineRead(
    'get_baseline_snapshot',
    '获取某日市场基线快照（阶段/情绪/风险/建议仓位/核心事件）。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => getSnapshotByDate(ymdParam('date', args)!) ?? null,
  ),
  defineRead(
    'get_baseline_inputs',
    '获取某日 baseline 原子输入清单（market_snapshot / event / stage_signal 等）。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => getInputsByTimeKey(ymdParam('date', args)!),
  ),
  defineRead(
    'get_baseline_timeline',
    '获取一段时间范围内的市场基线快照列表。',
    {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'YYYY-MM-DD' },
        end: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    (args) => getSnapshotsInRange(ymdParam('start', args)!, ymdParam('end', args)!),
  ),
  defineRead(
    'get_daily_review',
    '获取某日 daily_review 聚合（评分、契合度、胜率、key_takeaways/mistakes/next_actions）。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => getDailyReview(ymdParam('date', args)!) ?? null,
  ),
  defineRead(
    'get_operations',
    '查询某日或区间的交易操作。优先 date；若提供 start+end 则查询区间。',
    {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        start: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        end: { type: 'string', description: 'YYYY-MM-DD（可选）' },
      },
      additionalProperties: false,
    },
    (args) => {
      const date = ymdParam('date', args, false);
      if (date) return getOperationsByDate(date);
      const start = ymdParam('start', args, false);
      const end = ymdParam('end', args, false);
      if (start && end) return getOperationsByRange(start, end);
      throw new Error('需提供 date 或 start+end');
    },
  ),
  defineRead(
    'get_operation_with_evaluations',
    '获取单笔操作及其全部评估。',
    {
      type: 'object',
      properties: { id: { type: 'string', description: 'operation id' } },
      required: ['id'],
      additionalProperties: false,
    },
    (args) => {
      const id = strParam('id', args)!;
      const op = getOperationById(id);
      if (!op) return null;
      return { operation: op, evaluations: getEvaluationsByOperation(id) };
    },
  ),
  defineRead(
    'get_weekly_review',
    '获取某周聚合复盘（period_key 形如 2026-W18）。若不存在则即时聚合。',
    {
      type: 'object',
      properties: { period_key: { type: 'string', description: '形如 2026-W18' } },
      required: ['period_key'],
      additionalProperties: false,
    },
    (args) => {
      const key = strParam('period_key', args)!;
      return getPeriodReview('week', key) ?? aggregatePeriodReview('week', key);
    },
  ),
  defineRead(
    'get_weekly_insights',
    '获取某周的历史模式洞察（lookback 默认 4，最大 12）。',
    {
      type: 'object',
      properties: {
        period_key: { type: 'string', description: '形如 2026-W18' },
        lookback: { type: 'number', description: '回看周数', default: 4 },
      },
      required: ['period_key'],
      additionalProperties: false,
    },
    (args) => {
      const key = strParam('period_key', args)!;
      const lookback = Math.max(1, Math.min(12, Number(args['lookback']) || 4));
      return buildPeriodInsight('week', key, lookback);
    },
  ),
  defineRead(
    'get_permission_card',
    '查询某日交易权限卡。若不存在返回 null。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => getPermissionCard(ymdParam('date', args)!) ?? null,
  ),
  defineRead(
    'get_permission_cards',
    '查询区间权限卡。',
    {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'YYYY-MM-DD' },
        end: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    (args) => getPermissionCardsByRange(ymdParam('start', args)!, ymdParam('end', args)!),
  ),
  defineRead(
    'get_position_plans',
    '查询某日持仓计划卡。若提供 start+end 则查询区间。',
    {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        start: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        end: { type: 'string', description: 'YYYY-MM-DD（可选）' },
      },
      additionalProperties: false,
    },
    (args) => {
      const date = ymdParam('date', args, false);
      if (date) return getPositionPlansByDate(date);
      const start = ymdParam('start', args, false);
      const end = ymdParam('end', args, false);
      if (start && end) return getPositionPlansByRange(start, end);
      throw new Error('需提供 date 或 start+end');
    },
  ),
  defineRead(
    'get_position_plan',
    '查询某日单只标的的持仓计划卡。',
    {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        symbol: { type: 'string', description: '标的代码' },
      },
      required: ['date', 'symbol'],
      additionalProperties: false,
    },
    (args) => getPositionPlan(ymdParam('date', args)!, strParam('symbol', args)!) ?? null,
  ),
  defineRead(
    'get_pretrade_reviews',
    '查询盘中预审记录。优先 date；或提供 start+end。',
    {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        start: { type: 'string', description: 'YYYY-MM-DD（可选）' },
        end: { type: 'string', description: 'YYYY-MM-DD（可选）' },
      },
      additionalProperties: false,
    },
    (args) => {
      const date = ymdParam('date', args, false);
      if (date) return getPretradeReviewsByDate(date);
      const start = ymdParam('start', args, false);
      const end = ymdParam('end', args, false);
      if (start && end) return getPretradeReviewsByRange(start, end);
      throw new Error('需提供 date 或 start+end');
    },
  ),
  defineRead(
    'get_pretrade_review',
    '查询单条盘中预审记录。',
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    (args) => getPretradeReview(strParam('id', args)!) ?? null,
  ),
  defineRead(
    'get_violations',
    '检测某日交易纪律违规与风险信号（基于 operations + permission + position-plan + pretrade）。只读；critical 才是硬违规，warning/info 需要复盘判定。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => detectTradeViolations(ymdParam('date', args)!),
  ),
  defineRead(
    'get_today_context',
    '一次性拿今日的 baseline / permission / position-plan / 已记录 pretrade / violations，用于盘中快速判断。violations 同时包含硬违规与 warning/info 风险信号。需要传入今日日期。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => {
      const d = ymdParam('date', args)!;
      const weekKey = isoWeekKey(d);
      return {
        date: d,
        week_key: weekKey,
        month_key: monthKey(d),
        baseline: getSnapshotByDate(d) ?? null,
        permission: getPermissionCard(d) ?? null,
        position_plans: getPositionPlansByDate(d),
        pretrade_reviews: getPretradeReviewsByDate(d),
        violations: detectTradeViolations(d),
      };
    },
  ),
  defineRead(
    'fetch_eastmoney_indices',
    '拉取主要 A 股指数最新报价（上证/深成/创业板/中证500/科创50）。',
    { type: 'object', properties: {}, additionalProperties: false },
    () => fetchEastmoneyIndices(),
  ),
  defineRead(
    'fetch_eastmoney_quote',
    '拉取一只或多只 A 股最新报价。secids 可以是裸代码（如 002317）或带交易所前缀（如 1.600600）。',
    {
      type: 'object',
      properties: {
        secids: {
          type: 'array', items: { type: 'string' },
          description: '标的代码列表，例如 ["002317","600600"]',
        },
      },
      required: ['secids'],
      additionalProperties: false,
    },
    (args) => {
      const arr = args['secids'];
      if (!Array.isArray(arr) || !arr.length) throw new Error('secids 必须是非空数组');
      return fetchEastmoneyQuotes(arr.map(String));
    },
  ),
  defineRead(
    'fetch_eastmoney_kline',
    '拉取个股历史 K 线，默认日 K，最多返回最近若干交易日。',
    {
      type: 'object',
      properties: {
        secid: { type: 'string', description: '裸代码或带前缀，例如 002317 或 0.002317' },
        period: { type: 'string', enum: ['D', 'W', 'M'], description: '日/周/月 K，默认 D' },
        beg: { type: 'string', description: '起始日期 YYYY-MM-DD 或 YYYYMMDD（可选）' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD 或 YYYYMMDD（可选）' },
      },
      required: ['secid'],
      additionalProperties: false,
    },
    (args) => fetchEastmoneyKline(
      strParam('secid', args)!,
      strParam('period', args, false) ?? 'D',
      strParam('beg', args, false),
      strParam('end', args, false),
    ),
  ),
  defineRead(
    'fetch_eastmoney_zt_pool',
    '拉取某日东方财富涨停池（前 50 只）。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => fetchEastmoneyZTPool(ymdParam('date', args)!),
  ),
  defineRead(
    'fetch_eastmoney_dt_pool',
    '拉取某日东方财富跌停池（前 50 只）。',
    {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
    (args) => fetchEastmoneyDTPool(ymdParam('date', args)!),
  ),
  defineRead(
    'fetch_eastmoney_concept_boards',
    '拉取概念板块涨/跌幅榜，默认涨幅榜，最多 50 条。',
    {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: '涨幅榜或跌幅榜，默认 up' },
        limit: { type: 'number', description: '返回条数，默认 15，最大 50' },
      },
      additionalProperties: false,
    },
    (args) => {
      const direction = (strParam('direction', args, false) ?? 'up') as 'up' | 'down';
      const limit = Math.max(1, Math.min(50, Number(args['limit']) || 15));
      return fetchEastmoneyConceptBoards(direction, limit);
    },
  ),
  // 写入工具（ direct + confirm 共 14 个，handler 留空，executeTool 中按 side_effect 分流 ）
  ...buildWriteToolDefinitions(),
];

const TOOL_INDEX = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

export function listTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'side_effect' | 'risk'>> {
  return TOOL_DEFINITIONS.map(({ name, description, parameters, side_effect, risk }) => ({
    name, description, parameters, side_effect, risk,
  }));
}

export function getOpenAIToolSchema(): unknown[] {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function parseToolArgs(name: string, rawArgs: string): Record<string, unknown> {
  if (!rawArgs || !rawArgs.trim()) return {};
  try { return JSON.parse(rawArgs); }
  catch { throw new Error(`工具 ${name} 参数 JSON 解析失败: ${rawArgs.slice(0, 200)}`); }
}

/**
 * 工具执行入口（统一三种 side_effect）：
 *   - read：直接调 handler
 *   - write_direct：频率限制 + 调 WRITE_HANDLERS.apply + audit
 *   - write_confirm：频率限制 + 落 ChatProposal（pending）+ emit 给前端
 *     真正写入由 routes /proposals/:id/apply 触发，复用 applyProposal()
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolExecCtx = {},
): Promise<unknown> {
  const tool = TOOL_INDEX.get(name);
  if (!tool) throw new Error(`未注册工具: ${name}`);
  const args = parseToolArgs(name, rawArgs);

  // ── 1. read ──
  if (tool.side_effect === 'read') {
    if (!tool.handler) throw new Error(`read 工具 ${name} 缺少 handler`);
    return tool.handler(args, ctx);
  }

  // ── 2. write_*：先做频率限制 ──
  const threadId = ctx.thread_id;
  if (threadId) {
    const rl = rateLimitCheck(threadId);
    if (!rl.ok) {
      throw new Error(`写入频率超限：本会话最近 1 分钟已写 ${rl.recent} 次（上限 ${RATE_LIMIT_PER_MIN}）。请等待 ${Math.ceil(rl.retry_after_ms / 1000)}s 后再试。`);
    }
  }

  const handler = getWriteHandler(name);
  if (!handler) throw new Error(`未实现的写入工具: ${name}`);
  const source = ctx.source ?? 'agent:chat';

  // ── 3. write_direct：直接落库 + audit ──
  if (tool.side_effect === 'write_direct') {
    const startedAt = Date.now();
    // 写前快照（用于审计 / 未来回滚）。snapshot 抛错不阻断 apply。
    let snapshot: unknown = null;
    try { snapshot = handler.snapshot(args); }
    catch (e) { console.warn(`[chat] snapshot before ${name} failed:`, (e as Error)?.message ?? e); }

    let result: unknown;
    try {
      result = await Promise.resolve(handler.apply(args, { source }));
    } catch (e) {
      if (threadId) rateLimitRefund(threadId);
      const entry: AuditEntry = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        thread_id: threadId,
        message_id: ctx.message_id,
        tool_name: name,
        side_effect: 'write_direct',
        args,
        status: 'error',
        error: (e as Error)?.message ?? String(e),
        snapshot_before: snapshot,
        source,
        duration_ms: Date.now() - startedAt,
      };
      try { appendAudit(entry); } catch (e2) { console.error('[chat] audit append failed:', e2); }
      throw e;
    }
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      thread_id: threadId,
      message_id: ctx.message_id,
      tool_name: name,
      side_effect: 'write_direct',
      args,
      status: 'ok',
      result,
      snapshot_before: snapshot,
      source,
      duration_ms: Date.now() - startedAt,
    };
    try { appendAudit(entry); } catch (e) { console.error('[chat] audit append failed:', e); }
    return { status: 'ok', tool: name, result };
  }

  // ── 4. write_confirm：生成 pending proposal ──
  if (!threadId) throw new Error('write_confirm 工具需要 thread_id 上下文');
  const preview = handler.preview(args);
  const snapshot = handler.snapshot(args);
  const proposal: ChatProposal = {
    id: `prop_${crypto.randomBytes(6).toString('hex')}`,
    thread_id: threadId,
    message_id: ctx.message_id,
    tool_call_id: ctx.tool_call_id,
    tool_name: name,
    args,
    summary: preview.summary,
    target: preview.target,
    risk: handler.risk,
    status: 'pending',
    snapshot_before: snapshot ?? null,
    created_at: new Date().toISOString(),
  };
  insertChatProposal(proposal);
  ctx.emit_proposal?.(proposal);
  return {
    status: 'pending_user_confirmation',
    proposal_id: proposal.id,
    tool: name,
    summary: proposal.summary,
    target: proposal.target,
    risk: proposal.risk,
    hint: '提案已发给用户，等待人工点【应用】或【取消】才会生效。请你简短解释你想做什么改动并停止后续动作；不要假设它已经成功。',
  };
}

/**
 * 真正执行 proposal（路由 apply 用）：复用 WRITE_HANDLERS.apply + audit。
 * source 一般是 'user'（用户在 UI 点应用），与 agent:chat 区分。
 */
export async function applyProposalById(
  proposalId: string,
  source = 'user',
): Promise<{ proposal: ChatProposal; result: unknown }> {
  const p = getChatProposal(proposalId);
  if (!p) throw new Error(`proposal 不存在: ${proposalId}`);
  if (p.status !== 'pending') throw new Error(`proposal 状态非 pending（当前: ${p.status}）`);
  const handler = getWriteHandler(p.tool_name);
  if (!handler) throw new Error(`未实现的写入工具: ${p.tool_name}`);
  const startedAt = Date.now();
  let result: unknown;
  let status: ChatProposalStatus = 'applied';
  let err: string | undefined;
  try {
    result = await Promise.resolve(handler.apply(p.args as Record<string, unknown>, { source }));
  } catch (e) {
    status = 'failed';
    err = (e as Error)?.message ?? String(e);
  }
  const updated = updateChatProposal(p.id, {
    status,
    result: status === 'applied' ? result : undefined,
    error: err,
    decided_at: new Date().toISOString(),
    decided_by: source,
  });
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    thread_id: p.thread_id,
    message_id: p.message_id,
    proposal_id: p.id,
    tool_name: p.tool_name,
    side_effect: 'write_confirm',
    args: p.args,
    status: status === 'applied' ? 'ok' : 'error',
    error: err,
    snapshot_before: p.snapshot_before,
    result: status === 'applied' ? result : undefined,
    source,
    duration_ms: Date.now() - startedAt,
  };
  try { appendAudit(entry); } catch (e) { console.error('[chat] audit append failed:', e); }
  if (status === 'failed') throw new Error(err);
  return { proposal: updated!, result };
}

export function cancelProposalById(
  proposalId: string,
  source = 'user',
): ChatProposal {
  const p = getChatProposal(proposalId);
  if (!p) throw new Error(`proposal 不存在: ${proposalId}`);
  if (p.status !== 'pending') throw new Error(`proposal 状态非 pending（当前: ${p.status}）`);
  const updated = updateChatProposal(p.id, {
    status: 'cancelled',
    decided_at: new Date().toISOString(),
    decided_by: source,
  });
  return updated!;
}
