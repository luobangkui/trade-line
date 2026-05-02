import { v4 as uuidv4 } from 'uuid';
import type {
  MarketStage,
  PermissionStatus,
  PretradeAction,
  RiskAction,
  TacticCategory,
  TacticCondition,
  TacticConditionKind,
  TacticDefinition,
  TacticDefinitionCreateRequest,
  TacticImportRequest,
  TacticImportResult,
  TacticStatus,
} from '../models/types';

const ACTIONS: PretradeAction[] = ['buy', 'add', 'rebuy', 'switch'];
const RISK_ACTIONS: RiskAction[] = [
  'new_buy', 'add_winner', 'add_loser', 'rebuy_same_symbol', 'switch_position', 'reduce', 'sell', 'hold',
];
const STAGES: MarketStage[] = ['CHAOS', 'REPAIR_EARLY', 'REPAIR_CONFIRM', 'MAIN_UP', 'HIGH_RISK', 'DISTRIBUTION', 'UNKNOWN'];
const PERMISSIONS: PermissionStatus[] = ['protect', 'normal', 'attack'];
const STATUSES: TacticStatus[] = ['draft', 'active', 'archived'];
const CATEGORIES: TacticCategory[] = ['entry', 'add', 'rebuy', 'switch', 'exit', 'risk', 'general'];

function compactStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[,\n，、]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function enumArray<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  const set = new Set(allowed);
  return compactStringArray(values).filter((x): x is T => set.has(x as T));
}

function normalizeStatus(v: unknown): TacticStatus {
  return STATUSES.includes(v as TacticStatus) ? v as TacticStatus : 'active';
}

function normalizeCategory(v: unknown): TacticCategory {
  return CATEGORIES.includes(v as TacticCategory) ? v as TacticCategory : 'general';
}

function conditionText(item: string | Partial<TacticCondition>): string {
  if (typeof item === 'string') return item.trim();
  return String(item.text ?? '').trim();
}

function normalizeConditions(
  items: Array<string | Partial<TacticCondition>> | undefined,
  kind: TacticConditionKind,
): TacticCondition[] {
  const out: TacticCondition[] = [];
  for (const [idx, item] of (items ?? []).entries()) {
    const text = conditionText(item);
    if (!text) continue;
    const partial = typeof item === 'string' ? {} : item;
    out.push({
      id: partial.id ?? `${kind}_${idx + 1}`,
      kind,
      text,
      required: partial.required ?? kind !== 'forbidden',
      evidence_hint: partial.evidence_hint,
      missing_verdict: partial.missing_verdict,
    });
  }
  return out;
}

export function normalizeTacticDraft(
  draft: TacticDefinitionCreateRequest,
  defaults: { source?: string; created_by?: string } = {},
): TacticDefinition {
  const now = new Date().toISOString();
  const sourceText = draft.source_text ? String(draft.source_text).slice(0, 4000) : undefined;
  return {
    id: draft.id?.trim() || `tactic_${uuidv4()}`,
    name: draft.name.trim(),
    aliases: compactStringArray(draft.aliases),
    status: normalizeStatus(draft.status),
    version: Number.isFinite(Number(draft.version)) ? Number(draft.version) : 1,
    category: normalizeCategory(draft.category),
    summary: draft.summary?.trim() ?? '',
    tags: compactStringArray(draft.tags),
    applicable_actions: enumArray(draft.applicable_actions, ACTIONS),
    risk_actions: enumArray(draft.risk_actions, RISK_ACTIONS),
    allowed_modes: compactStringArray(draft.allowed_modes),
    market_stages: enumArray(draft.market_stages, STAGES),
    permission_statuses: enumArray(draft.permission_statuses, PERMISSIONS),
    setup_conditions: normalizeConditions(draft.setup_conditions, 'setup'),
    entry_triggers: normalizeConditions(draft.entry_triggers, 'trigger'),
    confirm_signals: normalizeConditions(draft.confirm_signals, 'confirm'),
    invalidation_conditions: normalizeConditions(draft.invalidation_conditions, 'invalidation'),
    forbidden_conditions: normalizeConditions(draft.forbidden_conditions, 'forbidden'),
    position_sizing: draft.position_sizing?.trim(),
    illustration_images: draft.illustration_images ?? [],
    notes: draft.notes?.trim(),
    source: draft.source?.trim() || defaults.source || 'manual',
    source_text: sourceText,
    imported_at: now,
    created_by: draft.created_by?.trim() || defaults.created_by || 'user',
    created_at: now,
    updated_at: now,
  };
}

