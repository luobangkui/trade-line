import fs from 'fs';
import path from 'path';
import type {
  BaselineInput, BaselineSnapshot, BaselineRelation, FutureWatchItem,
  TradeOperation, OperationEvaluation, DailyReviewSummary,
  PeriodReview, PeriodType, ReviewJournal,
} from '../models/types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

interface DB {
  inputs: BaselineInput[];
  snapshots: BaselineSnapshot[];
  relations: BaselineRelation[];
  future_watchlist: FutureWatchItem[];
  trade_operations: TradeOperation[];
  operation_evaluations: OperationEvaluation[];
  daily_reviews: DailyReviewSummary[];
  weekly_reviews: PeriodReview[];
  monthly_reviews: PeriodReview[];
  review_journals: ReviewJournal[];
}

const EMPTY_DB: DB = {
  inputs: [], snapshots: [], relations: [], future_watchlist: [],
  trade_operations: [], operation_evaluations: [], daily_reviews: [],
  weekly_reviews: [], monthly_reviews: [], review_journals: [],
};

function load(): DB {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return { ...EMPTY_DB };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) as Partial<DB>;
    return { ...EMPTY_DB, ...parsed };
  } catch {
    return { ...EMPTY_DB };
  }
}

function save(db: DB): void {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

// ── Inputs ────────────────────────────────────────────────
export function insertInput(input: BaselineInput): BaselineInput {
  const db = load();
  db.inputs.push(input);
  save(db);
  return input;
}

export function getInputsByTimeKey(timeKey: string): BaselineInput[] {
  return load().inputs.filter((i) => i.time_key === timeKey && i.status === 'active');
}

export function getAllInputs(): BaselineInput[] {
  return load().inputs;
}

export function updateInputStatus(id: string, status: BaselineInput['status']): void {
  const db = load();
  const item = db.inputs.find((i) => i.id === id);
  if (item) { item.status = status; save(db); }
}

// ── Snapshots ─────────────────────────────────────────────
export function upsertSnapshot(snapshot: BaselineSnapshot): BaselineSnapshot {
  const db = load();
  const idx = db.snapshots.findIndex((s) => s.time_key === snapshot.time_key);
  if (idx >= 0) db.snapshots[idx] = snapshot;
  else db.snapshots.push(snapshot);
  save(db);
  return snapshot;
}

export function getSnapshotByDate(timeKey: string): BaselineSnapshot | undefined {
  return load().snapshots.find((s) => s.time_key === timeKey);
}

export function getSnapshotsInRange(start: string, end: string): BaselineSnapshot[] {
  return load().snapshots
    .filter((s) => s.time_key >= start && s.time_key <= end)
    .sort((a, b) => a.time_key.localeCompare(b.time_key));
}

export function getAllSnapshots(): BaselineSnapshot[] {
  return load().snapshots.sort((a, b) => a.time_key.localeCompare(b.time_key));
}

// ── Relations ─────────────────────────────────────────────
export function insertRelation(rel: BaselineRelation): void {
  const db = load();
  db.relations.push(rel);
  save(db);
}

export function getRelationsBySnapshot(snapshotId: string): BaselineRelation[] {
  return load().relations.filter((r) => r.snapshot_id === snapshotId);
}

// ── Future Watchlist ──────────────────────────────────────
export function insertFutureItem(item: FutureWatchItem): FutureWatchItem {
  const db = load();
  db.future_watchlist.push(item);
  save(db);
  return item;
}

export function getFutureItemsByRange(start: string, end: string): FutureWatchItem[] {
  return load().future_watchlist
    .filter((f) => f.expected_time >= start && f.expected_time <= end)
    .sort((a, b) => a.expected_time.localeCompare(b.expected_time));
}

export function getAllFutureItems(): FutureWatchItem[] {
  return load().future_watchlist;
}

// 查询某日期处于"进行中"的未来事件（start <= date <= end）
export function getActiveFutureItemsByDate(date: string): FutureWatchItem[] {
  return load().future_watchlist.filter((f) => {
    if (f.review_status === 'expired') return false;
    const start = f.expected_time.slice(0, 10);
    const end = f.expected_end_time ? f.expected_end_time.slice(0, 10) : start;
    return start <= date && date <= end;
  });
}

export function updateFutureItemStatus(id: string, status: FutureWatchItem['review_status']): void {
  const db = load();
  const item = db.future_watchlist.find((f) => f.id === id);
  if (item) { item.review_status = status; save(db); }
}

export function resetInputsByTimeKey(timeKey: string): number {
  const db = load();

  const before = db.inputs.length;
  db.inputs = db.inputs.filter((i) => i.time_key !== timeKey);

  db.relations = db.relations.filter((r) => {
    const snap = db.snapshots.find((s) => s.id === r.snapshot_id);
    return snap?.time_key !== timeKey;
  });

  // future_watchlist 是全局数据，按 expected_time 跨多天展示，不随 reset 删除

  save(db);
  return before - db.inputs.length;
}

export function resetDB(): void {
  save({ ...EMPTY_DB });
}

// ── Trade Operations ──────────────────────────────────────
export function insertOperation(op: TradeOperation): TradeOperation {
  const db = load();
  db.trade_operations.push(op);
  save(db);
  return op;
}

export function getOperationsByDate(timeKey: string): TradeOperation[] {
  return load().trade_operations
    .filter((o) => o.time_key === timeKey)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getOperationById(id: string): TradeOperation | undefined {
  return load().trade_operations.find((o) => o.id === id);
}

export function getOperationsByRange(start: string, end: string): TradeOperation[] {
  return load().trade_operations
    .filter((o) => o.time_key >= start && o.time_key <= end)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function deleteOperation(id: string): boolean {
  const db = load();
  const before = db.trade_operations.length;
  db.trade_operations = db.trade_operations.filter((o) => o.id !== id);
  db.operation_evaluations = db.operation_evaluations.filter((e) => e.operation_id !== id);
  save(db);
  return db.trade_operations.length < before;
}

// ── Operation Evaluations ─────────────────────────────────
export function insertEvaluation(ev: OperationEvaluation): OperationEvaluation {
  const db = load();
  // 同一 evaluator 对同一 operation 只保留最新一条
  db.operation_evaluations = db.operation_evaluations.filter(
    (e) => !(e.operation_id === ev.operation_id && e.evaluator === ev.evaluator)
  );
  db.operation_evaluations.push(ev);
  save(db);
  return ev;
}

export function getEvaluationsByOperation(opId: string): OperationEvaluation[] {
  return load().operation_evaluations
    .filter((e) => e.operation_id === opId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getEvaluationsByDate(timeKey: string): OperationEvaluation[] {
  return load().operation_evaluations.filter((e) => e.time_key === timeKey);
}

// ── Daily Review Summary ──────────────────────────────────
export function upsertDailyReview(review: DailyReviewSummary): DailyReviewSummary {
  const db = load();
  const idx = db.daily_reviews.findIndex((r) => r.time_key === review.time_key);
  if (idx >= 0) db.daily_reviews[idx] = review;
  else db.daily_reviews.push(review);
  save(db);
  return review;
}

export function getDailyReview(timeKey: string): DailyReviewSummary | undefined {
  return load().daily_reviews.find((r) => r.time_key === timeKey);
}

export function getDailyReviewsByRange(start: string, end: string): DailyReviewSummary[] {
  return load().daily_reviews
    .filter((r) => r.time_key >= start && r.time_key <= end)
    .sort((a, b) => a.time_key.localeCompare(b.time_key));
}

export function getAllDailyReviews(): DailyReviewSummary[] {
  return load().daily_reviews.sort((a, b) => a.time_key.localeCompare(b.time_key));
}

// ── Weekly / Monthly Period Reviews ──────────────────────
function periodBucket(db: DB, type: PeriodType): PeriodReview[] {
  return type === 'week' ? db.weekly_reviews : db.monthly_reviews;
}

export function upsertPeriodReview(review: PeriodReview): PeriodReview {
  const db = load();
  const arr = periodBucket(db, review.period_type);
  const idx = arr.findIndex((r) => r.period_key === review.period_key);
  if (idx >= 0) arr[idx] = review;
  else arr.push(review);
  save(db);
  return review;
}

export function getPeriodReview(type: PeriodType, periodKey: string): PeriodReview | undefined {
  const db = load();
  return periodBucket(db, type).find((r) => r.period_key === periodKey);
}

export function getPeriodReviewsByRange(
  type: PeriodType,
  startKey: string,
  endKey: string,
): PeriodReview[] {
  const db = load();
  return periodBucket(db, type)
    .filter((r) => r.period_key >= startKey && r.period_key <= endKey)
    .sort((a, b) => a.period_key.localeCompare(b.period_key));
}

export function getAllPeriodReviews(type: PeriodType): PeriodReview[] {
  const db = load();
  return [...periodBucket(db, type)].sort((a, b) => a.period_key.localeCompare(b.period_key));
}

/** 取该 period 之前的 N 个历史复盘 (不含本期)，用于趋势/洞察对比 */
export function getRecentPeriodReviewsBefore(
  type: PeriodType,
  periodKey: string,
  n: number,
): PeriodReview[] {
  const all = getAllPeriodReviews(type).filter((r) => r.period_key < periodKey);
  return all.slice(-n);
}

// ── Review Journals (完全独立的复盘日志) ──────────────
export function insertJournal(j: ReviewJournal): ReviewJournal {
  const db = load();
  db.review_journals.push(j);
  save(db);
  return j;
}

export function getJournalById(id: string): ReviewJournal | undefined {
  return load().review_journals.find((j) => j.id === id);
}

export function getJournalsByPeriod(scope: ReviewJournal['scope'], periodKey: string): ReviewJournal[] {
  return load().review_journals
    .filter((j) => j.scope === scope && j.period_key === periodKey)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function listJournals(filter: {
  scope?: ReviewJournal['scope'];
  tag?: string;
  status?: ReviewJournal['status'];
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): { items: ReviewJournal[]; total: number } {
  let arr = load().review_journals;
  if (filter.scope)  arr = arr.filter((j) => j.scope === filter.scope);
  if (filter.status) arr = arr.filter((j) => j.status === filter.status);
  if (filter.source) arr = arr.filter((j) => j.source === filter.source);
  if (filter.tag)    arr = arr.filter((j) => j.tags.includes(filter.tag!));
  if (filter.search) {
    const q = filter.search.toLowerCase();
    arr = arr.filter((j) =>
      j.title.toLowerCase().includes(q)
      || (j.summary ?? '').toLowerCase().includes(q)
      || (j.body ?? '').toLowerCase().includes(q),
    );
  }
  const sorted = arr.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const total = sorted.length;
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  return { items: sorted.slice(offset, offset + limit), total };
}

export function updateJournal(id: string, patch: Partial<ReviewJournal>): ReviewJournal | undefined {
  const db = load();
  const idx = db.review_journals.findIndex((j) => j.id === id);
  if (idx < 0) return undefined;
  const merged: ReviewJournal = {
    ...db.review_journals[idx],
    ...patch,
    id: db.review_journals[idx].id,
    created_at: db.review_journals[idx].created_at,
    updated_at: new Date().toISOString(),
  };
  db.review_journals[idx] = merged;
  save(db);
  return merged;
}

export function deleteJournal(id: string): boolean {
  const db = load();
  const before = db.review_journals.length;
  db.review_journals = db.review_journals.filter((j) => j.id !== id);
  save(db);
  return db.review_journals.length < before;
}
