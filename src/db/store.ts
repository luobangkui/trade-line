import fs from 'fs';
import path from 'path';
import type { BaselineInput, BaselineSnapshot, BaselineRelation, FutureWatchItem } from '../models/types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

interface DB {
  inputs: BaselineInput[];
  snapshots: BaselineSnapshot[];
  relations: BaselineRelation[];
  future_watchlist: FutureWatchItem[];
}

function load(): DB {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return { inputs: [], snapshots: [], relations: [], future_watchlist: [] };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) as DB;
  } catch {
    return { inputs: [], snapshots: [], relations: [], future_watchlist: [] };
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

export function updateFutureItemStatus(id: string, status: FutureWatchItem['review_status']): void {
  const db = load();
  const item = db.future_watchlist.find((f) => f.id === id);
  if (item) { item.review_status = status; save(db); }
}

export function resetInputsByTimeKey(timeKey: string): { inputs: number; futures: number } {
  const db = load();

  const beforeInputs = db.inputs.length;
  db.inputs = db.inputs.filter((i) => i.time_key !== timeKey);

  db.relations = db.relations.filter((r) => {
    const snap = db.snapshots.find((s) => s.id === r.snapshot_id);
    return snap?.time_key !== timeKey;
  });

  // 同时清理当天上传的未来观察项（linked_snapshot_time_key === timeKey）
  const beforeFutures = db.future_watchlist.length;
  db.future_watchlist = db.future_watchlist.filter(
    (f) => f.linked_snapshot_time_key !== timeKey,
  );

  save(db);
  return {
    inputs: beforeInputs - db.inputs.length,
    futures: beforeFutures - db.future_watchlist.length,
  };
}

export function resetDB(): void {
  save({ inputs: [], snapshots: [], relations: [], future_watchlist: [] });
}