function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) return { fm: {}, body: content };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: content };
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\s*\n/, '');
  const fm: Record<string, unknown> = {};
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    val = val.replace(/^["']|["']$/g, '');
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      fm[key] = val;
    }
  }
  return { fm, body };
}

function firstHeading(body: string): string | undefined {
  return body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
}

function firstParagraph(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*#/.test(line)) {
      if (out.length) break;
      continue;
    }
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (out.length) break;
      continue;
    }
    out.push(line.trim());
  }
  return out.join(' ').slice(0, 300);
}

function sectionBullets(body: string, aliases: string[]): string[] {
  const aliasSet = aliases.map((x) => x.toLowerCase());
  const lines = body.split('\n');
  const out: string[] = [];
  let active = false;
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      active = aliasSet.some((alias) => title.includes(alias));
      continue;
    }
    if (!active) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet?.[1]?.trim()) out.push(bullet[1].trim());
  }
  return out;
}

function parseMarkdownTactic(content: string, req: TacticImportRequest): TacticDefinitionCreateRequest {
  const { fm, body } = parseFrontmatter(content.trim());
  const name = String(fm.name ?? firstHeading(body) ?? '').trim();
  if (!name) throw new Error('Markdown 战法缺少 name 或一级标题');
  return {
    name,
    aliases: compactStringArray(fm.aliases),
    status: normalizeStatus(fm.status),
    version: Number(fm.version ?? 1),
    category: normalizeCategory(fm.category),
    summary: String(fm.summary ?? firstParagraph(body) ?? ''),
    tags: compactStringArray(fm.tags),
    applicable_actions: enumArray(fm.applicable_actions, ACTIONS),
    risk_actions: enumArray(fm.risk_actions, RISK_ACTIONS),
    allowed_modes: compactStringArray(fm.allowed_modes),
    market_stages: enumArray(fm.market_stages, STAGES),
    permission_statuses: enumArray(fm.permission_statuses, PERMISSIONS),
    setup_conditions: sectionBullets(body, ['setup', '前置', '适用', '环境', '条件']),
    entry_triggers: sectionBullets(body, ['entry', 'trigger', '买点', '入场', '触发']),
    confirm_signals: sectionBullets(body, ['confirm', '确认', '信号']),
    invalidation_conditions: sectionBullets(body, ['invalidation', 'exit', '失效', '退出', '止损']),
    forbidden_conditions: sectionBullets(body, ['forbidden', '禁止', '禁忌', '不做']),
    position_sizing: sectionBullets(body, ['sizing', '仓位']).join('；') || undefined,
    notes: sectionBullets(body, ['notes', '备注']).join('；') || undefined,
    source: req.source,
    source_text: content.slice(0, 4000),
    created_by: req.created_by,
  };
}

function parseJsonDrafts(content: string): TacticDefinitionCreateRequest[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed as TacticDefinitionCreateRequest[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return (parsed as { items: TacticDefinitionCreateRequest[] }).items;
  }
  return [parsed as TacticDefinitionCreateRequest];
}

export function parseTacticImportRequest(req: TacticImportRequest): TacticImportResult {
  const warnings: string[] = [];
  const skipped: TacticImportResult['skipped'] = [];
  let drafts: TacticDefinitionCreateRequest[] = [];

  if (req.items?.length) {
    drafts = req.items;
  } else if (req.content?.trim()) {
    const content = req.content.trim();
    const format = req.format === 'auto' || !req.format
      ? (/^[\[{]/.test(content) ? 'json' : 'markdown')
      : req.format;
    if (format === 'json') drafts = parseJsonDrafts(content);
    else drafts = [parseMarkdownTactic(content, req)];
  } else {
    throw new Error('导入战法需要提供 content 或 items');
  }

  const imported: TacticDefinition[] = [];
  for (const draft of drafts) {
    if (!draft?.name?.trim()) {
      skipped.push({ name: '(unknown)', reason: '缺少 name' });
      continue;
    }
    const tactic = normalizeTacticDraft(draft, { source: req.source, created_by: req.created_by });
    if (
      !tactic.setup_conditions.length
      && !tactic.entry_triggers.length
      && !tactic.confirm_signals.length
      && !tactic.forbidden_conditions.length
    ) {
      warnings.push(`战法「${tactic.name}」缺少可检查条件，已作为草稿式条目导入。`);
    }
    imported.push(tactic);
  }

  return { imported, skipped, warnings };
}
