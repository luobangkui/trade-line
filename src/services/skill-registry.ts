/**
 * Skill Router — 轻量 markdown skill 加载与匹配
 *
 * 加载顺序（同名时后者覆盖前者，达到「用户级覆盖仓库级」的效果）：
 *   1. 仓库根 SKILL.md       → source=repo:entry
 *   2. 仓库 skill/<name>.md   → source=repo:doc
 *   3. ~/.trade-line/skills/<name>.md          → source=user:doc
 *   4. ~/.trade-line/skills/<dir>/SKILL.md     → source=user:dir
 *
 * 第一版只是文档型能力，不执行任何脚本；
 * 解析支持 YAML frontmatter（name/description/triggers/priority/tags），
 * 没有 frontmatter 也能工作，会按文件名/H1 推断 name + description。
 *
 * 路径安全：每条 skill 都通过 fs.realpathSync 校验仍位于白名单根下，
 * 任何越界路径直接拒绝，避免 ../../../etc/passwd 这类问题。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SkillDoc, SkillFrontmatter, SkillSource, SkillSelectionItem } from '../models/types';

const REPO_ROOT = process.cwd();
const REPO_ENTRY = path.resolve(REPO_ROOT, 'SKILL.md');
const REPO_SKILL_DIR = path.resolve(REPO_ROOT, 'skill');
const USER_SKILL_DIR = path.resolve(
  process.env.TRADE_LINE_SKILL_DIR
    ? process.env.TRADE_LINE_SKILL_DIR
    : path.join(os.homedir(), '.trade-line', 'skills'),
);

/** 内存缓存：key=path, value=已解析 SkillDoc。失效条件：mtime/size 变化。 */
const CACHE = new Map<string, SkillDoc>();
let LAST_INDEX_MS = 0;
let LAST_INDEX: SkillDoc[] = [];
const INDEX_TTL_MS = 5_000; // 简单 TTL，避免每次请求都扫盘

const REGISTRY_ROOTS: ReadonlyArray<string> = [REPO_ROOT, REPO_SKILL_DIR, USER_SKILL_DIR];

export interface SkillRegistryDebug {
  repo_root: string;
  repo_entry: string;
  repo_skill_dir: string;
  user_skill_dir: string;
  user_skill_dir_exists: boolean;
  total: number;
  by_source: Record<SkillSource, number>;
}

/* ──────────────────────────────────────────
 * frontmatter 解析（支持 YAML 子集，不引入新依赖）
 * ────────────────────────────────────────── */

function safeRead(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }
}

function safeStat(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath); }
  catch { return null; }
}

function parseScalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // 去掉两端引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

interface ParsedMd {
  frontmatter: SkillFrontmatter;
  has_frontmatter: boolean;
  body: string;
}

