/**
 * Trade model - stores completed and ongoing trades
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface ITrade extends Document {
  tradeId: string;
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  leverage: number;

  // Timestamps
  entryTime: Date;
  exitTime?: Date;

  // P&L and performance
  pnl?: number;
  pnlPercent?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;

  // Trade metadata
  archetype: string;
  regime: string;
  setupQuality: number;

  // Risk management
  stopLoss: number;
  takeProfit: number[];
  riskAmount: number;

  // Trade lifecycle
  status: 'OPEN' | 'CLOSED' | 'STOPPED_OUT' | 'INVALIDATED';
  invalidationReason?: string;

  // Agent analysis
  agentScores?: {
    structure?: number;
    positioning?: number;
    context?: number;
    adversary?: number;
    ensemble?: number;
  };

  // Additional data
  featureSnapshotId?: string;
  notes?: string;

  createdAt: Date;
  updatedAt: Date;
}

const TradeSchema = new Schema<ITrade>({
  tradeId: { type: String, required: true, unique: true, index: true },
  asset: { type: String, required: true, index: true },
  direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  quantity: { type: Number, required: true },
  leverage: { type: Number, required: true },

  entryTime: { type: Date, required: true, index: true },
  exitTime: { type: Date, index: true },

  pnl: { type: Number },
  pnlPercent: { type: Number },
  realizedPnl: { type: Number },
  unrealizedPnl: { type: Number },

  archetype: { type: String, required: true, index: true },
  regime: { type: String, required: true, index: true },
  setupQuality: { type: Number, required: true },

  stopLoss: { type: Number, required: true },
  takeProfit: { type: [Number], required: true },
  riskAmount: { type: Number, required: true },

  status: { type: String, enum: ['OPEN', 'CLOSED', 'STOPPED_OUT', 'INVALIDATED'], required: true, index: true },
  invalidationReason: { type: String },

  agentScores: {
    structure: { type: Number },
    positioning: { type: Number },
    context: { type: Number },
    adversary: { type: Number },
    ensemble: { type: Number },
  },

  featureSnapshotId: { type: String },
  notes: { type: String },
}, {
  timestamps: true,
});

// Indexes for common queries
TradeSchema.index({ asset: 1, status: 1, entryTime: -1 });
TradeSchema.index({ archetype: 1, regime: 1 });
TradeSchema.index({ status: 1, entryTime: -1 });

export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);
