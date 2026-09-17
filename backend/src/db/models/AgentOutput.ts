/**
 * AgentOutput model - stores AI agent analysis outputs for auditing and learning
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IAgentOutput extends Document {
  outputId: string;
  opportunityId: string;
  agentName: string;
  promptVersion: string;

  // Agent response
  stance: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'ABSTAIN';
  strength: number;
  selfConfidence: number;

  // Claims with citations
  claims: Array<{
    text: string;
    stance: string;
    strength: number;
    featureIds: string[];
    observedValues: Record<string, number>;
    verified: boolean;
    rejectionReason?: string;
  }>;

  // Agent metadata
  abstainReason?: string;
  missingInformation: string[];
  wouldChangeMyView?: string;

  // Verification and scoring
  claimsVerified: number;
  claimsRejected: number;
  verificationRate: number;

  // Provider info
  provider: string;
  llmModel: string;
  temperature: number;

  // Usage metrics
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  latencyMs: number;

  // Feature snapshot reference
  featureSnapshotHash: string;

  // Raw response for debugging
  rawResponse: string;

  // Performance (populated after trade closes)
  outcomeCorrect?: boolean;
  contributionScore?: number;

  createdAt: Date;
  updatedAt: Date;
}

const AgentOutputSchema = new Schema<IAgentOutput>({
  outputId: { type: String, required: true, unique: true, index: true },
  opportunityId: { type: String, required: true, index: true },
  agentName: { type: String, required: true, index: true },
  promptVersion: { type: String, required: true },

  stance: { type: String, enum: ['BULLISH', 'BEARISH', 'NEUTRAL', 'ABSTAIN'], required: true },
  strength: { type: Number, required: true },
  selfConfidence: { type: Number, required: true },

  claims: [{
    text: { type: String, required: true },
    stance: { type: String, required: true },
    strength: { type: Number, required: true },
    featureIds: [{ type: String }],
    observedValues: { type: Schema.Types.Mixed },
    verified: { type: Boolean, required: true },
    rejectionReason: { type: String },
  }],

  abstainReason: { type: String },
  missingInformation: [{ type: String }],
  wouldChangeMyView: { type: String },

  claimsVerified: { type: Number, required: true },
  claimsRejected: { type: Number, required: true },
  verificationRate: { type: Number, required: true },

  provider: { type: String, required: true, index: true },
  llmModel: { type: String, required: true },
  temperature: { type: Number, required: true },

  inputTokens: { type: Number, required: true },
  outputTokens: { type: Number, required: true },
  costUSD: { type: Number, required: true },
  latencyMs: { type: Number, required: true },

  featureSnapshotHash: { type: String, required: true, index: true },
  rawResponse: { type: String, required: true },

  outcomeCorrect: { type: Boolean },
  contributionScore: { type: Number },
}, {
  timestamps: true,
});

// Indexes for agent performance analysis
AgentOutputSchema.index({ agentName: 1, createdAt: -1 });
AgentOutputSchema.index({ provider: 1, llmModel: 1 });
AgentOutputSchema.index({ verificationRate: 1 });

export const AgentOutput = mongoose.model<IAgentOutput>('AgentOutput', AgentOutputSchema);