function parseMarkdown(content: string): ParsedMd {
  // 必须以 --- 开头才视为 frontmatter
  if (!content.startsWith('---')) {
    return { frontmatter: {}, has_frontmatter: false, body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: {}, has_frontmatter: false, body: content };
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\s*\n/, '');

  const fm: SkillFrontmatter = {};
  const lines = yaml.split('\n');
  let listKey: keyof SkillFrontmatter | null = null;
  let listAcc: string[] = [];
  const flushList = () => {
    if (listKey && listAcc.length) {
      (fm as Record<string, unknown>)[listKey] = listAcc.slice();
    }
    listKey = null;
    listAcc = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (listKey && /^\s+-\s+/.test(line)) {
      listAcc.push(line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    flushList();
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (val === '' || val == null) {
      // 后续可能是数组
      if (key === 'triggers' || key === 'tags') {
        listKey = key as keyof SkillFrontmatter;
        listAcc = [];
      }
      continue;
    }
    if (key === 'name' || key === 'description') {
      const v = parseScalar(val);
      (fm as Record<string, unknown>)[key] = String(v);
    } else if (key === 'priority') {
      const v = parseScalar(val);
      if (typeof v === 'number') fm.priority = v;
      else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) fm.priority = Number(v);
    } else if (key === 'triggers' || key === 'tags') {
      // 内联 [a, b] 语法
      if (val.startsWith('[') && val.endsWith(']')) {
        const arr = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        (fm as Record<string, unknown>)[key] = arr;
      } else {
        (fm as Record<string, unknown>)[key] = [String(parseScalar(val))];
      }
    }
  }
  flushList();
  return { frontmatter: fm, has_frontmatter: true, body };
}

function firstHeading(body: string): string | null {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function firstNonEmptyParagraph(body: string, limit = 200): string {
  const lines = body.split('\n');
  let buf: string[] = [];
  let started = false;
  for (const l of lines) {
    if (/^\s*#/.test(l)) {
      if (started) break;
      continue;
    }
    if (l.trim() === '') {
      if (started) break;
      continue;
    }
    started = true;
    buf.push(l.trim());
    if (buf.join(' ').length >= limit) break;
  }
  const out = buf.join(' ').replace(/\s+/g, ' ').trim();
  return out.length > limit ? out.slice(0, limit) + '…' : out;
}

/* ──────────────────────────────────────────
 * 路径白名单 + 安全校验
 * ────────────────────────────────────────── */

function isUnderAnyRoot(p: string): boolean {
  for (const root of REGISTRY_ROOTS) {
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { continue; }
    let realP: string;
    try { realP = fs.realpathSync(p); } catch { continue; }
    if (realP === realRoot || realP.startsWith(realRoot + path.sep)) return true;
  }
  return false;
}

/* ──────────────────────────────────────────
 * 单个文件 → SkillDoc
 * ────────────────────────────────────────── */

function buildId(source: SkillSource, key: string): string {
  return `${source}:${key}`;
}

function loadSkillFromFile(filePath: string, source: SkillSource, displayPath: string): SkillDoc | null {
  if (!isUnderAnyRoot(filePath)) return null;
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) return null;

  const cached = CACHE.get(filePath);
  if (cached && cached.size === stat.size && cached.mtime_ms === stat.mtimeMs) {
    return cached;
  }
  const raw = safeRead(filePath);
  if (raw == null) return null;

  const parsed = parseMarkdown(raw);
  const baseName = path.basename(filePath);
  const dirName = path.basename(path.dirname(filePath));
  // user:dir → 用目录名作为 name；其它默认用文件名去掉 .md
  const fallbackName = source === 'user:dir' ? dirName : baseName.replace(/\.md$/i, '');
  const name = (parsed.frontmatter.name && parsed.frontmatter.name.trim())
    || fallbackName;
  const description = (parsed.frontmatter.description && parsed.frontmatter.description.trim())
    || firstHeading(parsed.body)
    || firstNonEmptyParagraph(parsed.body, 200)
    || '（无描述）';
  const triggers = (parsed.frontmatter.triggers ?? []).map((t) => t.trim()).filter(Boolean);
  const priority = typeof parsed.frontmatter.priority === 'number' ? parsed.frontmatter.priority : 50;
  const tags = (parsed.frontmatter.tags ?? []).map((t) => t.trim()).filter(Boolean);

  const idKey = source === 'user:dir' ? dirName : baseName;
  const doc: SkillDoc = {
    id: buildId(source, idKey),
    name,
    description,
    source,
    path: filePath,
    display_path: displayPath,
    triggers,
    priority,
    tags,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    has_frontmatter: parsed.has_frontmatter,
  };
  CACHE.set(filePath, doc);
  return doc;
}

/* ──────────────────────────────────────────
 * 三类目录扫描
 * ────────────────────────────────────────── */

function scanRepoEntry(): SkillDoc[] {
  const out: SkillDoc[] = [];
  if (!fs.existsSync(REPO_ENTRY)) return out;
  const d = loadSkillFromFile(REPO_ENTRY, 'repo:entry', 'SKILL.md');
  if (d) out.push(d);
  return out;
}

function scanRepoSkillDir(): SkillDoc[] {
  const out: SkillDoc[] = [];
  if (!fs.existsSync(REPO_SKILL_DIR)) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(REPO_SKILL_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      const full = path.join(REPO_SKILL_DIR, e.name);
      const d = loadSkillFromFile(full, 'repo:doc', `skill/${e.name}`);
      if (d) out.push(d);
    }
  }
  return out;
}

function scanUserSkillDir(): SkillDoc[] {
  const out: SkillDoc[] = [];
  if (!fs.existsSync(USER_SKILL_DIR)) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(USER_SKILL_DIR, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      const full = path.join(USER_SKILL_DIR, e.name);
      const d = loadSkillFromFile(full, 'user:doc', e.name);
      if (d) out.push(d);
      continue;
    }
    if (e.isDirectory()) {
      const subPath = path.join(USER_SKILL_DIR, e.name);
      // 优先 SKILL.md，兼容 skill.md
      const candidates = ['SKILL.md', 'Skill.md', 'skill.md'];
      for (const cand of candidates) {
        const full = path.join(subPath, cand);
        if (fs.existsSync(full)) {
          const d = loadSkillFromFile(full, 'user:dir', `${e.name}/${cand}`);
          if (d) out.push(d);
          break;
        }
      }
    }
  }
  return out;
}

/* ──────────────────────────────────────────
 * 公共 API
 * ────────────────────────────────────────── */

