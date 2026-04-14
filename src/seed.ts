/**
 * Mock 数据种子：生成过去 30 天 + 未来 7 天的模拟数据
 * 情绪曲线：混乱 → 修复 → 主升 → 高位风险（完整周期）
 */
import { v4 as uuidv4 } from 'uuid';
import { resetDB, insertInput, insertFutureItem } from './db/store';
import { aggregateSnapshot } from './services/aggregator';
import type { BaselineInput, FutureWatchItem } from './models/types';

// 使用本地日期（避免 UTC 偏移导致日期错误）
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const todayLocal = localDateStr(new Date());

function dateStr(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateStr(d);
}

// 情绪曲线：30天完整周期
function emotionAt(dayIndex: number): number {
  // 前10天：18→42（混乱→修复早期）
  // 中10天：42→73（修复确认→主升）
  // 后10天：73→85（主升→高位风险）
  if (dayIndex < 10) return Math.round(18 + (dayIndex / 9) * 24);
  if (dayIndex < 20) return Math.round(42 + ((dayIndex - 10) / 9) * 31);
  return Math.round(73 + ((dayIndex - 20) / 9) * 12);
}

const MARKET_EVENTS_BY_PHASE = [
  // 混乱期事件
  ['外资大幅净流出，市场恐慌情绪蔓延', '高位股普遍跌停，资金出逃迹象明显', '大盘跌破重要支撑位，短线多头割肉', '龙头股出现天地板，市场信心受损'],
  // 修复早期事件
  ['部分超跌股开始企稳反弹', '核心板块龙头止跌，资金试探性介入', '涨停板数量小幅回升，赚钱效应初现', '政策面传来利好消息，情绪略有修复'],
  // 修复确认事件
  ['AI算力板块强势晋级，主线初步确立', '连板股增多，市场做多热情回升', '北上资金净流入创近期新高', '核心赛道龙头放量突破，形态走好'],
  // 主升行情事件
  ['主线板块集体爆发，市场热度全面提升', '涨停家数突破百家，资金共振明显', '市值效应显现，小盘股跟随主升', '机构重仓股走强，外资持续买入'],
  // 高位风险事件
  ['高位股开始出现分歧，龙头炸板率上升', '追高资金被套，情绪分化加剧', '板块轮动加速，资金获利了结', '技术指标超买，短线风险加大'],
];

function getPhaseEvents(dayIndex: number): string[] {
  if (dayIndex < 7)  return MARKET_EVENTS_BY_PHASE[0]!.slice(0, 2);
  if (dayIndex < 14) return MARKET_EVENTS_BY_PHASE[1]!.slice(0, 2);
  if (dayIndex < 20) return MARKET_EVENTS_BY_PHASE[2]!.slice(0, 2);
  if (dayIndex < 25) return MARKET_EVENTS_BY_PHASE[3]!.slice(0, 2);
  return MARKET_EVENTS_BY_PHASE[4]!.slice(0, 2);
}

function makeInput(partial: Omit<BaselineInput, 'id' | 'created_at'>): BaselineInput {
  return { ...partial, id: uuidv4(), created_at: new Date().toISOString() };
}

