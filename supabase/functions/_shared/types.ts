export type Intent = "lead" | "engagement" | "spam";
export type ConfidenceLevel = "low" | "medium" | "high";

export interface InteractionRow {
  id: string;
  source_item_id: string;
  source: "own_reply" | "keyword_search";
  event_type: string;
  post_id: string | null;
  username: string | null;
  comment_text: string;
  intent: Intent | null;
  signals: string[];
  risk_flags: string[];
  confidence_level: ConfidenceLevel | null;
  bot_reply_text: string | null;
  reply_sent: boolean;
  notification_sent: boolean;
}

export interface ContentRow {
  id: string;
  text: string;
  media_url: string | null;
  container_id: string | null;
}

export interface Classification {
  intent: Intent;
  signals: string[];
  riskFlags: string[];
  confidenceLevel: ConfidenceLevel;
  botReplyText: string | null;
}

export interface JobResult {
  claimed?: number;
  processed?: number;
  published?: number;
  inserted?: number;
  skipped?: boolean;
  failed: number;
}
