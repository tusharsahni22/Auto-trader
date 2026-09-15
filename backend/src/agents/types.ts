import type { Claim } from "../decision/types.js";
import type { FeatureSnapshot } from "../decision/snapshot.js";

export type AgentKind = "free" | "paid";

export interface AgentContext {
  snapshot: FeatureSnapshot;
  headlines: { title: string; source: string; publishedAt: number; url: string }[];
}

export interface AgentProvider {
  name: string;
  label: string;
  kind: AgentKind;
  /** Env var name the provider reads its API key from (undefined for the free rules engine, which needs none). */
  apiKeyEnv?: string;
  model?: string;
  hasKey(): boolean;
  generateClaims(ctx: AgentContext): Promise<Claim[]>;
}

export interface AgentStatus {
  name: string;
  label: string;
  kind: AgentKind;
  model?: string;
  hasKey: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastClaimCount: number | null;
}