async function seed() {
  console.log('清空数据库...');
  resetDB();

  console.log('写入过去 30 天数据...');
  for (let i = 0; i < 30; i++) {
    const date = dateStr(i - 29);
    const emotion = emotionAt(i);
    const events = getPhaseEvents(i);
    const isWeekend = [0, 6].includes(new Date(date + 'T12:00:00').getDay());
    if (isWeekend) continue; // 跳过周末

    // market_snapshot
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'market_snapshot', source: 'market_agent', source_type: 'agent',
      title: `${date} 市场快照`,
      payload: {
        emotion_score: emotion,
        events,
        limit_up: Math.round(20 + emotion * 1.2),
        limit_down: Math.round(40 - emotion * 0.3),
        turnover_rate: (3 + emotion * 0.05).toFixed(2),
      },
      confidence: 0.9, priority: 8, tags: ['daily', 'market'],
      effective_start: `${date}T09:00:00+08:00`,
      effective_end: `${date}T15:30:00+08:00`,
      created_by: 'market_agent', status: 'active',
    }));

    // market_event
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'market_event', source: 'news_agent', source_type: 'agent',
      title: events[0] ?? '市场平稳运行',
      payload: {
        summary: events.join('；'),
        impact_direction: emotion > 62 ? 'bullish' : emotion < 40 ? 'bearish' : 'neutral',
        impact_level: Math.min(1, emotion / 100 + 0.1),
        related_sectors: emotion > 62 ? ['AI算力', '机器人', '半导体'] : emotion < 40 ? ['黄金', '国债', '公用事业'] : ['消费', '医药'],
      },
      confidence: 0.85, priority: 7, tags: ['event', 'news'],
      created_by: 'news_agent', status: 'active',
    }));

    // stage_signal
    const preferred = emotion > 62
      ? ['AI算力', '机器人自动化', '信创'] : emotion > 45
      ? ['科技主线', '消费复苏', '红利'] : ['黄金', '防御消费', '国债'];
    const avoid = emotion > 78
      ? ['追高高位股', '题材炒作'] : emotion < 35
      ? ['强周期', '高杠杆'] : ['短线博弈', '低价垃圾股'];
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'stage_signal', source: 'strategy_agent', source_type: 'agent',
      title: `${date} 阶段信号`,
      payload: { emotion_score: emotion, preferred_styles: preferred, avoid_styles: avoid },
      confidence: 0.88, priority: 8, tags: ['stage', 'signal'],
      created_by: 'strategy_agent', status: 'active',
    }));

    await aggregateSnapshot(date);
  }

  // 今天
  {
    const date = dateStr(0);
    const emotion = 81;
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'market_snapshot', source: 'market_agent', source_type: 'agent',
      title: `${date} 今日快照`,
      payload: { emotion_score: emotion, events: ['主线AI板块持续强化', '高位股出现分歧但核心未死', '场内资金博弈加剧'] },
      confidence: 0.92, priority: 9, tags: ['today', 'market'],
      created_by: 'market_agent', status: 'active',
    }));
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'stage_signal', source: 'strategy_agent', source_type: 'agent',
      title: `${date} 今日阶段信号`,
      payload: { emotion_score: emotion, preferred_styles: ['AI算力核心', '低位补涨'], avoid_styles: ['追高', '高位博弈'] },
      confidence: 0.9, priority: 9, tags: ['today'],
      created_by: 'strategy_agent', status: 'active',
    }));
    insertInput(makeInput({
      time_key: date, time_granularity: 'day',
      data_type: 'trade_plan', source: 'manual', source_type: 'user',
      title: '今日交易预案',
      payload: { summary: '以主线核心为主，高位股注意分歧后承接机会，仓位控制在4-5成，不追高' },
      confidence: 1.0, priority: 10, tags: ['plan', 'today'],
      created_by: 'manual', status: 'active',
    }));
    await aggregateSnapshot(date);
  }

  console.log('写入未来 7 天观察项...');
  const FUTURE_EVENTS: Array<{ daysAhead: number; title: string; eventType: string; certainty: FutureWatchItem['certainty']; impact: number }> = [
    { daysAhead: 1, title: 'CPI 数据公布，关注通胀预期变化', eventType: 'macro_data', certainty: 'high', impact: 0.7 },
    { daysAhead: 2, title: 'Fed 官员发言，关注鹰鸽立场', eventType: 'policy', certainty: 'high', impact: 0.65 },
    { daysAhead: 3, title: '某 AI 龙头业绩预告窗口', eventType: 'earnings', certainty: 'medium', impact: 0.8 },
    { daysAhead: 4, title: '重要板块解禁压力日，注意流动性风险', eventType: 'unlock', certainty: 'high', impact: 0.6 },
    { daysAhead: 5, title: '政策例行新闻发布会', eventType: 'policy', certainty: 'medium', impact: 0.5 },
    { daysAhead: 6, title: '美股 NVIDIA 财报，影响 A 股科技情绪', eventType: 'earnings', certainty: 'high', impact: 0.75 },
    { daysAhead: 7, title: '月末资金面观察节点', eventType: 'liquidity', certainty: 'low', impact: 0.45 },
  ];

  for (const fe of FUTURE_EVENTS) {
    const expectedDate = dateStr(fe.daysAhead);
    if ([0, 6].includes(new Date(expectedDate + 'T12:00:00').getDay())) continue;
    const item: FutureWatchItem = {
      id: uuidv4(), expected_time: `${expectedDate}T09:00:00+08:00`,
      event_type: fe.eventType, title: fe.title,
      payload: { description: fe.title },
      certainty: fe.certainty, impact_level: fe.impact,
      review_status: 'pending',
      linked_snapshot_time_key: todayLocal,
      created_at: new Date().toISOString(),
    };
    insertFutureItem(item);
  }

  console.log('✅ Seed 完成！');
  console.log(`   过去 30 天数据已生成（跳过周末）`);
  console.log(`   未来 7 天观察项已写入`);
  console.log(`   运行 npm run dev 查看时间线\n`);
}

seed().catch(console.error);
