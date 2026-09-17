/**
 * Opportunity model - stores detected trading opportunities before they become trades
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IOpportunity extends Document {
  opportunityId: string;
  asset: string;
  direction: 'LONG' | 'SHORT';
  archetype: string;
  regime: string;

  // Scoring
  archetypeScore: number;
  ensembleScore: number;
  calibratedProbability: number;

  // Price levels
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];

  // Risk/Reward
  riskRewardRatio: number;
  expectedValue: number;
  positionSize: number;

  // Agent claims
  agentClaims?: {
    structure?: any[];
    positioning?: any[];
    context?: any[];
    adversary?: any[];
  };

  // Feature snapshot
  featureSnapshot: any;
  featureSnapshotHash: string;

  // Status
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED';
  rejectionReason?: string;

  // Timing
  detectedAt: Date;
  expiresAt: Date;
  executedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const OpportunitySchema = new Schema<IOpportunity>({
  opportunityId: { type: String, required: true, unique: true, index: true },
  asset: { type: String, required: true, index: true },
  direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
  archetype: { type: String, required: true, index: true },
  regime: { type: String, required: true, index: true },

  archetypeScore: { type: Number, required: true },
  ensembleScore: { type: Number, required: true },
  calibratedProbability: { type: Number, required: true },

  entryPrice: { type: Number, required: true },
  currentPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  takeProfitLevels: { type: [Number], required: true },

  riskRewardRatio: { type: Number, required: true },
  expectedValue: { type: Number, required: true },
  positionSize: { type: Number, required: true },

  agentClaims: { type: Schema.Types.Mixed },

  featureSnapshot: { type: Schema.Types.Mixed, required: true },
  featureSnapshotHash: { type: String, required: true, index: true },

  status: { type: String, enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'EXECUTED'], required: true, index: true },
  rejectionReason: { type: String },

  detectedAt: { type: Date, required: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  executedAt: { type: Date },
}, {
  timestamps: true,
});

// Indexes for common queries
OpportunitySchema.index({ asset: 1, status: 1, detectedAt: -1 });
OpportunitySchema.index({ status: 1, expiresAt: 1 });

export const Opportunity = mongoose.model<IOpportunity>('Opportunity', OpportunitySchema);
