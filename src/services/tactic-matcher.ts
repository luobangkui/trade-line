import { listTactics } from '../db/store';
import type {
  PretradeVerdict,
  TacticCondition,
  TacticDefinition,
  TacticEvaluation,
  TacticMatchIntent,
  TacticMatchResult,
} from '../models/types';

function includesIfSpecified<T extends string>(values: T[], needle: T | undefined): boolean {
  return !needle || values.length === 0 || values.includes(needle);
}

function textIncludes(haystack: string, needle: string): boolean {
  const compact = needle.trim().toLowerCase();
  if (!compact) return false;
  if (haystack.includes(compact)) return true;
  const tokens = compact
    .split(/[\s,，、；;。:：/|()（）]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  return tokens.length > 0 && tokens.some((x) => haystack.includes(x));
}

function intentText(intent: TacticMatchIntent): string {
  return [
    intent.symbol, intent.name, intent.mode, intent.rationale, ...(intent.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function requiredConditions(tactic: TacticDefinition): TacticCondition[] {
  return [
    ...tactic.setup_conditions,
    ...tactic.entry_triggers,
    ...tactic.confirm_signals,
    ...tactic.invalidation_conditions,
  ].filter((c) => c.required !== false);
}

function allCheckConditions(tactic: TacticDefinition): TacticCondition[] {
  return [
    ...tactic.setup_conditions,
    ...tactic.entry_triggers,
    ...tactic.confirm_signals,
    ...tactic.invalidation_conditions,
  ];
}

function worstVerdict(a: PretradeVerdict | undefined, b: PretradeVerdict | undefined): PretradeVerdict | undefined {
  const rank: Record<PretradeVerdict, number> = { REJECT: 4, WAIT: 3, ALLOW_SMALL: 2, ALLOW: 1 };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

function evaluateTactic(tactic: TacticDefinition, intent: TacticMatchIntent): TacticEvaluation | null {
  if (tactic.status === 'archived') return null;
  if (!includesIfSpecified(tactic.applicable_actions, intent.action)) return null;
  if (!includesIfSpecified(tactic.risk_actions, intent.risk_action)) return null;
  if (!includesIfSpecified(tactic.market_stages, intent.market_stage)) return null;
  if (!includesIfSpecified(tactic.permission_statuses, intent.permission_status)) return null;
  if (intent.mode && tactic.allowed_modes.length && !tactic.allowed_modes.includes(intent.mode)) return null;

  const haystack = intentText(intent);
  const matched: string[] = [];
  const missing: string[] = [];
  const forbidden: string[] = [];
  let score = 20;
  let suggested: PretradeVerdict | undefined;

  if (intent.action && tactic.applicable_actions.includes(intent.action)) score += 15;
  if (intent.risk_action && tactic.risk_actions.includes(intent.risk_action)) score += 15;
  if (intent.mode && tactic.allowed_modes.includes(intent.mode)) score += 15;
  if (intent.permission_status && tactic.permission_statuses.includes(intent.permission_status)) score += 5;
  if (intent.market_stage && tactic.market_stages.includes(intent.market_stage)) score += 5;

  for (const cond of allCheckConditions(tactic)) {
    if (textIncludes(haystack, cond.text)) {
      matched.push(cond.text);
      score += cond.required === false ? 3 : 8;
    } else if (cond.required !== false) {
      missing.push(cond.text);
      score -= 4;
      suggested = worstVerdict(suggested, cond.missing_verdict ?? 'WAIT');
    }
  }

  for (const cond of tactic.forbidden_conditions) {
    if (textIncludes(haystack, cond.text)) {
      forbidden.push(cond.text);
      score -= 30;
      suggested = 'REJECT';
    }
  }

  const requiredCount = requiredConditions(tactic).length;
  if (requiredCount === 0 && tactic.summary && textIncludes(haystack, tactic.summary)) score += 5;

  const status = forbidden.length
    ? 'blocked'
    : missing.length
      ? 'partial'
      : 'matched';

  const reasons: string[] = [];
  if (status === 'matched') reasons.push('战法关键清单未发现缺口，可作为支持证据。');
  if (missing.length) reasons.push(`缺少 ${missing.length} 项关键确认。`);
  if (forbidden.length) reasons.push(`命中 ${forbidden.length} 项战法禁忌。`);

  return {
    tactic_id: tactic.id,
    tactic_name: tactic.name,
    status,
    score: Math.max(0, Math.min(100, score)),
    matched_conditions: matched,
    missing_conditions: missing,
    forbidden_hits: forbidden,
    suggested_verdict: suggested,
    reasons,
  };
}

export function matchPretradeTactics(intent: TacticMatchIntent): TacticMatchResult {
  const evaluations = listTactics()
    .map((t) => evaluateTactic(t, intent))
    .filter((x): x is TacticEvaluation => x != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const best = evaluations[0];
  const waitConditions = new Set<string>();
  const forbiddenActions = new Set<string>();
  const reasons: string[] = [];
  let suggested: PretradeVerdict | undefined;

  for (const ev of evaluations) {
    for (const item of ev.missing_conditions) waitConditions.add(`战法「${ev.tactic_name}」待确认：${item}`);
    for (const item of ev.forbidden_hits) forbiddenActions.add(`战法「${ev.tactic_name}」禁止：${item}`);
    suggested = worstVerdict(suggested, ev.suggested_verdict);
  }

  if (!evaluations.length) {
    reasons.push('未找到与当前意图匹配的战法。');
  } else if (best) {
    reasons.push(`最佳匹配战法：${best.tactic_name}（${best.status}，score=${best.score}）。`);
  }

  return {
    intent,
    evaluations,
    best_match: best,
    suggested_verdict: suggested,
    wait_conditions: [...waitConditions],
    forbidden_actions: [...forbiddenActions],
    reasons,
  };
}
