export type TimeGranularity = 'day' | 'intraday' | 'week';

export type DataType =
  | 'market_snapshot'
  | 'emotion_metric'
  | 'market_event'
  | 'future_event'
  | 'manual_note'
  | 'trade_plan'
  | 'risk_alert'
  | 'stage_signal'
  | 'position_suggestion'
  | 'override';

export type MarketStage =
  | 'CHAOS'
  | 'REPAIR_EARLY'
  | 'REPAIR_CONFIRM'
  | 'MAIN_UP'
  | 'HIGH_RISK'
  | 'DISTRIBUTION'
  | 'UNKNOWN';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type NodeType = 'fact' | 'interpretation' | 'future';
export type Certainty = 'high' | 'medium' | 'low';
export type ReviewStatus = 'pending' | 'triggered' | 'expired' | 'fulfilled';

export interface BaselineInput {
  id: string;
  time_key: string;
  time_granularity: TimeGranularity;
  data_type: DataType;
  source: string;
  source_type: 'agent' | 'user' | 'system';
  title: string;
  payload: Record<string, unknown>;
  confidence: number;
  priority: number;
  tags: string[];
  effective_start?: string;
  effective_end?: string;
  created_at: string;
  created_by: string;
  status: 'active' | 'superseded' | 'archived';
}

export interface BaselineSnapshot {
  id: string;
  time_key: string;
  time_granularity: TimeGranularity;
  market_stage: MarketStage;
  emotion_score: number;
  risk_level: RiskLevel;
  position_min: number;
  position_max: number;
  preferred_styles: string[];
  avoid_styles: string[];
  action_summary: string;
  core_events: string[];
  future_watch_items: string[];
  summary: Record<string, unknown>;
  generated_at: string;
  generator_version: string;
}

export interface BaselineRelation {
  snapshot_id: string;
  input_id: string;
  contribution_type: string;
  contribution_weight: number;
}

export interface FutureWatchItem {
  id: string;
  expected_time: string;
  event_type: string;
  title: string;
  payload: Record<string, unknown>;
  certainty: Certainty;
  impact_level: number;
  review_status: ReviewStatus;
  linked_snapshot_time_key?: string;
  created_at: string;
}

export interface InputUploadRequest {
  time_key: string;
  time_type?: TimeGranularity;
  data_type: DataType;
  source: string;
  title: string;
  payload?: Record<string, unknown>;
  confidence?: number;
  tags?: string[];
  effective_time_range?: { start: string; end: string };
  priority?: number;
}

export interface TimelineNode {
  date: string;
  node_type: NodeType;
  is_future: boolean;
  snapshot?: BaselineSnapshot;
  inputs_count: number;
  future_items: FutureWatchItem[];
  highlight: boolean;
}

export interface TimelineResponse {
  nodes: TimelineNode[];
  today: string;
}
