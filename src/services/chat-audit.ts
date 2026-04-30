import fs from 'fs';
import path from 'path';

export const AUDIT_DIR = path.join(process.cwd(), 'data', 'audit');

export interface AuditEntry {
  id: string;
  ts: string;
  thread_id?: string;
  message_id?: string;
  proposal_id?: string;
  tool_name: string;
  side_effect: 'write_direct' | 'write_confirm';
  args: unknown;
  status: 'ok' | 'error';
  error?: string;
  /** 写前快照（覆盖类必有；create 类为 null） */
  snapshot_before?: unknown;
  /** 写入返回结果（成功才填） */
  result?: unknown;
  /** 谁触发：'agent:chat' 或 'user' (apply proposal 时) */
  source: string;
  duration_ms: number;
}

export function ensureAuditDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function dayKey(ts: string): string {
  return ts.slice(0, 10);
}

export function appendAudit(entry: AuditEntry): void {
  ensureAuditDir();
  const file = path.join(AUDIT_DIR, `${dayKey(entry.ts)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
}

/** 读取最近 N 条 audit 记录（合并最近 7 天的 jsonl）。limit 默认 50，最大 500。 */
export function listRecentAudits(limit = 50): AuditEntry[] {
  ensureAuditDir();
  const cap = Math.max(1, Math.min(500, limit));
  const files = fs.readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, 7);
  const all: AuditEntry[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try { all.push(JSON.parse(ln) as AuditEntry); } catch { /* ignore broken line */ }
    }
  }
  return all
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, cap);
}

/* ── 频率限制（按 thread）──────────────────────────────
 * 单 thread 每分钟最多 N 次写入（含 propose）。
 * 内存桶，进程重启即清零，足够防止 LLM 失控。
 */
const RATE_BUCKETS = new Map<string, number[]>();
export const RATE_LIMIT_PER_MIN = 8;
const RATE_WINDOW_MS = 60_000;

export function rateLimitCheck(threadId: string): { ok: true } | { ok: false; retry_after_ms: number; recent: number } {
  const now = Date.now();
  const arr = RATE_BUCKETS.get(threadId) ?? [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_PER_MIN) {
    const oldest = fresh[0];
    return { ok: false, retry_after_ms: RATE_WINDOW_MS - (now - oldest), recent: fresh.length };
  }
  fresh.push(now);
  RATE_BUCKETS.set(threadId, fresh);
  return { ok: true };
}

export function rateLimitRefund(threadId: string): void {
  const arr = RATE_BUCKETS.get(threadId);
  if (!arr || !arr.length) return;
  arr.pop();
  RATE_BUCKETS.set(threadId, arr);
}