/** 同名按 source 优先级（user:* 覆盖 repo:*）合并；返回稳定排序的 skill 列表。 */
export function listSkills(force = false): SkillDoc[] {
  const now = Date.now();
  if (!force && LAST_INDEX.length > 0 && now - LAST_INDEX_MS < INDEX_TTL_MS) {
    return LAST_INDEX.slice();
  }
  const all = [...scanRepoEntry(), ...scanRepoSkillDir(), ...scanUserSkillDir()];
  // 同 name 用 user:* 覆盖 repo:*
  const byName = new Map<string, SkillDoc>();
  const sourceRank: Record<SkillSource, number> = {
    'repo:entry': 0,
    'repo:doc': 1,
    'user:doc': 2,
    'user:dir': 3,
  };
  for (const d of all) {
    const cur = byName.get(d.name.toLowerCase());
    if (!cur || sourceRank[d.source] > sourceRank[cur.source]) {
      byName.set(d.name.toLowerCase(), d);
    }
  }
  // entry 总是单独保留（即使同名，也不应被合并掉）—— 因为用户可能想覆盖 entry，这种情况下尊重用户
  const merged = Array.from(byName.values());
  // 排序：source 优先 user>repo:doc>repo:entry，priority 高的在前
  merged.sort((a, b) => {
    const s = sourceRank[b.source] - sourceRank[a.source];
    if (s !== 0) return s;
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  LAST_INDEX = merged;
  LAST_INDEX_MS = now;
  return merged.slice();
}

export function getSkill(idOrName: string): SkillDoc | null {
  if (!idOrName) return null;
  const list = listSkills();
  const lower = idOrName.toLowerCase();
  // 1. 精确 id 命中
  const byId = list.find((d) => d.id === idOrName);
  if (byId) return byId;
  // 2. 兼容旧的 "sop-pretrade.md" / "SKILL.md" 写法
  const byBaseName = list.find((d) => path.basename(d.path).toLowerCase() === lower);
  if (byBaseName) return byBaseName;
  // 3. 按 name
  const byName = list.find((d) => d.name.toLowerCase() === lower);
  if (byName) return byName;
  // 4. 按 display_path
  const byDisplay = list.find((d) => d.display_path.toLowerCase() === lower);
  if (byDisplay) return byDisplay;
  return null;
}

export function readSkillContent(idOrName: string): { skill: SkillDoc; content: string } {
  const skill = getSkill(idOrName);
  if (!skill) throw new Error(`skill 不存在: ${idOrName}`);
  if (!isUnderAnyRoot(skill.path)) throw new Error(`skill 路径越界: ${skill.path}`);
  const content = safeRead(skill.path);
  if (content == null) throw new Error(`skill 文件读取失败: ${skill.display_path}`);
  return { skill, content };
}

/* ──────────────────────────────────────────
 * 路由：按用户 query 选 skill
 * ────────────────────────────────────────── */

const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '在', '和', '吧', '吗', '呢', '请', '帮', '把', '给',
  '一下', '现在', '今天', '明天', '一个', '怎么', '什么', '为啥', '为什么', '能不能', '可以',
  'a', 'an', 'the', 'is', 'are', 'of', 'to', 'for', 'and', 'or',
]);

