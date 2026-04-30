import fs from 'fs';
import path from 'path';
import type {
  BaselineInput, BaselineSnapshot, BaselineRelation, FutureWatchItem,
  TradeOperation, OperationEvaluation, DailyReviewSummary,
  PeriodReview, PeriodType, ReviewJournal, TradingPermissionCard,
  PositionPlan, PretradeReview,
  ChatSettings, ChatThread, ChatMessage, ChatProposal, ChatProposalStatus,
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
  permission_cards: TradingPermissionCard[];
  position_plans: PositionPlan[];
  pretrade_reviews: PretradeReview[];
  chat_settings?: ChatSettings;
  chat_threads: ChatThread[];
  chat_messages: ChatMessage[];
  chat_proposals: ChatProposal[];
}

const EMPTY_DB: DB = {
  inputs: [], snapshots: [], relations: [], future_watchlist: [],
  trade_operations: [], operation_evaluations: [], daily_reviews: [],
  weekly_reviews: [], monthly_reviews: [], review_journals: [],
  permission_cards: [], position_plans: [], pretrade_reviews: [],
  chat_threads: [], chat_messages: [], chat_proposals: [],
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

/**
 * 局部更新一笔交易（仅修正手敲错的字段）。
 * 不允许通过此接口改：id / time_key / symbol / name / created_at / created_by /
 * linked_baseline_*（自动关联）。如需改这些字段请先 delete 再 create。
 */
export function updateOperation(
  id: string,
  patch: Partial<TradeOperation>,
): TradeOperation | undefined {
  const db = load();
  const idx = db.trade_operations.findIndex((o) => o.id === id);
  if (idx < 0) return undefined;
  const old = db.trade_operations[idx];
  const merged: TradeOperation = {
    ...old,
    ...patch,
    id: old.id,
    time_key: old.time_key,
    symbol: old.symbol,
    name: old.name,
    created_at: old.created_at,
    created_by: old.created_by,
    linked_baseline_stage: old.linked_baseline_stage,
    linked_baseline_emotion: old.linked_baseline_emotion,
  };
  db.trade_operations[idx] = merged;
  save(db);
  return merged;
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

/** 物理删除指定周/月聚合复盘（不影响 daily / operations / journals） */
export function deletePeriodReview(type: PeriodType, periodKey: string): boolean {
  const db = load();
  const arr = periodBucket(db, type);
  const before = arr.length;
  if (type === 'week') {
    db.weekly_reviews = arr.filter((r) => r.period_key !== periodKey);
  } else {
    db.monthly_reviews = arr.filter((r) => r.period_key !== periodKey);
  }
  save(db);
  return periodBucket(db, type).length < before;
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

// ── Trading Permission Cards ──────────────────────────────
/**
 * 覆盖语义：每日一张卡（按 date 唯一）。
 * - locked=true 时：拒绝覆盖（必须先 unlock 或 force=true）。
 * - 未传 locked：保留旧值（首次写入默认 false）。
 */
export function upsertPermissionCard(
  card: TradingPermissionCard,
  opts: { force?: boolean } = {},
): { card: TradingPermissionCard; locked_skipped: boolean } {
  const db = load();
  const idx = db.permission_cards.findIndex((c) => c.date === card.date);
  if (idx >= 0) {
    const old = db.permission_cards[idx];
    if (old.locked && !opts.force) {
      return { card: old, locked_skipped: true };
    }
    const merged: TradingPermissionCard = {
      ...card,
      created_at: old.created_at,
      updated_at: new Date().toISOString(),
    };
    db.permission_cards[idx] = merged;
    save(db);
    return { card: merged, locked_skipped: false };
  }
  db.permission_cards.push(card);
  save(db);
  return { card, locked_skipped: false };
}

export function getPermissionCard(date: string): TradingPermissionCard | undefined {
  return load().permission_cards.find((c) => c.date === date);
}

export function getPermissionCardsByRange(start: string, end: string): TradingPermissionCard[] {
  return load().permission_cards
    .filter((c) => c.date >= start && c.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function getAllPermissionCards(): TradingPermissionCard[] {
  return [...load().permission_cards].sort((a, b) => a.date.localeCompare(b.date));
}

export function deletePermissionCard(date: string): boolean {
  const db = load();
  const before = db.permission_cards.length;
  db.permission_cards = db.permission_cards.filter((c) => c.date !== date);
  save(db);
  return db.permission_cards.length < before;
}

export function setPermissionCardLock(date: string, locked: boolean): TradingPermissionCard | undefined {
  const db = load();
  const card = db.permission_cards.find((c) => c.date === date);
  if (!card) return undefined;
  card.locked = locked;
  card.updated_at = new Date().toISOString();
  save(db);
  return card;
}

// ── Position Plans ────────────────────────────────────────
/**
 * 覆盖语义：同一 date + symbol 只有一张持仓计划卡。
 * locked=true 时拒绝覆盖，除非 force=true。
 */
export function upsertPositionPlan(
  plan: PositionPlan,
  opts: { force?: boolean } = {},
): { plan: PositionPlan; locked_skipped: boolean } {
  const db = load();
  const idx = db.position_plans.findIndex((p) => p.date === plan.date && p.symbol === plan.symbol);
  if (idx >= 0) {
    const old = db.position_plans[idx];
    if (old.locked && !opts.force) {
      return { plan: old, locked_skipped: true };
    }
    const merged: PositionPlan = {
      ...plan,
      id: old.id,
      created_at: old.created_at,
      updated_at: new Date().toISOString(),
    };
    db.position_plans[idx] = merged;
    save(db);
    return { plan: merged, locked_skipped: false };
  }
  db.position_plans.push(plan);
  save(db);
  return { plan, locked_skipped: false };
}

export function getPositionPlan(date: string, symbol: string): PositionPlan | undefined {
  return load().position_plans.find((p) => p.date === date && p.symbol === symbol);
}

export function getPositionPlansByDate(date: string): PositionPlan[] {
  return load().position_plans
    .filter((p) => p.date === date)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function getPositionPlansByRange(start: string, end: string): PositionPlan[] {
  return load().position_plans
    .filter((p) => p.date >= start && p.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

export function deletePositionPlan(date: string, symbol: string): boolean {
  const db = load();
  const before = db.position_plans.length;
  db.position_plans = db.position_plans.filter((p) => !(p.date === date && p.symbol === symbol));
  save(db);
  return db.position_plans.length < before;
}

export function setPositionPlanLock(date: string, symbol: string, locked: boolean): PositionPlan | undefined {
  const db = load();
  const plan = db.position_plans.find((p) => p.date === date && p.symbol === symbol);
  if (!plan) return undefined;
  plan.locked = locked;
  plan.updated_at = new Date().toISOString();
  save(db);
  return plan;
}

// ── Pretrade Reviews ──────────────────────────────────────
export function insertPretradeReview(review: PretradeReview): PretradeReview {
  const db = load();
  db.pretrade_reviews.push(review);
  save(db);
  return review;
}

export function getPretradeReview(id: string): PretradeReview | undefined {
  return load().pretrade_reviews.find((r) => r.id === id);
}

export function getPretradeReviewsByDate(date: string): PretradeReview[] {
  return load().pretrade_reviews
    .filter((r) => r.date === date)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getPretradeReviewsByRange(start: string, end: string): PretradeReview[] {
  return load().pretrade_reviews
    .filter((r) => r.date >= start && r.date <= end)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function deletePretradeReview(id: string): boolean {
  const db = load();
  const before = db.pretrade_reviews.length;
  db.pretrade_reviews = db.pretrade_reviews.filter((r) => r.id !== id);
  save(db);
  return db.pretrade_reviews.length < before;
}

// ── Chat Settings / Threads / Messages ────────────────────
export function getChatSettings(): ChatSettings | undefined {
  return load().chat_settings;
}

export function upsertChatSettings(settings: ChatSettings): ChatSettings {
  const db = load();
  db.chat_settings = settings;
  save(db);
  return settings;
}

export function deleteChatSettings(): boolean {
  const db = load();
  if (!db.chat_settings) return false;
  db.chat_settings = undefined;
  save(db);
  return true;
}

export function listChatThreads(): ChatThread[] {
  return [...load().chat_threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getChatThread(id: string): ChatThread | undefined {
  return load().chat_threads.find((t) => t.id === id);
}

export function insertChatThread(thread: ChatThread): ChatThread {
  const db = load();
  db.chat_threads.push(thread);
  save(db);
  return thread;
}

export function updateChatThread(id: string, patch: Partial<ChatThread>): ChatThread | undefined {
  const db = load();
  const idx = db.chat_threads.findIndex((t) => t.id === id);
  if (idx < 0) return undefined;
  const merged: ChatThread = {
    ...db.chat_threads[idx],
    ...patch,
    id: db.chat_threads[idx].id,
    created_at: db.chat_threads[idx].created_at,
    updated_at: new Date().toISOString(),
  };
  db.chat_threads[idx] = merged;
  save(db);
  return merged;
}

export function deleteChatThread(id: string): boolean {
  const db = load();
  const before = db.chat_threads.length;
  db.chat_threads = db.chat_threads.filter((t) => t.id !== id);
  db.chat_messages = db.chat_messages.filter((m) => m.thread_id !== id);
  save(db);
  return db.chat_threads.length < before;
}

export function listChatMessages(threadId: string): ChatMessage[] {
  return load().chat_messages
    .filter((m) => m.thread_id === threadId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function insertChatMessage(message: ChatMessage): ChatMessage {
  const db = load();
  db.chat_messages.push(message);
  const tIdx = db.chat_threads.findIndex((t) => t.id === message.thread_id);
  if (tIdx >= 0) {
    db.chat_threads[tIdx].message_count = db.chat_messages.filter((m) => m.thread_id === message.thread_id).length;
    db.chat_threads[tIdx].updated_at = new Date().toISOString();
  }
  save(db);
  return message;
}

// ── Chat Proposals (写入提案) ─────────────────────────────
export function insertChatProposal(p: ChatProposal): ChatProposal {
  const db = load();
  db.chat_proposals.push(p);
  save(db);
  return p;
}

export function getChatProposal(id: string): ChatProposal | undefined {
  return load().chat_proposals.find((p) => p.id === id);
}

export function listChatProposalsByThread(threadId: string): ChatProposal[] {
  return load().chat_proposals
    .filter((p) => p.thread_id === threadId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function listPendingProposals(): ChatProposal[] {
  return load().chat_proposals
    .filter((p) => p.status === 'pending')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function updateChatProposal(
  id: string,
  patch: Partial<Omit<ChatProposal, 'id' | 'thread_id' | 'tool_name' | 'created_at'>>,
): ChatProposal | undefined {
  const db = load();
  const idx = db.chat_proposals.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  db.chat_proposals[idx] = { ...db.chat_proposals[idx], ...patch };
  save(db);
  return db.chat_proposals[idx];
}

export function expireOldPendingProposals(maxAgeMs: number): number {
  const db = load();
  const now = Date.now();
  let expired = 0;
  for (const p of db.chat_proposals) {
    if (p.status !== 'pending') continue;
    const t = Date.parse(p.created_at);
    if (Number.isFinite(t) && now - t > maxAgeMs) {
      p.status = 'expired';
      p.decided_at = new Date().toISOString();
      p.decided_by = 'system:expire';
      expired += 1;
    }
  }
  if (expired) save(db);
  return expired;
}

// 测试/便捷用：重置所有提案状态（不要在生产路由暴露）
export function _statusForTest(_: ChatProposalStatus): never { throw new Error('not used'); }