function ngrams(s: string, n: number): string[] {
  if (s.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

/**
 * 中文友好 tokenizer：
 * - 先按标点/空白切粗 token
 * - 再对每个 token 做 2/3/4-gram 切片，加入 token 集合
 * - 过滤 stop words 和长度 1 的字符
 */
function tokenize(query: string): string[] {
  if (!query) return [];
  const lowered = query.toLowerCase();
  const rough = lowered.split(/[\s,，.。;；:：!！?？、(\)（）\[\]【】<>《》"'""''`]+/).filter(Boolean);
  const out = new Set<string>();
  for (const raw of rough) {
    if (!raw) continue;
    if (raw.length === 1) continue;
    if (!STOP_WORDS.has(raw)) out.add(raw);
    for (let n = 2; n <= 4; n++) {
      for (const g of ngrams(raw, n)) {
        if (STOP_WORDS.has(g)) continue;
        out.add(g);
      }
    }
  }
  return Array.from(out);
}

function tokenHits(haystack: string, tokens: string[]): string[] {
  const lower = haystack.toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (seen.has(tok)) continue;
    if (lower.includes(tok)) {
      hits.push(tok);
      seen.add(tok);
    }
  }
  return hits;
}

function scoreSkill(skill: SkillDoc, query: string, tokens: string[]): SkillSelectionItem | null {
  if (!query.trim()) return null;
  const matches: string[] = [];
  let score = 0;

  // trigger 命中：完整短语包含 / token 子串相互包含
  for (const t of skill.triggers) {
    if (!t) continue;
    const tl = t.toLowerCase();
    if (query.toLowerCase().includes(tl) || tokens.some((tok) => tok.includes(tl) || tl.includes(tok))) {
      matches.push(`trigger:${t}`);
      score += 30;
    }
  }
  // name 命中（按 N-gram，避免要求整段命中）
  const nameHits = tokenHits(skill.name, tokens);
  for (const h of nameHits) {
    matches.push(`name:${h}`);
    score += 12;
  }
  // description 命中：每个 token 计 5 分，封顶避免长描述压制 trigger
  const descHits = tokenHits(skill.description, tokens);
  let descScore = 0;
  for (const h of descHits.slice(0, 6)) {
    matches.push(`desc:${h}`);
    descScore += 5;
  }
  score += descScore;
  // tags / display_path 命中：弱信号
  const tagsHaystack = `${skill.tags.join(' ')} ${skill.display_path}`;
  const tagHits = tokenHits(tagsHaystack, tokens);
  for (const h of tagHits.slice(0, 4)) {
    matches.push(`tag:${h}`);
    score += 3;
  }

  if (matches.length === 0) return null;
  // priority 微调（0..3 分），避免同分时随机
  score += Math.max(0, Math.min(3, skill.priority / 30));
  return { skill, matches, score };
}

export interface SelectOptions {
  /** 最多返回几条，默认 3 */
  limit?: number;
  /** 候选池：若不传则使用 listSkills() 全集 */
  pool?: SkillDoc[];
}

/** 按用户消息匹配相关 skill；query 为空时返回空数组（不强行注入） */
export function selectRelevantSkills(query: string, opts: SelectOptions = {}): SkillSelectionItem[] {
  const limit = Math.max(1, Math.min(8, opts.limit ?? 3));
  const tokens = tokenize(query);
  const pool = opts.pool ?? listSkills();
  const scored: SkillSelectionItem[] = [];
  for (const s of pool) {
    const r = scoreSkill(s, query, tokens);
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/* ──────────────────────────────────────────
 * 调试：注入到 system prompt 的格式化
 * ────────────────────────────────────────── */

export interface BuildSkillContextOpts {
  /** 单个 skill 注入正文最大字符数 */
  perSkillCharLimit?: number;
  /** 全部 skill 总字符数 */
  totalCharLimit?: number;
}

export function buildSkillContext(items: SkillSelectionItem[], opts: BuildSkillContextOpts = {}): string {
  if (items.length === 0) return '';
  const perLimit = opts.perSkillCharLimit ?? 6000;
  const totalLimit = opts.totalCharLimit ?? 12000;
  const blocks: string[] = [];
  let used = 0;
  for (const it of items) {
    let body = '';
    try {
      body = readSkillContent(it.skill.id).content;
    } catch (e) {
      body = `（读取失败：${(e as Error).message}）`;
    }
    let truncated = body;
    let truncFlag = '';
    if (body.length > perLimit) {
      truncated = body.slice(0, perLimit);
      truncFlag = `\n\n…（已截断，全文 ${body.length} 字；调用 read_skill_doc("${it.skill.id}") 取完整版）`;
    }
    const header = `### Skill: ${it.skill.name}\n`
      + `- id: ${it.skill.id}\n`
      + `- source: ${it.skill.source} · ${it.skill.display_path}\n`
      + `- 命中: ${it.matches.join(', ')}\n`;
    const block = `${header}\n${truncated}${truncFlag}`;
    if (used + block.length > totalLimit) {
      blocks.push(`### Skill: ${it.skill.name}\n（已超总长度上限，未注入正文；可调用 read_skill_doc("${it.skill.id}") 取全文）`);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  return [
    '【按用户提问自动加载的相关 skill 摘要】',
    '注意：以下 skill 是 router 根据本轮用户消息匹配出的；若与本次任务无关请忽略。',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

export function getRegistryDebug(): SkillRegistryDebug {
  const list = listSkills();
  const bySource: Record<SkillSource, number> = {
    'repo:entry': 0, 'repo:doc': 0, 'user:doc': 0, 'user:dir': 0,
  };
  for (const d of list) bySource[d.source] += 1;
  return {
    repo_root: REPO_ROOT,
    repo_entry: REPO_ENTRY,
    repo_skill_dir: REPO_SKILL_DIR,
    user_skill_dir: USER_SKILL_DIR,
    user_skill_dir_exists: fs.existsSync(USER_SKILL_DIR),
    total: list.length,
    by_source: bySource,
  };
}

/** 仅供测试/调试：清掉缓存强制 reload */
export function clearSkillCache(): void {
  CACHE.clear();
  LAST_INDEX = [];
  LAST_INDEX_MS = 0;
}
